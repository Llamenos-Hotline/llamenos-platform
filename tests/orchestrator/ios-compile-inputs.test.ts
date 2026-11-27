import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, normalize } from 'node:path'
import { describe, it, expect } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { ciJobBlocks } from '../../orchestrator/src/ios-isolation'

/**
 * Rail for #3012: `ios-compile-check` runs on one of the only two self-hosted
 * Macs (16 GiB, swapping at two concurrent iOS jobs), so it is gated on the
 * NARROW `ios_compile` flag rather than the blast-radius `ios` flag. That is
 * only safe while the flag's regex covers every path the job actually builds
 * from — and a hand-kept list silently rots the first time the build grows a
 * dependency (an under-trigger does not fail, it stops compiling iOS for a
 * change that breaks it).
 *
 * So the regex is not what is trusted here. This file DERIVES the job's real
 * inputs from the build itself and fails when one is not matched by the real
 * classifier (`.github/scripts/detect-changed-platforms.sh`, run as a process):
 *
 *   1. apps/ios/project.yml — every source/dependency path that leaves apps/ios
 *   2. apps/ios/Package.swift — every local `path:` that leaves apps/ios
 *   3. the ios-compile-check job's own steps — every repo script it runs
 *      (transitively), every `bun run <script>` and the TypeScript import
 *      closure of what that script executes, every `hashFiles(...)` cache
 *      input, `bun install`'s manifest + lockfile, and the workflow file and
 *      classifier that define the gate
 *
 * and each of those is asserted to set `ios_compile=true`. The break-it tests
 * at the bottom drop a dependency from the classifier and prove this check
 * goes red — a guard that has never been seen to fail is not a guard.
 */

const ROOT = join(__dirname, '..', '..')
const SCRIPT = '.github/scripts/detect-changed-platforms.sh'
const JOB = 'ios-compile-check'
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')
const isDir = (p: string): boolean => existsSync(join(ROOT, p)) && statSync(join(ROOT, p)).isDirectory()

/** One input the job reads, and why we believe it. */
interface Input { path: string; via: string }

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/** Comment-stripped text: a path a comment merely mentions is not an input. */
function executable(text: string, path: string): string {
  const marker = path.endsWith('.ts') || path.endsWith('.tsx') ? /^\s*(\/\/|\*|\/\*)/ : /^\s*#/
  return text.split('\n').filter((l) => !marker.test(l)).join('\n')
}

/** 1. project.yml: any string value that is a relative path leaving apps/ios. */
function projectYmlInputs(): Input[] {
  const out: Input[] = []
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      if (!node.startsWith('../')) return
      const repoPath = normalize(join('apps/ios', node))
      if (!repoPath.startsWith('apps/ios/')) out.push({ path: repoPath, via: 'apps/ios/project.yml' })
    } else if (Array.isArray(node)) node.forEach(walk)
    else if (node !== null && typeof node === 'object') Object.values(node).forEach(walk)
  }
  walk(parseYaml(read('apps/ios/project.yml')))
  return out
}

/** 2. Package.swift: local `path:` arguments that leave apps/ios. */
function packageSwiftInputs(): Input[] {
  const out: Input[] = []
  for (const m of executable(read('apps/ios/Package.swift'), 'Package.swift').matchAll(/path:\s*"([^"]+)"/g)) {
    const repoPath = normalize(join('apps/ios', m[1] as string))
    if (!repoPath.startsWith('apps/ios/')) out.push({ path: repoPath, via: 'apps/ios/Package.swift' })
  }
  return out
}

/** tsconfig `paths` aliases -> repo directories/files, read from tsconfig.json. */
function tsAliases(): [prefix: string, target: string][] {
  const paths = (JSON.parse(read('tsconfig.json')) as { compilerOptions: { paths: Record<string, string[]> } })
    .compilerOptions.paths
  return Object.entries(paths).map(([k, v]) => [k.replace(/\*$/, ''), normalize((v[0] as string).replace(/\*$/, ''))])
}

function resolveTs(spec: string, fromFile: string): string | undefined {
  let base: string | undefined
  if (spec.startsWith('.')) base = normalize(join(dirname(fromFile), spec))
  else {
    const alias = tsAliases().find(([p]) => spec === p || spec.startsWith(p) && p.endsWith('/'))
    if (alias !== undefined) base = normalize(join(alias[1], spec.slice(alias[0].length)))
  }
  if (base === undefined) return undefined
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, `${base}.json`, join(base, 'index.ts')]) {
    if (existsSync(join(ROOT, cand)) && !isDir(cand)) return cand
  }
  return undefined
}

