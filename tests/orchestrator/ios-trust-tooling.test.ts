import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, normalize } from 'node:path'
import { describe, it, expect } from 'vitest'
import { TRUST_ANCHOR_FILES } from '../../orchestrator/src/config.js'
import { TRUST_TOOLING_FILES, classifyIosGateFile, iosIsolationFor, type IosIsolationReads } from '../../orchestrator/src/ios-isolation.js'
import { SNAPSHOT_PATH } from '../../packages/protocol/tools/trust-snapshot'
import { trackedFiles } from './codeowners.js'

/**
 * #3108 — the trust snapshot tooling shares `packages/protocol/` with the
 * schemas that generate the Swift types compiled into the app, and the
 * `packages/protocol/` prefix used to schedule iOS tier FULL (326 tests, two
 * serial Mac waves) for a diff of only the extractor, its tests and the
 * committed extraction.
 *
 * #3129 — the carve-out is an EXCLUSION from that prefix, never an enumeration
 * of what reaches the app: a protocol file nobody has classified earns FULL and
 * compiles iOS, so adding one never forces a write to the supply-chain script.
 *
 * The carve-out is an explicit list of five files, kept in step in two places
 * that decide different questions:
 *   - `.github/scripts/detect-changed-platforms.sh`'s `SHARED_DEPS_EXCLUDE_RE`
 *     — which iOS TIER a diff earns;
 *   - `orchestrator/src/ios-isolation.ts`'s `TRUST_TOOLING_FILES` — whether a
 *     diff that schedules the gate must form its own merge group.
 * Each entry is PROVEN unable to reach the binary (exists, not a codegen input,
 * not named in project.yml), and each rail below is a diff that can really
 * break the iOS gate (or a file that really is a codegen input) and must still
 * be refused.
 */

const ROOT = join(__dirname, '..', '..')
const SCRIPT = join(ROOT, '.github/scripts/detect-changed-platforms.sh')
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

function classifyWith(script: string, files: string[]): Record<string, string> {
  const r = spawnSync('bash', [script], { input: files.join('\n'), encoding: 'utf8' })
  expect(r.status, `classifier failed: ${r.stderr}`).toBe(0)
  return Object.fromEntries(r.stdout.trim().split('\n').map((l) => l.split('=') as [string, string]))
}
const classify = (files: string[]): Record<string, string> => classifyWith(SCRIPT, files)

const NO_READS: IosIsolationReads = { readMergeBase: async () => undefined, readFileAt: async () => undefined }
const PR = { baseRefName: 'main', headRefOid: '2'.repeat(40) }

/** Files codegen reads or imports (the transitive relative-import closure of
 *  codegen.ts, plus every `resolve(__dirname, ...)` path it names), repo-relative. */
function codegenInputs(): Set<string> {
  const seen = new Set<string>()
  const tracked = new Set(trackedFiles(ROOT))
  const pending = ['packages/protocol/tools/codegen.ts']
  const resolveImport = (from: string, spec: string): string | undefined => {
    const base = normalize(join(dirname(from), spec))
    for (const c of [base, `${base}.ts`, `${base}/index.ts`]) if (existsSync(join(ROOT, c)) && /\.\w+$/.test(c)) return c
    return undefined
  }
  while (pending.length > 0) {
    const f = pending.pop() as string
    if (seen.has(f)) continue
    seen.add(f)
    if (!f.endsWith('.ts')) continue
    const text = read(f)
    for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const r = resolveImport(f, m[1] as string)
      if (r !== undefined) pending.push(r)
    }
    for (const m of text.matchAll(/resolve\(__dirname,\s*'([^']+)'\)/g)) {
      const p = normalize(join(dirname(f), m[1] as string))
      // Tracked, not merely present: `codegen.ts` also names its own OUTPUT directory
      // (`GENERATED_DIR`), which exists only once codegen has run — so an `existsSync`
      // test made this set, and the assertions over it, depend on build state.
      if (tracked.has(p)) seen.add(p)
    }
  }
  return seen
}

