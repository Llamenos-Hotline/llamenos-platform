import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import { verifyMechanical, type VerifyReport } from '../../orchestrator/src/verify.js'
import { checkScope } from '../../orchestrator/src/scope.js'
import {
  NEVER_WRITE_PATHS, SECRET_PATH_PATTERNS, TRUST_ANCHOR_APPROVERS, TRUST_ANCHOR_FILES, type Lane,
} from '../../orchestrator/src/config.js'
import { classifyImpact, tierFor } from '../../orchestrator/src/impact.js'
import { buildBrief, renderBrief, writeGateRules } from '../../orchestrator/src/brief.js'
import { buildGateTrace } from '../../orchestrator/src/trace.js'
import { REVIEW_REQUEST_LOGIN } from '../../orchestrator/src/ci.js'
import {
  SECRET_REASON_PREFIX, TRUST_ANCHOR_REASON_PREFIX, isShippedClientSource, trustAnchorEntry, trustProjection,
} from '../../orchestrator/src/write-gate.js'
import { ISRG_ROOT_X1, ISRG_ROOT_X2, SHOWCERTS_CHAIN, throwawayPrivateKeyPem } from './pem-fixtures.js'
import { trackedFiles } from './codeowners.js'

/**
 * #2556 — the six properties the write gate must have, each proven by
 * BREAKING it: inject the thing the property forbids, and watch the gate
 * refuse. A green gate is not evidence until it has been shown to go red on
 * purpose.
 *
 * Everything below goes through `verifyMechanical` against REAL git objects,
 * in the CI arrangement: a repo whose head commit carries the change, parked
 * on its base, so every byte the gate judges is read from the head as an
 * object — never from a checkout. That is the same function `fleet/verify`,
 * `fleet/review` and the fleet's own loop call.
 *
 * Properties 1–3 were demonstrated FAILING against the pre-fix gate (main at
 * 797d4df34): the private key in a `.ts` file and in a `.der` were accepted,
 * the annotated public chain was refused with exactly #2550's
 * "touched never-write paths: …le-chain.pem", and an unapproved edit to each
 * of the six trust-anchor files passed. The PR body records that run.
 */

const repos: string[] = []
afterEach(() => { for (const d of repos.splice(0)) rmSync(d, { recursive: true, force: true }) })

const git = (dir: string, ...args: string[]): string => execFileSync('git', args, { cwd: dir }).toString().trim()

const UNRESTRICTED: Lane = {
  id: '(no lane — not a fleet branch)', mode: 'off', cap: 0, engine: 'claude', requireLabel: '', vetoLabels: [],
  scope: { owned: [], notOwned: [] },
}

type Files = Record<string, string | Buffer | null>

/** A repo with `base` committed, then `head` applied (`null` deletes, an
 *  `{ from, to }` rename moves) — left parked on the base. */
function judged(base: Files, head: Files, renames: Array<[string, string]> = []): { dir: string; base: string; head: string } {
  const dir = mkdtempSync(join(tmpdir(), 'llamenos-write-gate-'))
  repos.push(dir)
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
  const put = (files: Files) => {
    for (const [p, c] of Object.entries(files)) {
      if (c === null) { git(dir, 'rm', '-q', p); continue }
      mkdirSync(dirname(join(dir, p)), { recursive: true })
      writeFileSync(join(dir, p), c)
    }
  }
  put({ 'README.md': 'base\n', ...base })
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'base')
  const b = git(dir, 'rev-parse', 'HEAD')
  put(head)
  for (const [from, to] of renames) {
    mkdirSync(dirname(join(dir, to)), { recursive: true })
    git(dir, 'mv', from, to)
  }
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'head')
  const h = git(dir, 'rev-parse', 'HEAD')
  git(dir, 'checkout', '-q', '--detach', b)
  return { dir, base: b, head: h }
}

function gate(
  r: { dir: string; base: string; head: string },
  trustAnchorApprovals?: () => Promise<readonly string[] | undefined>,
): Promise<VerifyReport> {
  return verifyMechanical({
    worktree: r.dir, base: r.base, branch: r.head, lane: UNRESTRICTED, skipTests: true, trustAnchorApprovals,
  })
}

