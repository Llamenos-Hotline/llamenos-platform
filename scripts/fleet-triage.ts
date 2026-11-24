#!/usr/bin/env bun
/**
 * Fleet triage agent — assigns `lane:*` labels to unlabelled open issues from
 * the file paths their bodies cite (#1814).
 *
 * Why this exists: `select.ts` rejects any item no lane claims with
 * `reason: 'other-lane'`, so an open issue with no `lane:` label is unroutable
 * even when it is otherwise dispatchable. Assigning the lane is mechanical —
 * the body cites paths, and each lane's scope paths already live in
 * `.claude/agents/fragments/<lane>-supervisor.md`, loaded by the SAME
 * `loadLanes()` the tick uses, and judged by the SAME router. This script
 * reads that table rather than duplicating it, so the triage agent and the
 * dispatcher cannot drift apart. The tick also labels an unlabelled
 * dispatchable issue itself when the answer is unambiguous (#2623); this
 * script is the batch form for the rest of the backlog.
 *
 * The one hard boundary: THIS TOOL NEVER APPLIES `agent-dispatchable`.
 * `lane:*` is a noun — it describes what an issue touches, and a wrong one is
 * cheap and visible. `agent-dispatchable` is a verb — it causes work to
 * happen. Label-as-trigger has already caused four gate bugs in this repo;
 * the rule drawn from that is that labels describe and requests act. An agent
 * that can enqueue its own work removes the last human decision about what
 * the fleet spends its budget on. So this agent proposes routing, and a human
 * still decides what gets worked. The boundary is enforced twice: the
 * decision function's return type can only ever be `lane:<id>`, and
 * `assertAppliableLabel()` throws on anything else before any `gh` call is
 * made.
 *
 * Decision rules — implemented ONCE, in orchestrator/src/route.ts, and shared
 * with the dispatcher's pre-dispatch ownership check (#1764), so triage and
 * dispatch cannot disagree about which lane authors an issue:
 *   1. Extract repo-relative paths from the issue body.
 *   2. Attribute each path to the AUTHORING lane (a real lane, never a
 *      scope-only fragment) that owns it — carve-outs honoured — by longest
 *      owned match. A path several lanes own equally (`packages/i18n/locales/`,
 *      `package.json`) is a deliberate shared-write grant: it attributes nowhere.
 *   3. The contract owner when the issue cites the contract and two or more
 *      consumer lanes; otherwise one lane implicated, or one lane strictly
 *      dominant → apply `lane:<x>`. Three implicated lanes is one cross-lane
 *      change authored by one lane, never a split (#2979 point 4).
 *   4. No paths, no lane match, or a tie → apply nothing and say why. An agent
 *      that always picks a lane has not been verified — it has just been
 *      observed agreeing.
 *
 * Usage:
 *   bun run scripts/fleet-triage.ts              # dry run: print the plan
 *   bun run scripts/fleet-triage.ts -- --apply   # apply lane: labels
 *   bun run scripts/fleet-triage.ts -- --limit 50
 *
 * Default is a dry run. `--apply` only ever ADDS labels, only ever from the
 * allowlist above, and only to open issues carrying no `lane:*` label already.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadLanes, type Lane } from '../orchestrator/src/config.js'
import { attributePaths, authorFor, extractPaths, type PathAttribution } from '../orchestrator/src/route.js'
import { gh, describeGhFailure } from '../orchestrator/src/gh.js'

export { attributePaths, extractPaths }

/** The only labels this agent may ever apply. `agent-dispatchable` is absent
 *  on purpose — see the header. Widening this set is a fleet-governance
 *  decision, not a code change. */
const APPLIABLE_LABEL = /^lane:(backend|shared|desktop|ios|android|infra)$/

/** The labels `decideLane` is allowed to return — a type-level guarantee on
 *  top of the runtime `APPLIABLE_LABEL` check. */
export type TriageLabel = `lane:${string}`

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
 * The routing decision for one issue: `lane:<author>` from the SAME router
 * the dispatcher uses (`authorFor`, orchestrator/src/route.ts), or no label
 * with a reason. Ties are NOT broken here — an unlabelled issue whose cited
 * paths split evenly is a human's call — and nothing is ever split: an issue
 * spanning three lanes is one cross-lane change authored by one lane (the
 * contract owner when it cites the contract and two consumers), with the other
 * lanes reviewing (#2979 point 4). `needs-split` was the per-lane slicing the
 * lane model retired.
 */
export function decideLane(attribution: PathAttribution, lanes: readonly Lane[]): TriageDecision {
  const decision = authorFor(attribution, lanes, { breakTies: false })
  const paths = [...attribution.attributed.values()].flat()
  if (decision.author === undefined) return { label: null, reason: decision.reason, lanes: decision.counts, paths }
  return { label: `lane:${decision.author}`, lanes: decision.counts, paths }
}

/** Convenience composition kept pure for tests: body in, decision out. */
export function triageBody(body: string, lanes: readonly Lane[]): TriageDecision {
  const extracted = extractPaths(body)
  if (extracted.length === 0) {
    return { label: null, reason: 'issue body cites no repo paths', lanes: {}, paths: [] }
  }
  const decision = decideLane(attributePaths(extracted, lanes), lanes)
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
  const lanes = await loadLanes(repoRoot)

  const raw = await gh([
    'issue', 'list', '--state', 'open', '--limit', String(limit),
    '--json', 'number,title,body,labels',
  ])
  const issues = JSON.parse(raw) as IssueRow[]

  const untriaged = issues.filter((i) => !i.labels.some((l) => l.name.startsWith('lane:')))
  console.log(
    `${issues.length} open issues, ${issues.length - untriaged.length} already carry lane:, ` +
    `${untriaged.length} to triage (${apply ? 'APPLYING labels' : 'dry run — pass --apply to label'})`,
  )

  const tally = { labelled: 0, skipped: 0, failed: 0 }
  for (const issue of untriaged) {
    const decision = triageBody(`${issue.title}\n${issue.body ?? ''}`, lanes)
    const detail =
      decision.label === null
        ? `SKIP (${decision.reason})`
        : `${decision.label} (${Object.entries(decision.lanes).map(([l, n]) => `${l}:${n}`).join(', ')})`
    console.log(`#${issue.number} ${decision.label === null ? ' ' : '+'} ${detail}  ${issue.title}`)
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
    tally.labelled++
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
    `done: ${tally.labelled} lane labels, ` +
    `${tally.skipped} skipped, ${tally.failed} failed${apply ? '' : ' (dry run — nothing applied)'}`,
  )
}
