import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname, normalize } from 'node:path'
import {
  classifyIosGateFile, isContentCheckedPath, iosIsolationFor,
  plistChangeBeyondVersion, enStringsChangeBeyondAdditions,
  packageJsonChangeReachingGate, ciYmlChangeReachingGate, ciJobBlocks,
  IOS_GATE_HARNESS, IOS_GATE_BUN_SCRIPTS,
  type IosIsolationReads,
} from '../../orchestrator/src/ios-isolation.js'

const ROOT = join(__dirname, '..', '..')
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

const PLIST = 'apps/ios/Sources/App/Info.plist'
const BASE_SHA = '1'.repeat(40)
const HEAD_SHA = '2'.repeat(40)
const PR = { baseRefName: 'main', headRefOid: HEAD_SHA }

/** Reads that serve `files[path] = [base, head]`; a missing entry is an
 *  unreadable file. */
function reads(files: Record<string, [string, string]>, mergeBase: string | null = BASE_SHA): IosIsolationReads & { asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    readMergeBase: async () => mergeBase ?? undefined,
    readFileAt: async (path, sha) => {
      asked.push(path)
      const pair = files[path]
      if (pair === undefined) return undefined
      return sha === BASE_SHA ? pair[0] : sha === HEAD_SHA ? pair[1] : undefined
    },
  }
}

const bumpPlist = (text: string, to: string): string =>
  text.replace(/(<key>CFBundleShortVersionString<\/key>\s*<string>)[^<]*/, `$1${to}`)

describe('classifyIosGateFile — what one file means for "can this fail the iOS gate"', () => {
  it.each([
    ['apps/ios/Tests/UI/ActiveCallUITests.swift', 'risky'],
    ['apps/ios/Tests/UI/Helpers/BaseUITest.swift', 'risky'],
    ['apps/ios/Tests/UI/ci-smoke.txt', 'risky'],
    ['apps/ios/Tests/Unit/DashboardCallsTests.swift', 'risky'],
    ['apps/ios/Sources/ViewModels/DashboardViewModel.swift', 'risky'],
    ['apps/ios/project.yml', 'risky'],
    ['apps/ios/scripts/ui-tests.py', 'risky'],
    ['packages/crypto/src/hpke.rs', 'risky'],
    ['packages/protocol/schemas/hubs.ts', 'risky'],
    ['packages/i18n/tools/i18n-codegen.ts', 'risky'],
    ['packages/i18n/languages.ts', 'risky'],
    ['.github/workflows/ios-e2e.yml', 'risky'],
    ['scripts/ci/mac-runner-disk-guard.sh', 'risky'],
    ['bun.lock', 'risky'],
    ['.mise.toml', 'risky'],
    ['tsconfig.json', 'risky'],
    [PLIST, 'content'],
    ['packages/i18n/locales/en.json', 'content'],
    ['package.json', 'content'],
    ['.github/workflows/ci.yml', 'content'],
    ['packages/i18n/locales/de.json', 'inert'],
    ['packages/i18n/deferred.json', 'inert'],
    ['apps/ios/README.md', 'inert'],
    ['CHANGELOG.md', 'inert'],
    ['apps/worker/routes/hubs.ts', 'inert'],
    ['apps/android/app/build.gradle.kts', 'inert'],
    ['apps/desktop/tauri.conf.json', 'inert'],
    ['scripts/ci/apt-install-bounded.sh', 'inert'],
    ['scripts/test-ios.sh', 'inert'], // the LOCAL runner; CI never calls it
    ['.github/workflows/tauri-release.yml', 'inert'],
  ])('%s → %s', (path, kind) => {
    expect(classifyIosGateFile(path).kind).toBe(kind)
  })

  it('serves content reads ONLY for the content-checked shapes', () => {
    expect(isContentCheckedPath('package.json')).toBe(true)
    expect(isContentCheckedPath(PLIST)).toBe(true)
    expect(isContentCheckedPath('apps/worker/routes/hubs.ts')).toBe(false)
    expect(isContentCheckedPath('apps/ios/../../etc/Info.plist')).toBe(false)
  })
})