const secretLine = (rep: VerifyReport) => rep.reasons.find((l) => l.startsWith(SECRET_REASON_PREFIX))
const trustLine = (rep: VerifyReport) => rep.reasons.find((l) => l.startsWith(TRUST_ANCHOR_REASON_PREFIX))

const OPERATOR = TRUST_ANCHOR_APPROVERS[0] as string
const approvedBy = (...logins: string[]) => async () => logins

/** The secret patterns as they stood BEFORE #2556, pinned as a literal — so
 *  a regression that narrows the live list cannot also narrow this check. */
const PRE_2556_SECRET_PATTERNS = [
  '.env', '.dev.vars', 'keystore.properties', '*.pem', 'id_rsa', 'id_ed25519', '*.jks', '*.keystore', '*.p8',
  '*.p12', '*.pfx', '*.key', '*.mobileprovision', '.npmrc', '.pgpass', 'authorized_keys',
] as const

/** A concrete file name for each pattern (`*` → a plausible stem). */
const nameFor = (pattern: string) => pattern.replaceAll('*', 'release')

// ---------------------------------------------------------------------------
describe('property 1 — a file holding a private key is never agent-writable', () => {
  describe('no pre-#2556 secret pattern regressed', () => {
    it('every pre-#2556 pattern is still in the live never-write list', () => {
      for (const p of PRE_2556_SECRET_PATTERNS) expect(NEVER_WRITE_PATHS, `${p} was dropped`).toContain(p)
    })

    // At the root, nested, and under the two directories #2556 names, through
    // the real list. `*.pem` has no content here, so it is refused exactly as
    // it was before — the certificate carve-out needs bytes to prove itself.
    it.each(PRE_2556_SECRET_PATTERNS.map((p) => [p]))('%s is still refused at every depth, tests/ and testdata/ included', (p) => {
      const name = nameFor(p)
      const paths = [name, `deploy/docker/${name}`, `tests/fixtures/${name}`, `apps/desktop/testdata/${name}`]
      expect(checkScope(paths, UNRESTRICTED.scope, NEVER_WRITE_PATHS).forbidden).toEqual(paths)
    })

    it('a genuine secret file is still refused end to end, with its pattern named', async () => {
      const rep = await gate(judged({}, { 'deploy/docker/.env.production': 'PG_PASSWORD=hunter2\n' }))
      expect(rep.passed).toBe(false)
      expect(secretLine(rep)).toContain('deploy/docker/.env.production (its path matches secret pattern ".env")')
    })
  })

  describe('the real Ansible deployment inputs are now covered — the tracked templates stay writable', () => {
    // `deploy/ansible/vars.yml` itself is a TRACKED PLACEHOLDER template
    // (deploy/ansible/.gitignore says so) that the infra lane edits; no
    // pattern covered it before #2556 and none should. The real values live
    // in the gitignored files below, which no pattern covered either.
    // Path-only: this test never reads any deploy file.
    const REAL = [
      'deploy/ansible/vars-production.yml', 'deploy/ansible/vars-staging.yml',
      'deploy/ansible/inventory-production.yml', 'deploy/ansible/inventory-staging.yml',
      'deploy/ansible/vars-production.yml.orig', 'deploy/ansible/.roundtrip-inventory.yml',
      'deploy/ansible/.vault-pass', 'deploy/ansible/prod.vault-pass',
    ]
    const TEMPLATES = [
      'deploy/ansible/vars.yml', 'deploy/ansible/vars.example.yml', 'deploy/ansible/vars-production.example.yml',
      'deploy/ansible/inventory.yml', 'deploy/ansible/inventory-production.example.yml',
    ]
    it('refuses every real deployment input', () => {
      expect(checkScope(REAL, UNRESTRICTED.scope, NEVER_WRITE_PATHS).forbidden).toEqual(REAL)
    })
    it('leaves every tracked template writable', () => {
      for (const t of TEMPLATES) expect(trackedFiles(), `${t} is not tracked`).toContain(t)
      expect(checkScope(TEMPLATES, UNRESTRICTED.scope, NEVER_WRITE_PATHS).forbidden).toEqual([])
    })
  })

  describe('a key is refused wherever it sits and whatever it is named — by its bytes', () => {
    it.each<[string, () => string | Buffer]>([
      ['pasted into a TypeScript test', () => `export const KEY = \`${throwawayPrivateKeyPem()}\`\n`],
      ['as a one-line string with \\n escapes', () => `const k = '${throwawayPrivateKeyPem().trimEnd().split('\n').join('\\n')}'\n`],
      ['in a .txt under testdata/', () => throwawayPrivateKeyPem()],
      ['as an unarmoured DER file', () => generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'der' })],
      ['as PKCS#1 RSA inside a Kotlin source file', () =>
        `val k = """${generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs1', format: 'pem' })}"""\n`],
    ])('refuses a key %s', async (_how, make) => {
      const path = 'tests/fixtures/keys/material'
      const rep = await gate(judged({}, { [path]: make() }))
      expect(rep.passed).toBe(false)
      expect(secretLine(rep)).toMatch(new RegExp(`${path} \\(its content holds a (PEM ".*PRIVATE KEY" block|DER-encoded .*private key)`))
      expect(secretLine(rep)).toContain('A test key must be generated at test time')
    })

    it('refuses a key re-encoded as UTF-16, BOM or no BOM', async () => {
      const key = throwawayPrivateKeyPem()
      for (const bytes of [
        Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(key, 'utf16le')]),
        Buffer.from(key, 'utf16le'),
      ]) {
        const rep = await gate(judged({}, { 'tests/fixtures/key.txt': bytes }))
        expect(rep.passed).toBe(false)
        expect(secretLine(rep)).toContain('tests/fixtures/key.txt (its content holds a PEM "PRIVATE KEY" block')
      }
    })

    it('refuses a key appended to an otherwise public certificate chain', async () => {
      const rep = await gate(judged({}, {
        'apps/android/app/src/test/resources/certs/le-chain.pem': `${SHOWCERTS_CHAIN}${throwawayPrivateKeyPem()}`,
      }))
      expect(rep.passed).toBe(false)
      expect(secretLine(rep)).toContain('le-chain.pem (its path matches secret pattern "*.pem"')
    })

    it('refuses a real key pasted into a committed template the path rule exempts', async () => {
      const rep = await gate(judged({}, { 'deploy/docker/.env.example': `API_KEY=change-me\n${throwawayPrivateKeyPem()}` }))
      expect(rep.passed).toBe(false)
      expect(secretLine(rep)).toContain('deploy/docker/.env.example (its content holds a PEM "PRIVATE KEY" block (line 2))')
    })

    it('no approval clears a secret — not even the operator\'s', async () => {
      const rep = await gate(judged({}, { 'tests/fixtures/key.ts': throwawayPrivateKeyPem() }), approvedBy(OPERATOR))
      expect(rep.passed).toBe(false)
      expect(secretLine(rep)).toContain('not clearable by any approval')
    })

    it('still admits a committed template that holds no key', async () => {
      const rep = await gate(judged({}, { 'deploy/docker/.env.example': 'PG_PASSWORD=change-me\n' }))
      expect(rep.reasons).toEqual([])
      expect(rep.passed).toBe(true)
    })
  })
})

