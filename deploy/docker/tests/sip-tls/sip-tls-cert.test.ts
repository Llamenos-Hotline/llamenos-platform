/**
 * Behavioural tests for deploy/docker/sip-tls-cert.sh — the script both SIP
 * entrypoints use to put TLS material in place and publish the trust anchor.
 *
 * These run the real script with /bin/sh against a temp directory. There is no
 * container and no SIP daemon: what is asserted is the script's contract with
 * the two entrypoints, which is where the configurable cert/key paths live.
 *
 * Never asserts on private key CONTENT — only that a key file exists, or that
 * a published anchor does not contain one.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const SCRIPT = path.resolve(__dirname, '../../sip-tls-cert.sh')
const hasOpenssl = spawnSync('openssl', ['version']).status === 0

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'sip-tls-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Run sip-tls-cert.sh <cert> <key> <anchor>, returning its stderr log. */
function run(
  args: { cert: string; key?: string; anchor?: string },
  env: Record<string, string> = {},
): { stderr: string; status: number } {
  const key = args.key ?? args.cert
  const anchor = args.anchor ?? path.join(dir, 'anchor', 'edge.pem')
  const res = spawnSync('/bin/sh', [SCRIPT, args.cert, key, anchor], {
    env: { ...process.env, SIP_TLS_SANS: 'sip.example.org', ...env },
    encoding: 'utf8',
  })
  return { stderr: res.stderr ?? '', status: res.status ?? -1 }
}

/** A throwaway self-signed cert+key, written as two files. */
function makeCertAndKey(certPath: string, keyPath: string, cn = 'preexisting.example.org') {
  mkdirSync(path.dirname(certPath), { recursive: true })
  mkdirSync(path.dirname(keyPath), { recursive: true })
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath,
    '-days', '2', '-subj', `/CN=${cn}`,
    '-addext', `subjectAltName=DNS:${cn}`,
  ], { stdio: 'ignore' })
}

function subjectOf(certPath: string): string {
  return execFileSync('openssl', ['x509', '-in', certPath, '-noout', '-subject'], {
    encoding: 'utf8',
  })
}

describe.skipIf(!hasOpenssl)('sip-tls-cert.sh — configurable cert and key paths', () => {
  it('honours a configured cert path that differs from the historical default', () => {
    // The whole point of the change: the daemon's certificate no longer has to
    // live at one hardcoded location.
    const cert = path.join(dir, 'custom', 'nested', 'edge.pem')
    const { status } = run({ cert })

    expect(status).toBe(0)
    expect(existsSync(cert)).toBe(true)
    expect(readFileSync(cert, 'utf8')).toContain('-----BEGIN CERTIFICATE-----')
  })

  it('writes cert and key to SEPARATE files when given two paths', () => {
    // Let's Encrypt is always two files; a script that can only emit a
    // combined PEM cannot be pointed at one.
    const cert = path.join(dir, 'split', 'fullchain.pem')
    const key = path.join(dir, 'split', 'privkey.pem')
    const { status } = run({ cert, key })

    expect(status).toBe(0)
    expect(readFileSync(cert, 'utf8')).toContain('-----BEGIN CERTIFICATE-----')
    // The certificate file must NOT carry the key when the two are split.
    expect(readFileSync(cert, 'utf8')).not.toContain('PRIVATE KEY')
    expect(existsSync(key)).toBe(true)
    expect(statSync(key).size).toBeGreaterThan(0)
  })

  it('writes one combined PEM when cert and key name the same file', () => {
    // The self-signed default, unchanged: one file holding both halves.
    const combined = path.join(dir, 'combined.pem')
    const { status } = run({ cert: combined, key: combined })

    expect(status).toBe(0)
    const pem = readFileSync(combined, 'utf8')
    expect(pem).toContain('-----BEGIN CERTIFICATE-----')
    expect(pem).toContain('PRIVATE KEY')
  })

  it('covers SIP_TLS_SANS on the generated certificate', () => {
    const cert = path.join(dir, 'san.pem')
    run({ cert }, { SIP_TLS_SANS: 'sip.example.org,10.0.2.2' })

    const text = execFileSync('openssl', ['x509', '-in', cert, '-noout', '-ext', 'subjectAltName'], {
      encoding: 'utf8',
    })
    expect(text).toContain('DNS:sip.example.org')
    expect(text).toContain('IP Address:10.0.2.2')
    // Always added, so in-container probes work.
    expect(text).toContain('IP Address:127.0.0.1')
  })
})

