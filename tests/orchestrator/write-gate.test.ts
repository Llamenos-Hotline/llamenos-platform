import { describe, it, expect } from 'vitest'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { derPrivateKeyKind, findPrivateKeyMaterial, MIN_KEY_BODY_CHARS } from '../../orchestrator/src/key-material.js'
import {
  changedLinesByFile, secretFinding, secretRefusal, trustAnchorApprovers, trustAnchorFinding, trustAnchorRefusal,
  SECRET_REASON_PREFIX, TRUST_ANCHOR_REASON_PREFIX, TRUST_SIGNATURES,
} from '../../orchestrator/src/write-gate.js'
import { NEVER_WRITE_PATHS, TRUST_ANCHOR_FILES } from '../../orchestrator/src/config.js'
import { ISRG_ROOT_X1, ISRG_ROOT_X2, SHOWCERTS_CHAIN, throwawayPrivateKeyPem, throwawayPublicKeyPem } from './pem-fixtures.js'

/**
 * Unit tests for the pure halves of the write gate (#2556): private key
 * recognition (key-material.ts) and classification/rendering (write-gate.ts).
 * The end-to-end proof of the six properties, through `verifyMechanical`
 * against real git objects, is `write-gate-properties.test.ts`.
 *
 * Every private key here is GENERATED at test time — the same rule, for the
 * same reason, as `pem-fixtures.ts`: `gitleaks` is a required check and a
 * committed key literal would trip it whether or not the key was real. Every
 * PuTTY/age "key" is assembled from parts for the same reason.
 */

const bytes = (s: string) => Buffer.from(s, 'latin1')
/** PEM boundaries assembled at runtime, so this file holds no literal that a
 *  secret scanner reads as a key block. */
const PK = ['PRIVATE', 'KEY'].join(' ')
const BEGIN = (label: string) => `-----BEGIN ${label}-----`
const END = (label: string) => `-----END ${label}-----`
const der = (pem: string) => Buffer.from(pem.split('\n').filter((l) => !l.startsWith('-----')).join(''), 'base64')

const ed25519 = () => generateKeyPairSync('ed25519')
const rsa = () => generateKeyPairSync('rsa', { modulusLength: 1024 })
const ec = () => generateKeyPairSync('ec', { namedCurve: 'P-256' })

