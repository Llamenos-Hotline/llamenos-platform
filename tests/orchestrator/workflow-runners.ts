/**
 * Where can each workflow job run? A resolver for `runs-on` across every file
 * in `.github/workflows/`, so a rail about runner placement covers the whole
 * class rather than the one workflow that last failed (#2544).
 *
 * Why this exists. #2748 moved every ios-e2e.yml shard off GitHub-hosted
 * `macos-15`, because a hosted job that never gets a runner is ABANDONED after
 * ~15 minutes (runner_name="", zero steps) and `ci-status` reads it as "produced
 * NO VERDICT". Its guard read ios-e2e.yml alone. ci.yml's `ios-compile-check`
 * was still on `macos-15`, and PR #2749 was blocked by exactly that mechanism
 * while the guard passed. A guard scoped narrower than the class reports
 * safety it does not provide; this one enumerates the class from the files.
 *
 * It resolves, and refuses to guess. `runs-on` can be a string, a label list,
 * a `{ group, labels }` object, `${{ matrix.<key> }}` over a literal or
 * `fromJSON('…')` matrix, or an arbitrary expression choosing between literal
 * label sets (fleet-review.yml). Every literal the expression can produce is a
 * candidate placement. A `runs-on` from which no literal can be recovered is
 * reported as UNRESOLVED — never treated as safe.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

export const WORKFLOWS_DIR = join(process.cwd(), '.github', 'workflows')

/**
 * The label set every self-hosted Mac job must request, and the labels the
 * Macs actually carry. Measured 2026-11-13 via
 * `gh api repos/Llamenos-Hotline/llamenos-platform/actions/runners`:
 * `mac-mini-ios-1` and `mac-mini-ios-2`, both online, both exactly
 * `self-hosted,macOS,ARM64,ios-e2e`. A job asking for a label neither has is
 * not abandoned — it waits forever, which is worse.
 */
export const MAC_RUNNER_LABELS = ['self-hosted', 'macOS', 'ARM64', 'ios-e2e'] as const

/** One literal placement a job's `runs-on` can produce. */
export type Placement =
  | { kind: 'hosted-macos'; image: string }
  | { kind: 'self-hosted'; labels: string[] }
  | { kind: 'other'; value: string }

export interface JobPlacements {
  /** `<file>:<job id>` */
  where: string
  file: string
  job: string
  placements: Placement[]
  /** Why `runs-on` could not be resolved to literals, when it could not. */
  unresolved?: string
}

export interface RawJob {
  'runs-on'?: unknown
  uses?: string
  needs?: string | string[]
  if?: string
  name?: string
  strategy?: { matrix?: unknown }
  steps?: Array<{ name?: string; run?: string }>
}
export interface RawWorkflow {
  on?: unknown
  jobs?: Record<string, RawJob>
}

/** Every workflow file, parsed. */
export function loadWorkflows(dir: string = WORKFLOWS_DIR): Map<string, RawWorkflow> {
  const out = new Map<string, RawWorkflow>()
  for (const file of readdirSync(dir).sort()) {
    if (!/\.ya?ml$/.test(file)) continue
    out.set(file, parseYaml(readFileSync(join(dir, file), 'utf8')) as RawWorkflow)
  }
  return out
}

const EXPR = /\$\{\{([\s\S]*?)\}\}/

/** Every single-quoted literal in an expression, JSON-decoded when it is JSON. */
function literalsIn(expr: string): unknown[] {
  const out: unknown[] = []
  for (const m of expr.matchAll(/'((?:[^']|'')*)'/g)) {
    const raw = (m[1] as string).replace(/''/g, "'")
    try {
      out.push(JSON.parse(raw))
    } catch {
      out.push(raw)
    }
  }
  return out
}

/** The values a matrix can give `key`, from literal axes, `include`, or fromJSON literals. */
function matrixValues(matrix: unknown, key: string): unknown[] | null {
  if (matrix === undefined || matrix === null) return null
  const fromEntries = (entries: unknown): unknown[] =>
    Array.isArray(entries)
      ? entries.flatMap((e) => (e !== null && typeof e === 'object' && key in e ? [(e as Record<string, unknown>)[key]] : []))
      : []
  if (typeof matrix === 'string') {
    // the whole matrix is an expression: `${{ fromJSON('{"include":[…]}') }}`
    const vals = literalsIn(matrix).flatMap((lit) => {
      if (Array.isArray(lit)) return fromEntries(lit)
      if (lit !== null && typeof lit === 'object') {
        const o = lit as Record<string, unknown>
        return [...(Array.isArray(o[key]) ? (o[key] as unknown[]) : []), ...fromEntries(o.include)]
      }
      return []
    })
    return vals.length > 0 ? vals : null
  }
  if (typeof matrix !== 'object') return null
  const m = matrix as Record<string, unknown>
  const vals: unknown[] = []
  const axis = m[key]
  if (Array.isArray(axis)) vals.push(...axis)
  else if (typeof axis === 'string') {
    const lits = literalsIn(axis).flatMap((l) => (Array.isArray(l) ? l : [l]))
    if (lits.length === 0) return null
    vals.push(...lits)
  }
  const include = m.include
  if (Array.isArray(include)) vals.push(...fromEntries(include))
  else if (typeof include === 'string') {
    const lits = literalsIn(include)
    if (lits.length === 0) return null
    for (const l of lits) vals.push(...fromEntries(l))
  }
  return vals.length > 0 ? vals : null
}

