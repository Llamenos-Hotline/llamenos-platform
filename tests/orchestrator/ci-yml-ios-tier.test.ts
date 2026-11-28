import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

/**
 * #3131 — `.github/workflows/ci.yml` is named in SHARED_DEPS_RE, IOS_FULL_RE
 * and IOS_COMPILE_RE, so any diff touching it used to earn the FULL iOS tier
 * (326 tests, two serial waves on the only two self-hosted Macs), even one that
 * changes nothing a job can observe: #3120's whole ci.yml diff is five YAML
 * comment lines.
 *
 * `detect-changed-platforms.sh` now classifies ci.yml's diff by the two PARSED
 * workflows (`CI_YML_BASE_FILE` / `CI_YML_HEAD_FILE`): `inert` (identical node
 * graph) → no platform flag; `outside_ios` (only hosted-Linux jobs that neither
 * feed nor read an iOS job changed) → smoke and no compile; anything else, and
 * every failure to decide → FULL, exactly as before.
 *
 * Most cases run against the REAL ci.yml with one edit applied, so the answer is
 * about the workflow CI actually runs. Nothing here touches git: the file is read
 * from the working tree (present in `fleet/verify`'s `git archive` export) and
 * the two sides are written to a temp dir.
 */

const ROOT = join(__dirname, '..', '..')
const SCRIPT = join(ROOT, '.github/scripts/detect-changed-platforms.sh')
const CI = '.github/workflows/ci.yml'
const REAL = readFileSync(join(ROOT, CI), 'utf8')

type Outputs = Record<string, string>
interface Run { out: Outputs; stderr: string }

function run(files: string[], sides?: { base: string | undefined; head: string | undefined }, env: NodeJS.ProcessEnv = process.env): Run {
  const extra: NodeJS.ProcessEnv = {}
  if (sides !== undefined) {
    const dir = mkdtempSync(join(tmpdir(), 'ci-yml-tier-'))
    if (sides.base !== undefined) { extra.CI_YML_BASE_FILE = join(dir, 'base.yml'); writeFileSync(extra.CI_YML_BASE_FILE, sides.base) }
    else extra.CI_YML_BASE_FILE = join(dir, 'absent-base.yml')
    if (sides.head !== undefined) { extra.CI_YML_HEAD_FILE = join(dir, 'head.yml'); writeFileSync(extra.CI_YML_HEAD_FILE, sides.head) }
    else extra.CI_YML_HEAD_FILE = join(dir, 'absent-head.yml')
  }
  const r = spawnSync('bash', [SCRIPT], { input: files.join('\n') + '\n', encoding: 'utf8', env: { ...env, ...extra } })
  expect(r.status, `classifier failed: ${r.stderr}`).toBe(0)
  const out = Object.fromEntries(r.stdout.trim().split('\n').map((l) => l.split('=') as [string, string]))
  return { out, stderr: r.stderr }
}

/** The classification of a ci.yml-only diff from `base` to `head`. */
const ciDiff = (base: string, head: string): Run => run([CI], { base, head })

/** Exactly one occurrence of `anchor` in `text`, with `insert` placed after it. */
function after(text: string, anchor: string, insert: string): string {
  const at = text.indexOf(anchor)
  expect(at, `anchor not found in ci.yml: ${JSON.stringify(anchor)}`).toBeGreaterThanOrEqual(0)
  expect(text.indexOf(anchor, at + 1), `anchor is not unique in ci.yml: ${JSON.stringify(anchor)}`).toBe(-1)
  return text.slice(0, at + anchor.length) + insert + text.slice(at + anchor.length)
}

function replaceOnce(text: string, from: string, to: string): string {
  const at = text.indexOf(from)
  expect(at, `not found in ci.yml: ${JSON.stringify(from)}`).toBeGreaterThanOrEqual(0)
  expect(text.indexOf(from, at + 1), `not unique in ci.yml: ${JSON.stringify(from)}`).toBe(-1)
  return text.slice(0, at) + to + text.slice(at + from.length)
}

