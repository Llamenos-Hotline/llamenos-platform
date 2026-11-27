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
import { buildGateTrace, trustSnapshotLines } from '../../orchestrator/src/trace.js'
import { SNAPSHOT_PATH, TRUST_INPUT_PREFIXES, fsReader } from '../../packages/protocol/tools/trust-snapshot.js'
import { REVIEW_REQUEST_LOGIN } from '../../orchestrator/src/ci.js'
import { SECRET_REASON_PREFIX, TRUST_ANCHOR_REASON_PREFIX } from '../../orchestrator/src/write-gate.js'
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
describe('property 3 — the control over a shipped client\'s trust requires a human', () => {
  const PIN_A = `"sha256/${'A'.repeat(43)}="`
  const PIN_B = `"sha256/${'B'.repeat(43)}="`

  it('registers the trust control: the sign-off ledger, the extractor, the release CLI and the tests that break them (#3069)', () => {
    expect(TRUST_ANCHOR_FILES.map((a) => a.path).sort()).toEqual([
      'docs/security/trust-signoffs.json',
      'packages/protocol/tools/trust-release.test.ts',
      'packages/protocol/tools/trust-snapshot-cli.ts',
      'packages/protocol/tools/trust-snapshot.test.ts',
      'packages/protocol/tools/trust-snapshot.ts',
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
      expect(trustLine(rep)).toContain(`No trust-anchor approver (${OPERATOR}) has signed off on ${rep.verifiedCommit}`)
      expect(rep.trustAnchors).toEqual({ files: [path], approvedBy: [] })
    })

    it('lands once the operator has approved this exact head', async () => {
      const rep = await gate(judged({ [path]: `pins = [${PIN_A}]\n` }, { [path]: `pins = [${PIN_B}]\n` }), approvedBy(OPERATOR))
      expect(rep.reasons).toEqual([])
      expect(rep.passed).toBe(true)
      expect(rep.trustAnchors).toEqual({ files: [path], approvedBy: [OPERATOR] })
    })
  })

  const CONTROL = 'packages/protocol/tools/trust-snapshot.ts'

  it.each<[string, readonly string[] | undefined | 'throws']>([
    ['the fleet\'s own reviewer identity', [REVIEW_REQUEST_LOGIN]],
    ['a bot', ['dependabot[bot]']],
    ['any other login', ['someone-else']],
    ['nobody', []],
    ['an unreadable review list', undefined],
    ['a lookup that throws', 'throws'],
  ])('is not cleared by %s', async (_who, approvals) => {
    const lookup = approvals === 'throws' ? async () => { throw new Error('API down') } : async () => approvals
    const rep = await gate(judged({ [CONTROL]: 'a\n' }, { [CONTROL]: 'b\n' }), lookup)
    expect(rep.passed).toBe(false)
    expect(trustLine(rep)).toBeDefined()
  })

  it('says it could not ask, rather than that nobody approved, when the reviews were unreadable', async () => {
    const rep = await gate(judged({ [CONTROL]: 'a\n' }, { [CONTROL]: 'b\n' }), async () => undefined)
    expect(trustLine(rep)).toContain('reviews and comments could not be read')
  })

  it('refuses deleting the control', async () => {
    const rep = await gate(judged({ [CONTROL]: 'a\n' }, { [CONTROL]: null }))
    expect(rep.passed).toBe(false)
    expect(trustLine(rep)).toContain(CONTROL)
  })

  it('refuses RENAMING the control away — the old path is judged too', async () => {
    const body = 'export const x = 1\n'.repeat(20)
    const rep = await gate(judged({ [CONTROL]: body }, {}, [[CONTROL, 'packages/protocol/tools/misc.ts']]))
    expect(rep.changedFiles).toContain(CONTROL)
    expect(rep.passed).toBe(false)
    expect(trustLine(rep)).toContain(CONTROL)
  })

  it('the approvers are humans: never the fleet\'s reviewer identity, never a bot', () => {
    expect(TRUST_ANCHOR_APPROVERS.length).toBeGreaterThan(0)
    expect(TRUST_ANCHOR_APPROVERS).not.toContain(REVIEW_REQUEST_LOGIN)
    for (const l of TRUST_ANCHOR_APPROVERS) expect(l).not.toMatch(/\[bot\]$|^dependabot|^github-actions/)
  })
})