// ---------------------------------------------------------------------------
describe('property 2 — a public certificate used as test input is agent-writable', () => {
  it.each<[string, string, string | Buffer]>([
    // The exact shape of #2550's le-chain-ye.pem / le-chain-yr.pem.
    ['an `openssl s_client -showcerts` chain', 'apps/android/app/src/test/resources/certs/le-chain-ye.pem', SHOWCERTS_CHAIN],
    ['a bare root certificate', 'apps/android/app/src/test/resources/certs/isrg-root-ye.pem', ISRG_ROOT_X2],
    ['a certificate bundle', 'apps/android/app/src/test/resources/certs/unpinned-chain.pem', `${ISRG_ROOT_X1}\n${ISRG_ROOT_X2}`],
    ['a DER certificate', 'apps/desktop/testdata/lets-encrypt/isrg-root-x1.der',
      Buffer.from(ISRG_ROOT_X1.split('\n').filter((l) => !l.startsWith('-----')).join(''), 'base64')],
  ])('admits %s', async (_what, path, content) => {
    const rep = await gate(judged({}, { [path]: content }))
    expect(rep.reasons).toEqual([])
    expect(rep.passed).toBe(true)
  })

  it('admits the public certificates this repo already tracks, read from the tree', () => {
    const certs = trackedFiles().filter((f) => f.endsWith('.pem') && !f.includes('/vendor/'))
    expect(certs.length, 'expected the tracked ISRG root fixtures').toBeGreaterThan(0)
    const r = checkScope(certs, UNRESTRICTED.scope, NEVER_WRITE_PATHS, (f) => readFileSync(join(process.cwd(), f)))
    expect(r.forbidden).toEqual([])
  })
})