/** The text of job `name` in the real file: its `  name:` header up to the next job header. */
function jobSpan(text: string, name: string): { start: number; end: number } {
  const headers = [...text.matchAll(/^ {2}([A-Za-z0-9_-]+):[ \t]*$/gm)].map((m) => ({ name: m[1] as string, index: m.index }))
  const jobsAt = text.search(/^jobs:\s*$/m)
  const inJobs = headers.filter((h) => h.index > jobsAt)
  const i = inJobs.findIndex((h) => h.name === name)
  expect(i, `no job "${name}" in ci.yml`).toBeGreaterThanOrEqual(0)
  return { start: inJobs[i]?.index as number, end: i + 1 < inJobs.length ? (inJobs[i + 1]?.index as number) : text.length }
}

/** A real, behaviour-changing edit to job `name`: one step added at the top of
 *  its `steps:`. A reusable-workflow call has no steps; its `with:` gains a key. */
function editJob(text: string, name: string): string {
  const { start, end } = jobSpan(text, name)
  const block = text.slice(start, end)
  const steps = /^ {4}steps:[ \t]*\n/m.exec(block)
  const edited = steps !== null
    ? block.slice(0, steps.index + steps[0].length) + '      - run: echo "#3131 probe"\n' + block.slice(steps.index + steps[0].length)
    : (() => {
        const w = /^ {4}with:[ \t]*\n/m.exec(block)
        expect(w, `job "${name}" has neither steps: nor with:`).not.toBeNull()
        const m = w as RegExpExecArray
        return block.slice(0, m.index + m[0].length) + '      probe_3131: true\n' + block.slice(m.index + m[0].length)
      })()
  return text.slice(0, start) + edited + text.slice(end)
}

const expectFull = (r: Run): void => {
  expect(r.out.ios_tier, `expected FULL — stderr:\n${r.stderr}`).toBe('full')
  expect(r.out.ios_compile).toBe('true')
}

// ── The two PRs the issue measured, replayed on today's ci.yml ──────────────

/** #3120's entire ci.yml diff: one hunk, five added comment lines. */
const PR_3120 = (text: string): string => after(text,
  "  # `merge_group` sets no GITHUB_HEAD_REF, and this workflow has no tag push.\n",
  '  # The tag half of that predicate is therefore never evaluated here, and by\n' +
  "  # design: a release tag is pushed only by release.yml's `draft` job with\n" +
  '  # GITHUB_TOKEN, which starts no workflow, so a `v*` trigger would never fire.\n' +
  "  # The same check runs instead as a step of release.yml's `check` job, on the\n" +
  '  # merge commit and before the tag exists (#3094).\n')

/** #3089's entire ci.yml diff: one step appended in `docs-guard`. */
const PR_3089 = (text: string): string => after(text,
  '        run: bun scripts/check-unique-test-names.ts\n\n',
  '      # A v2 spec that says "amends <ID>" must find a "Amended by #<pr> ...,\n' +
  '      # effective once <condition>" pointer under <ID>\'s own heading in the spec\n' +
  '      # that defines it, so a signed-off spec never reads as current once another\n' +
  '      # one has changed it (#3034). Tests first (fixtures that must fail), then\n' +
  '      # the real specs. Node built-ins only, so no `bun install`.\n' +
  '      - name: Check every spec amendment has its pointer back\n' +
  '        run: |\n' +
  '          bun test ./scripts/check-amendment-pointers.test.ts\n' +
  '          bun scripts/check-amendment-pointers.ts\n\n')