/** Repo paths a TS file READS at run time through `__dirname`-relative
 *  constants: `const X = resolve(__dirname, '../y')` and `readFileSync(X)` /
 *  `readdirSync(X)` / `existsSync(X)`. Writes (`writeFileSync`/`mkdirSync`) are
 *  outputs, not inputs, and are deliberately not collected. */
function dirnameReads(file: string, text: string): string[] {
  const consts = new Map<string, string>()
  for (const m of text.matchAll(/const\s+(\w+)\s*=\s*(?:resolve|join)\(\s*__dirname\s*,\s*([^)]*)\)/g)) {
    const segs = [...(m[2] as string).matchAll(/'([^']*)'/g)].map((s) => s[1] as string)
    consts.set(m[1] as string, normalize(join(dirname(file), ...segs)))
  }
  const out: string[] = []
  for (const [name, path] of consts) {
    if (new RegExp(`(?:readFileSync|readdirSync|existsSync|statSync)\\(\\s*${name}\\b`).test(text)
      || new RegExp(`(?:readFileSync|readdirSync)\\(\\s*(?:join|resolve)\\(\\s*${name}\\b`).test(text)) out.push(path)
  }
  return out
}

/** The TS import closure of `entry`, plus the `__dirname`-relative paths each
 *  file in it reads. Relative and tsconfig-aliased imports only; bare package
 *  imports are the lockfile's business. */
function tsClosure(entry: string): Input[] {
  const seen = new Set<string>()
  const out: Input[] = []
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.shift() as string
    if (seen.has(file)) continue
    seen.add(file)
    out.push({ path: file, via: `TS import closure of ${entry}` })
    if (!file.endsWith('.ts') && !file.endsWith('.tsx')) continue
    const text = executable(read(file), file)
    for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*|require\(\s*)['"]([^'"]+)['"]/g)) {
      const r = resolveTs(m[1] as string, file)
      if (r !== undefined) queue.push(r)
    }
    for (const p of dirnameReads(file, text)) out.push({ path: p, via: `read at run time by ${file}` })
  }
  return out
}

