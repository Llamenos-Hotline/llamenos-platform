/**
 * The PBX image version is a media-plane security control, which is not
 * obvious from any one file, so it is asserted here.
 *
 * `apps/worker/telephony/registrar.ts` provisions every volunteer endpoint
 * with `dtls_verify: 'fingerprint'` — the RFC 5763 binding that ties the DTLS
 * certificate to the `a=fingerprint:` carried in the signalled SDP. On
 * Asterisk before 22.10.0 that setting does not survive being stored:
 * `asterisk-config/sorcery.conf` backs `endpoint` with astdb, so the object is
 * serialised on write and re-parsed on every inbound INVITE, and the
 * pre-22.10.0 serialiser (`dtlsverify_to_str`) collapsed every non-zero verify
 * mode to the string `"Yes"`. `"Yes"` parses back as fingerprint AND
 * certificate, so Asterisk ran full X.509 chain verification against an empty
 * trust store — which no self-signed RFC 5763 peer certificate can satisfy.
 * Measured on a deployed PBX: every DTLS-SRTP call died at the handshake with
 * `certificate verify failed` and carried zero audio (#1687).
 *
 * Only two values are fixed points of that lossy serialiser, `yes` and `no`,
 * so on an affected build there is no `dtls_verify` setting that yields
 * fingerprint-only verification. Downgrading the image therefore does not
 * merely lose a nicety: it either kills the media plane outright, or invites
 * the `dtls_verify: 'no'` "fix" that removes the binding entirely while every
 * call still connects. Both failures are invisible to any other test here.
 *
 * So the vetted digests are enumerated. Bumping the PBX image is allowed; doing
 * it without recording the Asterisk version is not.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const DEPLOY = path.resolve(__dirname, '../../..')

/**
 * Digests vetted to carry upstream 269a566a347f ("pjsip_configuration: Show
 * actual dtls_verify config"), first released in Asterisk 22.10.0. Add an entry
 * only after confirming `core show version` in the candidate image reports
 * 22.10.0 or later.
 */
const VETTED_DIGESTS: Record<string, string> = {
  'sha256:fa1d49e3826d3e85232e9a63bb1659a20088dabe8e41980ecc7948fb1da6efe6': '22.10.1',
}

/** The pre-fix pin this repo shipped until #1687. Must never come back. */
const AFFECTED_DIGEST = 'sha256:e30df5ec1b512827bf3cffc49b8000b07376a05c950736d028348eba80035015'

/** Every file under deploy/, so a new pin in a new file cannot slip the check. */
function deployFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '.terraform') continue
      deployFiles(full, out)
    } else if (/\.(ya?ml|j2|tf|sh|conf|md|ts)$/.test(entry)) {
      out.push(full)
    }
  }
  return out
}

/** `andrius/asterisk@sha256:…` occurrences, with the file that carries them. */
function asteriskPins(): { file: string; digest: string }[] {
  const pins: { file: string; digest: string }[] = []
  for (const file of deployFiles(DEPLOY)) {
    // This test names the affected digest deliberately; it is not a pin.
    if (file === __filename) continue
    for (const m of readFileSync(file, 'utf8').matchAll(/andrius\/asterisk@(sha256:[0-9a-f]{64})/g)) {
      pins.push({ file: path.relative(DEPLOY, file), digest: m[1] })
    }
  }
  return pins
}

describe('the Asterisk image pin keeps DTLS fingerprint verification working', () => {
  it('pins the PBX image somewhere under deploy/', () => {
    // A zero-pin result would make every assertion below vacuously true.
    expect(asteriskPins().length).toBeGreaterThan(0)
  })

  it('pins only digests vetted for Asterisk >= 22.10.0', () => {
    for (const { file, digest } of asteriskPins()) {
      expect(
        Object.keys(VETTED_DIGESTS),
        `${file} pins andrius/asterisk@${digest}, which is not vetted for the ` +
          'dtls_verify fix (#1687). Confirm `core show version` >= 22.10.0 in ' +
          'that image and add the digest to VETTED_DIGESTS with its version.',
      ).toContain(digest)
    }
  })

  it('never reintroduces the pre-fix digest', () => {
    for (const { file, digest } of asteriskPins()) {
      expect(digest, `${file} reintroduces the Asterisk 22.8.2 pin from #1687`).not.toBe(
        AFFECTED_DIGEST,
      )
    }
  })

  it('pins the same digest everywhere, so no deploy path lags behind', () => {
    // The Ansible vars and the role template drifted apart before; a PBX
    // deployed from one and verified against the other proves nothing.
    expect(new Set(asteriskPins().map((p) => p.digest)).size).toBe(1)
  })

  it('keeps the Helm chart on an Asterisk 22.10+ tag', () => {
    // Helm carries a tag rather than a digest, and sat on 20.11 — a build that
    // predates the fix — while compose moved on.
    const values = readFileSync(path.join(DEPLOY, 'helm/llamenos/values.yaml'), 'utf8')
    const tag = /repository: andrius\/asterisk[\s\S]*?\n\s*tag: "([^"]+)"/.exec(values)?.[1]
    expect(tag, 'no andrius/asterisk tag found in the Helm values').toBeTruthy()
    const [major, minor] = (tag as string).split('_')[0].split('.').map(Number)
    expect(major, `Helm pins Asterisk ${tag}; #1687 needs >= 22.10.0`).toBeGreaterThanOrEqual(22)
    if (major === 22) {
      expect(minor, `Helm pins Asterisk ${tag}; #1687 needs >= 22.10.0`).toBeGreaterThanOrEqual(10)
    }
  })

  it('states the version floor next to the compose pin', () => {
    // The digest alone carries no reason, and the reason is what stops the next
    // person from "simplifying" this back to an older image or to dtls_verify=no.
    const compose = readFileSync(path.join(DEPLOY, 'docker/docker-compose.yml'), 'utf8')
    expect(compose).toContain('22.10.0')
    expect(compose).toContain('#1687')
  })

  it('does not provision dtls_verify=no anywhere in a deploy config', () => {
    // `no` makes Asterisk never compare the presented certificate to the
    // fingerprint it was given, so an attacker on the media plane no longer has
    // to touch the SDP at all. It is not a workaround for an old image.
    for (const file of deployFiles(DEPLOY)) {
      if (file === __filename) continue
      const assignments = readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => !/^\s*[;#]/.test(l))
        .filter((l) => /dtls_verify\s*[:=]\s*['"]?no['"]?\s*$/.test(l))
      expect(assignments, `${path.relative(DEPLOY, file)} sets dtls_verify=no`).toEqual([])
    }
  })
})