describe('findPrivateKeyMaterial — recognises every key encoding it claims to', () => {
  it.each<[string, () => string]>([
    ['PKCS#8 PEM (Ed25519)', () => ed25519().privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()],
    ['PKCS#1 "RSA PRIVATE KEY" PEM', () => rsa().privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()],
    ['SEC1 "EC PRIVATE KEY" PEM', () => ec().privateKey.export({ type: 'sec1', format: 'pem' }).toString()],
    ['"ENCRYPTED PRIVATE KEY" PEM', () => ed25519().privateKey.export({
      type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'not-a-secret',
    }).toString()],
    ['an "OPENSSH PRIVATE KEY" block', () =>
      `${BEGIN(`OPENSSH ${PK}`)}\n${randomBytes(300).toString('base64').match(/.{1,70}/g)?.join('\n')}\n` +
      `${END(`OPENSSH ${PK}`)}\n`],
  ])('finds %s', (_name, make) => {
    const found = findPrivateKeyMaterial(bytes(make()))
    expect(found).toBeDefined()
    expect(found?.kind).toMatch(/^a PEM ".*PRIVATE KEY" block$/)
  })

  it.each<[string, () => Buffer, RegExp]>([
    ['a DER PKCS#8 key', () => ed25519().privateKey.export({ type: 'pkcs8', format: 'der' }), /PKCS#8 private key/],
    ['a DER PKCS#1 RSA key', () => rsa().privateKey.export({ type: 'pkcs1', format: 'der' }), /RSA \/ DSA private key/],
    ['a DER SEC1 EC key', () => ec().privateKey.export({ type: 'sec1', format: 'der' }), /SEC1 EC private key/],
    ['a DER encrypted PKCS#8 key', () => ed25519().privateKey.export({
      type: 'pkcs8', format: 'der', cipher: 'aes-256-cbc', passphrase: 'not-a-secret',
    }), /encrypted PKCS#8 private key/],
  ])('finds %s with no PEM armour at all', (_name, make, kind) => {
    expect(findPrivateKeyMaterial(make())?.kind).toMatch(kind)
  })

  it('finds a key pasted into source as a one-line string with \\n escapes', () => {
    const pem = throwawayPrivateKeyPem().trimEnd().split('\n').join('\\n')
    const src = `export const privateKey = '${pem}'\n`
    expect(findPrivateKeyMaterial(bytes(`// a test\n${src}`))).toEqual({ kind: 'a PEM "PRIVATE KEY" block', line: 2 })
  })

  it('finds a key whose END line is missing — a truncated paste is still a key', () => {
    const truncated = throwawayPrivateKeyPem().replace(`${END(PK)}\n`, '')
    expect(truncated).not.toContain(END(PK))
    expect(findPrivateKeyMaterial(bytes(truncated))).toBeDefined()
  })

  it('finds a key appended to an annotated certificate chain', () => {
    expect(findPrivateKeyMaterial(bytes(`${SHOWCERTS_CHAIN}\n${throwawayPrivateKeyPem()}`))?.line).toBeGreaterThan(30)
  })

  it('finds a PuTTY key file and an age secret key', () => {
    const putty = [`PuTTY-User-Key-File-3: ssh-ed25519`, 'Encryption: none', 'Public-Lines: 2', 'AAAA', 'Private-Lines: 1', 'AAAA']
    expect(findPrivateKeyMaterial(bytes(putty.join('\n')))?.kind).toBe('a PuTTY private key file')
    const age = ['AGE', 'SECRET', 'KEY', '1'].join('-') + 'QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L'.repeat(2).slice(0, 58)
    expect(findPrivateKeyMaterial(bytes(`# created: today\n${age}\n`))).toEqual({ kind: 'an age secret key', line: 2 })
  })
})

describe('findPrivateKeyMaterial — and nothing that is not a key', () => {
  it.each<[string, string | Buffer]>([
    ['a certificate', ISRG_ROOT_X1],
    ['a certificate bundle', `${ISRG_ROOT_X1}\n${ISRG_ROOT_X2}`],
    ['an annotated chain', SHOWCERTS_CHAIN],
    ['a PUBLIC KEY block', throwawayPublicKeyPem()],
    ['a DER certificate', der(ISRG_ROOT_X1)],
    ['a DER SubjectPublicKeyInfo', ed25519().publicKey.export({ type: 'spki', format: 'der' })],
    // The tracked repo shapes that a marker-only scan would have refused:
    ['a provider doc naming the boundaries',
      `- **Private key errors**: Paste the full PEM content including the \`${BEGIN(PK)}\` and \`${END(PK)}\` lines.\n`],
    ['a placeholder body', `private_key: '${BEGIN(PK)}\\nfake\\n${END(PK)}\\n',\n`],
    ['a fixture body the gate must not confuse with a key',
      `"apns_key_p8": "${BEGIN(PK)}\\nCHECKREQUIREDENVFIXTUREKEYNOTREAL\\n${END(PK)}\\n",\n`],
    ['a truncated header-only body', `'${BEGIN(PK)}\\nMIIEvAIBADANBgkqhkiG9w0BAQEFAAS=\\n${END(PK)}'\n`],
    ['a template saying where a key goes', `ASC_KEY=${BEGIN(PK)}\n# ... (paste p8 key contents here)\n${END(PK)}\n`],
    ['code that checks for the phrase', 'check(!pem.contains("PRIVATE KEY")) { "refusing it" }\n'],
    ['a file that merely starts with "0" (0x30)', '0\n1\n2\n'],
    ['random bytes', randomBytes(4096)],
  ])('ignores %s', (_name, content) => {
    expect(findPrivateKeyMaterial(typeof content === 'string' ? bytes(content) : content)).toBeUndefined()
  })

  it('needs a key-sized body: one character short of the smallest real key is not one', () => {
    const body = (n: number) => `${BEGIN(PK)}\n${'A'.repeat(n)}\n${END(PK)}\n`
    expect(findPrivateKeyMaterial(bytes(body(MIN_KEY_BODY_CHARS - 1)))).toBeUndefined()
    expect(findPrivateKeyMaterial(bytes(body(MIN_KEY_BODY_CHARS)))).toBeDefined()
    // ...and the smallest real key, an Ed25519 PKCS#8, sits exactly at it.
    const smallest = throwawayPrivateKeyPem().split('\n').filter((l) => l.length > 0 && !l.startsWith('-----')).join('')
    expect(smallest.length).toBe(MIN_KEY_BODY_CHARS)
  })

  it('does not credit a neighbouring certificate\'s body to an empty key boundary', () => {
    expect(findPrivateKeyMaterial(bytes(`${BEGIN(PK)}\n${ISRG_ROOT_X1}`))).toBeUndefined()
  })
})

describe('derPrivateKeyKind', () => {
  it('refuses anything whose outer SEQUENCE does not span the whole input', () => {
    const key = ed25519().privateKey.export({ type: 'pkcs8', format: 'der' })
    expect(derPrivateKeyKind(key)).toBe('PKCS#8 private key')
    expect(derPrivateKeyKind(Buffer.concat([key, Buffer.from([0])]))).toBeUndefined()
    expect(derPrivateKeyKind(key.subarray(0, key.length - 1))).toBeUndefined()
  })
})

describe('secretFinding', () => {
  it('names the path half for a pattern match', () => {
    expect(secretFinding('deploy/docker/.env', NEVER_WRITE_PATHS)).toBe('its path matches secret pattern ".env"')
  })

  it('names the parse failure for a *.pem the content could not vouch for', () => {
    expect(secretFinding('certs/x.pem', NEVER_WRITE_PATHS, `${ISRG_ROOT_X1}\nSession-ID: ${'ab'.repeat(32)}\n`))
      .toMatch(/^its path matches secret pattern "\*\.pem" and its content is not provably public certificate material: line \d+, outside any PEM block, carries a 64-character/)
  })

  it('says so when a *.pem has no content to read', () => {
    expect(secretFinding('certs/x.pem', NEVER_WRITE_PATHS)).toMatch(/no content to show it is a public certificate/)
  })

  it('admits a public certificate chain', () => {
    expect(secretFinding('certs/le-chain.pem', NEVER_WRITE_PATHS, SHOWCERTS_CHAIN)).toBeUndefined()
  })

  it('finds a key under ANY name, and inside a committed template', () => {
    const key = throwawayPrivateKeyPem()
    expect(secretFinding('tests/fixtures/key.ts', NEVER_WRITE_PATHS, key)).toBe('its content holds a PEM "PRIVATE KEY" block (line 1)')
    expect(secretFinding('deploy/docker/.env.example', NEVER_WRITE_PATHS, `X=1\n${key}`)).toMatch(/content holds a PEM/)
    expect(secretFinding('deploy/docker/.env.example', NEVER_WRITE_PATHS, 'X=change-me\n')).toBeUndefined()
  })
})

describe('trustAnchorFinding', () => {
  it('names what a registered file anchors, whatever its diff', () => {
    for (const a of TRUST_ANCHOR_FILES) expect(trustAnchorFinding(a.path)).toBe(`it is ${a.anchors}`)
  })

  it('catches a signature line changed in an unregistered shipped file, and quotes it', () => {
    const f = 'apps/android/app/src/main/java/org/llamenos/hotline/api/NewClient.kt'
    expect(trustAnchorFinding(f, ['    .certificatePinner(pinner)'])).toBe(
      'its diff changes an OkHttp/JSSE trust hook in shipped client source: `.certificatePinner(pinner)`',
    )
    expect(trustAnchorFinding(f, ['val x = 1'])).toBeUndefined()
  })

  it('ignores the same line outside shipped client source', () => {
    for (const f of [
      'apps/android/app/src/test/java/org/llamenos/hotline/api/CertificatePinnerTest.kt',
      'apps/android/app/src/debug/res/xml/network_security_config.xml',
      'apps/ios/Tests/Unit/CertificatePinningTests.swift',
      'scripts/inject-cert-pins.ts',
    ]) expect(trustAnchorFinding(f, ['CertificatePinner.Builder()', '<pin-set>'])).toBeUndefined()
  })

  it.each(TRUST_SIGNATURES.map((s) => [s.name, s] as const))('signature %s matches a line of its own kind', (_n, s) => {
    const sample: Record<string, string> = {
      'an SPKI pin literal (sha256/…)': `"sha256/${'C'.repeat(43)}="`,
      'an Android network-security trust element': '<pin-set expiration="2027-01-01">',
      'an OkHttp/JSSE trust hook': 'object : X509TrustManager {',
      'an Apple Security trust API': 'SecTrustEvaluateWithError(trust, nil)',
      'a rustls/reqwest trust hook': 'impl ServerCertVerifier for Pinned {',
      'a SIP TLS trust anchor': 'applyTlsTrustAnchor(core, sip)',
    }
    expect(sample[s.name], `no sample line for signature "${s.name}"`).toBeDefined()
    expect(s.re.test(sample[s.name] as string)).toBe(true)
  })
})

describe('changedLinesByFile', () => {
  it('attributes added and removed lines, and never reads hunk content as a header', () => {
    const diff = [
      'diff --git a/a.kt b/a.kt', 'index 1..2 100644', '--- a/a.kt', '+++ b/a.kt', '@@ -1,2 +1,2 @@',
      ' keep', '-old pin', '+new pin', '--- looks like a header but is a removed line', '+++ and an added one',
      'diff --git a/gone.rs b/gone.rs', 'deleted file mode 100644', '--- a/gone.rs', '+++ /dev/null', '@@ -1 +0,0 @@',
      '-cert_pin::verify()',
      'diff --git "a/caf\\303\\251.swift" "b/caf\\303\\251.swift"', '--- "a/caf\\303\\251.swift"', '+++ "b/caf\\303\\251.swift"',
      '@@ -0,0 +1 @@', '+serverTrust',
    ].join('\n')
    const m = changedLinesByFile(diff)
    expect(m.get('a.kt')).toEqual(['old pin', 'new pin', '-- looks like a header but is a removed line', '++ and an added one'])
    expect(m.get('gone.rs')).toEqual(['cert_pin::verify()'])
    expect(m.get('café.swift')).toEqual(['serverTrust'])
  })
})

describe('trustAnchorApprovers', () => {
  const SHA = 'a'.repeat(40)
  const r = (login: string, state: string, commitId = SHA) => ({ login, state, commitId })

  it('counts an approver\'s approval of exactly this commit', () => {
    expect(trustAnchorApprovers({ reviews: [r('rhonda-rodododo', 'APPROVED')], author: 'llamenos-auto', approvedSha: SHA }))
      .toEqual(['rhonda-rodododo'])
  })

  it.each<[string, ReturnType<typeof r>[], string | undefined]>([
    ['an approval of an earlier head', [r('rhonda-rodododo', 'APPROVED', 'b'.repeat(40))], 'llamenos-auto'],
    ['an approval later withdrawn by a change request', [r('rhonda-rodododo', 'APPROVED'), r('rhonda-rodododo', 'CHANGES_REQUESTED')], undefined],
    ['an approval later dismissed', [r('rhonda-rodododo', 'APPROVED'), r('rhonda-rodododo', 'DISMISSED')], undefined],
    ['the fleet\'s own reviewer identity', [r('llamenos-auto', 'APPROVED')], 'someone'],
    ['a bot', [r('dependabot[bot]', 'APPROVED')], 'someone'],
    ['the PR author approving themself', [r('rhonda-rodododo', 'APPROVED')], 'rhonda-rodododo'],
    ['a plain comment', [r('rhonda-rodododo', 'COMMENTED')], undefined],
  ])('does not count %s', (_name, reviews, author) => {
    expect(trustAnchorApprovers({ reviews, author, approvedSha: SHA })).toEqual([])
  })

  it('does not let a later plain comment withdraw an approval — GitHub does not either', () => {
    expect(trustAnchorApprovers({
      reviews: [r('rhonda-rodododo', 'APPROVED'), r('rhonda-rodododo', 'COMMENTED')], author: undefined, approvedSha: SHA,
    })).toEqual(['rhonda-rodododo'])
  })
})

describe('the refusal text names its class', () => {
  it('a secret refusal starts with its prefix and only mentions key generation when a key was found', () => {
    const path = secretRefusal([{ file: '.env', why: 'its path matches secret pattern ".env"' }])
    expect(path.startsWith(`${SECRET_REASON_PREFIX} — secret material`)).toBe(true)
    expect(path).not.toMatch(/test key/)
    expect(secretRefusal([{ file: 'k.ts', why: 'its content holds a PEM "PRIVATE KEY" block (line 1)' }])).toMatch(/test key must be generated/)
  })

  it('a trust-anchor refusal says whose approval of which commit is missing — and when it could not ask', () => {
    const f = [{ file: 'apps/desktop/src/cert_pin.rs', why: 'it is the desktop pin capture' }]
    const none = trustAnchorRefusal(f, 'abc123', [])
    expect(none.startsWith(`${TRUST_ANCHOR_REASON_PREFIX} — a shipped client's TLS trust decision`)).toBe(true)
    expect(none).toContain('No APPROVED review from a trust-anchor approver (rhonda-rodododo) is on abc123')
    expect(trustAnchorRefusal(f, 'abc123', undefined)).toContain('reviews could not be read')
  })
})