const SCRIPT_REF = /(?:^|[\s"'`=(/:}])((?:\.github\/(?:scripts|actions)|(?:packages\/[a-z0-9-]+\/)?scripts|packages\/[a-z0-9-]+\/tools)\/[A-Za-z0-9_./-]+\.(?:sh|py|ts|mjs|js))/g

function resolveRef(ref: string, fromDir: string): string | undefined {
  const clean = ref.replace(/^\.\//, '')
  for (const base of ['', fromDir, 'packages/crypto', 'apps/ios']) {
    const p = normalize(join(base, clean))
    if (existsSync(join(ROOT, p)) && !isDir(p)) return p
  }
  return undefined
}

/** `bun run <name>` -> the files its package.json script executes. */
function bunScriptEntries(name: string, seen = new Set<string>()): string[] {
  if (seen.has(name)) return []
  seen.add(name)
  const cmd = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts[name]
  if (cmd === undefined) return []
  const files: string[] = []
  for (const m of cmd.matchAll(/\bbun\s+run\s+([A-Za-z0-9:_.-]+)/g)) {
    const inner = m[1] as string
    if (existsSync(join(ROOT, inner)) && !isDir(inner)) files.push(inner)
    else files.push(...bunScriptEntries(inner, seen))
  }
  for (const m of cmd.matchAll(/(?:^|\s)((?:packages|scripts|apps)\/[A-Za-z0-9_./-]+\.(?:ts|sh|py|mjs|js))/g)) {
    if (existsSync(join(ROOT, m[1] as string))) files.push(m[1] as string)
  }
  return files
}

/** A `hashFiles('a/**\/*.rs', ...)` glob's static prefix -> a path the glob matches. */
function globProbe(glob: string): string {
  return glob.replace(/\*\*\//g, '').replace(/\*/g, 'probe')
}

/** 3. The job's own steps. */
function jobInputs(): Input[] {
  const workflow = '.github/workflows/ci.yml'
  const block = ciJobBlocks(read(workflow))?.jobs.get(JOB)
  expect(block, `${workflow} has a ${JOB} job`).toBeDefined()
  const text = executable(block as string, workflow)
  const out: Input[] = [
    // The file that defines the gate, and the classifier that schedules it: an
    // edit to either changes whether and how this job runs.
    { path: workflow, via: 'the workflow that defines the gate' },
    { path: SCRIPT, via: 'the classifier that decides whether the gate runs' },
  ]

  // Repo scripts the steps run, closed transitively over the scripts' own references.
  const queue: { path: string; text: string; dir: string }[] = [{ path: `${workflow}#${JOB}`, text, dir: '' }]
  const seen = new Set<string>()
  while (queue.length > 0) {
    const src = queue.shift() as { path: string; text: string; dir: string }
    for (const m of src.text.matchAll(SCRIPT_REF)) {
      const path = resolveRef(m[1] as string, src.dir)
      if (path === undefined) throw new Error(`${src.path} references ${m[1]}, which does not resolve — teach resolveRef, never drop the reference`)
      if (seen.has(path)) continue
      seen.add(path)
      out.push({ path, via: `a script ${JOB} runs (from ${src.path})` })
      queue.push({ path, text: executable(read(path), path), dir: dirname(path) })
    }
  }

  // `bun install --frozen-lockfile` reads the manifest, the lockfile and, because
  // the entry points are TypeScript with aliases, tsconfig.json.
  if (/\bbun install\b/.test(text)) {
    out.push({ path: 'package.json', via: '`bun install`' }, { path: 'bun.lock', via: '`bun install --frozen-lockfile`' })
  }
  const entries = new Set<string>()
  for (const m of text.matchAll(/\bbun\s+run\s+([A-Za-z0-9:_.-]+)/g)) {
    for (const e of bunScriptEntries(m[1] as string)) entries.add(e)
  }
  if (entries.size > 0) out.push({ path: 'tsconfig.json', via: 'bun resolves the entry points\' path aliases from it' })
  for (const entry of entries) out.push(...tsClosure(entry))

  // Cache inputs: a path the job keys a cache on is a path whose change must re-run it.
  for (const m of text.matchAll(/hashFiles\(([^)]*)\)/g)) {
    for (const g of (m[1] as string).matchAll(/'([^']+)'/g)) out.push({ path: globProbe(g[1] as string), via: 'hashFiles() cache key' })
  }
  // Local composite actions.
  for (const m of text.matchAll(/uses:\s*\.\/(\.github\/actions\/[A-Za-z0-9_./-]+)/g)) {
    out.push({ path: `${m[1] as string}/action.yml`, via: 'a local action the job uses' })
  }
  return out
}

/** Everything the job builds from, de-duplicated by path. */
function iosCompileInputs(): Input[] {
  const byPath = new Map<string, Input>()
  for (const i of [...projectYmlInputs(), ...packageSwiftInputs(), ...jobInputs()]) {
    if (i.path.startsWith('apps/ios/')) continue // IOS_RE's whole tree — covered by construction below
    if (!byPath.has(i.path)) byPath.set(i.path, i)
  }
  return [...byPath.values()]
}

// ---------------------------------------------------------------------------
// The real classifier, run as a process
// ---------------------------------------------------------------------------

function classify(files: string[], script = join(ROOT, SCRIPT)): Record<string, string> {
  const r = spawnSync('bash', [script], { input: files.join('\n'), encoding: 'utf8' })
  expect(r.status, `classifier failed: ${r.stderr}`).toBe(0)
  return Object.fromEntries(r.stdout.trim().split('\n').map((l) => l.split('=') as [string, string]))
}

/** A concrete changed-file path for an input: a directory input is probed with a file inside it. */
const probeOf = (path: string): string => (isDir(path) ? `${path}/__probe__` : path)

/** Async twin of `classify` so the ~90 inputs are classified concurrently. */
function classifyAsync(files: string[], script: string): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [script])
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => { out += d.toString() })
    child.stderr.on('data', (d: Buffer) => { err += d.toString() })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`classifier exited ${code}: ${err}`))
      resolve(Object.fromEntries(out.trim().split('\n').map((l) => l.split('=') as [string, string])))
    })
    child.stdin.end(files.join('\n'))
  })
}

/** The inputs the classifier at `script` does NOT send to `ios-compile-check`. */
async function uncovered(inputs: Input[], script = join(ROOT, SCRIPT)): Promise<Input[]> {
  const flags = await Promise.all(inputs.map((i) => classifyAsync([probeOf(i.path)], script)))
  return inputs.filter((_, n) => flags[n]?.['ios_compile'] !== 'true')
}

