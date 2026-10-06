/**
 * The SIP edge's TLS certificate and key paths are configurable, which is only
 * true if every link in the chain is actually connected. Two real defects on
 * this exact path were silent in precisely this way:
 *
 *   * `kamailio_tls_cert_path` / `kamailio_tls_key_path` existed in the
 *     Ansible role's defaults and were referenced by NOTHING — tls.cfg.j2
 *     carried literal paths, so setting either variable did nothing at all.
 *   * the Ansible compose template mounted no TLS directory, so the
 *     certificate was generated on the host and the container could not see
 *     it — the TLS listener could never bind.
 *
 * Neither is visible to a unit test of any single file, and neither shows up
 * until a deploy. So these assert the wiring: a declared path variable must be
 * referenced, a template placeholder must be substituted, and no config may
 * reintroduce a literal certificate path.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const DOCKER = path.resolve(__dirname, '../..')
const ANSIBLE = path.resolve(__dirname, '../../../ansible')
const read = (p: string) => readFileSync(p, 'utf8')

/** Certificate paths that used to be hardcoded. None may reappear in a config. */
const FORMERLY_HARDCODED = ['/etc/kamailio/cert.pem', '/var/lib/asterisk/keys/asterisk.pem']

describe('Kamailio: the configured cert and key reach tls.cfg', () => {
  const template = read(path.join(DOCKER, 'kamailio/tls.cfg.template'))
  const entrypoint = read(path.join(DOCKER, 'kamailio/kamailio-entrypoint.sh'))

  it('declares cert and key as two separate placeholders', () => {
    // One combined path cannot name an ACME keypair, which is two files.
    expect(template).toMatch(/^certificate = @KAMAILIO_TLS_CERT_FILE@$/m)
    expect(template).toMatch(/^private_key = @KAMAILIO_TLS_KEY_FILE@$/m)
  })

  it('carries no literal certificate path', () => {
    for (const literal of FORMERLY_HARDCODED) {
      // A comment may mention the default; an assignment may not.
      const assignments = template
        .split('\n')
        .filter((l) => !l.trimStart().startsWith('#'))
        .filter((l) => l.includes(literal))
      expect(assignments, `${literal} is assigned literally in tls.cfg.template`).toEqual([])
    }
  })

  it('substitutes every placeholder the template declares', () => {
    const declared = [...template.matchAll(/@([A-Z0-9_]+)@/g)].map((m) => m[1])
    expect(declared.length).toBeGreaterThan(0)
    for (const name of new Set(declared)) {
      // The entrypoint's sed must have a rule for it, or the rendered tls.cfg
      // keeps a literal `@NAME@` and Kamailio fails to find the file.
      expect(entrypoint, `no sed rule substitutes @${name}@`).toContain(`@${name}@`)
    }
  })

  it('defaults both paths to the previous hardcoded behaviour', () => {
    // Unset => byte-identical behaviour to before they were configurable.
    expect(entrypoint).toContain('${KAMAILIO_TLS_CERT_FILE:-/etc/kamailio/cert.pem}')
    // The key defaults to the certificate: one combined self-signed PEM.
    expect(entrypoint).toContain('${KAMAILIO_TLS_KEY_FILE:-$cert_file}')
  })

  it('renders to the path kamailio.cfg actually reads', () => {
    const cfg = read(path.join(DOCKER, 'kamailio/kamailio.cfg'))
    const configured = cfg.match(/modparam\("tls",\s*"config",\s*"([^"]+)"\)/)
    expect(configured).not.toBeNull()
    expect(entrypoint).toContain(`rendered=${configured![1]}`)
  })
})

