import { GRANT_EXCLUDED_PATHS, NEVER_WRITE_PATHS, type Lane } from './config.js'
import { SCOPE_GRANT_PREFIX, laneIdFromBranch } from './ci.js'
import { matchesPath } from './fragments.js'
import { checkScope } from './scope.js'
import { isFleetOwnedBranch } from './automerge.js'
import { secretFinding } from './write-gate.js'
import { REPO, gh, ghJson, describeGhFailure } from './gh.js'
import { prApiNumber } from './review-request.js'

/**
 * Cross-lane fleet PRs carry their own `scope:<lane>` grant at open (#2643).
 *
 * The measured failure: four of seven overnight PRs (#2633, #2634, #2637,
 * #2638) each fixed ONE problem whose files straddled a lane boundary — a
 * route that honours a new filter needs the schema declaring it and the client
 * sending it; a permission added to the catalog needs a migration granting it.
 * Every one failed `fleet/verify` and `fleet/review` at `NO-VERDICT:scope`
 * with `review=not-run`, so NO reviewer ran at all, until an operator applied
 * the right `scope:` labels by hand and then DELETEd and POSTed the requested
 * reviewer — because `fleet-verify.yml` deliberately listens for
 * `review_requested` and not `labeled`, and a rerun repeats the stale label
 * lookup. The grant mechanism existed (#1115) and was self-applicable; nothing
 * in the dispatch path ever applied it.
 *
 * This module is the missing step. At PR open the orchestrator reads the PR's
 * file list, works out which lanes' grants the diff needs, applies exactly
 * those labels, says so on the PR, and refires the review so the gate's first
 * attempt already sees them.
 *
 * What this does NOT change, and must not:
 *
 * - **The gate still decides.** `resolveGrantedLanes` / `checkScopeAcross`
 *   read the labels and re-judge every file. A wrong grant here cannot widen
 *   anything the gate would not allow with that label applied by hand.
 * - **`GRANT_EXCLUDED_PATHS` is the hard boundary.** A diff touching a
 *   grant-excluded path (CI, deploy, supply chain), a secret, or a path no
 *   lane owns gets NO grant at all — not a partial one. Granting the
 *   grantable half of a PR that cannot pass anyway would only make the label
 *   list read like an authorisation nobody gave. The refusal is logged with
 *   the exact files; the gate's `scope advice:` lines tell the reader the
 *   remedy as before.
 * - **Never a self-grant by the worker.** The label is applied by the
 *   orchestrator from the diff on GitHub, not read from anything the worker
 *   wrote, and the PR comment below makes the widening visible.
 */

/** Marks the PR comment this module posts, so a reader (and a test) can tell
 *  a fleet-applied grant from one an operator applied by hand. */
export const SCOPE_GRANT_COMMENT_MARKER = '<!-- fleet:scope-grant -->'

export interface ScopeGrantPlan {
  /** Lane ids whose `scope:<lane>` label the diff needs, sorted. */
  grants: string[]
  /** Files that cannot be granted, with why. Non-empty means NO grant is made. */
  refused: { file: string; reason: 'secret' | 'grant-excluded' | 'unowned' }[]
  /** For each granted lane, the files that needed it (for the PR comment). */
  filesByLane: Record<string, string[]>
}

/**
 * Which `scope:<lane>` labels a diff needs, or why it cannot have them.
 *
 * Pure. A file the PR's own lane owns needs nothing. Any other file needs a
 * lane that really owns it (non-empty `owned` — the same "an empty list owns
 * nothing" rule `scopeStrayAdvice` and `resolveGrantedLanes` apply), is not
 * grant-excluded, and is not a secret. When several lanes own one file the
 * lane already chosen for another file wins, then the alphabetically first —
 * deterministic, and the smallest label set that covers the diff.
 */
export function planScopeGrants(
  changed: readonly string[],
  own: Lane,
  allLanes: readonly Lane[],
): ScopeGrantPlan {
  const candidates = allLanes.filter((l) => l.id !== own.id && l.scope.owned.length > 0)
  const refused: ScopeGrantPlan['refused'] = []
  const chosen = new Set<string>()
  const filesByLane: Record<string, string[]> = {}
  for (const f of [...new Set(changed)].sort()) {
    if (secretFinding(f, NEVER_WRITE_PATHS, undefined) !== undefined) {
      refused.push({ file: f, reason: 'secret' })
      continue
    }
    if (own.scope.owned.length === 0 || checkScope([f], own.scope, []).strayed.length === 0) continue
    if (GRANT_EXCLUDED_PATHS.some((p) => matchesPath(f, p))) {
      refused.push({ file: f, reason: 'grant-excluded' })
      continue
    }
    const owners = candidates.filter((l) => checkScope([f], l.scope, []).strayed.length === 0).map((l) => l.id).sort()
    if (owners.length === 0) {
      refused.push({ file: f, reason: 'unowned' })
      continue
    }
    const pick = owners.find((id) => chosen.has(id)) ?? owners[0]
    if (pick === undefined) continue
    chosen.add(pick)
    ;(filesByLane[pick] ??= []).push(f)
  }
  return { grants: [...chosen].sort(), refused, filesByLane }
}