// `trackedFiles`, never a bare `git ls-files`: under `fleet/verify` this suite runs
// inside a `git archive` export of the commit under judgement, which has no `.git`,
// so a raw git call throws at collection time and the whole suite fails to load.
const trackedProtocolFiles = (): string[] => trackedFiles(ROOT).filter((f) => f.startsWith('packages/protocol/'))

/** The top-level alternatives of the classifier's `SHARED_DEPS_EXCLUDE_RE`, as
 *  written (still escaped). Depth-aware: the vitest alternative nests groups. */
function exclusionAlternatives(script: string): string[] {
  const line = script.split('\n').find((l) => l.startsWith("SHARED_DEPS_EXCLUDE_RE='"))
  expect(line, 'SHARED_DEPS_EXCLUDE_RE line exists').toBeDefined()
  const m = /^SHARED_DEPS_EXCLUDE_RE='\^\((.*)\)\$'$/.exec(line as string)
  expect(m, `SHARED_DEPS_EXCLUDE_RE is not of the form '^(...)$': ${line}`).not.toBeNull()
  const body = (m as RegExpExecArray)[1] as string
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of body) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === '|' && depth === 0) { out.push(cur); cur = '' } else cur += ch
  }
  out.push(cur)
  return out
}

/** The alternatives that carve something out of `packages/protocol/` — still as
 *  written, so a pattern smuggled in is visible to `carveOutViolations`. */
const protocolExclusions = (script: string): string[] =>
  exclusionAlternatives(script).filter((a) => a.startsWith('packages/protocol/'))

/** A literal path: path characters, and `\.` as the only escape. */
const LITERAL_PATH = /^packages\/protocol\/(?:[A-Za-z0-9_\-/]|\\\.)+$/

interface CarveOutEvidence { exists: (p: string) => boolean; codegenInputs: Set<string>; projectYml: string }

/** Every reason an exclusion entry is NOT provably unable to reach the iOS
 *  binary. All reasons are collected for each entry — no short-circuit — so a
 *  rail can assert the specific one it breaks. */
function carveOutViolations(entries: string[], ev: CarveOutEvidence): string[] {
  const out: string[] = []
  for (const raw of entries) {
    if (!LITERAL_PATH.test(raw)) { out.push(`${raw}: not a literal path`); continue }
    const path = raw.replace(/\\\./g, '.')
    if (!ev.exists(path)) out.push(`${path}: does not exist`)
    if (ev.codegenInputs.has(path)) out.push(`${path}: is a codegen input`)
    if (ev.projectYml.includes(path.slice('packages/'.length))) out.push(`${path}: is named in apps/ios/project.yml`)
  }
  return out
}
const realEvidence = (): CarveOutEvidence => ({
  exists: (p) => existsSync(join(ROOT, p)),
  codegenInputs: codegenInputs(),
  projectYml: read('apps/ios/project.yml'),
})