// ---------------------------------------------------------------------------
describe('property 4 — the refusal says which property was violated', () => {
  it('one diff, four different facts, four different sentences', async () => {
    const rep = await gate(judged({ 'packages/protocol/tools/trust-snapshot.ts': 'a\n' }, {
      'deploy/docker/.env': 'X=1\n',
      'tests/fixtures/key.ts': throwawayPrivateKeyPem(),
      'tests/fixtures/pinned.pem': `${ISRG_ROOT_X1}\n# pin sha256/${'C'.repeat(43)}=\n`,
      'packages/protocol/tools/trust-snapshot.ts': 'b\n',
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
    expect(trust).toContain('packages/protocol/tools/trust-snapshot.ts (it is the trust snapshot extractor and release verdict — what it cannot read, no gate can see)')
    expect(trust).toContain('re-requests review from llamenos-auto')
    expect(secret).not.toContain('trust-snapshot.ts')
    expect(trust).not.toContain('.env')
  })

  it('the gate trace keeps both refusals, so the ledger can tell them apart', async () => {
    const rep = await gate(judged({ 'packages/protocol/tools/trust-snapshot.ts': 'a\n' }, { 'packages/protocol/tools/trust-snapshot.ts': 'b\n', '.npmrc': 't\n' }))
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
    // The registered paths are the bullet list; other backticked paths in the prose are not claims about the registry.
    const listed = [...body.matchAll(/^ {2}- `((?:apps|packages|docs)\/[^`]+)`/gm)].map((m) => m[1]).sort()
    expect(listed).toEqual(TRUST_ANCHOR_FILES.map((a) => a.path).sort())
  })
})

// ---------------------------------------------------------------------------
describe('#3069 — the trust snapshot in the gate: shown, never signed per PR', () => {
  const ROOT = process.cwd()
  // The files the extractor reads, as a repo: the REAL shipped sources, so a diff
  // below is a diff against the tree the fleet actually judges.
  const reader = fsReader(ROOT)
  const treeFiles = (): Files => {
    const out: Files = {}
    for (const f of [...reader.list(TRUST_INPUT_PREFIXES), SNAPSHOT_PATH]) {
      if (/\.(kt|kts|swift|rs|xml|plist|yml|json)$/.test(f)) out[f] = reader.read(f) ?? ''
    }
    return out
  }
  const tree = treeFiles()
  const text = (f: string): string => {
    const t = tree[f]
    if (typeof t !== 'string') throw new Error(`${f} is not in the trust tree`)
    return t
  }
  const edit = (f: string, from: string | RegExp, to: string): Files => {
    const before = text(f)
    const after = before.replace(from, to)
    expect(after, `${String(from)} no longer matches ${f}`).not.toBe(before)
    return { [f]: after }
  }
  const API = 'apps/android/app/src/main/java/org/llamenos/hotline/api/ApiService.kt'
  const MANIFEST = 'apps/android/app/src/main/AndroidManifest.xml'
  const NSC = 'apps/android/app/src/main/res/xml/network_security_config.xml'
  const PROJECT = 'apps/ios/project.yml'
  const NEG = (rep: VerifyReport) => {
    expect(rep.reasons).toEqual([])
    expect(rep.passed).toBe(true)
    expect(rep.trustAnchors).toBeUndefined()
  }

  it('the tree the tests judge is the real shipped client source — not a vacuous stub', () => {
    expect(Object.keys(tree).length).toBeGreaterThan(300)
    expect(Object.keys(tree)).toContain(API)
  })

  describe('replaying the diffs that used to demand a TLS signature for nothing', () => {
    it('#3051: five imports and three suspend wrappers on existing routes in ApiService.kt gate nothing', async () => {
      const rep = await gate(judged(tree, {
        [API]: text(API).replace('import okhttp3.OkHttpClient', 'import okhttp3.OkHttpClient\nimport org.llamenos.hotline.model.Alpha').replace(/\}\s*$/, '\n    suspend fun alpha(): Alpha = get("/api/alpha")\n    suspend fun beta(): Unit = post("/api/beta")\n}\n'),
      }))
      NEG(rep)
      expect(rep.trustSnapshot).toMatchObject({ changed: false })
      expect(trustSnapshotLines(rep)).toEqual([])
    })

    it('#3060: one non-exported activity in the manifest gates nothing', async () => {
      const rep = await gate(judged(tree, edit(MANIFEST, '</application>', '    <activity android:name=".NotificationTapActivity" android:exported="false" />\n    </application>')))
      NEG(rep)
      expect(rep.trustSnapshot).toMatchObject({ changed: false })
    })

    it('adding one Swift file to the iOS app (a project.yml sources entry) gates nothing', async () => {
      const rep = await gate(judged(tree, {
        ...edit(PROJECT, '    sources:\n      - path: Sources\n', '    sources:\n      - path: Sources\n      - path: Sources/NewFeature\n'),
        'apps/ios/Sources/NewFeature/Thing.swift': 'import Foundation\nstruct Thing { let id: Int }\n',
      }))
      NEG(rep)
      expect(rep.trustSnapshot).toMatchObject({ changed: false })
    })

    it('a diff that touches nothing the extractor reads does not even extract', async () => {
      const rep = await gate(judged(tree, { 'docs/notes.md': 'hello\n' }))
      NEG(rep)
      expect(rep.trustSnapshot).toBeUndefined()
    })
  })

  describe('a diff that DOES move the trust snapshot is shown, states what changed, and is not a refusal', () => {
    const cases: Array<[string, () => Files, RegExp]> = [
      ['a wrong pin base64', () => edit(NSC, /(<pin digest="SHA-256">)C5/, '$1D5'), /pins\.android\.osPinSets\[\]/],
      ['a root removed from the set', () => edit(NSC, /<pin digest="SHA-256">sCkq5UWXjg[^<]*<\/pin>/, ''), /pins\.android\.osPinSets\[\]|pinSet/],
      ['usesCleartextTraffic flipped to true', () => edit(MANIFEST, '<application', '<application android:usesCleartextTraffic="true"'), /usesCleartextTraffic/],
      ['App Transport Security weakened', () => edit(PROJECT, 'NSAllowsArbitraryLoads: false', 'NSAllowsArbitraryLoads: true'), /appTransportSecurity/],
      ['a new HTTP client built without the pinner', () => ({ 'apps/android/app/src/main/java/org/llamenos/hotline/api/Telemetry.kt': 'package x\nval c = okhttp3.OkHttpClient.Builder().build()\n' }), /Telemetry\.kt/],
      ['the localhost exemption widened to a suffix match', () => edit(API, 'hostname == "localhost"', 'hostname.endsWith("localhost")'), /loopbackExemptions/],
    ]
    it.each(cases)('%s', async (_name, change, mention) => {
      const rep = await gate(judged(tree, change()))
      NEG(rep)
      expect(rep.trustSnapshot?.changed).toBe(true)
      expect(rep.trustSnapshot?.changes.join('\n')).toMatch(mention)
      const lines = trustSnapshotLines(rep).join('\n')
      expect(lines).toContain('trust snapshot CHANGED')
      expect(lines).toContain('shown here, not gated')
      expect(lines).toContain(rep.trustSnapshot?.headDigest as string)
      // The PR moved a value without updating the committed snapshot: the line says so.
      expect(lines).toContain('NOT updated')
    })

    it('a PR that updates the committed snapshot with the change is not reported stale', async () => {
      const { extractTrustSnapshot, serializeSnapshot } = await import('../../packages/protocol/tools/trust-snapshot.js')
      const changed = edit(MANIFEST, '<application', '<application android:usesCleartextTraffic="true"')
      const headTree = fsReaderOver({ ...tree, ...changed })
      const rep = await gate(judged(tree, { ...changed, [SNAPSHOT_PATH]: serializeSnapshot(extractTrustSnapshot(headTree)) }))
      expect(rep.trustSnapshot?.changed).toBe(true)
      expect(rep.trustSnapshot?.committedStale).toBe(false)
      expect(trustSnapshotLines(rep).join('\n')).not.toContain('NOT updated')
    })
  })

  it('a head the extractor cannot read is REPORTED, never read as "nothing changed"', async () => {
    const rep = await gate(judged(tree, edit(API, /DEFAULT_PIN_HASHES/g, 'PIN_HASHES')))
    NEG(rep)
    expect(rep.trustSnapshot?.error).toMatch(/could not be read/)
    expect(trustSnapshotLines(rep).join('\n')).toMatch(/trust snapshot: .*could not be read.*repo test .*fails/)
  })
})

/** A TreeReader over an in-memory file map, for extracting what a judged head holds. */
function fsReaderOver(files: Files): import('../../packages/protocol/tools/trust-snapshot.js').TreeReader {
  const list = (prefixes: readonly string[]) =>
    Object.keys(files).filter((f) => prefixes.some((p) => f === p.replace(/\/$/, '') || f.startsWith(p))).sort()
  return { list, read: (p) => (typeof files[p] === 'string' ? (files[p] as string) : undefined) }
}