export interface ScopeGrantDeps {
  /** The PR's changed paths, renames included under BOTH names — `undefined`
   *  when they could not be read ("could not look" is never "nothing changed"). */
  readChangedFiles(pr: string): Promise<string[] | undefined>
  /** The PR's current label names — `undefined` when unreadable. */
  readLabels(pr: string): Promise<string[] | undefined>
  lanes(): Promise<Lane[]>
  /** Adds labels. THROWS on failure. */
  addLabels(pr: string, labels: string[]): Promise<void>
  /** Posts the visibility comment. THROWS on failure. */
  comment(pr: string, body: string): Promise<void>
  /** Re-fires the review request so the gate re-reads the labels just
   *  applied — `labeled` does not trigger it. Resolves true only when the
   *  request is confirmed to have fired. Must not throw. */
  refireReview(pr: string, branch: string): Promise<boolean>
  log(msg: string): void
}

export type ScopeGrantOutcome =
  | { kind: 'skipped'; reason: string }
  /** Nothing outside the PR's own lane (or every needed grant is already on). */
  | { kind: 'not-needed' }
  /** The diff needs a path no grant can reach: no label was applied. */
  | { kind: 'refused'; refused: ScopeGrantPlan['refused'] }
  | { kind: 'granted'; grants: string[]; refired: boolean }
  | { kind: 'failed'; reason: string }

export function scopeGrantComment(plan: ScopeGrantPlan, applied: readonly string[]): string {
  const lines = Object.entries(plan.filesByLane)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([lane, files]) => `- \`${SCOPE_GRANT_PREFIX}${lane}\` — ${files.map((f) => `\`${f}\``).join(', ')}`)
  return (
    `${SCOPE_GRANT_COMMENT_MARKER}\n` +
    `**Fleet-applied scope grant** (#2643) — this PR's diff crosses a lane boundary, so the orchestrator ` +
    `applied ${applied.map((l) => `\`${SCOPE_GRANT_PREFIX}${l}\``).join(', ')} and re-requested review so ` +
    `\`fleet/verify\` and \`fleet/review\` judge the change on its merits instead of stopping at ` +
    `\`NO-VERDICT:scope\`.\n\n${lines.join('\n')}\n\n` +
    `The gate still re-checks every file against these labels. CI, deploy and supply-chain paths ` +
    `(\`GRANT_EXCLUDED_PATHS\`), secrets, and paths no lane owns are never granted this way. ` +
    `If this widening is wrong, remove the label and the PR is judged on its own lane alone.`
  )
}

/**
 * The one entry point: called from `realDispatch` the moment a dispatched
 * item's PR is known to exist, BEFORE the at-open review request, and from the
 * `scope-grant` command. Never throws — a PR left ungranted is exactly the
 * `NO-VERDICT:scope` state the gate already reports with its remedy.
 */
