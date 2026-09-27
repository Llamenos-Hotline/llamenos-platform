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
 *   3. The `codeql` rollup needs `analyze`, runs `if: always()`, is named
 *      `CodeQL` on merge_group (the queue's required context) and NOT
 *      `CodeQL` on pull_request (where GHAS's alert gate owns that name).
 *   4. STAGED legs (any other job running codeql-action/init — java-kotlin
 *      and swift today, #1243) are tolerated but never counted as required
 *      coverage: they must not overlap the required extractors, must not be
 *      in the rollup's `needs`, and their `if:` must be a plain allow-list of
 *      events that excludes pull_request and merge_group, so they have no
 *      route to blocking a merge.
 *
 * Promoting a staged language to required means moving it into `analyze` AND
 * adding its identifier to REQUIRED_IDENTIFIERS below — a deliberate edit to
 * a code-owned file, which is the point.
 *
 * Usage:
 *   bun scripts/check-codeql-languages.ts [path/to/codeql.yml]
 *
 * Exit code: 0 = pass, 1 = violations found, 2 = the rail itself failed
 */

import { readFileSync } from 'node:fs'

const DEFAULT_WORKFLOW = '.github/workflows/codeql.yml'
const REQUIRED_JOB = 'analyze'
const ROLLUP_JOB = 'codeql'
const REQUIRED_CONTEXT = 'CodeQL'
const REQUIRED_TRIGGERS = ['push', 'pull_request', 'merge_group', 'schedule'] as const
const MERGE_BLOCKING_EVENTS = ['pull_request', 'merge_group'] as const

/**
 * The identifiers default setup analysed, exactly as
 * `GET /repos/Llamenos-Hotline/llamenos-platform/code-scanning/default-setup`
 * listed them on 2026-09-27 (query_suite "default", threat_model "remote").
 * Seven identifiers, five analyses: see ALIASES.
 */
const REQUIRED_IDENTIFIERS = [
  'actions',
  'javascript',
  'javascript-typescript',
  'python',
  'ruby',
  'rust',
  'typescript',
] as const

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
  strategy?: { matrix?: unknown }
  steps?: unknown
}

type Workflow = {
  on?: unknown
  jobs?: Record<string, Job>
}

type InitStep = { uses: string; with?: { languages?: unknown } }

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

function initSteps(job: Job): InitStep[] {
  if (!Array.isArray(job.steps)) return []
  return job.steps.filter(
    (step): step is InitStep =>
      isRecord(step) && typeof step.uses === 'string' && step.uses.startsWith('github/codeql-action/init@'),
  )
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

/**
 * The rollup's check-run name for an event. Accepts a literal name, or the
 * one shape codeql.yml uses:
 * `${{ github.event_name == '<event>' && '<then>' || '<else>' }}`.
 */
function rollupNameFor(name: unknown, event: string): string | undefined {
  if (typeof name !== 'string') return undefined
  if (!name.includes('${{')) return name
  const m = normalizeExpression(name).match(
    /^\$\{\{ github\.event_name == '([a-z_]+)' && '([^']+)' \|\| '([^']+)' \}\}$/,
  )
  if (!m) return undefined
  const [, when, then, otherwise] = m
  return event === when ? then : otherwise
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
    if (typeof job.name === 'string' && job.name.trim() === REQUIRED_CONTEXT) {
      violations.push(`staged job \`${id}\` is named \`${REQUIRED_CONTEXT}\`, the required context`)
    }
    staged.push({ job: id, languages })
  }

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
    const onQueue = rollupNameFor(rollup.name, 'merge_group')
    const onPr = rollupNameFor(rollup.name, 'pull_request')
    if (onQueue === undefined || onPr === undefined) {
      violations.push(`\`${ROLLUP_JOB}\`'s name is not a form this rail can evaluate: ${String(rollup.name)}`)
    } else {
      if (onQueue !== REQUIRED_CONTEXT) {
        violations.push(`\`${ROLLUP_JOB}\` is named \`${onQueue}\` on merge_group — the queue's ref needs a \`${REQUIRED_CONTEXT}\` check-run`)
      }
      if (onPr === REQUIRED_CONTEXT) {
        violations.push(
          `\`${ROLLUP_JOB}\` is named \`${REQUIRED_CONTEXT}\` on pull_request — that name belongs to GHAS's alert gate there, and a green rollup must not be able to stand in for it`,
        )
      }
    }
  }

  if (violations.length > 0) {
    console.error(`❌ ${path}: CodeQL required coverage has diverged from default setup's languages:`)
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
  console.log(`✅ ${path}: required CodeQL legs cover exactly the ${REQUIRED_IDENTIFIERS.length} default-setup identifiers (${byExtractor.size} analyses):`)
  for (const [extractor, ids] of byExtractor) console.log(`   ${ids.join(', ')} → ${extractor}`)
  if (staged.length > 0) {
    console.log(`   Staged, not required (outside the ${REQUIRED_CONTEXT} rollup, never on ${MERGE_BLOCKING_EVENTS.join('/')}):`)
    for (const { job, languages } of staged) console.log(`   ${languages.join(', ')} (${job})`)
  }
}

try {
  main()
} catch (err) {
  console.error('CodeQL language check failed to run:', err)
  process.exit(2)
}