/** The classifier with `needle` struck out of the IOS_COMPILE_RE line only. */
function classifierWithout(needle: string): string {
  const lines = read(SCRIPT).split('\n')
  const idx = lines.findIndex((l) => l.startsWith('IOS_COMPILE_RE='))
  expect(idx, 'IOS_COMPILE_RE line exists').toBeGreaterThanOrEqual(0)
  const line = lines[idx] as string
  expect(line, `IOS_COMPILE_RE contains ${needle}`).toContain(needle)
  lines[idx] = line.replace(needle, '')
  const dir = mkdtempSync(join(tmpdir(), 'ios-compile-guard-'))
  const path = join(dir, 'detect-changed-platforms.sh')
  writeFileSync(path, lines.join('\n'))
  chmodSync(path, 0o755)
  return path
}

// ---------------------------------------------------------------------------

describe('ios-compile-check is gated on the narrow ios_compile flag (#3012)', () => {
  const inputs = iosCompileInputs()

  it('the derivation finds the real build inputs — it is not vacuously empty', () => {
    const paths = inputs.map((i) => i.path)
    expect(paths).toEqual(expect.arrayContaining([
      '.github/workflows/ci.yml',
      SCRIPT,
      'package.json',
      'bun.lock',
      'tsconfig.json',
      // project.yml's out-of-tree Swift sources
      'packages/protocol/generated/swift',
      // a script the job runs
      'scripts/ci/mac-runner-disk-guard-wait.sh',
      // what `bun run codegen` / `i18n:codegen` execute
      'packages/protocol/tools/codegen.ts',
      'packages/protocol/tools/schema-registry.ts',
      'packages/i18n/tools/i18n-codegen.ts',
      // the crypto xcframework build, and the cache key's inputs
      'packages/crypto/scripts/build-mobile.sh',
      'packages/crypto/Cargo.toml',
    ]))
    // And it reaches the data the codegen READS, not just the code it imports.
    expect(paths.some((p) => p.startsWith('packages/protocol/') && p.endsWith('crypto-labels.json'))).toBe(true)
    expect(paths.some((p) => p.startsWith('packages/i18n/locales'))).toBe(true)
  })

  it('EVERY path the job builds from sets ios_compile — derived from the build, not from the regex', async () => {
    const missing = (await uncovered(inputs)).map((i) => `${i.path}   (${i.via})`)
    expect(missing, 'iOS build inputs the ios_compile filter does not match — a change to one would stop compiling iOS; add them to IOS_COMPILE_RE').toEqual([])
  })

  it('every file under apps/ios sets ios_compile (the whole tree is an input)', () => {
    for (const f of ['apps/ios/Sources/App/AppState.swift', 'apps/ios/Tests/Unit/X.swift', 'apps/ios/project.yml', 'apps/ios/Package.swift']) {
      expect(classify([f])['ios_compile'], f).toBe('true')
    }
  })

  it('ios_compile implies ios — the narrow flag can never be true while the wide one is false', async () => {
    const flags = await Promise.all(inputs.map((i) => classifyAsync([probeOf(i.path)], join(ROOT, SCRIPT))))
    inputs.forEach((i, n) => expect(flags[n]?.['ios'], i.path).toBe('true'))
  })

  it('a desktop-only or worker-only push does not schedule ios-compile-check', () => {
    for (const files of [
      ['apps/desktop/src/lib.rs', 'apps/desktop/voice/src/core.rs', 'apps/desktop/Cargo.lock'],
      ['src/client/lib/voice.ts', 'src/client/routes/__root.tsx', 'tests/voice-desktop.spec.ts'],
      ['apps/worker/routes/hubs.ts', 'apps/worker/services/records.ts', 'drizzle/0001_x.sql'],
      ['apps/android/app/src/main/java/X.kt'],
      ['packages/shared/types.ts', 'packages/test-specs/features/core/x.feature'],
      ['scripts/fetch-linphone-sdk.sh', 'scripts/dev-bun.sh', 'vitest.unit.config.ts'],
      ['deploy/docker/docker-compose.yml', 'README.md'],
    ]) {
      const out = classify(files)
      expect(out['ios_compile'], files.join(', ')).toBe('false')
    }
  })

  it('a crate, protocol, i18n, iOS, toolchain or gate-definition change DOES schedule it', () => {
    for (const f of [
      'packages/crypto/src/encryption.rs',
      'packages/crypto/Cargo.lock',
      'packages/protocol/schemas/hubs.ts',
      'packages/protocol/crypto-labels.json',
      'packages/i18n/locales/de.json',
      'packages/i18n/tools/i18n-codegen.ts',
      'apps/ios/Sources/App/AppState.swift',
      'package.json',
      'bun.lock',
      '.github/workflows/ci.yml',
      SCRIPT,
      'scripts/ci/mac-runner-disk-guard.sh',
    ]) {
      expect(classify([f])['ios_compile'], f).toBe('true')
    }
  })

  it('one iOS file among desktop files still schedules it', () => {
    expect(classify(['apps/desktop/src/lib.rs', 'packages/protocol/schemas/hubs.ts', 'apps/worker/app.ts'])['ios_compile']).toBe('true')
  })

  it('ci.yml gates the job on ios_compile (not ios), and the platform-suite audit agrees', () => {
    const ci = read('.github/workflows/ci.yml')
    const blocks = ciJobBlocks(ci)
    const block = blocks?.jobs.get(JOB) as string
    const ifLine = /^ {4}if:\s*(.*)$/m.exec(block)?.[1] ?? ''
    expect(ifLine).toContain("needs.changes.outputs.ios_compile == 'true'")
    expect(ifLine).not.toMatch(/outputs\.ios\b/)
    expect(blocks?.jobs.get('changes') as string).toContain('ios_compile: ${{ steps.filter.outputs.ios_compile }}')
    // platform-suite-coverage must not call a deliberate skip "wiring drift".
    const audit = blocks?.jobs.get('platform-suite-coverage') as string
    expect(audit).toContain('IOS_COMPILE: ${{ needs.changes.outputs.ios_compile }}')
    expect(audit).toMatch(/\[ "\$IOS_COMPILE" = "true" \] && \[ "\$R_IOS_COMPILE" = "skipped" \]/)
  })
})

