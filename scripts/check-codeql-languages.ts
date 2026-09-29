#!/usr/bin/env bun
/**
 * check-codeql-languages.ts — Fail if the CodeQL workflow's REQUIRED analyses
 * stop covering exactly the languages GitHub's default setup analysed.
 *
 * Why: moving CodeQL from default setup to .github/workflows/codeql.yml puts
 * the language list in a file anyone can edit. An earlier attempt at this
 * migration listed four languages and left out `rust` — packages/crypto — and
 * nothing anywhere would have reported it: a leg that doesn't exist can't
 * fail. This rail makes that a red check.
 *
 * Offline and self-contained: the expected set and the alias table are
 * committed below, not fetched from the API, so CI and a laptop agree.
 *
 * What it proves about codeql.yml:
 *   1. The `analyze` matrix, resolved through ALIASES, is exactly
 *      REQUIRED_IDENTIFIERS resolved the same way — nothing missing, nothing
 *      extra — and `init` analyses `${{ matrix.language }}`, not a literal.
 *   2. `analyze` has no `if:`, and the workflow triggers on push,
 *      pull_request, merge_group and schedule, so no event quietly skips it.
 *   3. The `codeql` rollup needs `analyze`, runs `if: always()`, and is named
 *      literally `CodeQL` — the required context — on every event. On
 *      merge_group it is the only `CodeQL` check-run; on pull_request it sits
 *      beside GHAS's alert gate, and both must pass. A rollup under any other
 *      name leaves `CodeQL` to the alert gate alone, which goes `neutral`
 *      (accepted) when an upload is refused — so a failed analysis would pass.
 *   3a. No other job claims a name the required context could resolve to:
 *      none but the rollup is named `CodeQL`, and none uses default setup's
 *      `Analyze (<language>)` names, which its own check-runs carry.
 *   4. STAGED legs (any other job running codeql-action/init — java-kotlin
 *      and swift today, #1243) are tolerated but never counted as required
 *      coverage: they must not overlap the required extractors, must not be
 *      in the rollup's `needs`, and their `if:` must be a plain allow-list of
 *      events that excludes pull_request and merge_group, so they have no
 *      route to blocking a merge.
 *   5. STAGED legs never upload to code scanning: every analyze step sets
 *      `upload: never`, there is no upload-sarif step, and the job does not
 *      hold `security-events: write`. GHAS judges each PR against every
 *      configuration present on main; one that exists on main but never on
 *      PRs turns every PR's `CodeQL` check into "cannot determine the alerts
 *      introduced by this pull request" — `neutral`, which a required check
 *      accepts. A staged upload would silently take the verdict out of the
 *      required gate.
 *
 *   6. Every identifier default setup's configuration listed is accounted
 *      for exactly once: REQUIRED (a leg of `analyze`), STAGED (some staged
 *      job analyses it) or NOT_ANALYSED — and a NOT_ANALYSED language must
 *      still have no source in the tree, so the day one appears the rail
 *      demands a leg for it instead of carrying a stale exemption.
 *
 * Promoting a staged language to required means moving it into `analyze` AND
 * moving its identifier from STAGED_IDENTIFIERS to REQUIRED_IDENTIFIERS below
 * — a deliberate edit to a code-owned file, which is the point.
 *
 * Usage:
 *   bun scripts/check-codeql-languages.ts [path/to/codeql.yml] [source-root]
 *
 * Exit code: 0 = pass, 1 = violations found, 2 = the rail itself failed
 */

import { readdirSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'

const DEFAULT_WORKFLOW = '.github/workflows/codeql.yml'
const REQUIRED_JOB = 'analyze'
const ROLLUP_JOB = 'codeql'
const REQUIRED_CONTEXT = 'CodeQL'
const REQUIRED_TRIGGERS = ['push', 'pull_request', 'merge_group', 'schedule'] as const
const MERGE_BLOCKING_EVENTS = ['pull_request', 'merge_group'] as const
/** Default setup's check-runs are `Analyze (<language>)`; ours must never share one. */
const DEFAULT_SETUP_JOB_NAME_PREFIX = 'analyze ('

/**
 * Every identifier default setup's configuration listed, exactly as
 * `GET /repos/Llamenos-Hotline/llamenos-platform/code-scanning/default-setup`
 * returned them on 2026-09-29, once default setup was disabled (state
 * "not-configured", query_suite "default", threat_model "remote"). Each one
 * is partitioned below into REQUIRED, STAGED or NOT_ANALYSED; one in none of
 * them, or in more than one, fails the rail.
 */
const DEFAULT_SETUP_IDENTIFIERS = [
  'actions',
  'c-cpp',
  'java-kotlin',
  'javascript',
  'javascript-typescript',
  'python',
  'ruby',
  'rust',
  'swift',
  'typescript',
] as const

type DefaultSetupIdentifier = (typeof DEFAULT_SETUP_IDENTIFIERS)[number]

/**
 * The identifiers default setup actually analysed: the code-scanning analyses
 * API holds thousands of successful `/language:<id>` analyses on main for
 * each of these five. Seven identifiers, five analyses: see ALIASES.
 */
const REQUIRED_IDENTIFIERS = [
  'actions',
  'javascript',
  'javascript-typescript',
  'python',
  'ruby',
  'rust',
  'typescript',
] as const satisfies readonly DefaultSetupIdentifier[]

/**
 * Listed, but never successfully analysed: default setup's only run of each
 * (2026-09-27, main at f98844021) ended "unsuccessful execution" with 0
 * results — Kotlin and Swift need a traced build, which default setup cannot
 * do. Each must be analysed by a staged job (#1243) until it is promoted.
 */
const STAGED_IDENTIFIERS = ['java-kotlin', 'swift'] as const satisfies readonly DefaultSetupIdentifier[]

/**
 * Listed, never successfully analysed, and deliberately given no leg. The
 * `sourceExtensions` are what the extractor would need to analyse anything;
 * the rail fails if a tracked file with one of them appears.
 */
const NOT_ANALYSED: Readonly<Partial<Record<DefaultSetupIdentifier, { reason: string; sourceExtensions: readonly string[] }>>> = {
  'c-cpp': {
    reason:
      'the tree has no C/C++ translation unit — its only C-family file is packages/crypto/bindings/swift/LlamenosCoreFFI.h, ' +
      "a UniFFI-generated header for the Rust crate (a required leg). Default setup's one c-cpp run (2026-09-27, f98844021) " +
      'ended "unsuccessful execution" with 0 results.',
    sourceExtensions: ['.c', '.cc', '.cpp', '.cxx', '.c++'],
  },
}

/** Never walked for NOT_ANALYSED sources: untracked build output and dependencies. */
const SOURCE_SCAN_SKIP_DIRS = new Set([
  '.git', 'node_modules', 'target', 'dist', 'build', '.build', '.gradle', 'DerivedData', 'vendor', '.bun',
])

/**
 * CodeQL language identifier → the extractor that analyses it. Copied from
 * codeql-action's own table, src/languages/builtin.json at v4.38.2
 * (2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2 — the SHA codeql.yml pins), and
 * matching GitHub's documented identifier table, where `javascript` and
 * `typescript` are alternatives for `javascript-typescript`, and `java` and
 * `kotlin` for `java-kotlin`. codeql-action/init resolves every requested
 * identifier through this table and de-duplicates the result, so identifiers
 * sharing an extractor are ONE analysis.
 *
 * An identifier missing here fails the rail rather than being guessed at.
 */
const ALIASES: Readonly<Record<string, string>> = {
  actions: 'actions',
  c: 'cpp',
  'c-c++': 'cpp',
  'c-cpp': 'cpp',
  'c#': 'csharp',
  'c++': 'cpp',
  cpp: 'cpp',
  csharp: 'csharp',
  go: 'go',
  java: 'java',
  'java-kotlin': 'java',
  javascript: 'javascript',
  'javascript-typescript': 'javascript',
  kotlin: 'java',
  python: 'python',
  ruby: 'ruby',
  rust: 'rust',
  swift: 'swift',
  typescript: 'javascript',
}

type Job = {
  name?: unknown
  if?: unknown
  needs?: unknown
  permissions?: unknown
  strategy?: { matrix?: unknown }
  steps?: unknown
}

type Workflow = {
  on?: unknown
  jobs?: Record<string, Job>
}

type InitStep = { uses: string; with?: { languages?: unknown } }
type ActionStep = { uses: string; with?: Record<string, unknown> }

const violations: string[] = []

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeExpression(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function resolve(identifier: string): string | undefined {
  return ALIASES[identifier.trim().toLowerCase()]
}

function stepsUsing(job: Job, action: string): ActionStep[] {
  if (!Array.isArray(job.steps)) return []
  return job.steps.filter(
    (step): step is ActionStep =>
      isRecord(step) && typeof step.uses === 'string' && step.uses.startsWith(`${action}@`),
  )
}

function initSteps(job: Job): InitStep[] {
  return stepsUsing(job, 'github/codeql-action/init')
}

function triggers(on: unknown): string[] {
  if (typeof on === 'string') return [on]
  if (Array.isArray(on)) return on.filter((t): t is string => typeof t === 'string')
  if (isRecord(on)) return Object.keys(on)
  return []
}

function needsOf(job: Job): string[] {
  if (typeof job.needs === 'string') return [job.needs]
  if (Array.isArray(job.needs)) return job.needs.filter((n): n is string => typeof n === 'string')
  return []
}

/** The literal languages of the `analyze` matrix, from `language:` and/or `include[].language`. */
function matrixLanguages(job: Job): string[] | undefined {
  const matrix = job.strategy?.matrix
  if (!isRecord(matrix)) return undefined
  const languages: string[] = []
  if (Array.isArray(matrix.language)) {
    for (const l of matrix.language) if (typeof l === 'string') languages.push(l)
  }
  if (Array.isArray(matrix.include)) {
    for (const entry of matrix.include) {
      if (isRecord(entry) && typeof entry.language === 'string') languages.push(entry.language)
    }
  }
  return languages
}

/**
 * The events a job-level `if:` admits, when it is a plain allow-list:
 * `github.event_name == 'a' || github.event_name == 'b'`. Anything else is
 * undefined — the rail will not guess what an arbitrary expression permits.
 */
function allowListedEvents(condition: string): string[] | undefined {
  const expr = normalizeExpression(condition.replace(/^\$\{\{([\s\S]*)\}\}$/, '$1'))
  const terms = expr.split('||').map((t) => t.trim())
  const events: string[] = []
  for (const term of terms) {
    const m = term.match(/^github\.event_name == '([a-z_]+)'$/)
    if (!m) return undefined
    events.push(m[1])
  }
  return events
}

/** The check-run name a job reports under: its `name:`, else its id. */
/** Files under `root` whose extension is in `extensions`, skipping SOURCE_SCAN_SKIP_DIRS. */
function sourcesWithExtensions(root: string, extensions: readonly string[]): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SOURCE_SCAN_SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name))
      } else if (entry.isFile() && extensions.includes(extname(entry.name).toLowerCase())) {
        found.push(join(dir, entry.name))
      }
    }
  }
  walk(root)
  return found
}