// ---------------------------------------------------------------------------
describe('property 3 — a change to a shipped client\'s trust anchors requires a human', () => {
  const PIN_A = `"sha256/${'A'.repeat(43)}="`
  const PIN_B = `"sha256/${'B'.repeat(43)}="`

  it('registers the five files #2556 names, and the iOS pin set', () => {
    expect(TRUST_ANCHOR_FILES.map((a) => a.path).sort()).toEqual([
      'apps/android/app/src/main/java/org/llamenos/hotline/api/ApiService.kt',
      'apps/android/app/src/main/res/xml/network_security_config.xml',
      'apps/desktop/src/api_config.rs',
      'apps/desktop/src/cert_pin.rs',
      'apps/desktop/src/net.rs',
      'apps/ios/Sources/Services/CertificatePinning.swift',
    ])
  })

  it('every registered trust anchor is a real tracked file — a registry over nothing is not a gate', () => {
    const files = trackedFiles()
    for (const a of TRUST_ANCHOR_FILES) expect(files, `${a.path} is not tracked`).toContain(a.path)
  })

  describe.each(TRUST_ANCHOR_FILES.map((a) => [a.path, a] as const))('%s', (path, anchor) => {
    it('is refused without a human approval, naming what it anchors', async () => {
      const rep = await gate(judged({ [path]: `pins = [${PIN_A}]\n` }, { [path]: `pins = [${PIN_B}]\n` }))
      expect(rep.passed).toBe(false)
      expect(trustLine(rep)).toContain(`${path} (it is ${anchor.anchors})`)
      expect(trustLine(rep)).toContain(`No APPROVED review from a trust-anchor approver (${OPERATOR}) is on ${rep.verifiedCommit}`)
      expect(rep.trustAnchors).toEqual({ files: [path], approvedBy: [] })
    })

    it('lands once the operator has approved this exact head', async () => {
      const rep = await gate(judged({ [path]: `pins = [${PIN_A}]\n` }, { [path]: `pins = [${PIN_B}]\n` }), approvedBy(OPERATOR))
      expect(rep.reasons).toEqual([])
      expect(rep.passed).toBe(true)
      expect(rep.trustAnchors).toEqual({ files: [path], approvedBy: [OPERATOR] })
    })
  })

  const CERT_PIN = 'apps/desktop/src/cert_pin.rs'

  it.each<[string, readonly string[] | undefined | 'throws']>([
    ['the fleet\'s own reviewer identity', [REVIEW_REQUEST_LOGIN]],
    ['a bot', ['dependabot[bot]']],
    ['any other login', ['someone-else']],
    ['nobody', []],
    ['an unreadable review list', undefined],
    ['a lookup that throws', 'throws'],
  ])('is not cleared by %s', async (_who, approvals) => {
    const lookup = approvals === 'throws' ? async () => { throw new Error('API down') } : async () => approvals
    const rep = await gate(judged({ [CERT_PIN]: 'a\n' }, { [CERT_PIN]: 'b\n' }), lookup)
    expect(rep.passed).toBe(false)
    expect(trustLine(rep)).toBeDefined()
  })

  it('says it could not ask, rather than that nobody approved, when the reviews were unreadable', async () => {
    const rep = await gate(judged({ [CERT_PIN]: 'a\n' }, { [CERT_PIN]: 'b\n' }), async () => undefined)
    expect(trustLine(rep)).toContain('reviews could not be read')
  })

  it('refuses deleting a trust anchor', async () => {
    const rep = await gate(judged({ [CERT_PIN]: 'a\n' }, { [CERT_PIN]: null }))
    expect(rep.passed).toBe(false)
    expect(trustLine(rep)).toContain(CERT_PIN)
  })

  it('refuses RENAMING a trust anchor away — the old path is judged too', async () => {
    const body = 'fn verify() {}\n'.repeat(20)
    const rep = await gate(judged({ [CERT_PIN]: body }, {}, [[CERT_PIN, 'apps/desktop/src/tls_misc.rs']]))
    expect(rep.changedFiles).toContain(CERT_PIN)
    expect(rep.passed).toBe(false)
    expect(trustLine(rep)).toContain(CERT_PIN)
  })

  describe('any future equivalent — a trust decision made outside the registry', () => {
    it('refuses a NEW shipped file that introduces a pinner', async () => {
      const f = 'apps/android/app/src/main/java/org/llamenos/hotline/api/NewPinner.kt'
      const rep = await gate(judged({}, { [f]: `val p = CertificatePinner.Builder().add(host, ${PIN_B}).build()\n` }))
      expect(rep.passed).toBe(false)
      expect(trustLine(rep)).toMatch(new RegExp(`${f.replaceAll('.', '\\.')} \\(its diff changes .* in shipped client source: \``))
    })

    it('refuses REMOVING the pinner from a call site', async () => {
      const f = 'apps/android/app/src/main/java/org/llamenos/hotline/api/WebSocketService.kt'
      const before = 'client.newBuilder()\n    .certificatePinner(ApiService.buildPinner(host))\n    .build()\n'
      const rep = await gate(judged({ [f]: before }, { [f]: 'client.newBuilder()\n    .build()\n' }))
      expect(rep.passed).toBe(false)
      expect(trustLine(rep)).toContain(f)
    })

    it('refuses a trust-everything verifier added to desktop source', async () => {
      const f = 'apps/desktop/src/http_client.rs'
      const rep = await gate(judged({}, { [f]: 'builder.danger_accept_invalid_certs(true)\n' }))
      expect(rep.passed).toBe(false)
      expect(trustLine(rep)).toContain('a rustls/reqwest trust hook')
    })

    // From the automated security review of this PR: the manifest pointer is
    // as load-bearing as the file it points at.
    it('refuses deleting the manifest\'s networkSecurityConfig pointer — which drops every pin', async () => {
      const f = 'apps/android/app/src/main/AndroidManifest.xml'
      const app = (attr: string) => `<application\n        android:label="x"\n${attr}        android:icon="y">\n`
      const rep = await gate(judged(
        { [f]: app('        android:networkSecurityConfig="@xml/network_security_config"\n') },
        { [f]: app('') },
      ))
      expect(rep.passed).toBe(false)
      expect(trustLine(rep)).toContain(`${f} (its diff changes an Android network-security setting`)
    })

    it('refuses flipping App Transport Security open — a value on the line AFTER its key', async () => {
      const f = 'apps/ios/Sources/App/Info.plist'
      const plist = (v: string) => `<key>NSAppTransportSecurity</key>\n<dict>\n\t<key>NSAllowsArbitraryLoads</key>\n\t<${v}/>\n</dict>\n`
      const rep = await gate(judged({ [f]: plist('false') }, { [f]: plist('true') }))
      expect(rep.passed).toBe(false)
      expect(trustLine(rep)).toContain('`<key>NSAllowsArbitraryLoads</key> <false/> → <true/>`')
    })

    it('does NOT hold the release version bump knope makes in the same Info.plist', async () => {
      const f = 'apps/ios/Sources/App/Info.plist'
      const plist = (v: string) =>
        `<key>CFBundleShortVersionString</key>\n\t<string>${v}</string>\n\t<key>NSAllowsArbitraryLoads</key>\n\t<false/>\n`
      const rep = await gate(judged({ [f]: plist('0.21.7') }, { [f]: plist('0.21.8') }))
      expect(rep.reasons).toEqual([])
    })

    it('refuses a pin changed inside a file git treats as binary — bytes, not hunks', async () => {
      const f = 'apps/android/app/src/main/res/raw/pins.bin'
      const blob = (c: string) => Buffer.concat([Buffer.from([0, 0, 0, 0x0a]), Buffer.from(`"sha256/${c.repeat(43)}="\n`)])
      const rep = await gate(judged({ [f]: blob('A') }, { [f]: blob('B') }))
      expect(rep.passed).toBe(false)
      expect(trustLine(rep)).toContain(`${f} (its diff changes an SPKI pin literal`)
    })

    // From the second automated security review of this PR: a variant source
    // set overrides `main/` in the build that ships.
    it('refuses a release-variant network config that replaces the pinned one — even with no pins in it', async () => {
      const f = 'apps/android/app/src/release/res/xml/network_security_config.xml'
      const rep = await gate(judged({}, { [f]: '<?xml version="1.0" encoding="utf-8"?>\n<network-security-config/>\n' }))
      expect(rep.passed).toBe(false)
      expect(trustLine(rep)).toContain(`${f} (its diff changes an Android network-security setting`)
    })

    it('does NOT hold the debug variant\'s own network config — debug builds do not ship', async () => {
      const f = 'apps/android/app/src/debug/res/xml/network_security_config.xml'
      const rep = await gate(judged({}, { [f]: '<network-security-config>\n<base-config cleartextTrafficPermitted="true"/>\n</network-security-config>\n' }))
      expect(rep.reasons).toEqual([])
    })

    it.each<[string, string, string]>([
      ['re-pointing Android resources', 'apps/android/app/build.gradle.kts', '    sourceSets {\n        getByName("main").res.srcDirs("src/overrides/res")\n    }\n'],
      ['re-pointing the iOS Info.plist', 'apps/ios/project.yml', '    info:\n      path: Sources/App/Other.plist\n'],
    ])('refuses %s — the indirection that swaps every setting at once', async (_what, f, body) => {
      const rep = await gate(judged({ [f]: 'name: x\n' }, { [f]: `name: x\n${body}` }))
      expect(rep.passed).toBe(false)
      expect(trustLine(rep)).toContain(`${f} (its diff changes a build-wiring setting that chooses what ships`)
    })

    // From the third automated security review of this PR.
    it('treats a product flavour named like a test set as shipped — exclusions are exact names, not prefixes', async () => {
      const f = 'apps/android/app/src/debugger/res/xml/network_security_config.xml'
      const rep = await gate(judged({}, { [f]: '<network-security-config/>\n' }))
      expect(rep.passed).toBe(false)
      expect(trustLine(rep)).toContain(f)
      const unitTests = 'apps/android/app/src/testRelease/res/xml/network_security_config.xml'
      expect((await gate(judged({}, { [unitTests]: '<network-security-config/>\n' }))).reasons).toEqual([])
    })

    it.each<[string, string, string]>([
      ['a new Gradle product flavour', 'apps/android/app/build.gradle.kts', '    productFlavors {\n        create("open") {}\n    }\n'],
      ['a new XcodeGen source path', 'apps/ios/project.yml', '    sources:\n      - path: Extra\n'],
      ['a Swift file dropped into an iOS resource path XcodeGen compiles', 'apps/ios/Resources/Fonts/Trust.swift',
        'final class T: NSObject, URLSessionDelegate { func f(_ c: URLAuthenticationChallenge) { _ = c.protectionSpace.serverTrust } }\n'],
    ])('refuses %s', async (_what, f, body) => {
      const rep = await gate(judged({ [f]: 'name: x\n' }, { [f]: `name: x\n${body}` }))
      expect(rep.passed).toBe(false)
      expect(trustLine(rep)).toContain(f)
    })

    it('refuses UTF-16 trust text that starts after a kilobyte of ASCII, at an odd offset', async () => {
      const f = 'apps/android/app/src/main/res/raw/notes.txt'
      const blob = (pin: string) => Buffer.concat([
        Buffer.from(`${'x'.repeat(1025)}\n`), Buffer.from(`"sha256/${pin.repeat(43)}="\n`, 'utf16le'),
      ])
      const rep = await gate(judged({ [f]: blob('A') }, { [f]: blob('B') }))
      expect(rep.passed).toBe(false)
      expect(trustLine(rep)).toContain(`${f} (its diff changes an SPKI pin literal`)
    })

    it('refuses removing a pinner from a call site re-encoded as UTF-16', async () => {
      const f = 'apps/android/app/src/main/java/org/llamenos/hotline/api/WebSocketService.kt'
      const utf16 = (t: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(t, 'utf16le')])
      const rep = await gate(judged(
        { [f]: utf16('client.newBuilder()\n.certificatePinner(ApiService.buildPinner(host))\n.build()\n') },
        { [f]: utf16('client.newBuilder()\n.build()\n') },
      ))
      expect(rep.passed).toBe(false)
      expect(trustLine(rep)).toContain(f)
    })

    it('does NOT hold an ordinary edit to a call-site file that leaves its trust lines alone', async () => {
      const f = 'apps/android/app/src/main/java/org/llamenos/hotline/api/WebSocketService.kt'
      const pinned = '    .certificatePinner(ApiService.buildPinner(host))\n'
      const rep = await gate(judged({ [f]: `val a = 1\n${pinned}` }, { [f]: `val a = 2\n${pinned}` }))
      expect(rep.reasons).toEqual([])
      expect(rep.trustAnchors).toBeUndefined()
    })

    it('does NOT hold the same pinner code in a test — tests do not ship', async () => {
      const f = 'apps/android/app/src/test/java/org/llamenos/hotline/api/CertificatePinnerTest.kt'
      const rep = await gate(judged({}, { [f]: `val p = CertificatePinner.Builder().add(host, ${PIN_B}).build()\n` }))
      expect(rep.reasons).toEqual([])
    })
  })

  it('the approvers are humans: never the fleet\'s reviewer identity, never a bot', () => {
    expect(TRUST_ANCHOR_APPROVERS.length).toBeGreaterThan(0)
    expect(TRUST_ANCHOR_APPROVERS).not.toContain(REVIEW_REQUEST_LOGIN)
    for (const l of TRUST_ANCHOR_APPROVERS) expect(l).not.toMatch(/\[bot\]$|^dependabot|^github-actions/)
  })

  // The discovery rail: "any future equivalent" cannot appear silently. Every
  // tracked shipped-client file that carries a trust signature today is either
  // registered whole-file, or named here as a call site — a file that APPLIES
  // a decision made in a registered file, whose trust lines the signature
  // check already holds. A new file carrying one fails this test until a
  // human decides which it is.
  const CALL_SITES: Record<string, string> = {
    'apps/android/app/src/main/java/org/llamenos/hotline/api/WebSocketService.kt':
      'applies ApiService.buildPinner (registered) to the relay WebSocket',
    'apps/android/app/src/main/java/org/llamenos/hotline/telephony/LinphoneService.kt':
      'applies the SIP TLS trust anchor the hub publishes at runtime — nothing compiled in',
    'apps/ios/Sources/Services/APIService.swift':
      'the URLSession challenge handler, delegating to CertificatePinValidator (registered CertificatePinning.swift)',
    'apps/ios/Sources/Services/LinphoneService.swift':
      'applies the SIP TLS trust anchor the hub publishes at runtime — nothing compiled in',
    // Mixed files knope bumps on every release, so they cannot be registered
    // whole-file; their trust lines (and each line's value) are compared.
    'apps/android/app/src/main/AndroidManifest.xml':
      'points the app at the registered network_security_config.xml (android:networkSecurityConfig)',
    'apps/android/app/build.gradle.kts':
      'release versioning plus a test task that reads the release <pin-set>; a pin injected here ships',
    'apps/ios/Sources/App/Info.plist':
      'App Transport Security (NSAllowsArbitraryLoads) beside the release version keys',
    'apps/ios/project.yml':
      'XcodeGen source of the same App Transport Security keys',
  }

  it('every tracked shipped-client file carrying a trust signature is registered or a named call site', () => {
    // The gate's own predicate, so the rail scans exactly what the gate holds.
    const shipped = trackedFiles().filter(isShippedClientSource)
    expect(shipped.length, 'no shipped client source found — the scan would pass vacuously').toBeGreaterThan(100)
    // The gate's own projection over the raw bytes — every text view, binary
    // files included — so the rail sees exactly what the gate compares.
    const carriers = shipped.filter((f) => trustProjection(readFileSync(join(process.cwd(), f))).length > 0)
    const unclassified = carriers.filter((f) => trustAnchorEntry(f) === undefined && !(f in CALL_SITES))
    expect(unclassified, 'shipped files making a trust decision that is neither registered nor a known call site').toEqual([])
    for (const a of TRUST_ANCHOR_FILES) expect(carriers, `${a.path} carries no trust signature`).toContain(a.path)
    for (const f of Object.keys(CALL_SITES)) expect(carriers, `call site ${f} no longer carries one — drop it`).toContain(f)
  })
})