describe('the content checks — the change, not the file name', () => {
  const plist = read(PLIST)
  const en = read('packages/i18n/locales/en.json')
  const pkg = read('package.json')
  const ci = read('.github/workflows/ci.yml')

  it('Info.plist: a version-string swap is not risk; anything else is', () => {
    expect(plistChangeBeyondVersion(plist, bumpPlist(plist, '9.9.9'))).toBeUndefined()
    expect(plistChangeBeyondVersion(plist, plist.replace(/<key>CFBundleVersion<\/key>(\s*)<string>[^<]*/, '<key>CFBundleVersion</key>$1<string>42'))).toBeUndefined()
    // an ATS / URL-scheme / background-mode edit in the same file
    const ats = bumpPlist(plist, '9.9.9').replace('</dict>\n</plist>', '\t<key>NSAppTransportSecurity</key>\n\t<dict/>\n</dict>\n</plist>')
    expect(ats).not.toBe(bumpPlist(plist, '9.9.9'))
    expect(plistChangeBeyondVersion(plist, ats)).toMatch(/more than/)
  })

  it('en.json: an added key is not risk; a changed or removed English value is', () => {
    const obj = JSON.parse(en) as Record<string, unknown>
    const added = JSON.stringify({ ...obj, zzNewSection: { fresh: 'Brand new string' } }, null, 2)
    expect(enStringsChangeBeyondAdditions(en, added)).toBeUndefined()
    const [section] = Object.keys(obj).filter((k) => typeof obj[k] === 'object')
    const inner = obj[section as string] as Record<string, unknown>
    const [key] = Object.keys(inner)
    const changed = JSON.stringify({ ...obj, [section as string]: { ...inner, [key as string]: 'Different English' } })
    expect(enStringsChangeBeyondAdditions(en, changed)).toMatch(new RegExp(`${section}\\.${key}`))
    const { [section as string]: _gone, ...removed } = obj
    expect(enStringsChangeBeyondAdditions(en, JSON.stringify(removed))).toMatch(/removes/)
  })

  it('package.json: version and an unrelated script are not risk; a dependency or a gate script is', () => {
    const obj = JSON.parse(pkg) as { version: string; scripts: Record<string, string>; devDependencies?: Record<string, string> }
    expect(packageJsonChangeReachingGate(pkg, JSON.stringify({ ...obj, version: '99.0.0' }))).toBeUndefined()
    expect(packageJsonChangeReachingGate(pkg, JSON.stringify({ ...obj, scripts: { ...obj.scripts, 'test:new-thing': 'bunx vitest run x' } }))).toBeUndefined()
    expect(packageJsonChangeReachingGate(pkg, JSON.stringify({ ...obj, devDependencies: { ...obj.devDependencies, 'left-pad': '1.0.0' } }))).toMatch(/devDependencies/)
    expect(packageJsonChangeReachingGate(pkg, JSON.stringify({ ...obj, scripts: { ...obj.scripts, codegen: 'echo broken' } }))).toMatch(/codegen/)
    expect(packageJsonChangeReachingGate(pkg, JSON.stringify({ ...obj, scripts: { ...obj.scripts, postinstall: 'rm -rf /' } }))).toMatch(/postinstall/)
    // transitively: a script the gate's script calls
    const viaRef = { ...obj.scripts, codegen: 'bun run gen:inner', 'gen:inner': 'bun run packages/protocol/tools/codegen.ts' }
    expect(packageJsonChangeReachingGate(JSON.stringify({ ...obj, scripts: viaRef }), JSON.stringify({ ...obj, scripts: { ...viaRef, 'gen:inner': 'echo broken' } }))).toMatch(/gen:inner/)
  })

  it('ci.yml: a non-iOS job edit is not risk; an iOS job, the changes job, or workflow-level config is', () => {
    const blocks = ciJobBlocks(ci)
    expect(blocks).toBeDefined()
    const edit = (job: string): string => {
      const block = blocks?.jobs.get(job)
      expect(block, `ci.yml has a ${job} job`).toBeDefined()
      return ci.replace(block as string, `${block as string}\n      # edited`)
    }
    expect(ciYmlChangeReachingGate(ci, edit('desktop-rust'))).toBeUndefined()
    expect(ciYmlChangeReachingGate(ci, edit('backend-unit'))).toBeUndefined()
    expect(ciYmlChangeReachingGate(ci, edit('ios-build-test'))).toMatch(/ios-build-test/)
    expect(ciYmlChangeReachingGate(ci, edit('ios-e2e'))).toMatch(/ios-e2e/)
    expect(ciYmlChangeReachingGate(ci, edit('changes'))).toMatch(/changes/)
    expect(ciYmlChangeReachingGate(ci, ci.replace(/^jobs:/m, 'env:\n  NEW: "1"\njobs:'))).toMatch(/workflow-level/)
  })

  it('the real ci.yml\'s iOS gate jobs are the ones the marker finds', () => {
    const blocks = ciJobBlocks(ci)
    const ios = [...(blocks?.jobs ?? [])].filter(([, b]) => /\boutputs\.ios\b/.test(b)).map(([n]) => n)
    expect(ios).toEqual(expect.arrayContaining(['changes', 'ios-build-test', 'ios-compile-check', 'ios-e2e']))
  })
})