/**
 * Point 6: every default-setup identifier is REQUIRED, STAGED or NOT_ANALYSED
 * exactly once; STAGED ones have a staged job; NOT_ANALYSED ones still have
 * nothing to analyse.
 */
function checkDefaultSetupPartition(stagedExtractors: ReadonlySet<string>, sourceRoot: string): void {
  const partitions: [string, readonly string[]][] = [
    ['REQUIRED_IDENTIFIERS', REQUIRED_IDENTIFIERS],
    ['STAGED_IDENTIFIERS', STAGED_IDENTIFIERS],
    ['NOT_ANALYSED', Object.keys(NOT_ANALYSED)],
  ]
  for (const id of DEFAULT_SETUP_IDENTIFIERS) {
    const homes = partitions.filter(([, ids]) => ids.includes(id)).map(([name]) => name)
    if (homes.length !== 1) {
      violations.push(
        `default-setup identifier \`${id}\` must be in exactly one of REQUIRED_IDENTIFIERS, STAGED_IDENTIFIERS, NOT_ANALYSED (found ${homes.length === 0 ? 'none' : homes.join(', ')}) — otherwise it is dropped silently`,
      )
    }
  }
  for (const id of STAGED_IDENTIFIERS) {
    const extractor = resolve(id)
    if (extractor === undefined || !stagedExtractors.has(extractor)) {
      violations.push(`\`${id}\` is in STAGED_IDENTIFIERS but no staged job analyses it — default setup listed it, so dropping its leg drops it`)
    }
  }
  for (const [id, entry] of Object.entries(NOT_ANALYSED)) {
    if (!entry) continue
    const sources = sourcesWithExtensions(sourceRoot, entry.sourceExtensions)
    if (sources.length > 0) {
      violations.push(
        `\`${id}\` is in NOT_ANALYSED ("no source to analyse") but the tree now has ${sources.length} ${id} source file(s), e.g. ${sources.slice(0, 3).join(', ')} — give it a CodeQL leg`,
      )
    }
  }
}