describe('ci.yml earns the iOS tier its CONTENT reaches, not its name (#3131)', () => {
  it('#3120 (five comment lines) earns no iOS tier and no platform suite — but the ci.yml text rails still run', () => {
    const r = ciDiff(REAL, PR_3120(REAL))
    expect(r.stderr).toContain('ci.yml classified as inert')
    expect(r.out).toMatchObject({
      docs_only: 'false', ios: 'false', ios_tier: 'none', ios_compile: 'false',
      android: 'false', desktop: 'false', backend: 'false', crypto: 'false',
      orchestrator: 'true',
    })
  })

  it('#3089 (one step in docs-guard) earns no more than smoke, and no iOS compile', () => {
    const r = ciDiff(REAL, PR_3089(REAL))
    expect(r.stderr).toContain('ci.yml classified as outside_ios')
    expect(r.out).toMatchObject({ ios: 'true', ios_tier: 'smoke', ios_compile: 'false', android: 'true', desktop: 'true', backend: 'true' })
  })

  it('#3089 and #3120 together — two non-iOS edits — are still smoke', () => {
    expect(ciDiff(REAL, PR_3089(PR_3120(REAL))).out.ios_tier).toBe('smoke')
  })

  it('a comment change MIXED with one real change to an iOS job earns FULL — the whole diff is classified, not each hunk', () => {
    expectFull(ciDiff(REAL, editJob(PR_3120(REAL), 'ios-build-test')))
    expectFull(ciDiff(REAL, editJob(PR_3089(PR_3120(REAL)), 'ios-compile-check')))
  })

  it('a comment-shaped line inside a run: block is script, not a YAML comment — it is never inert', () => {
    // `#` lines in a block scalar are part of the string: a heredoc or a
    // github-script body would see them. In an iOS job that is FULL.
    const { start, end } = jobSpan(REAL, 'ios-build-test')
    const block = REAL.slice(start, end)
    const m = /^( +)run: \|\n/m.exec(block)
    expect(m, 'ios-build-test has a run: | step').not.toBeNull()
    const at = start + (m as RegExpExecArray).index + (m as RegExpExecArray)[0].length
    const indent = `${(m as RegExpExecArray)[1]}  `
    const head = REAL.slice(0, at) + `${indent}# looks like a comment\n` + REAL.slice(at)
    const r = ciDiff(REAL, head)
    expect(r.stderr).not.toContain('classified as inert')
    expectFull(r)
  })
})