describe('Asterisk: the configured cert and key reach the transports', () => {
  const pjsip = read(path.join(DOCKER, 'asterisk-config/pjsip.conf'))
  const entrypoint = read(path.join(DOCKER, 'asterisk-entrypoint.sh'))

  it('sets no literal cert_file / priv_key_file in pjsip.conf', () => {
    // /etc/asterisk is a read-only mount, so a literal here is unoverridable.
    const assignments = pjsip
      .split('\n')
      .filter((l) => !l.trimStart().startsWith(';'))
      .filter((l) => /^\s*(cert_file|priv_key_file|ca_list_file)\s*=/.test(l))
    expect(assignments).toEqual([])
  })

  it('generates a fragment that sets them for both TLS transports', () => {
    expect(entrypoint).toContain('tls.conf')
    expect(entrypoint).toContain('cert_file = ${tls_cert_file}')
    expect(entrypoint).toContain('priv_key_file = ${tls_key_file}')
    for (const transport of ['transport-tls', 'transport-wss']) {
      expect(entrypoint).toContain(transport)
    }
  })

  it('writes the fragment into a directory pjsip.conf includes', () => {
    const includes = [...pjsip.matchAll(/^#include\s+"([^"]+)"/gm)].map((m) => m[1])
    const fragDir = entrypoint.match(/pjsip_frag_dir=(\S+)/)
    expect(fragDir).not.toBeNull()
    // An un-included fragment is inert, and the transports would have no key
    // material at all now that pjsip.conf carries none.
    expect(includes.some((i) => i.startsWith(fragDir![1]))).toBe(true)
  })

  it('defaults both paths to the previous hardcoded behaviour', () => {
    expect(entrypoint).toContain('${ASTERISK_TLS_CERT_FILE:-$keys_dir/asterisk.pem}')
    expect(entrypoint).toContain('${ASTERISK_TLS_KEY_FILE:-$tls_cert_file}')
  })

  it('names ca_list_file only when that file actually exists', () => {
    // Measured in the pinned image: it ships no openssl, and generation is
    // skipped whenever a certificate is already mounted — so ca-list.pem was
    // never built and the fragment pointed the transport at a path that did
    // not exist. ca_list_file exists purely to stop pjproject complaining
    // about CA material; naming a missing file is worse than naming none.
    expect(entrypoint).toMatch(/\[ -s "\$ca_list_file" \][\s\S]{0,120}ca_list_file =/)
  })
})

describe('Ansible: every declared TLS path variable is referenced', () => {
  const defaults = read(path.join(ANSIBLE, 'roles/kamailio/defaults/main.yml'))
  // Every file in the role, not a hand-listed set: a variable referenced only
  // from a file this test forgot to list would read as unreferenced, and a
  // file added later would silently escape the check.
  //
  // defaults/main.yml is EXCLUDED. It holds the declarations, so including it
  // makes every variable look referenced by its own definition line — which it
  // did, and this check then passed with a deliberately unreferenced variable
  // added. The whole point is to find variables used nowhere ELSE.
  const DECLARING_FILE = path.join(ANSIBLE, 'roles/kamailio/defaults/main.yml')
  const role = readdirSync(path.join(ANSIBLE, 'roles/kamailio'), { recursive: true })
    .map((f) => path.join(ANSIBLE, 'roles/kamailio', String(f)))
    .filter((f) => statSync(f).isFile() && f !== DECLARING_FILE)
    .map(read)
    .join('\n')

  it('references each kamailio_tls_* variable somewhere in the role', () => {
    // The defect: a variable an operator can set that changes nothing.
    const declared = [...defaults.matchAll(/^(kamailio_tls_[a-z0-9_]+):/gm)].map((m) => m[1])
    expect(declared.length).toBeGreaterThan(0)
    const unreferenced = declared.filter((v) => !role.includes(v))
    expect(unreferenced, 'declared but never used — setting these does nothing').toEqual([])
  })

  it('wires cert and key as two separate variables into tls.cfg', () => {
    const tlsCfg = read(path.join(ANSIBLE, 'roles/kamailio/templates/tls.cfg.j2'))
    expect(tlsCfg).toMatch(/^certificate = \{\{ kamailio_tls_cert_file \}\}$/m)
    expect(tlsCfg).toMatch(/^private_key = \{\{ kamailio_tls_key_file \}\}$/m)
  })

  it('mounts the directory holding the material tls.cfg names', () => {
    // Without this the certificate exists on the host and nowhere else, and
    // the TLS listener silently never binds.
    const compose = read(path.join(ANSIBLE, 'roles/kamailio/templates/compose/kamailio.j2'))
    expect(compose).toContain('kamailio_tls_container_dir')
    expect(compose).toMatch(/kamailio_tls_cert_source_dir \| default\(kamailio_tls_dir\)/)
    // Read-only: an externally-managed certificate is not ours to write to.
    expect(compose).toMatch(/kamailio_tls_container_dir \}\}:ro/)
  })

  it('keeps server-certificate verification on for the client role', () => {
    // verify_certificate=no belongs only to [server:default], where it governs
    // CLIENT certificates (volunteers authenticate with a digest secret).
    // [client:default] verifies the certificates it is presented, and that must
    // never be switched off to make anything work.
    const tlsCfg = read(path.join(ANSIBLE, 'roles/kamailio/templates/tls.cfg.j2'))
    const clientBlock = tlsCfg.slice(tlsCfg.indexOf('[client:default]'))
    expect(clientBlock).toMatch(/^verify_certificate = yes$/m)
  })
})

describe('Compose: the configurable paths and the read-only mount are passed through', () => {
  const prod = read(path.join(DOCKER, 'docker-compose.yml'))
  const dev = read(path.join(DOCKER, 'docker-compose.dev.yml'))

  it('passes the Kamailio cert and key through in the prod stack', () => {
    expect(prod).toContain('KAMAILIO_TLS_CERT_FILE=${KAMAILIO_TLS_CERT_FILE:-}')
    expect(prod).toContain('KAMAILIO_TLS_KEY_FILE=${KAMAILIO_TLS_KEY_FILE:-}')
  })

  it('passes the Asterisk cert and key through in both stacks', () => {
    for (const [name, file] of [['prod', prod], ['dev', dev]] as const) {
      expect(file, name).toContain('ASTERISK_TLS_CERT_FILE=${ASTERISK_TLS_CERT_FILE:-}')
      expect(file, name).toContain('ASTERISK_TLS_KEY_FILE=${ASTERISK_TLS_KEY_FILE:-}')
    }
  })

  it('mounts an externally-managed certificate READ-ONLY', () => {
    // A writable mount of ACME storage would let a compromised PBX container
    // rewrite the certificate the web listener serves.
    const mounts = [...prod.matchAll(/\$\{SIP_TLS_CERT_DIR:-[^}]+\}:(\S+)/g)].map((m) => m[1])
    expect(mounts.length).toBeGreaterThan(0)
    for (const target of mounts) {
      expect(target, 'SIP_TLS_CERT_DIR must be mounted :ro').toMatch(/:ro$/)
    }
  })

  it('mounts the tls.cfg TEMPLATE, not a prebuilt tls.cfg', () => {
    // A mounted tls.cfg would be read-only and unrenderable, which is what
    // made the paths unconfigurable in the first place.
    expect(prod).toContain('kamailio/tls.cfg.template')
    expect(prod).not.toMatch(/\.\/kamailio\/tls\.cfg:/)
  })
})