export async function grantScopeAtOpen(
  input: { pr: string | undefined; headRefName: string; branchMismatch?: string | undefined },
  deps: ScopeGrantDeps,
): Promise<ScopeGrantOutcome> {
  const { pr: prRaw, headRefName } = input
  if (prRaw === undefined) return { kind: 'skipped', reason: 'no PR was opened' }
  if (input.branchMismatch !== undefined) {
    return { kind: 'skipped', reason: `branch-mismatch:${input.branchMismatch} — the PR is not on the branch this item was dispatched for` }
  }
  const laneId = laneIdFromBranch(headRefName)
  if (laneId === undefined || !isFleetOwnedBranch(headRefName)) {
    return { kind: 'skipped', reason: `${headRefName} is not a fleet-dispatched branch` }
  }
  const pr = prApiNumber(prRaw)
  if (pr === undefined) {
    const reason = `PR ${prRaw} is neither a number nor a ${REPO} pull URL — not guessing`
    deps.log(`scope-grant: ${reason}`)
    return { kind: 'failed', reason }
  }
  try {
    const lanes = await deps.lanes()
    const own = lanes.find((l) => l.id === laneId)
    if (own === undefined) return { kind: 'skipped', reason: `unknown lane ${laneId}` }
    const changed = await deps.readChangedFiles(pr)
    if (changed === undefined) {
      const reason = `could not read PR ${pr}'s changed files — granting nothing`
      deps.log(`scope-grant: ${reason}`)
      return { kind: 'failed', reason }
    }
    const plan = planScopeGrants(changed, own, lanes)
    if (plan.refused.length > 0) {
      deps.log(
        `scope-grant: pr ${pr} NOT granted — ${plan.refused.map((r) => `${r.file} (${r.reason})`).join(', ')}; ` +
        'no scope: label can reach these, so they must leave the PR (the gate\'s "scope advice" lines say the same)',
      )
      return { kind: 'refused', refused: plan.refused }
    }
    if (plan.grants.length === 0) return { kind: 'not-needed' }
    const labels = await deps.readLabels(pr)
    if (labels === undefined) {
      const reason = `could not read PR ${pr}'s labels — not guessing which grants are missing`
      deps.log(`scope-grant: ${reason}`)
      return { kind: 'failed', reason }
    }
    const missing = plan.grants.filter((g) => !labels.includes(`${SCOPE_GRANT_PREFIX}${g}`))
    if (missing.length === 0) return { kind: 'not-needed' }
    await deps.addLabels(pr, missing.map((g) => `${SCOPE_GRANT_PREFIX}${g}`))
    deps.log(`scope-grant: pr ${pr} granted ${missing.map((g) => `${SCOPE_GRANT_PREFIX}${g}`).join(', ')}`)
    // Visibility is best-effort: the labels already do the work, and a
    // failed comment must not stop the review refire that makes them count.
    try { await deps.comment(pr, scopeGrantComment(plan, missing)) } catch (e) {
      deps.log(`scope-grant: pr ${pr} grant comment failed (${describeGhFailure(e)}) — labels are applied`)
    }
    const refired = await deps.refireReview(pr, headRefName)
    if (!refired) deps.log(`scope-grant: pr ${pr} labels applied but the review re-request is unconfirmed — re-request review by hand`)
    return { kind: 'granted', grants: missing, refired }
  } catch (e) {
    const reason = describeGhFailure(e)
    deps.log(`scope-grant: pr ${prRaw} FAILED — ${reason}`)
    return { kind: 'failed', reason }
  }
}

/** The live reads and writes, wired like every other orchestrator module:
 *  `gh` by argv, the repo pinned by `REPO`. */
export function defaultScopeGrantDeps(
  log: (msg: string) => void,
  lanes: () => Promise<Lane[]>,
  refireReview: (pr: string, branch: string) => Promise<boolean>,
): ScopeGrantDeps {
  return {
    readChangedFiles: async (pr) => {
      const pages = await ghJson<{ filename?: string; previous_filename?: string }[][]>(
        ['api', '--paginate', '--slurp', `repos/${REPO}/pulls/${pr}/files?per_page=100`],
        60_000,
        (detail) => log(`scope-grant: reading PR ${pr}'s files failed: ${detail}`),
      )
      if (pages === undefined) return undefined
      return pages.flat().flatMap((f) => [f.filename, f.previous_filename].filter((n): n is string => typeof n === 'string'))
    },
    readLabels: async (pr) => {
      const data = await ghJson<{ labels?: { name?: string }[] }>(
        ['api', `repos/${REPO}/issues/${pr}`],
        30_000,
        (detail) => log(`scope-grant: reading PR ${pr}'s labels failed: ${detail}`),
      )
      if (data === undefined) return undefined
      return (data.labels ?? []).flatMap((l) => (typeof l.name === 'string' ? [l.name] : []))
    },
    lanes,
    // The REST add-labels endpoint, not `gh pr edit --add-label`: it creates a
    // label that does not exist yet instead of failing the whole edit.
    addLabels: async (pr, labels) => {
      await gh(['api', '-X', 'POST', `repos/${REPO}/issues/${pr}/labels`, ...labels.flatMap((l) => ['-f', `labels[]=${l}`])], 30_000)
    },
    comment: async (pr, body) => { await gh(['api', '-X', 'POST', `repos/${REPO}/issues/${pr}/comments`, '-f', `body=${body}`], 30_000) },
    refireReview,
    log,
  }
}