describe('TRUST_TOOLING_FILES is a list a reader can check, bound to the trust control itself', () => {
  it('names five files and every one of them exists', () => {
    expect(TRUST_TOOLING_FILES).toHaveLength(5)
    for (const f of TRUST_TOOLING_FILES) expect(existsSync(join(ROOT, f)), f).toBe(true)
  })

  it('is exactly the committed snapshot plus the trust-anchor files that live under packages/protocol/', () => {
    const anchors = TRUST_ANCHOR_FILES.map((a) => a.path).filter((p) => p.startsWith('packages/protocol/'))
    expect(anchors.length).toBeGreaterThan(0)
    expect([...TRUST_TOOLING_FILES].sort()).toEqual([SNAPSHOT_PATH, ...anchors].sort())
  })

  it('shares nothing with what codegen reads — not one entry is a Swift codegen input', () => {
    const inputs = codegenInputs()
    // The closure walker is not vacuous: it reaches the files codegen provably reads.
    expect([...inputs]).toEqual(expect.arrayContaining([
      'packages/protocol/tools/codegen.ts', 'packages/protocol/tools/schema-registry.ts', 'packages/protocol/crypto-labels.json',
    ]))
    for (const f of TRUST_TOOLING_FILES) expect(inputs.has(f), `${f} is read by codegen`).toBe(false)
  })

  it('every protocol file codegen reaches stays risky and earns the FULL tier', () => {
    const inputs = [...codegenInputs()].filter((f) => f.startsWith('packages/protocol/'))
    expect(inputs.length).toBeGreaterThan(10)
    for (const f of inputs) {
      expect(classifyIosGateFile(f).kind, f).toBe('risky')
      expect(classify([f])['ios_tier'], f).toBe('full')
      expect(classify([f])['ios_compile'], f).toBe('true')
    }
  })

  it('the iOS project reads packages/protocol only through its generated output', () => {
    const project = read('apps/ios/project.yml')
    const protocolPaths = [...project.matchAll(/\.\.\/\.\.\/packages\/protocol\/[^\s'"]+/g)].map((m) => m[0])
    expect(protocolPaths.length).toBeGreaterThan(0)
    for (const p of protocolPaths) expect(p, 'project.yml reads a hand-written protocol file').toMatch(/\/generated\//)
  })
})

describe('the exclusion list in the classifier is proven, not trusted (#3129)', () => {
  it('names exactly TRUST_TOOLING_FILES, each as a literal path', () => {
    const entries = protocolExclusions(read('.github/scripts/detect-changed-platforms.sh'))
    for (const e of entries) expect(e, 'an exclusion entry must be a literal path').toMatch(LITERAL_PATH)
    expect(entries.map((e) => e.replace(/\\\./g, '.')).sort()).toEqual([...TRUST_TOOLING_FILES].sort())
  })

  it('every entry exists, is not a codegen input and is not named in project.yml', () => {
    expect(carveOutViolations(protocolExclusions(read('.github/scripts/detect-changed-platforms.sh')), realEvidence())).toEqual([])
  })

  // Faking a carve-out: each of these, added to the list, must turn the suite red
  // for the reason it breaks — not merely for some other reason.
  it.each([
    ['a codegen input', 'packages/protocol/tools/codegen\\.ts', 'is a codegen input'],
    ['a codegen data file', 'packages/protocol/crypto-labels\\.json', 'is a codegen input'],
    ['a pattern instead of a path', 'packages/protocol/tools/trust-.*\\.ts', 'not a literal path'],
    ['a file that does not exist', 'packages/protocol/tools/no-such-file\\.ts', 'does not exist'],
  ])('break-it: %s cannot be carved out', (_name, entry, reason) => {
    const real = protocolExclusions(read('.github/scripts/detect-changed-platforms.sh'))
    const v = carveOutViolations([...real, entry], realEvidence())
    expect(v.length, v.join('; ')).toBeGreaterThan(0)
    expect(v.join('; ')).toContain(reason)
  })

  it('break-it: a path project.yml names cannot be carved out', () => {
    const named = [...read('apps/ios/project.yml').matchAll(/\.\.\/\.\.\/(packages\/protocol\/[^\s'"]+)/g)].map((m) => m[1] as string)
    expect(named.length).toBeGreaterThan(0)
    const entry = (named[0] as string).replace(/\./g, '\\.')
    expect(carveOutViolations([entry], realEvidence()).join('; ')).toContain('is named in apps/ios/project.yml')
  })

  it('break-it: carving codegen.ts out of the real script takes it off FULL — and the rails above catch exactly that edit', () => {
    const text = read('.github/scripts/detect-changed-platforms.sh')
    const needle = 'packages/protocol/trust\\.snapshot\\.json|'
    expect(text, 'the exclusion entry this rail mutates moved').toContain(needle)
    const mutatedText = text.replace(needle, `${needle}packages/protocol/tools/codegen\\.ts|`)
    const dir = mkdtempSync(join(tmpdir(), 'ios-trust-tooling-'))
    const mutated = join(dir, 'detect-changed-platforms.sh')
    writeFileSync(mutated, mutatedText, { mode: 0o755 })
    // The mutation is live: codegen.ts no longer schedules the FULL tier...
    expect(classifyWith(mutated, ['packages/protocol/tools/codegen.ts'])).toMatchObject({ ios_tier: 'none', ios_compile: 'false' })
    // ...and the list check refuses it.
    expect(carveOutViolations(protocolExclusions(mutatedText), realEvidence())).toEqual(['packages/protocol/tools/codegen.ts: is a codegen input'])
  })
})

describe('every tracked file under packages/protocol/ is FULL unless carved out — FULL by default (#3129)', () => {
  const files = trackedProtocolFiles()
  const trust = new Set(TRUST_TOOLING_FILES)

  it('sees the real tree', () => {
    expect(files.length).toBeGreaterThan(40)
    for (const f of TRUST_TOOLING_FILES) expect(files).toContain(f)
  })

  it('a file that is not trust tooling earns the FULL tier and compiles iOS', () => {
    const offenders = files.filter((f) => !trust.has(f)).filter((f) => {
      const o = classify([f])
      return o['ios_tier'] !== 'full' || o['ios_compile'] !== 'true'
    })
    expect(offenders, 'a protocol file off the FULL tier that is not in the proven exclusion list').toEqual([])
  })

  // The property #3129 exists for: nobody classified these, and nobody has to.
  it.each([
    'packages/protocol/hash-field-registry.json',
    'packages/protocol/brand-new-registry.json',
    'packages/protocol/tools/brand-new-codegen-step.ts',
    'packages/protocol/fixtures/new-fixture.json',
    'packages/protocol/NOTES.md',
  ])('a protocol file nobody has classified (%s) earns FULL and compiles iOS', (f) => {
    expect(classify([f])).toMatchObject({ ios: 'true', ios_tier: 'full', ios_compile: 'true' })
    if (!f.endsWith('.md')) expect(classifyIosGateFile(f).kind).toBe('risky')
  })

  it('a non-markdown file that is not trust tooling is risky to the isolation predicate', () => {
    const offenders = files.filter((f) => !trust.has(f) && !f.endsWith('.md')).filter((f) => classifyIosGateFile(f).kind !== 'risky')
    expect(offenders).toEqual([])
  })

  it('a file that IS trust tooling schedules nothing at all', () => {
    for (const f of TRUST_TOOLING_FILES) {
      const o = classify([f])
      expect(o, f).toMatchObject({
        app: 'true', ios: 'false', ios_tier: 'none', ios_compile: 'false', android: 'false', desktop: 'false', backend: 'false', crypto: 'false',
      })
      expect(classifyIosGateFile(f).kind, f).toBe('inert')
    }
  })
})

describe('the tier a diff earns (what arm-batch.sh reads out of the same regexes)', () => {
  it("#3106's own file list is not iOS tier FULL", () => {
    const files = [
      'packages/protocol/tools/trust-snapshot.ts',
      'packages/protocol/tools/trust-snapshot.test.ts',
      'packages/protocol/trust.snapshot.json',
    ]
    expect(classify(files)).toMatchObject({ ios: 'false', ios_tier: 'none', ios_compile: 'false' })
  })

  it('all five trust tooling files together are NONE', () => {
    expect(classify([...TRUST_TOOLING_FILES])).toMatchObject({ ios: 'false', ios_tier: 'none', ios_compile: 'false' })
  })

  // Prove each of the files that really reach Swift, not just the first.
  it.each([
    'packages/protocol/schemas/hubs.ts',
    'packages/protocol/schemas/records.ts',
    'packages/protocol/crypto-labels.json',
    'packages/protocol/tools/codegen.ts',
    'packages/protocol/tools/schema-registry.ts',
  ])('%s alone is still FULL', (f) => {
    expect(classify([f])).toMatchObject({ ios: 'true', ios_tier: 'full', ios_compile: 'true' })
  })

  it.each([
    'packages/protocol/schemas/hubs.ts',
    'packages/protocol/crypto-labels.json',
    'packages/protocol/tools/codegen.ts',
    'packages/protocol/tools/schema-registry.ts',
    'apps/ios/Sources/App/Info.plist',
    'apps/ios/project.yml',
    'packages/crypto/src/lib.rs',
  ])('trust tooling together with %s is still FULL', (f) => {
    expect(classify([...TRUST_TOOLING_FILES, f])['ios_tier']).toBe('full')
  })

  it('a diff moving a pinned value in the iOS client stays FULL, with or without the snapshot', () => {
    const ats = 'apps/ios/Sources/App/Info.plist'
    expect(classify([ats])['ios_tier']).toBe('full')
    expect(classify([ats, SNAPSHOT_PATH])['ios_tier']).toBe('full')
  })

  it('a diff moving a pinned value in a client the iOS gate never builds does not reach it', () => {
    // Unchanged by this work: apps/android and apps/desktop alone have never
    // scheduled the iOS gate. The snapshot file no longer adds a reason to.
    const android = ['apps/android/app/src/main/res/xml/network_security_config.xml', SNAPSHOT_PATH]
    expect(classify(android)).toMatchObject({ android: 'true', ios_tier: 'none' })
    expect(classify(['apps/desktop/tauri.conf.json', SNAPSHOT_PATH])).toMatchObject({ ios_tier: 'none' })
  })

  it('break-it: with the protocol entries struck from the exclusion list, the same files read FULL — the rail measures the carve-out', () => {
    const text = read('.github/scripts/detect-changed-platforms.sh')
    const entries = protocolExclusions(text)
    expect(entries).toHaveLength(TRUST_TOOLING_FILES.length)
    let mutatedText = text
    for (const e of entries) mutatedText = mutatedText.replace(`|${e}`, '')
    expect(protocolExclusions(mutatedText), 'the mutation struck every protocol entry').toEqual([])
    const dir = mkdtempSync(join(tmpdir(), 'ios-trust-tooling-'))
    const mutated = join(dir, 'detect-changed-platforms.sh')
    writeFileSync(mutated, mutatedText, { mode: 0o755 })
    expect(classifyWith(mutated, [SNAPSHOT_PATH])).toMatchObject({ ios: 'true', ios_tier: 'full', ios_compile: 'true' })
    expect(classifyWith(mutated, [...TRUST_TOOLING_FILES])['ios_tier']).toBe('full')
  })
})

describe('iosIsolationFor — the merge-group verdict', () => {
  it("#3106's file list is batchable: no isolation, nothing to read", async () => {
    const files = [
      'packages/protocol/tools/trust-snapshot.ts',
      'packages/protocol/tools/trust-snapshot.test.ts',
      'packages/protocol/trust.snapshot.json',
    ]
    expect(await iosIsolationFor(files, PR, NO_READS)).toEqual({ isolate: false, checked: [] })
    expect(await iosIsolationFor([...TRUST_TOOLING_FILES], PR, NO_READS)).toEqual({ isolate: false, checked: [] })
  })

  // Break it: each of these can really break the iOS gate and must still isolate.
  it.each([
    ['a protocol schema', 'packages/protocol/schemas/hubs.ts'],
    ['the crypto label registry', 'packages/protocol/crypto-labels.json'],
    ['the codegen', 'packages/protocol/tools/codegen.ts'],
    ['the schema registry', 'packages/protocol/tools/schema-registry.ts'],
    ['a protocol template', 'packages/protocol/templates/mutual-aid.json'],
    ['a hand-written protocol file', 'packages/protocol/crypto-format.ts'],
    ['a protocol file nobody has classified yet', 'packages/protocol/tools/brand-new-codegen-step.ts'],
    ['the iOS app', 'apps/ios/Sources/ViewModels/DashboardViewModel.swift'],
    ['the iOS project', 'apps/ios/project.yml'],
    ['the FFI', 'packages/crypto/src/ffi.rs'],
  ])('%s riding along with trust tooling still isolates', async (_name, file) => {
    const v = await iosIsolationFor([...TRUST_TOOLING_FILES, file], PR, NO_READS)
    expect(v.isolate).toBe(true)
    expect(v.isolate && v.reasons.map((r) => r.split(':')[0])).toEqual([file])
  })

  it('a sibling that merely LOOKS like trust tooling is not carved out', async () => {
    for (const f of ['packages/protocol/tools/trust-snapshot-extra.ts', 'packages/protocol/trust.snapshot.json.bak', 'packages/protocol/schemas/trust-snapshot.ts']) {
      const v = await iosIsolationFor([f], PR, NO_READS)
      expect(v.isolate, f).toBe(true)
    }
  })
})
