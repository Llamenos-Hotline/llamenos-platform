#!/usr/bin/env bun
/**
 * Fleet triage agent — assigns `lane:*` labels to unlabelled open issues from
 * the file paths their bodies cite (#1814).
 *
 * Why this exists: `select.ts` rejects any item no lane claims with
 * `reason: 'other-lane'`, so an open issue with no `lane:` label is unroutable
 * even when it is otherwise dispatchable. Assigning the lane is mechanical —
 * the body cites paths, and each lane's scope paths already live in
 * `.claude/agents/fragments/<lane>-supervisor.md`, parsed by the SAME
 * `loadLaneScopes()` + `matchesPath()` the orchestrator's scope breaker and
 * `doctor` use. This script reads that table rather than duplicating it, so
 * the triage agent and the router cannot drift apart.
 *
 * The one hard boundary: THIS TOOL NEVER APPLIES `agent-dispatchable`.
 * `lane:*` is a noun — it describes what an issue touches, and a wrong one is
 * cheap and visible. `agent-dispatchable` is a verb — it causes work to
 * happen. Label-as-trigger has already caused four gate bugs in this repo;
 * the rule drawn from that is that labels describe and requests act. An agent
 * that can enqueue its own work removes the last human decision about what
 * the fleet spends its budget on. So this agent proposes routing, and a human
 * still decides what gets worked. The boundary is enforced twice: the
 * decision function's return type can only ever be `lane:<id>` or
 * `needs-split`, and `assertAppliableLabel()` throws on anything else before
 * any `gh` call is made.
 *
 * Decision rules (mirroring the hand-triage of seven M1 issues on 2026-10-11):
 *   1. Extract repo-relative paths from the issue body.
 *   2. Attribute each path to the lane whose OWNED pattern matches longest
 *      (the same longest-match-wins rule as `scope.ts`). A path whose longest
 *      match ties across lanes — `packages/test-specs/features/`,
 *      `packages/i18n/locales/`, `playwright.config.ts` — is a deliberate
 *      shared-write grant: it is non-discriminative and attributes nowhere.
 *   3. Exactly one lane implicated, or one lane strictly dominant over one
 *      other → apply `lane:<x>`.
 *   4. Three or more lanes implicated → apply `needs-split` (no single lane
 *      can own it; dispatching it would burn three attempts, see #1764).
 *   5. No paths, no lane match, or a two-lane tie → apply nothing and say
 *      why. An agent that always picks a lane has not been verified — it has
 *      just been observed agreeing.
 *
 * Usage:
 *   bun run scripts/fleet-triage.ts              # dry run: print the plan
 *   bun run scripts/fleet-triage.ts -- --apply   # apply lane:/needs-split labels
 *   bun run scripts/fleet-triage.ts -- --limit 50
 *
 * Default is a dry run. `--apply` only ever ADDS labels, only ever from the
 * allowlist above, and only to open issues carrying no `lane:*` label and no
 * `needs-split` label already.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadLaneScopes, matchesPath, type LaneScope } from '../orchestrator/src/fragments.js'
import { gh, describeGhFailure } from '../orchestrator/src/gh.js'

/** The only labels this agent may ever apply. `agent-dispatchable` is absent
 *  on purpose — see the header. Widening this set is a fleet-governance
 *  decision, not a code change. */
const APPLIABLE_LABEL = /^(lane:(backend|shared|desktop|ios|android|infra)|needs-split)$/

/** The labels `decideLane` is allowed to return — a type-level guarantee on
 *  top of the runtime `APPLIABLE_LABEL` check. */
export type TriageLabel = `lane:${string}` | 'needs-split'

export type TriageDecision =
  | { label: TriageLabel; lanes: Record<string, number>; paths: string[] }
  | { label: null; reason: string; lanes: Record<string, number>; paths: string[] }

/** Throws unless `label` is one the triage agent may apply. The last gate
 *  before any `gh issue edit` runs. */
export function assertAppliableLabel(label: string): asserts label is TriageLabel {
  if (!APPLIABLE_LABEL.test(label)) {
    throw new Error(`fleet-triage must never apply label ${JSON.stringify(label)}`)
  }
}