/** Classify one literal value `runs-on` can take. */
export function classify(value: unknown): Placement[] {
  if (Array.isArray(value)) {
    const labels = value.map(String)
    if (labels.some((l) => l.toLowerCase() === 'self-hosted')) return [{ kind: 'self-hosted', labels }]
    return labels.flatMap((l) => classify(l))
  }
  const s = String(value).trim()
  if (s.toLowerCase() === 'self-hosted') return [{ kind: 'self-hosted', labels: [s] }]
  // Every GitHub-hosted macOS image and its larger-runner variants
  // (macos-15, macos-latest, macos-14-large, macos-15-xlarge, macos-26, …).
  if (/^macos-/i.test(s)) return [{ kind: 'hosted-macos', image: s }]
  return [{ kind: 'other', value: s }]
}

/** Resolve one job's `runs-on` to every literal placement it can produce. */
export function resolveJob(file: string, id: string, job: RawJob): JobPlacements {
  const base = { where: `${file}:${id}`, file, job: id }
  const runsOn = job['runs-on']
  if (runsOn === undefined) {
    // A job that calls a reusable workflow has no runner of its own; the
    // callee's jobs are resolved where they are defined.
    if (typeof job.uses === 'string') return { ...base, placements: [] }
    return { ...base, placements: [], unresolved: 'job has neither runs-on nor uses' }
  }

  const fromValue = (v: unknown): { placements: Placement[]; unresolved?: string } => {
    if (Array.isArray(v)) {
      if (v.some((e) => typeof e === 'string' && EXPR.test(e))) return { placements: [], unresolved: `label list contains an expression: ${JSON.stringify(v)}` }
      return { placements: classify(v) }
    }
    if (v !== null && typeof v === 'object') {
      const labels = (v as Record<string, unknown>).labels
      if (labels === undefined) return { placements: [], unresolved: `runs-on object with no labels: ${JSON.stringify(v)}` }
      return fromValue(labels)
    }
    const s = String(v)
    const expr = s.match(EXPR)
    if (expr === null) return { placements: classify(s) }
    const body = expr[1] as string
    const values: unknown[] = []
    for (const m of body.matchAll(/\bmatrix\.([A-Za-z_][\w-]*)/g)) {
      const vals = matrixValues(job.strategy?.matrix, m[1] as string)
      if (vals === null) return { placements: [], unresolved: `matrix.${m[1]} has no literal values to resolve` }
      values.push(...vals)
    }
    values.push(...literalsIn(body))
    if (values.length === 0) return { placements: [], unresolved: `no literal can be recovered from ${s}` }
    const placements: Placement[] = []
    for (const val of values) {
      const r = fromValue(val)
      if (r.unresolved !== undefined) return r
      placements.push(...r.placements)
    }
    return { placements }
  }

  const r = fromValue(runsOn)
  return { ...base, ...r }
}

/** Every job in every workflow, resolved. */
export function resolveAll(workflows: Map<string, RawWorkflow> = loadWorkflows()): JobPlacements[] {
  const out: JobPlacements[] = []
  for (const [file, wf] of workflows) {
    for (const [id, job] of Object.entries(wf.jobs ?? {})) out.push(resolveJob(file, id, job))
  }
  return out
}

/** Does this placement request only labels the Mac runners carry, including macOS? */
export function isSchedulableOnMacs(p: Placement): boolean {
  if (p.kind !== 'self-hosted') return false
  const have = new Set(MAC_RUNNER_LABELS.map((l) => l.toLowerCase()))
  return p.labels.every((l) => have.has(l.toLowerCase()))
}

/** A self-hosted placement that asks for macOS at all. */
export function asksForSelfHostedMac(p: Placement): boolean {
  return p.kind === 'self-hosted' && p.labels.some((l) => l.toLowerCase() === 'macos')
}

// ─── Can a job gate a merge? ────────────────────────────────────────────────