describe('break it: every change that can reach the iOS gate still earns FULL', () => {
  // Each of these is a real edit to the real file. None may narrow.
  it.each(['changes', 'ios-build-test', 'ios-compile-check', 'ios-e2e', 'ci-status', 'platform-suite-coverage'])(
    'a step/input added to %s', (job) => { expectFull(ciDiff(REAL, editJob(REAL, job))) })

  it('the path-filter wiring: the detect script invocation in `changes`', () => {
    expectFull(ciDiff(REAL, replaceOnce(REAL,
      "printf '%s\\n' \"$CHANGED\" | bash .github/scripts/detect-changed-platforms.sh | tee -a \"$GITHUB_OUTPUT\"",
      "printf '%s\\n' \"$CHANGED\" | grep -v ios | bash .github/scripts/detect-changed-platforms.sh | tee -a \"$GITHUB_OUTPUT\"")))
  })

  it('top-level env', () => {
    expectFull(ciDiff(REAL, replaceOnce(REAL, '\nenv:\n', '\nenv:\n  PROBE_3131: "1"\n')))
  })

  it.each([
    ['defaults', 'defaults:\n  run:\n    shell: bash\n'],
    ['a top-level anchor', 'x-probe: &probe\n  a: 1\n'],
  ])('a new top-level %s', (_what, block) => {
    expectFull(ciDiff(REAL, replaceOnce(REAL, '\njobs:\n', `\n${block}jobs:\n`)))
  })

  it('the existing top-level concurrency and permissions', () => {
    // Edited in place, not added: a second key would be a duplicate, which is
    // FULL for a different reason and would prove nothing about these keys.
    expectFull(ciDiff(REAL, replaceOnce(REAL, "format('ci-pr-{0}', github.ref)", "format('ci-pr-{0}', github.sha)")))
    expectFull(ciDiff(REAL, replaceOnce(REAL, '\npermissions: {}', '\npermissions: { contents: read }')))
  })

  it('workflow-level or job-order changes riding along with a safe docs-guard edit still earn FULL', () => {
    // Alone, each of these is also caught by the "no single job accounts for
    // it" fallback; paired with a real non-iOS job edit, only the workflow-level
    // and job-order comparisons themselves can catch them.
    expectFull(ciDiff(REAL, PR_3089(replaceOnce(REAL, '\nenv:\n', '\nenv:\n  PROBE_3131: "1"\n'))))
    const { start, end } = jobSpan(REAL, 'docs-guard')
    const block = REAL.slice(start, end)
    const without = REAL.slice(0, start) + REAL.slice(end)
    const { start: s2 } = jobSpan(without, 'lint')
    expectFull(ciDiff(REAL, PR_3089(without.slice(0, s2) + block + without.slice(s2))))
  })

  it('a change to the triggers (`on:`)', () => {
    expectFull(ciDiff(REAL, replaceOnce(REAL, '\n  merge_group:\n', '\n  merge_group:\n    types: [checks_requested]\n')))
  })

  it('a needs edge from a non-iOS job to an iOS job (added on the head side only)', () => {
    const { start, end } = jobSpan(REAL, 'docs-guard')
    const block = REAL.slice(start, end)
    expect(block).toContain('\n    needs: changes\n')
    const head = REAL.slice(0, start) + block.replace('\n    needs: changes\n', '\n    needs: [changes, ios-build-test]\n') + REAL.slice(end)
    expectFull(ciDiff(REAL, head))
  })

  it('a needs edge from a non-iOS job to an iOS job (removed — the BASE side has it)', () => {
    const { start, end } = jobSpan(REAL, 'docs-guard')
    const block = REAL.slice(start, end)
    const base = REAL.slice(0, start) + block.replace('\n    needs: changes\n', '\n    needs: [changes, ios-build-test]\n') + REAL.slice(end)
    expectFull(ciDiff(base, REAL))
  })

  it('an iOS job gaining a needs edge to a non-iOS job, with only the non-iOS job edited', () => {
    const { start, end } = jobSpan(REAL, 'ios-build-test')
    const withEdge = REAL.slice(0, start) + REAL.slice(start, end).replace('\n    needs: changes\n', '\n    needs: [changes, docs-guard]\n') + REAL.slice(end)
    expectFull(ciDiff(withEdge, PR_3089(withEdge)))
  })

  it('a reordered job', () => {
    const { start, end } = jobSpan(REAL, 'docs-guard')
    const block = REAL.slice(start, end)
    const without = REAL.slice(0, start) + REAL.slice(end)
    const { start: s2 } = jobSpan(without, 'lint')
    expectFull(ciDiff(REAL, without.slice(0, s2) + block + without.slice(s2)))
  })

  it('a renamed job (non-iOS, nothing needs it but ci-status — which must be edited too)', () => {
    let head = replaceOnce(REAL, '\n  docs-guard:\n', '\n  docs-guard-renamed:\n')
    head = head.replace(/(needs: \[[^\]\n]*\b)docs-guard\b/, '$1docs-guard-renamed')
    expectFull(ciDiff(REAL, head))
  })

  it('an added and a removed job', () => {
    expectFull(ciDiff(REAL, replaceOnce(REAL, '\n  docs-guard:\n', '\n  probe-3131:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n\n  docs-guard:\n')))
    const { start, end } = jobSpan(REAL, 'docs-guard')
    expectFull(ciDiff(REAL, REAL.slice(0, start) + REAL.slice(end)))
  })

  it('a non-iOS job moved onto the self-hosted Macs, or onto a matrix expression', () => {
    for (const ro of ['[self-hosted, macOS, ARM64, ios-e2e]', '${{ matrix.os }}', 'macos-latest']) {
      const { start, end } = jobSpan(REAL, 'docs-guard')
      const block = REAL.slice(start, end).replace('\n    runs-on: ubuntu-latest\n', `\n    runs-on: ${ro}\n`)
      expectFull(ciDiff(REAL, REAL.slice(0, start) + block + REAL.slice(end)))
    }
  })

  it('a non-iOS job that starts reading the narrowed flags', () => {
    const { start, end } = jobSpan(REAL, 'docs-guard')
    const block = REAL.slice(start, end).replace("needs.changes.outputs.release_only != 'true'", "needs.changes.outputs.ios_compile != 'true'")
    expect(block).toContain('ios_compile')
    expectFull(ciDiff(REAL, REAL.slice(0, start) + block + REAL.slice(end)))
  })

  it('a non-iOS job gaining a concurrency group, or changing its permissions', () => {
    const { start, end } = jobSpan(REAL, 'docs-guard')
    const block = REAL.slice(start, end)
    const withConc = block.replace('\n    runs-on: ubuntu-latest\n', '\n    runs-on: ubuntu-latest\n    concurrency: { group: ios-mac, cancel-in-progress: true }\n')
    expectFull(ciDiff(REAL, REAL.slice(0, start) + withConc + REAL.slice(end)))
    const withPerm = block.replace('\n    runs-on: ubuntu-latest\n', '\n    runs-on: ubuntu-latest\n    permissions:\n      actions: write\n')
    expectFull(ciDiff(REAL, REAL.slice(0, start) + withPerm + REAL.slice(end)))
  })
})

