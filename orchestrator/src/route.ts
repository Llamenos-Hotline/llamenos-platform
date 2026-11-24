import { CONTRACT_CONSUMER_LANE_IDS, CONTRACT_LANE_ID, GRANT_EXCLUDED_PATHS, LANE_IDS, type Lane } from './config.js'
import { matchesPath, type LaneScope } from './fragments.js'
import { checkScope } from './scope.js'

/**
 * Lanes route REVIEW and ownership; they do not fence what one PR may touch
 * (#2979). This module is the one router behind that model, shared by the
 * dispatcher (`tick.ts`) and the triage script (`scripts/fleet-triage.ts`), so
 * "which lane authors this issue" has one answer.
 *
 * The dispatch unit is a whole issue (or an epic stage), handed to ONE lane
 * that authors all of it. A cross-lane diff is legitimate: the orchestrator
 * grants the other lanes at PR open (`scope-grant.ts`) and those lanes review
 * it. Nothing here ever splits an issue into per-lane slices — "issue × lane"
 * is how a format change spanning the crate, the protocol, the server and the
 * clients used to land as PRs that drifted apart.
 *
 * What this decides, and when:
 *
 * - `authorFor` — which lane should author an issue, from the paths its body
 *   cites. Used by triage to label an unlabelled issue, and by the tick to
 *   route an `agent-dispatchable` issue that carries no `lane:` label (#2623).
 * - `routeForDispatch` — BEFORE a worker is launched (#1764): does the lane
 *   about to receive this issue own any of the files it names? If not, the
 *   item is MISROUTED: no dispatch, no attempt spent, and the outcome names
 *   the lane and the paths and says where it should go.
 * - `routeBlocked` — AFTER a worker reported BLOCKED: if the paths it said it
 *   needed are paths its lane can never write in its own PR, and one lane can,
 *   that is a routing finding, not a reason to park the item.
 *
 * Every function here is pure. The tracked tree is handed in, so a body that
 * mentions `fleet/verify` or `origin/main` (slashed, but not files) is not
 * mistaken for a file surface.
 */

/** The dispatchable lanes, in claim priority. A scope-only fragment (`mac`)
 *  owns paths a grant may reach but can never hold a branch, so it can never
 *  author anything and is never a routing target. */
function authoringLanes(lanes: readonly Lane[]): Lane[] {
  const ids: ReadonlySet<string> = new Set(LANE_IDS)
  return lanes.filter((l) => l.scopeOnly !== true && ids.has(l.id) && l.scope.owned.length > 0)
}

/**
 * Pulls repo-relative path citations out of free text — an issue body or a
 * worker's BLOCKED note. A citation is a token containing at least one `/`
 * (`apps/worker/routes/notes.ts`, `deploy/docker/…`); surrounding backticks,
 * quotes and sentence punctuation are stripped, as is a leading `./` and a
 * trailing `:line`. Bare filenames (`knope.toml`) are NOT extracted: without
 * a slash they collide with prose constantly. Globs containing a slash
 * (`.github/workflows/ios*.yml`) pass through unchanged — `matchesPath`
 * understands them.
 */