/** The trigger events of a workflow, with their `types` filter when given. */
function ownTriggers(wf: RawWorkflow): Map<string, string[] | null> {
  const out = new Map<string, string[] | null>()
  const on = wf.on
  if (typeof on === 'string') out.set(on, null)
  else if (Array.isArray(on)) for (const e of on) out.set(String(e), null)
  else if (on !== null && typeof on === 'object') {
    for (const [e, cfg] of Object.entries(on as Record<string, unknown>)) {
      const types = cfg !== null && typeof cfg === 'object' ? (cfg as Record<string, unknown>).types : undefined
      out.set(e, Array.isArray(types) ? types.map(String) : null)
    }
  }
  return out
}

/**
 * The events a workflow can effectively run under. A reusable workflow
 * (`workflow_call`) runs under its CALLER's event — the `github` context is
 * the caller's (measured; see ios-e2e.yml's fork-guard note) — so its
 * triggers are the union of every local caller's.
 */
export function effectiveTriggers(file: string, workflows: Map<string, RawWorkflow>, seen = new Set<string>()): Map<string, string[] | null> {
  const wf = workflows.get(file)
  const out = new Map<string, string[] | null>()
  if (wf === undefined || seen.has(file)) return out
  seen.add(file)
  for (const [e, t] of ownTriggers(wf)) if (e !== 'workflow_call') out.set(e, t)
  if (ownTriggers(wf).has('workflow_call')) {
    for (const [callerFile, caller] of workflows) {
      const calls = Object.values(caller.jobs ?? {}).some((j) => j.uses === `./.github/workflows/${file}`)
      if (!calls) continue
      for (const [e, t] of effectiveTriggers(callerFile, workflows, seen)) {
        const prev = out.get(e)
        // union of type filters; null (= all types) absorbs everything
        out.set(e, prev === null || t === null ? null : [...new Set([...(prev ?? []), ...t])])
      }
    }
  }
  return out
}

/**
 * Events under which a check on an OPEN PR head, or on a merge group, can be
 * waiting for this job. `pull_request` restricted to `closed` is not one: it
 * fires after the PR is closed (release.yml), so nothing gating can wait on it.
 */
export function mergeGatingEvents(triggers: Map<string, string[] | null>): string[] {
  const out: string[] = []
  for (const [e, types] of triggers) {
    if (e === 'merge_group' || e === 'pull_request_target') out.push(e)
    else if (e === 'pull_request' && !(types !== null && types.every((t) => t === 'closed'))) out.push(e)
  }
  return out
}

/**
 * The event names a job-level `if:` restricts it to, when the `if:` is a pure
 * disjunction of `github.event_name == '<x>'` terms; null when it is anything
 * else (the job may run under any of its workflow's events).
 */
export function eventsAllowedByIf(cond: string | undefined): string[] | null {
  if (cond === undefined) return null
  const body = (cond.match(EXPR)?.[1] ?? cond).trim()
  const terms = body.split('||').map((t) => t.trim().replace(/^\(|\)$/g, '').trim())
  const events: string[] = []
  for (const t of terms) {
    const m = t.match(/^github\.event_name\s*==\s*'([a-z_]+)'$/)
    if (m === null) return null
    events.push(m[1] as string)
  }
  return events
}

/** The merge-gating events this job can run under, after its own `if:`. */
export function jobMergeGatingEvents(file: string, id: string, workflows: Map<string, RawWorkflow>): string[] {
  const gating = mergeGatingEvents(effectiveTriggers(file, workflows))
  const allowed = eventsAllowedByIf(workflows.get(file)?.jobs?.[id]?.if)
  return allowed === null ? gating : gating.filter((e) => allowed.includes(e))
}

/**
 * Every `<file>:<job>` a job's verdict depends on: its transitive `needs`,
 * with a job that calls a local reusable workflow expanded to every job in
 * the callee (ci.yml's `ios-e2e` → all of ios-e2e.yml).
 */
export function needsClosure(file: string, id: string, workflows: Map<string, RawWorkflow>): Set<string> {
  const out = new Set<string>()
  const visit = (f: string, j: string): void => {
    const key = `${f}:${j}`
    if (out.has(key)) return
    out.add(key)
    const job = workflows.get(f)?.jobs?.[j]
    if (job === undefined) return
    const needs = job.needs === undefined ? [] : Array.isArray(job.needs) ? job.needs : [job.needs]
    for (const n of needs) visit(f, n)
    const callee = job.uses?.match(/^\.\/\.github\/workflows\/(.+\.ya?ml)$/)?.[1]
    if (callee !== undefined) for (const cj of Object.keys(workflows.get(callee)?.jobs ?? {})) visit(callee, cj)
  }
  visit(file, id)
  return out
}

/** The literal first step of a job is the self-hosted fork-PR refusal. */
export function firstStepIsForkGuard(job: RawJob | undefined): boolean {
  const first = job?.steps?.[0]
  if (first === undefined) return false
  return /Refuse to run on a fork PR/.test(first.name ?? '')
    && /"\$HEAD_REPO" != "\$THIS_REPO"/.test(first.run ?? '')
    && /exit 1/.test(first.run ?? '')
}