// ── Anchors and aliases: a small workflow, because the real file has none ───

const ANCHORED = (stepRun: string): string => `on: { pull_request: {} }
jobs:
  changes:
    runs-on: ubuntu-latest
    outputs:
      ios_tier: \${{ steps.f.outputs.ios_tier }}
    steps:
      - id: f
        run: echo
  docs-guard:
    needs: changes
    runs-on: ubuntu-latest
    steps:
      - &shared
        name: shared step
        run: ${stepRun}
  ios-build-test:
    needs: changes
    runs-on: [self-hosted, macOS]
    steps:
      - *shared
  ci-status:
    needs: [docs-guard, ios-build-test]
    runs-on: ubuntu-latest
    steps:
      - run: echo
`

describe('anchors and aliases are compared expanded', () => {
  it('editing an anchor that an iOS job consumes earns FULL, even though the anchor lives in a non-iOS job', () => {
    expectFull(ciDiff(ANCHORED('echo one'), ANCHORED('echo two')))
  })

  it('the same edit with the alias gone is a non-iOS change (proves the case above is FULL because of the alias)', () => {
    const noAlias = (s: string): string => ANCHORED(s).replace('      - *shared\n', '      - run: echo mac\n')
    expect(ciDiff(noAlias('echo one'), noAlias('echo two')).out.ios_tier).toBe('smoke')
  })

  it('renaming an anchor (same graph) is inert', () => {
    const a = ANCHORED('echo one')
    expect(ciDiff(a, a.replace('&shared', '&renamed').replace('*shared', '*renamed')).out.ios_tier).toBe('none')
  })

  it('a merge key at job level is unclassifiable, so FULL — it could carry a needs edge the job-level read misses', () => {
    // No alias reaches ios-build-test here, so the ONLY route to the iOS gate is
    // the needs edge hidden inside the merge key.
    const base = ANCHORED('echo one')
      .replace('      - *shared\n', '      - run: echo mac\n')
      .replace('  docs-guard:\n    needs: changes\n', '  docs-guard:\n    <<: { needs: [changes, ios-build-test] }\n')
    expectFull(ciDiff(base, base.replace('echo one', 'echo two')))
  })

  it('a recursive alias and an alias bomb are unclassifiable, so FULL', () => {
    const rec = 'on: push\njobs: &j\n  a:\n    runs-on: ubuntu-latest\n    x: *j\n'
    expectFull(ciDiff(rec, rec.replace('ubuntu-latest', 'ubuntu-24.04')))
    let bomb = 'x0: &a0 [lol, lol, lol, lol, lol, lol, lol, lol, lol, lol]\n'
    for (let i = 1; i < 8; i++) bomb += `x${i}: &a${i} [${Array.from({ length: 10 }, () => `*a${i - 1}`).join(', ')}]\n`
    const doc = (tail: string): string => `on: push\n${bomb}jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps: [{ run: ${tail} }]\n`
    const r = ciDiff(doc('one'), doc('two'))
    expect(r.stderr).toContain('node budget')
    expectFull(r)
  })
})