describe.skipIf(!hasOpenssl)('sip-tls-cert.sh — generation is skipped when a certificate exists', () => {
  it('leaves a pre-existing certificate and key untouched', () => {
    // A mounted real certificate (ACME or otherwise) must survive. Before the
    // cert/key split this was asserted nowhere, and the script regenerated
    // only when the single path was absent.
    const cert = path.join(dir, 'mounted', 'fullchain.pem')
    const key = path.join(dir, 'mounted', 'privkey.pem')
    makeCertAndKey(cert, key, 'mounted.example.org')
    const certBefore = readFileSync(cert, 'utf8')
    const keyMtimeBefore = statSync(key).mtimeMs

    const { stderr, status } = run({ cert, key })

    expect(status).toBe(0)
    expect(readFileSync(cert, 'utf8')).toBe(certBefore)
    expect(statSync(key).mtimeMs).toBe(keyMtimeBefore)
    expect(subjectOf(cert)).toContain('mounted.example.org')
    expect(stderr).toContain('certificate already present')
    // It must NOT have claimed to generate one.
    expect(stderr).not.toContain('generating a self-signed')
  })

  it('does not chmod or chown a certificate it did not generate', () => {
    // This is the read-only-mount case. The previous version chmod-ed the
    // keypair unconditionally; on a `:ro` bind that returns EROFS and, under
    // `set -e`, killed the entrypoint before the daemon ever started — so the
    // documented "mount a real certificate" path could not work at all.
    const cert = path.join(dir, 'ro', 'fullchain.pem')
    const key = path.join(dir, 'ro', 'privkey.pem')
    makeCertAndKey(cert, key)
    // 0644 is what an exported ACME chain commonly has; 600 is what the script
    // used to force. If it still forced it, this would come back 0600.
    execFileSync('chmod', ['644', cert])
    const modeBefore = statSync(cert).mode

    const { status } = run({ cert, key })

    expect(status).toBe(0)
    expect(statSync(cert).mode).toBe(modeBefore)
  })

  it('still succeeds when the certificate directory itself is read-only', () => {
    // The closest in-process stand-in for a `:ro` bind mount: the script must
    // not attempt any write inside it.
    const roDir = path.join(dir, 'readonly')
    const cert = path.join(roDir, 'fullchain.pem')
    const key = path.join(roDir, 'privkey.pem')
    makeCertAndKey(cert, key)
    execFileSync('chmod', ['500', roDir])
    try {
      const { status, stderr } = run({ cert, key })
      expect(status).toBe(0)
      expect(stderr).toContain('certificate already present')
    } finally {
      execFileSync('chmod', ['700', roDir])
    }
  })

  it('warns, without failing, when a cert is present but its key is missing', () => {
    // Worth naming: the handshake would otherwise fail with nothing saying why.
    const cert = path.join(dir, 'half', 'fullchain.pem')
    const key = path.join(dir, 'half', 'privkey.pem')
    makeCertAndKey(cert, path.join(dir, 'half', 'elsewhere.key'))

    const { status, stderr } = run({ cert, key })

    expect(status).toBe(0)
    expect(stderr).toContain('key')
    expect(stderr).toMatch(/missing or empty/)
  })
})

describe.skipIf(!hasOpenssl)('sip-tls-cert.sh — the published anchor never carries key material', () => {
  it('publishes the certificate only, from a combined PEM', () => {
    const combined = path.join(dir, 'combined.pem')
    const anchor = path.join(dir, 'out', 'edge.pem')
    run({ cert: combined, key: combined, anchor })

    const published = readFileSync(anchor, 'utf8')
    expect(published).toContain('-----BEGIN CERTIFICATE-----')
    expect(published).not.toContain('PRIVATE KEY')
  })

  it('publishes only the LEAF from a multi-certificate fullchain', () => {
    // An ACME fullchain holds the leaf plus intermediates. Publishing the whole
    // file would pin intermediates that rotate.
    const cert = path.join(dir, 'chain', 'fullchain.pem')
    const key = path.join(dir, 'chain', 'privkey.pem')
    const leafOnly = path.join(dir, 'chain', 'leaf.pem')
    makeCertAndKey(leafOnly, key, 'leaf.example.org')
    const second = path.join(dir, 'chain', 'second.pem')
    makeCertAndKey(second, path.join(dir, 'chain', 'second.key'), 'intermediate.example.org')
    mkdirSync(path.dirname(cert), { recursive: true })
    writeFileSync(cert, readFileSync(leafOnly, 'utf8') + readFileSync(second, 'utf8'))

    const anchor = path.join(dir, 'out', 'edge.pem')
    run({ cert, key, anchor })

    const published = readFileSync(anchor, 'utf8')
    expect(published.match(/-----BEGIN CERTIFICATE-----/g)).toHaveLength(1)
    expect(published).not.toContain('PRIVATE KEY')
    expect(subjectOf(anchor)).toContain('leaf.example.org')
  })

  it('exports SIP_TLS_ANCHOR_SOURCE verbatim when set', () => {
    // A real certificate's issuing ROOT, so clients survive renewals.
    const cert = path.join(dir, 'edge.pem')
    const rootCert = path.join(dir, 'root', 'ca.pem')
    makeCertAndKey(rootCert, path.join(dir, 'root', 'ca.key'), 'issuing-root.example.org')
    const anchor = path.join(dir, 'out', 'edge.pem')

    run({ cert, anchor }, { SIP_TLS_ANCHOR_SOURCE: rootCert })

    expect(subjectOf(anchor)).toContain('issuing-root.example.org')
    expect(readFileSync(anchor, 'utf8')).not.toContain('PRIVATE KEY')
  })
})