describe('break-it: the guard FAILS when a dependency is dropped from the filter (#3012)', () => {
  const inputs = iosCompileInputs()

  // Each term is one thing the build depends on. Strike it from the real
  // classifier and the derived check must name the input that fell out.
  it.each<[needle: string, mustReport: string]>([
    // #3108: protocol is enumerated (the trust snapshot tooling beside it reaches
    // no build), so the term is the whole group, and each part is struck alone.
    ['packages/protocol/(schemas/|templates/|generated/|(README\\.md|crypto-format\\.ts|crypto-formats\\.json|crypto-labels\\.json|package\\.json|template-types\\.ts)$|tools/(codegen|schema-registry)\\.ts$)|', 'packages/protocol/generated/swift'],
    ['generated/|', 'packages/protocol/generated/swift'],
    ['|tools/(codegen|schema-registry)\\.ts$', 'packages/protocol/tools/codegen.ts'],
    ['packages/i18n/|', 'packages/i18n/tools/i18n-codegen.ts'],
    ['packages/crypto/|', 'packages/crypto/scripts/build-mobile.sh'],
    ['|bun\\.lock', 'bun.lock'],
    ['|tsconfig[^/]*\\.json$', 'tsconfig.json'],
    ['|scripts/ci/mac-runner-disk-guard(-wait)?\\.sh$', 'scripts/ci/mac-runner-disk-guard-wait.sh'],
    ['|\\.github/workflows/ci\\.yml$', '.github/workflows/ci.yml'],
    ['|\\.github/scripts/detect-changed-platforms\\.sh$', SCRIPT],
  ])('dropping %s reports %s', async (needle, mustReport) => {
    const mutated = classifierWithout(needle)
    const reported = (await uncovered(inputs, mutated)).map((i) => i.path)
    expect(reported, `the derived guard did not notice ${needle} was dropped`).toContain(mustReport)
  })

  it('the un-mutated classifier reports nothing, so the failures above are the mutation\'s', async () => {
    expect(await uncovered(inputs)).toEqual([])
  })

  it('a dependency added to the build but not to the filter is caught', async () => {
    // Simulate the rot the guard exists for: the build grows an input the
    // classifier has never heard of.
    const grown: Input[] = [...inputs, { path: 'packages/brand-new-ffi/Cargo.toml', via: 'a hypothetical new build input' }]
    const missing = (await uncovered(grown)).map((i) => i.path)
    expect(missing).toEqual(['packages/brand-new-ffi/Cargo.toml'])
  })
})