describe('every undecidable case fails CLOSED to FULL', () => {
  it('no base/head content supplied (every caller that pipes a bare file list)', () => {
    const r = run([CI])
    expectFull(r)
    expect(r.out.android).toBe('true')
  })

  it('a side that does not exist (an added or deleted ci.yml)', () => {
    expectFull(run([CI], { base: undefined, head: REAL }))
    expectFull(run([CI], { base: REAL, head: undefined }))
  })

  it('a side that is not YAML, or not exactly one mapping document', () => {
    expectFull(ciDiff(REAL, `${REAL}\n  : : [unterminated\n`))
    expectFull(ciDiff(REAL, `${REAL}\n---\nsecond: doc\n`))
    expectFull(ciDiff('- a list\n', '- a list\n# c\n'))
  })

  it('a duplicate job id', () => {
    const dup = `${REAL}\n  docs-guard:\n    runs-on: ubuntu-latest\n    steps: [{ run: x }]\n`
    expectFull(ciDiff(dup, dup.replace('steps: [{ run: x }]', 'steps: [{ run: y }]')))
  })

  it('python3/PyYAML unavailable — FULL, and it says so with a ::warning', () => {
    // A PATH holding every tool the script uses EXCEPT python3.
    const bin = mkdtempSync(join(tmpdir(), 'ci-yml-nopy-'))
    mkdirSync(join(bin, 'b'))
    for (const tool of ['bash', 'cat', 'grep', 'echo']) {
      const p = spawnSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim()
      if (p.startsWith('/')) symlinkSync(p, join(bin, 'b', tool))
    }
    const r = run([CI], { base: REAL, head: PR_3120(REAL) }, { ...process.env, PATH: join(bin, 'b') })
    expectFull(r)
    expect(r.stderr).toContain('::warning title=ci.yml content classification unavailable::')
  })

  it('content supplied but ci.yml not in the diff changes nothing', () => {
    expect(run(['README.md'], { base: REAL, head: PR_3089(REAL) }).out).toMatchObject({ docs_only: 'true', ios_tier: 'none', backend: 'false' })
  })

  it('the narrowing never reaches another FULL file in the same diff', () => {
    expectFull(run([CI, 'apps/ios/Sources/App.swift'], { base: REAL, head: PR_3120(REAL) }))
    // ios-e2e.yml is a FULL-tier file but not an ios-compile-check input.
    expect(run([CI, '.github/workflows/ios-e2e.yml'], { base: REAL, head: PR_3089(REAL) }).out.ios_tier).toBe('full')
  })
})

describe('the changes job supplies the two sides from the range it diffs', () => {
  const changesStep = REAL.slice(jobSpan(REAL, 'changes').start, jobSpan(REAL, 'changes').end)

  it('exports CI_YML_BASE_FILE / CI_YML_HEAD_FILE before it runs the classifier', () => {
    const exportAt = changesStep.indexOf('export CI_YML_BASE_FILE=')
    const runAt = changesStep.indexOf('bash .github/scripts/detect-changed-platforms.sh')
    expect(exportAt, 'the changes job never supplies the two sides — the narrowing is dead in CI').toBeGreaterThan(0)
    expect(runAt).toBeGreaterThan(exportAt)
  })

  it('takes the base side from the merge base on pull_request (the three-dot range), and never under FALLBACK_ALL', () => {
    expect(changesStep).toContain('CI_YML_BASE_REV=$(git merge-base "$BASE" "$HEAD"')
    expect(changesStep).toMatch(/if \[\[ "\$FALLBACK_ALL" == "false" \]\] && grep -qxF "\$CI_YML" <<< "\$CHANGED"; then/)
    expect(changesStep).toContain('git show "$HEAD:$CI_YML"')
  })
})