export function extractPaths(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/[^\s`'"()[\]{}<>]*\/[^\s`'"()[\]{}<>]*/g)) {
    const token = m[0]
      .replace(/^\.\//, '')
      .replace(/^[,;:!?/]+/, '')
      .replace(/[.,;:!?]+$/, '')
      .replace(/:\d+(-\d+)?$/, '')
    if (token.length > 1 && token.includes('/') && !/^[a-z]+:\/\//i.test(token)) out.push(token)
  }
  return [...new Set(out)]
}

/** The tracked tree, indexed for "is this citation a real path?". */
export interface TreeIndex {
  files: ReadonlySet<string>
  /** Every directory that contains a tracked file, with a trailing `/`. */
  dirs: ReadonlySet<string>
}

export function indexTree(files: readonly string[]): TreeIndex {
  const dirs = new Set<string>()
  for (const f of files) {
    const parts = f.split('/')
    for (let i = 1; i < parts.length; i++) dirs.add(`${parts.slice(0, i).join('/')}/`)
  }
  return { files: new Set(files), dirs }
}

/** A citation names a tracked file, a directory holding tracked files, or a
 *  glob matching at least one tracked file. */
export function onTree(path: string, tree: TreeIndex): boolean {
  if (tree.files.has(path)) return true
  if (tree.dirs.has(path.endsWith('/') ? path : `${path}/`)) return true
  if (path.includes('*')) {
    for (const f of tree.files) if (matchesPath(f, path)) return true
  }
  return false
}

/** The cited paths that exist, in citation order. Without a tree every
 *  citation is kept: the caller decided it cannot check, and said so. */
export function surfaceOf(text: string, tree: TreeIndex | undefined): string[] {
  const cited = extractPaths(text)
  return tree === undefined ? cited : cited.filter((p) => onTree(p, tree))
}

/** Does `scope` own `path` (owned and not carved out — `checkScope`'s rule)?
 *  A citation of a directory itself (`apps/ios`) also tries its trailing-slash
 *  form, so it matches the lane's `apps/ios/` grant. */
export function scopeOwns(scope: LaneScope, path: string): boolean {
  if (scope.owned.length === 0) return false
  if (checkScope([path], scope, []).strayed.length === 0) return true
  return !path.endsWith('/') && checkScope([`${path}/`], scope, []).strayed.length === 0
}

function longestOwnedMatch(scope: LaneScope, path: string): number {
  let best = -1
  for (const p of scope.owned) {
    if ((matchesPath(path, p) || matchesPath(`${path}/`, p)) && p.length > best) best = p.length
  }
  return best
}

export interface PathAttribution {
  /** lane id -> cited paths attributed to that lane (each path lands in at most one lane). */
  attributed: Map<string, string[]>
  /** Paths several lanes own equally specifically — a deliberate shared-write
   *  grant (`packages/i18n/locales/`, `package.json`). They cannot
   *  discriminate lanes, so they attribute nowhere. */
  sharedWrite: string[]
  /** Paths no authoring lane owns. */
  unmatched: string[]
}

/**
 * Attributes each path to at most one AUTHORING lane: among the lanes that
 * really own it (owned and not carved out), the one whose owned pattern
 * matches longest. A carve-out is honoured — ios owns `.github/workflows/ios*.yml`
 * but disclaims `ios-e2e.yml`, so that file attributes to infra, not to ios.
 */
export function attributePaths(paths: readonly string[], lanes: readonly Lane[]): PathAttribution {
  const authors = authoringLanes(lanes)
  const attributed = new Map<string, string[]>()
  const sharedWrite: string[] = []
  const unmatched: string[] = []
  for (const path of paths) {
    let bestLen = -1
    let best: string[] = []
    for (const lane of authors) {
      if (!scopeOwns(lane.scope, path)) continue
      const len = longestOwnedMatch(lane.scope, path)
      if (len > bestLen) {
        bestLen = len
        best = [lane.id]
      } else if (len === bestLen) {
        best.push(lane.id)
      }
    }
    const only = best.length === 1 ? best[0] : undefined
    if (only !== undefined) attributed.set(only, [...(attributed.get(only) ?? []), path])
    else if (best.length > 1) sharedWrite.push(path)
    else unmatched.push(path)
  }
  return { attributed, sharedWrite, unmatched }
}

export type AuthorDecision =
  | {
    author: string
    /** single: one lane implicated · dominant: strictly most cited paths ·
     *  contract: a contract change spanning lanes, authored by the contract
     *  owner as one unit · priority: a tie broken by claim priority (only when
     *  the caller asked for it). */
    reason: 'single' | 'dominant' | 'contract' | 'priority'
    counts: Record<string, number>
  }
  | { author: undefined; reason: string; counts: Record<string, number> }

/**
 * The lane that authors an issue, from where its cited paths attribute.
 *
 * 1. **The contract owner** (#2979 point 1) authors any issue that cites a
 *    path attributed to it AND paths attributed to two or more consumer lanes
 *    (`CONTRACT_CONSUMER_LANE_IDS` — the server and the clients).
 *    A contract (crate, protocol schemas, test vectors, generated bindings)
 *    is changed together with its consumers in one PR, by the lane that owns
 *    the contract; the consumer lanes review it. This is the case that used
 *    to be split into per-lane PRs that drifted apart.
 * 2. Otherwise the lane with STRICTLY the most attributed paths.
 * 3. A tie is no answer — unless `breakTies`, when claim priority (the order
 *    of `lanes`) decides. The tick breaks ties when the current label is known
 *    wrong (any owning lane is better than one that owns nothing); triage does
 *    not, because a tie on an unlabelled issue is a human's call.
 *
 * Never returns "split it". Three implicated lanes is a cross-lane change,
 * which the fleet now represents as one PR with grants, not a reason to park.
 */
export function authorFor(
  attribution: PathAttribution,
  lanes: readonly Lane[],
  opts: { breakTies: boolean },
): AuthorDecision {
  const order = authoringLanes(lanes).map((l) => l.id)
  const counts: Record<string, number> = {}
  for (const [lane, paths] of attribution.attributed) counts[lane] = paths.length
  const implicated = order.filter((id) => (counts[id] ?? 0) > 0)
  if (implicated.length === 0) return { author: undefined, reason: 'no cited path is owned by any authoring lane', counts }
  if (implicated.length === 1 && implicated[0] !== undefined) return { author: implicated[0], reason: 'single', counts }
  const consumers: ReadonlySet<string> = new Set(CONTRACT_CONSUMER_LANE_IDS)
  if (implicated.includes(CONTRACT_LANE_ID) && implicated.filter((id) => consumers.has(id)).length >= 2) {
    return { author: CONTRACT_LANE_ID, reason: 'contract', counts }
  }
  const top = Math.max(...implicated.map((id) => counts[id] ?? 0))
  const leaders = implicated.filter((id) => counts[id] === top)
  if (leaders.length === 1 && leaders[0] !== undefined) return { author: leaders[0], reason: 'dominant', counts }
  if (opts.breakTies && leaders[0] !== undefined) return { author: leaders[0], reason: 'priority', counts }
  return { author: undefined, reason: `spans ${leaders.join(' and ')} with no dominant lane (${top} cited paths each)`, counts }
}

export type DispatchRoute =
  /** The body names no tracked path: nothing to check, dispatch as labelled. */
  | { kind: 'unknown' }
  /** The lane owns at least one cited path — it may author the issue and
   *  reach the rest through grants at PR open. */
  | { kind: 'routed'; owned: string[] }
  /**
   * Do not dispatch. `to` is the lane that should author it (undefined when no
   * authoring lane owns any cited path — itself a finding: a hole in the
   * lane table). `paths` are the cited paths, so the outcome names both the
   * lane and what it would have needed.
   */
  | { kind: 'misrouted'; to: string | undefined; paths: string[]; why: string }

/**
 * The pre-dispatch ownership check (#1764). Refuse to dispatch, instead of
 * dispatching to refuse.
 *
 * The rule is the intersection the issue asks for, and deliberately no
 * stricter: a lane that owns ANY cited path is routed, because issue bodies
 * cite context ("related: ci.yml"), and the worker reaches another lane's
 * paths through grants anyway. Only a lane owning NONE of the cited paths is
 * misrouted — the shape of #791/#727/#649/#737/#734, each of which burned
 * three dispatches producing correct refusals.
 *
 * The one override is the contract owner: an issue the contract owner should
 * author (`authorFor` rule 1) is misrouted to it from any other lane, so a
 * cross-platform format change ships as the single unit it is. It is not
 * applied when the contract lane is `off` — routing work to a lane that will
 * never run is parking it, which is what this module exists to stop.
 */
export function routeForDispatch(input: {
  text: string
  lane: Lane
  lanes: readonly Lane[]
  tree: TreeIndex | undefined
}): DispatchRoute {
  if (input.tree === undefined) return { kind: 'unknown' }
  const paths = surfaceOf(input.text, input.tree)
  if (paths.length === 0) return { kind: 'unknown' }
  const owned = paths.filter((p) => scopeOwns(input.lane.scope, p))
  const decision = authorFor(attributePaths(paths, input.lanes), input.lanes, { breakTies: true })
  const contract = input.lanes.find((l) => l.id === CONTRACT_LANE_ID)
  if (
    decision.reason === 'contract' && decision.author !== input.lane.id &&
    contract !== undefined && contract.mode !== 'off'
  ) {
    return {
      kind: 'misrouted', to: CONTRACT_LANE_ID, paths,
      why: `a contract change spanning ${Object.keys(decision.counts).sort().join(', ')} — the contract owner ` +
        `(lane "${CONTRACT_LANE_ID}") authors it as one PR and the other lanes review it`,
    }
  }
  if (owned.length > 0) return { kind: 'routed', owned }
  if (decision.author === undefined) {
    return { kind: 'misrouted', to: undefined, paths, why: `lane "${input.lane.id}" owns none of the cited paths, and no authoring lane owns any of them` }
  }
  const target = input.lanes.find((l) => l.id === decision.author)
  return {
    kind: 'misrouted', to: decision.author, paths,
    why: `lane "${input.lane.id}" owns none of the cited paths; lane "${decision.author}" owns ` +
      `${decision.counts[decision.author] ?? 0} of them` +
      (target?.mode === 'off' ? ` (lane "${decision.author}" is off, so it waits there until it is turned on)` : ''),
  }
}

/** Can a PR on `lane` write `path`? Its own lane, or a grant at PR open — which
 *  reaches another authoring lane's path unless the path is grant-excluded. */
function writableBy(lane: Lane, path: string, lanes: readonly Lane[]): boolean {
  if (scopeOwns(lane.scope, path)) return true
  if (GRANT_EXCLUDED_PATHS.some((p) => matchesPath(path, p))) return false
  return authoringLanes(lanes).some((l) => l.id !== lane.id && scopeOwns(l.scope, path))
}

/**
 * A worker reported BLOCKED. If the paths its note names include ones its lane
 * can never write — not its own and unreachable by a grant (CI, deploy,
 * supply chain) — and a single authoring lane owns every one of them, the item
 * was misrouted: re-route it there instead of parking it behind `needs-human`
 * (#1764 ask 3). Anything else (no paths named, paths the lane could have
 * written, paths no lane or several lanes own) stays BLOCKED: that is a real
 * decision, not a routing slip.
 */
export function routeBlocked(input: {
  note: string
  lane: Lane
  lanes: readonly Lane[]
  tree: TreeIndex | undefined
}): { kind: 'blocked' } | { kind: 'misrouted'; to: string; paths: string[]; why: string } {
  if (input.tree === undefined) return { kind: 'blocked' }
  const unwritable = surfaceOf(input.note, input.tree).filter((p) => !writableBy(input.lane, p, input.lanes))
  if (unwritable.length === 0) return { kind: 'blocked' }
  const owners = authoringLanes(input.lanes)
    .filter((l) => l.id !== input.lane.id && l.mode !== 'off' && unwritable.every((p) => scopeOwns(l.scope, p)))
  const to = owners[0]
  if (to === undefined) return { kind: 'blocked' }
  return {
    kind: 'misrouted', to: to.id, paths: unwritable,
    why: `the worker on lane "${input.lane.id}" needed paths only lane "${to.id}"'s own PR may write`,
  }
}