// ---------------------------------------------------------------------------
// The binding: IOS_GATE_HARNESS and IOS_GATE_BUN_SCRIPTS are what the
// queue-only iOS jobs actually run. A new step that runs a new script must
// fail here, or that script silently becomes "inert" and batchable.
// ---------------------------------------------------------------------------

/** Lines that execute — comments stripped, so a file a comment merely
 *  mentions is not demanded. */
function executable(text: string, path: string): string {
  const marker = path.endsWith('.ts') ? /^\s*(\/\/|\*|\/\*)/ : /^\s*#/
  return text.split('\n').filter((l) => !marker.test(l)).join('\n')
}

const SCRIPT_REF = /(?:^|[\s"'`=(/:}])((?:\.github\/(?:scripts|actions|workflows)|(?:apps\/ios\/|packages\/[a-z0-9-]+\/)?scripts)\/[A-Za-z0-9_./-]+\.(?:sh|py|ts|mjs|js|ya?ml))/g

/** The queue-only iOS jobs' own text: ios-e2e.yml, plus every ci.yml job
 *  gated on `revalidate` AND `outputs.ios`. */
function gateSources(): { path: string; text: string; dir: string }[] {
  const ci = ciJobBlocks(read('.github/workflows/ci.yml'))
  const jobs = [...(ci?.jobs ?? [])].filter(([, b]) => /if:.*revalidate.*outputs\.ios|if:.*outputs\.ios.*revalidate/.test(b))
  expect(jobs.map(([n]) => n).sort()).toEqual(['ios-build-test', 'ios-e2e'])
  return [
    { path: '.github/workflows/ios-e2e.yml', text: read('.github/workflows/ios-e2e.yml'), dir: '' },
    ...jobs.map(([n, b]) => ({ path: `ci.yml#${n}`, text: b, dir: '' })),
  ]
}

/** A reference resolved the way the steps would: from the repo root, or
 *  from a `working-directory` the steps use, or from the referring file's
 *  own directory. */
function resolveRef(ref: string, fromDir: string): string | undefined {
  const clean = ref.replace(/^\.\//, '')
  for (const base of ['', fromDir, 'packages/crypto', 'apps/ios']) {
    const p = normalize(join(base, clean))
    if (existsSync(join(ROOT, p))) return p
  }
  return undefined
}

describe('IOS_GATE_HARNESS is bound to what the queue-only iOS jobs run', () => {
  it('every repo script the iOS jobs run — transitively — is classified risky', () => {
    const seen = new Set<string>()
    const unresolved: string[] = []
    const inert: string[] = []
    const queue = gateSources()
    while (queue.length > 0) {
      const src = queue.shift() as { path: string; text: string; dir: string }
      for (const m of executable(src.text, src.path).matchAll(SCRIPT_REF)) {
        const ref = m[1] as string
        const path = resolveRef(ref, src.dir)
        if (path === undefined) { unresolved.push(`${src.path} → ${ref}`); continue }
        if (seen.has(path)) continue
        seen.add(path)
        if (classifyIosGateFile(path).kind !== 'risky') inert.push(`${path} (from ${src.path})`)
        queue.push({ path, text: read(path), dir: dirname(path) })
      }
    }
    // Every apps/ios script is risky as a tree; walk them too, they are the
    // harness the workflow calls by name.
    for (const f of readdirSync(join(ROOT, 'apps/ios/scripts'))) {
      const path = `apps/ios/scripts/${f}`
      for (const m of executable(read(path), path).matchAll(SCRIPT_REF)) {
        const resolved = resolveRef(m[1] as string, 'apps/ios/scripts')
        if (resolved !== undefined && classifyIosGateFile(resolved).kind !== 'risky') inert.push(`${resolved} (from ${path})`)
      }
      const rootRefs = read(path).matchAll(/\$\{?ROOT\}?\/([A-Za-z0-9_./-]+\.(?:sh|py|ts))/g)
      for (const m of rootRefs) {
        const p = m[1] as string
        if (existsSync(join(ROOT, p)) && classifyIosGateFile(p).kind !== 'risky') inert.push(`${p} (from ${path})`)
      }
    }
    // The walk found the harness at all — these are the scripts it must reach.
    expect([...seen]).toEqual(expect.arrayContaining([
      'scripts/ci/mac-runner-disk-guard.sh', 'apps/ios/scripts/ui-tests.py', 'apps/ios/scripts/native-backend.sh',
      '.github/scripts/classify-infra-failure.py', 'packages/crypto/scripts/build-mobile.sh',
    ]))
    expect(unresolved, 'references the binding cannot resolve — teach resolveRef, never drop them').toEqual([])
    expect(inert, 'scripts the iOS gate runs that the classifier calls inert — add them to IOS_GATE_HARNESS').toEqual([])
  })

  it('every IOS_GATE_HARNESS entry still exists (a stale entry is a renamed script the gate now runs unclassified)', () => {
    expect(IOS_GATE_HARNESS.filter((p) => !existsSync(join(ROOT, p)))).toEqual([])
  })

  it('every package.json script the iOS jobs run by name is in IOS_GATE_BUN_SCRIPTS', () => {
    const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts
    const named = new Set<string>()
    for (const src of gateSources()) {
      for (const m of executable(src.text, src.path).matchAll(/\bbun\s+run\s+([A-Za-z0-9:_.-]+)/g)) {
        if ((m[1] as string) in scripts) named.add(m[1] as string)
      }
    }
    expect(named.size).toBeGreaterThan(0)
    expect([...named].filter((n) => !IOS_GATE_BUN_SCRIPTS.includes(n))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The verdict over whole diffs — including the real #2548 PRs.
// ---------------------------------------------------------------------------

describe('iosIsolationFor — the verdict over a whole diff', () => {
  const plist = read(PLIST)
  const pkg = read('package.json')
  const pkgObj = JSON.parse(pkg) as Record<string, unknown> & { version: string; scripts: Record<string, string> }

  it('#2555 (release 0.21.8): version files + changelog — schedules the gate, NOT isolated', async () => {
    const files = [
      'CHANGELOG.md', 'apps/android/app/build.gradle.kts', 'apps/desktop/Cargo.toml', 'apps/desktop/tauri.conf.json',
      PLIST, 'deploy/helm/llamenos/Chart.yaml', 'package.json', 'Cargo.lock',
    ]
    const r = reads({
      [PLIST]: [plist, bumpPlist(plist, '0.21.8')],
      'package.json': [pkg, JSON.stringify({ ...pkgObj, version: '0.21.8' }, null, 2)],
    })
    expect(await iosIsolationFor(files, PR, r)).toEqual({ isolate: false, checked: [PLIST, 'package.json'] })
  })

  it('#2536 (a genuine iOS UI test PR) — isolated, naming the UI test', async () => {
    const files = ['apps/ios/Sources/ViewModels/DashboardViewModel.swift', 'apps/ios/Tests/UI/ActiveCallUITests.swift', 'apps/ios/Tests/Unit/DashboardCallsTests.swift']
    const v = await iosIsolationFor(files, PR, reads({}))
    expect(v.isolate).toBe(true)
    expect(v.isolate && v.reasons.some((x) => x.startsWith('apps/ios/Tests/UI/ActiveCallUITests.swift: an iOS UI test'))).toBe(true)
  })

  it('#2543 (Android + 22 locales, keys only added to en.json) — NOT isolated', async () => {
    const en = read('packages/i18n/locales/en.json')
    const enObj = JSON.parse(en) as Record<string, unknown>
    const locales = readdirSync(join(ROOT, 'packages/i18n/locales')).map((f) => `packages/i18n/locales/${f}`)
    const files = [...locales, 'packages/i18n/deferred.json', 'apps/android/app/src/main/java/X.kt']
    const r = reads({ 'packages/i18n/locales/en.json': [en, JSON.stringify({ ...enObj, zz: { confirmDelete: 'Type DELETE' } })] })
    expect(await iosIsolationFor(files, PR, r)).toEqual({ isolate: false, checked: ['packages/i18n/locales/en.json'] })
  })

  it('a path-risky file decides without reading any content', async () => {
    const r = reads({})
    const v = await iosIsolationFor(['apps/ios/Tests/UI/X.swift', 'package.json'], PR, r)
    expect(v.isolate).toBe(true)
    expect(r.asked).toEqual([])
  })

  it('a schedules-only diff with no content-checked file reads nothing and is batchable', async () => {
    const r = reads({})
    expect(await iosIsolationFor(['scripts/ci/apt-install-bounded.sh', 'apps/worker/x.ts'], PR, r)).toEqual({ isolate: false, checked: [] })
    expect(r.asked).toEqual([])
  })

  describe('fails toward ISOLATION when it cannot look', () => {
    it('an unreadable merge base isolates', async () => {
      const v = await iosIsolationFor([PLIST], PR, reads({}, null))
      expect(v.isolate && v.reasons[0]).toMatch(/merge base could not be read/)
    })

    it('an unreadable (or added/deleted) content-checked file isolates', async () => {
      const v = await iosIsolationFor([PLIST], PR, reads({}))
      expect(v.isolate && v.reasons[0]).toMatch(/could not be read/)
    })
  })

  // Break it: a rule that stops over-matching by matching nothing presents
  // as a merge-queue outage. Each of these is a diff that genuinely can fail
  // the shared Mac gate, and each must still isolate.
  describe('break-it: diffs that genuinely must form their own group still do', () => {
    it.each<[string, string[], Record<string, [string, string]>]>([
      ['a UI test hidden in a mostly-backend PR', ['apps/worker/routes/a.ts', 'apps/worker/routes/b.ts', 'apps/ios/Tests/UI/Helpers/BaseUITest.swift'], {}],
      ['a release-shaped PR that also edits a Swift file', ['CHANGELOG.md', 'package.json', PLIST, 'apps/ios/Sources/App/AppState.swift'], {}],
      ['the UI test shard list', ['apps/ios/Tests/UI/ci-smoke.txt'], {}],
      ['the Mac disk guard the iOS jobs run', ['scripts/ci/mac-runner-disk-guard.sh'], {}],
      ['the FFI', ['packages/crypto/src/ffi.rs'], {}],
      ['a protocol schema', ['packages/protocol/schemas/hubs.ts'], {}],
      ['a lockfile bump', ['bun.lock', 'package.json'], {}],
      ['Info.plist with an ATS change riding a version bump', [PLIST], {
        [PLIST]: [plist, bumpPlist(plist, '0.21.8').replace('</dict>\n</plist>', '\t<key>NSAppTransportSecurity</key>\n\t<dict/>\n</dict>\n</plist>')],
      }],
      ['package.json changing the codegen the gate runs', ['package.json'], {
        'package.json': [pkg, JSON.stringify({ ...pkgObj, scripts: { ...pkgObj.scripts, codegen: 'true' } })],
      }],
      ['an English string a UI test matches', ['packages/i18n/locales/en.json'], {
        'packages/i18n/locales/en.json': ['{"triage":{"status":"In progress"}}', '{"triage":{"status":"Underway"}}'],
      }],
      ['ci.yml editing the ios-e2e job', ['.github/workflows/ci.yml'], (() => {
        const ci = read('.github/workflows/ci.yml')
        const block = ciJobBlocks(ci)?.jobs.get('ios-e2e') as string
        return { '.github/workflows/ci.yml': [ci, ci.replace(block, block.replace('tier:', 'tier: full #'))] as [string, string] }
      })()],
    ])('%s', async (_name, files, content) => {
      const v = await iosIsolationFor(files, PR, reads(content))
      expect(v.isolate).toBe(true)
    })
  })
})
