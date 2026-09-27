import { matchesPath, type LaneScope } from './fragments.js'

function longestMatch(file: string, patterns: string[]): string | undefined {
  let best: string | undefined
  for (const p of patterns) {
    if (matchesPath(file, p) && (best === undefined || p.length > best.length)) best = p
  }
  return best
}

/**
 * Two rulings correct the brief this was drafted from:
 *
 * 1. Every comparison here — owned, notOwned, and neverWrite alike — goes
 *    through `matchesPath`, never a bare `startsWith`. Real fragments declare
 *    glob owned-paths (ios's `.github/workflows/ios*.yml`, android's
 *    `.github/workflows/*android*`, infra's `Dockerfile*`); `startsWith`
 *    would judge `.github/workflows/ios-e2e.yml` out-of-lane for ios because
 *    it never expands the `*`.
 *
 * 2. Overlap between `owned` and `notOwned` resolves by LONGEST MATCH WINS,
 *    not by checking `notOwned` first. The brief's notOwned-first order looks
 *    safe but is wrong against this repo's real data: backend's fragment
 *    writes "Does NOT own: `tests/` root" to mean it doesn't own the tests/
 *    ROOT — but the parser can only keep the bare string `tests/`, not the
 *    word "root". Checking notOwned first would then reject every file under
 *    backend's own `tests/features/` (its owned BDD feature directory)
 *    because it also matches the bare `tests/` notOwned entry — making
 *    backend's 363 `@backend` feature files unwritable by backend. Longest
 *    match resolves this correctly: `tests/features/` (15 chars) is more
 *    specific than `tests/` (6 chars) and wins, so backend keeps its features
 *    while desktop (which owns `tests/` but explicitly does not own
 *    `tests/features/`) is still correctly blocked from that same path — its
 *    notOwned entry is the longer, more specific one there. On an exact
 *    length tie, `notOwned` wins: deny is the safe default.
 *
 * `forbidden` (neverWrite) is checked first and is absolute: it beats both
 * owned and notOwned regardless of specificity, and it binds even a lane
 * whose `owned` list is empty — an unrestricted lane still cannot touch
 * secrets, deploy config, or CI. `strayed` is everything else that falls
 * outside the lane once neverWrite is out of the way.
 */
export function checkScope(
  changed: string[],
  scope: LaneScope,
  neverWrite: string[],
): { forbidden: string[]; strayed: string[] } {
  const forbidden: string[] = []
  const strayed: string[] = []
  for (const f of changed) {
    if (neverWrite.some((p) => matchesPath(f, p))) {
      forbidden.push(f)
      continue
    }
    const ownedMatch = longestMatch(f, scope.owned)
    const notOwnedMatch = longestMatch(f, scope.notOwned)
    if (notOwnedMatch !== undefined && (ownedMatch === undefined || notOwnedMatch.length >= ownedMatch.length)) {
      strayed.push(f)
      continue
    }
    if (scope.owned.length > 0 && ownedMatch === undefined) strayed.push(f)
  }
  return { forbidden, strayed }
}

/**
 * Scope across the set of lanes a PR is AUTHORISED to write: the lane it was
 * dispatched into, plus every lane explicitly granted to it by a `scope:<lane>`
 * label. A file is `strayed` only when it falls outside EVERY authorised lane —
 * being owned by any one of them is enough.
 *
 * Three properties this deliberately preserves:
 *
 * 1. `forbidden` (neverWrite) is checked first and is still ABSOLUTE. A grant
 *    names a lane, and no lane owns a never-write path, so no grant can ever
 *    reach one. Secrets, CI and deploy config stay unreachable however many
 *    labels a PR carries.
 *
 * 2. An unrestricted scope (`owned: []`) still means "no ownership check",
 *    exactly as `checkScope` has always treated it. That is what
 *    `UNSCOPED_LANE` relies on for branches that name no lane, so wiring this
 *    in changes nothing for them. Closing THAT hole is a separate, larger
 *    change (#1115) which cannot land until every path has an owner — today
 *    772 of 4165 tracked files have none.
 *
 * 3. Each lane is evaluated with its own `owned`/`notOwned` pair, never a
 *    flattened union of all of them. Flattening would break longest-match:
 *    desktop's `tests/` grant merged with backend's `tests/` notOwned entry
 *    would resolve differently than either lane does alone, and a file could
 *    become writable that neither lane can actually write.
 */
export function checkScopeAcross(
  changed: string[],
  scopes: LaneScope[],
  neverWrite: string[],
): { forbidden: string[]; strayed: string[] } {
  const forbidden: string[] = []
  const strayed: string[] = []
  const unrestricted = scopes.some((s) => s.owned.length === 0)
  for (const f of changed) {
    if (neverWrite.some((p) => matchesPath(f, p))) {
      forbidden.push(f)
      continue
    }
    if (unrestricted) continue
    if (!scopes.some((s) => checkScope([f], s, []).strayed.length === 0)) strayed.push(f)
  }
  return { forbidden, strayed }
}