// ---------------------------------------------------------------------------
describe('property 4 — the refusal says which property was violated', () => {
  it('one diff, four different facts, four different sentences', async () => {
    const rep = await gate(judged({ 'apps/desktop/src/cert_pin.rs': 'a\n' }, {
      'deploy/docker/.env': 'X=1\n',
      'tests/fixtures/key.ts': throwawayPrivateKeyPem(),
      'tests/fixtures/pinned.pem': `${ISRG_ROOT_X1}\n# pin sha256/${'C'.repeat(43)}=\n`,
      'apps/desktop/src/cert_pin.rs': 'b\n',
    }))
    expect(rep.passed).toBe(false)
    const secret = secretLine(rep) ?? ''
    const trust = trustLine(rep) ?? ''
    // A secret by its path.
    expect(secret).toContain('deploy/docker/.env (its path matches secret pattern ".env")')
    // A secret by its bytes, under a harmless name.
    expect(secret).toContain('tests/fixtures/key.ts (its content holds a PEM "PRIVATE KEY" block (line 1))')
    // A file whose NAME looks like a secret and whose content could not be
    // proven public — the false-positive candidate, with the line that did it.
    expect(secret).toMatch(/tests\/fixtures\/pinned\.pem \(its path matches secret pattern "\*\.pem" and its content is not provably public certificate material: line \d+, outside any PEM block, carries a \d+-character base64\/hex run/)
    // A trust anchor — a different class, a different remedy.
    expect(trust).toContain('apps/desktop/src/cert_pin.rs (it is the desktop pin capture and the enforcing certificate verifier)')
    expect(trust).toContain('re-requests review from llamenos-auto')
    expect(secret).not.toContain('cert_pin.rs')
    expect(trust).not.toContain('.env')
  })

  it('the gate trace keeps both refusals, so the ledger can tell them apart', async () => {
    const rep = await gate(judged({ 'apps/desktop/src/net.rs': 'a\n' }, { 'apps/desktop/src/net.rs': 'b\n', '.npmrc': 't\n' }))
    const trace = buildGateTrace({ report: rep })
    expect(trace).toContain(`scope=fail(${SECRET_REASON_PREFIX}`)
    expect(trace).toContain(TRUST_ANCHOR_REASON_PREFIX)
  })
})

// ---------------------------------------------------------------------------
describe('property 5 — every consumer agrees on the classification', () => {
  it.each(TRUST_ANCHOR_FILES.map((a) => [a.path]))('impact and tier both call %s a trust anchor', (path) => {
    const impact = classifyImpact([path], 1)
    expect(impact.impact).toBe('high')
    expect(impact.reasons.join(' ')).toContain('is a trust anchor')
    expect(tierFor([path])).toEqual({ tier: 2, reasons: [expect.stringContaining('trust anchor')] })
  })

  it.each(SECRET_PATH_PATTERNS.filter((p) => !PRE_2556_SECRET_PATTERNS.includes(p as never)).map((p) => [p]))(
    'a newly added secret pattern %s is high impact too',
    (p) => {
      expect(classifyImpact([`deploy/ansible/${nameFor(p)}`], 1).impact).toBe('high')
    },
  )

  it('every fleet brief states both refusals, rendered from the enforced constants', () => {
    const lane: Lane = { ...UNRESTRICTED, id: 'android', scope: { owned: ['apps/android/'], notOwned: [] } }
    const brief = renderBrief(buildBrief({ id: 1, title: 't', url: 'u', body: 'b', labels: [] } as never, lane, 'fleet/android/1'))
    expect(brief).toContain(writeGateRules())
    for (const a of TRUST_ANCHOR_FILES) expect(brief).toContain(`\`${a.path}\` — ${a.anchors}`)
    for (const p of SECRET_PATH_PATTERNS) expect(brief).toContain(`\`${p}\``)
    for (const l of TRUST_ANCHOR_APPROVERS) expect(brief).toContain(l)
  })

  it('the worker rules name exactly the registered trust anchors — no more, no fewer', () => {
    const rules = readFileSync(join(process.cwd(), '.claude/agents/fragments/_worker-rules.md'), 'utf8')
    const section = rules.slice(rules.indexOf('## The write gate'))
    expect(section.length, '_worker-rules.md has no "## The write gate" section').toBeGreaterThan(20)
    const body = section.slice(0, section.indexOf('\n## ', 3) > 0 ? section.indexOf('\n## ', 3) : undefined)
    const listed = [...body.matchAll(/`(apps\/[^`]+)`/g)].map((m) => m[1]).sort()
    expect(listed).toEqual(TRUST_ANCHOR_FILES.map((a) => a.path).sort())
  })
})