/**
 * Pulls repo-relative path citations out of an issue body. A citation is a
 * token containing at least one `/` (`apps/worker/routes/notes.ts`,
 * `deploy/docker/…`); surrounding backticks, quotes and sentence punctuation
 * are stripped, as is a leading `./`. Bare filenames (`knope.toml`) are NOT
 * extracted: without a slash they collide with prose constantly, and every
 * hand-triaged example cited a slashed path. Globs containing a slash
 * (`.github/workflows/ios*.yml`) pass through unchanged — `matchesPath`
 * understands them.
 */
export function extractPaths(body: string): string[] {
  const out: string[] = []
  for (const m of body.matchAll(/[^\s`'"()[\]{}<>]*\/[^\s`'"()[\]{}<>]*/g)) {
    const token = m[0]
      .replace(/^\.\//, '')
      .replace(/^[,;:!?/]+/, '')
      .replace(/[.,;:!?]+$/, '')
    if (token.length > 1 && token.includes('/')) out.push(token)
  }
  return [...new Set(out)]
}

export interface PathAttribution {
  /** lane id -> cited paths attributed to that lane (each path lands in at most one lane). */
  attributed: Map<string, string[]>
  /** Paths whose longest owned match ties across lanes — shared-write grants, non-discriminative. */
  sharedWrite: string[]
  /** Paths no lane's owned scope matches at all. */
  unmatched: string[]
}

/**
 * Attributes each cited path to at most one lane by longest matching OWNED
 * pattern — the same rule `scope.ts` uses to resolve owned/notOwned overlap.
 * A trailing `/` retry lets a citation of the directory itself (`apps/ios`)
 * match the lane's `apps/ios/` grant.
 *
 * A TIE at the longest length means the path sits under a deliberate
 * shared-write grant (the same pattern string appears in several fragments —
 * e.g. `packages/i18n/locales/`). Such a path cannot discriminate lanes, so
 * it attributes nowhere rather than implicating every tied lane and forcing a
 * false `needs-split`.
 */
export function attributePaths(paths: string[], scopes: Record<string, LaneScope>): PathAttribution {
  const attributed = new Map<string, string[]>()
  const sharedWrite: string[] = []
  const unmatched: string[] = []
  for (const path of paths) {
    let bestLen = -1
    let best: string[] = []
    for (const [lane, scope] of Object.entries(scopes)) {
      for (const pattern of scope.owned) {
        if (matchesPath(path, pattern) || matchesPath(`${path}/`, pattern)) {
          if (pattern.length > bestLen) {
            bestLen = pattern.length
            best = [lane]
          } else if (pattern.length === bestLen && !best.includes(lane)) {
            best.push(lane)
          }
        }
      }
    }
    if (best.length === 1 && best[0] !== undefined) {
      const list = attributed.get(best[0]) ?? []
      list.push(path)
      attributed.set(best[0], list)
    } else if (best.length > 1) {
      sharedWrite.push(path)
    } else {
      unmatched.push(path)
    }
  }
  return { attributed, sharedWrite, unmatched }
}

/**
 * The routing decision for one issue, from its attributed lane hits.
 *
 *   - 0 implicated lanes  → no label; the reason distinguishes "body cited no
 *     paths" from "paths cited match no lane's scope" — the second is the one
 *     a human should look at, because it means the scope table may have a gap.
 *   - 1 lane              → `lane:<that lane>`.
 *   - 2 lanes             → `lane:<winner>` only when the winner is STRICTLY
 *     dominant; a tie is a human call.
 *   - 3+ lanes            → `needs-split`. No single lane can own the work,
 *     and a mis-routed dispatch burns three attempts before giving up (#1764).
 *
 * Lane iteration is sorted so a tie-break is deterministic across runs.
 */
export function decideLane(attributed: Map<string, string[]>): TriageDecision {
  const lanes: Record<string, number> = {}
  for (const [lane, paths] of attributed) lanes[lane] = paths.length
  const paths = [...attributed.values()].flat()
  const ranked = Object.entries(lanes).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  if (ranked.length === 0) {
    return { label: null, reason: 'no cited path matched any lane scope', lanes, paths }
  }
  if (ranked.length >= 3) {
    return { label: 'needs-split', lanes, paths }
  }
  const [first, second] = ranked as [string, number][] as [[string, number], [string, number] | undefined]
  if (second === undefined || first[1] > second[1]) {
    return { label: `lane:${first[0]}`, lanes, paths }
  }
  return {
    label: null,
    reason: `spans ${first[0]} and ${second[0]} with no dominant lane (${first[1]} vs ${second[1]} cited paths)`,
    lanes,
    paths,
  }
}

/** Convenience composition kept pure for tests: body in, decision out. */
export function triageBody(body: string, scopes: Record<string, LaneScope>): TriageDecision {
  const extracted = extractPaths(body)
  if (extracted.length === 0) {
    return { label: null, reason: 'issue body cites no repo paths', lanes: {}, paths: [] }
  }
  const decision = decideLane(attributePaths(extracted, scopes).attributed)
  return { ...decision, paths: extracted }
}

interface IssueRow {
  number: number
  title: string
  body: string | null
  labels: { name: string }[]
}

function parseArgs(argv: string[]): { apply: boolean; limit: number } {
  let apply = false
  let limit = 500
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--apply') apply = true
    else if (a === '--limit') {
      const v = Number(argv[++i])
      if (!Number.isInteger(v) || v <= 0) throw new Error('--limit needs a positive integer')
      limit = v
    } else if (a === '--help' || a === '-h') {
      console.log('usage: bun run scripts/fleet-triage.ts [-- --apply] [-- --limit N]')
      process.exit(0)
    } else {
      throw new Error(`unknown argument: ${a}`)
    }
  }
  return { apply, limit }
}

if (import.meta.main) {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const { apply, limit } = parseArgs(process.argv.slice(2))
  const scopes = await loadLaneScopes(repoRoot)

  const raw = await gh([
    'issue', 'list', '--state', 'open', '--limit', String(limit),
    '--json', 'number,title,body,labels',
  ])
  const issues = JSON.parse(raw) as IssueRow[]

  const untriaged = issues.filter(
    (i) => !i.labels.some((l) => l.name.startsWith('lane:') || l.name === 'needs-split'),
  )
  console.log(
    `${issues.length} open issues, ${issues.length - untriaged.length} already carry lane:/needs-split, ` +
    `${untriaged.length} to triage (${apply ? 'APPLYING labels' : 'dry run — pass --apply to label'})`,
  )

  const tally = { labelled: 0, needsSplit: 0, skipped: 0, failed: 0 }
  for (const issue of untriaged) {
    const decision = triageBody(`${issue.title}\n${issue.body ?? ''}`, scopes)
    const detail =
      decision.label === null
        ? `SKIP (${decision.reason})`
        : `${decision.label} (${Object.entries(decision.lanes).map(([l, n]) => `${l}:${n}`).join(', ')})`
    console.log(`#${issue.number} ${decision.label === null ? ' ' : decision.label === 'needs-split' ? '~' : '+'} ${detail}  ${issue.title}`)
    if (decision.label === null) {
      tally.skipped++
      continue
    }
    try {
      assertAppliableLabel(decision.label)
    } catch (e) {
      // Unreachable by construction — decideLane's return type excludes every
      // other label — but the boundary is important enough to check twice.
      console.error(`#${issue.number} REFUSED: ${(e as Error).message}`)
      tally.failed++
      continue
    }
    if (decision.label === 'needs-split') tally.needsSplit++
    else tally.labelled++
    if (apply) {
      try {
        await gh(['issue', 'edit', String(issue.number), '--add-label', decision.label])
      } catch (e) {
        console.error(`#${issue.number} label failed: ${describeGhFailure(e)}`)
        tally.failed++
      }
    }
  }
  console.log(
    `done: ${tally.labelled} lane labels, ${tally.needsSplit} needs-split, ` +
    `${tally.skipped} skipped, ${tally.failed} failed${apply ? '' : ' (dry run — nothing applied)'}`,
  )
}