function checkName(id: string, job: Job): string {
  return (typeof job.name === 'string' ? job.name : id).trim()
}

function main(): void {
  const path = process.argv[2] ?? DEFAULT_WORKFLOW
  const workflow = Bun.YAML.parse(readFileSync(path, 'utf8')) as Workflow
  const jobs = workflow.jobs ?? {}

  // ── Triggers: an event the workflow doesn't run on has no coverage at all ──
  const on = triggers(workflow.on)
  for (const trigger of REQUIRED_TRIGGERS) {
    if (!on.includes(trigger)) violations.push(`workflow does not trigger on \`${trigger}\``)
  }

  // ── Required legs ──
  const analyze = jobs[REQUIRED_JOB]
  const requiredExtractors = new Set<string>()
  if (!analyze) {
    violations.push(`no \`${REQUIRED_JOB}\` job — the required CodeQL legs are gone`)
  } else {
    if (analyze.if !== undefined) {
      violations.push(`\`${REQUIRED_JOB}\` has an \`if:\` (${String(analyze.if)}) — required legs must run on every event`)
    }

    const init = initSteps(analyze)
    const languagesInput = init.length === 1 && typeof init[0].with?.languages === 'string'
      ? normalizeExpression(init[0].with.languages)
      : undefined
    if (languagesInput !== '${{ matrix.language }}') {
      violations.push(
        `\`${REQUIRED_JOB}\` must have exactly one codeql-action/init step with \`languages: \${{ matrix.language }}\` (found ${init.length} init step(s), languages: ${String(languagesInput)}) — otherwise the matrix is not what gets analysed`,
      )
    }

    const legs = matrixLanguages(analyze)
    if (legs === undefined) {
      violations.push(`\`${REQUIRED_JOB}\` has no literal \`strategy.matrix\` — the rail cannot see which languages it analyses`)
    } else {
      for (const leg of legs) {
        const extractor = resolve(leg)
        if (extractor === undefined) {
          violations.push(`\`${REQUIRED_JOB}\` leg \`${leg}\` is not a CodeQL identifier in this rail's ALIASES table`)
        } else if (requiredExtractors.has(extractor)) {
          violations.push(`\`${REQUIRED_JOB}\` leg \`${leg}\` duplicates another leg's analysis (\`${extractor}\`)`)
        } else {
          requiredExtractors.add(extractor)
        }
      }

      const expected = new Map<string, string[]>()
      for (const id of REQUIRED_IDENTIFIERS) {
        const extractor = resolve(id)
        if (extractor === undefined) throw new Error(`REQUIRED_IDENTIFIERS entry \`${id}\` has no ALIASES entry`)
        expected.set(extractor, [...(expected.get(extractor) ?? []), id])
      }
      for (const [extractor, ids] of expected) {
        if (!requiredExtractors.has(extractor)) {
          violations.push(
            `required coverage missing: no \`${REQUIRED_JOB}\` leg analyses \`${extractor}\`, which default setup analysed as ${ids.map((i) => `\`${i}\``).join(', ')}`,
          )
        }
      }
      for (const extractor of requiredExtractors) {
        if (!expected.has(extractor)) {
          violations.push(
            `\`${REQUIRED_JOB}\` analyses \`${extractor}\`, which is not in REQUIRED_IDENTIFIERS — promoting a language to required means adding it there deliberately`,
          )
        }
      }
    }
  }

  // ── Staged legs: tolerated, never counted as required coverage ──
  const staged: { job: string; languages: string[] }[] = []
  for (const [id, job] of Object.entries(jobs)) {
    if (id === REQUIRED_JOB) continue
    const init = initSteps(job)
    if (init.length === 0) continue
    const languages: string[] = []
    for (const step of init) {
      const input = step.with?.languages
      if (typeof input !== 'string' || input.includes('${{')) {
        violations.push(`staged job \`${id}\` must name its CodeQL language literally (found ${String(input)})`)
        continue
      }
      languages.push(...input.split(',').map((l) => l.trim()).filter(Boolean))
    }
    for (const language of languages) {
      const extractor = resolve(language)
      if (extractor === undefined) {
        violations.push(`staged job \`${id}\` language \`${language}\` is not a CodeQL identifier in this rail's ALIASES table`)
      } else if (requiredExtractors.has(extractor)) {
        violations.push(`staged job \`${id}\` analyses \`${extractor}\`, which is already a required leg`)
      }
    }
    if (typeof job.if !== 'string') {
      violations.push(`staged job \`${id}\` has no \`if:\` — it would run on ${MERGE_BLOCKING_EVENTS.join(' and ')}`)
    } else {
      const events = allowListedEvents(job.if)
      if (events === undefined) {
        violations.push(
          `staged job \`${id}\`'s \`if:\` must be a plain allow-list (github.event_name == '<event>' || ...) so this rail can prove it never runs on ${MERGE_BLOCKING_EVENTS.join(' or ')}; found: ${job.if}`,
        )
      } else {
        for (const event of MERGE_BLOCKING_EVENTS) {
          if (events.includes(event)) violations.push(`staged job \`${id}\` runs on \`${event}\` — a staged language must have no route to blocking a merge`)
        }
      }
    }
    // No route to code scanning: a staged configuration on main neutralises
    // the required gate on every PR (see header, point 5).
    const analyzeSteps = stepsUsing(job, 'github/codeql-action/analyze')
    if (analyzeSteps.length === 0) {
      violations.push(`staged job \`${id}\` has no codeql-action/analyze step`)
    }
    for (const step of analyzeSteps) {
      if (step.with?.upload !== 'never') {
        violations.push(
          `staged job \`${id}\` analyzes without \`upload: never\` (found ${String(step.with?.upload)}) — a staged configuration on main turns every PR's \`${REQUIRED_CONTEXT}\` check neutral ("cannot determine the alerts introduced")`,
        )
      }
    }
    if (stepsUsing(job, 'github/codeql-action/upload-sarif').length > 0) {
      violations.push(`staged job \`${id}\` has an upload-sarif step — staged results must not reach code scanning`)
    }
    const permissions = job.permissions
    if (permissions === 'write-all' || (isRecord(permissions) && permissions['security-events'] === 'write')) {
      violations.push(`staged job \`${id}\` holds \`security-events: write\` — staged legs never upload, so they get read at most`)
    }
    staged.push({ job: id, languages })
  }

  const stagedExtractors = new Set<string>()
  for (const { languages } of staged) {
    for (const language of languages) {
      const extractor = resolve(language)
      if (extractor !== undefined) stagedExtractors.add(extractor)
    }
  }
  checkDefaultSetupPartition(stagedExtractors, process.argv[3] ?? '.')

  // ── Rollup ──
  const rollup = jobs[ROLLUP_JOB]
  if (!rollup) {
    violations.push(`no \`${ROLLUP_JOB}\` rollup job — nothing reports \`${REQUIRED_CONTEXT}\` on the merge queue's ref`)
  } else {
    const needs = needsOf(rollup)
    if (!needs.includes(REQUIRED_JOB)) {
      violations.push(`\`${ROLLUP_JOB}\` does not need \`${REQUIRED_JOB}\` — a failed required leg would not fail it`)
    }
    for (const { job } of staged) {
      if (needs.includes(job)) {
        violations.push(`\`${ROLLUP_JOB}\` needs staged job \`${job}\` — a staged language would become able to block a merge`)
      }
    }
    if (typeof rollup.if !== 'string' || normalizeExpression(rollup.if) !== 'always()') {
      violations.push(`\`${ROLLUP_JOB}\` must be \`if: always()\` — otherwise a failed leg skips it, and skipped counts as passing`)
    }
    // Literal, not an expression: the name must be `CodeQL` on every event.
    if (rollup.name !== REQUIRED_CONTEXT) {
      violations.push(
        `\`${ROLLUP_JOB}\` must be named literally \`${REQUIRED_CONTEXT}\` (found ${String(rollup.name)}) — anything else leaves the required context to GHAS's alert gate alone, which goes neutral (accepted) when an upload is refused, and reports nothing at all on the merge queue's ref`,
      )
    }
  }

  // ── Names: one check name, one source ──
  for (const [id, job] of Object.entries(jobs)) {
    const name = checkName(id, job)
    if (id !== ROLLUP_JOB && name.toLowerCase() === REQUIRED_CONTEXT.toLowerCase()) {
      violations.push(`job \`${id}\` is named \`${name}\` — only the \`${ROLLUP_JOB}\` rollup may report the required context`)
    }
    if (name.toLowerCase().startsWith(DEFAULT_SETUP_JOB_NAME_PREFIX)) {
      violations.push(`job \`${id}\` is named \`${name}\` — default setup's own check-runs are \`Analyze (<language>)\`, so two sources would report one name`)
    }
  }

  if (violations.length > 0) {
    console.error(`❌ ${path}: the CodeQL workflow breaks its required-coverage contract:`)
    console.error('')
    for (const v of violations) console.error(`  - ${v}`)
    console.error('')
    console.error(`   Expected (scripts/check-codeql-languages.ts REQUIRED_IDENTIFIERS): ${REQUIRED_IDENTIFIERS.join(', ')}`)
    process.exit(1)
  }

  const byExtractor = new Map<string, string[]>()
  for (const id of REQUIRED_IDENTIFIERS) {
    const extractor = resolve(id) as string
    byExtractor.set(extractor, [...(byExtractor.get(extractor) ?? []), id])
  }
  console.log(`✅ ${path}: all ${DEFAULT_SETUP_IDENTIFIERS.length} default-setup identifiers accounted for; required legs cover exactly the ${REQUIRED_IDENTIFIERS.length} it analysed (${byExtractor.size} analyses):`)
  for (const [extractor, ids] of byExtractor) console.log(`   ${ids.join(', ')} → ${extractor}`)
  if (staged.length > 0) {
    console.log(`   Staged, not required (outside the ${REQUIRED_CONTEXT} rollup, never on ${MERGE_BLOCKING_EVENTS.join('/')}, never uploaded to code scanning):`)
    for (const { job, languages } of staged) console.log(`   ${languages.join(', ')} (${job})`)
  }
  for (const [id, entry] of Object.entries(NOT_ANALYSED)) {
    if (entry) console.log(`   Not analysed: ${id} — ${entry.reason}`)
  }
}

try {
  main()
} catch (err) {
  console.error('CodeQL language check failed to run:', err)
  process.exit(2)
}
