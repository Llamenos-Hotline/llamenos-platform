import { matchesPath, matchesSecretPath, type LaneScope } from './fragments.js'

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
 *
 * The neverWrite comparison is `matchesSecretPath`, not `matchesPath`: a
 * committed template (`deploy/docker/.env.example`) is not the secret it is
 * a template of, and the prefix match that makes `.env` catch
 * `.env.production` had been making all five of this repo's tracked
 * `*.example` secret templates permanently unwritable. Ownership still uses
 * plain `matchesPath` — a template is owned by whichever lane owns its
 * directory, exactly as before. See `SECRET_TEMPLATE_SUFFIXES`.
 */
export function checkScope(
  changed: string[],
  scope: LaneScope,
  neverWrite: string[],
): { forbidden: string[]; strayed: string[] } {
  const forbidden: string[] = []
  const strayed: string[] = []
  for (const f of changed) {
    if (neverWrite.some((p) => matchesSecretPath(f, p))) {
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
 * Scope across the lanes a PR is AUTHORISED to write: its OWN lane, plus every
 * lane explicitly granted to it by a `scope:<lane>` label. A file is `strayed`
 * only when it falls outside every authorised lane.
 *
 * The own scope and the granted scopes are separate parameters on purpose,
 * because "an empty `owned` list means no ownership check" must apply to the
 * PR's own lane and NEVER to a grant:
 *
 * - For the PR's own lane it is correct and load-bearing. `UNSCOPED_LANE` is
 *   exactly that, and it is how every branch not named `fleet/<lane>/…` is
 *   judged today. Treating it otherwise would change behaviour for most PRs.
 * - For a GRANT it is a fail-open. `assertLiveLanesHaveScope` only requires a
 *   non-empty scope of lanes that are not `off`, so an `off` lane — or one
 *   whose fragment is missing or unparseable — legitimately has `owned: []`.
 *   If a grant for such a lane were honoured, a single `scope:<that lane>`
 *   label would make the whole PR unrestricted and wave through a diff that
 *   would otherwise be `scope=fail`. An empty granted scope is therefore
 *   discarded: a grant may only ever widen by a real lane's real paths.
 *
 * `forbidden` (neverWrite) is checked first and stays ABSOLUTE either way —
 * but note precisely what that covers: `NEVER_WRITE_PATHS` is
 * `SECRET_PATH_PATTERNS`, i.e. **secrets only**. `deploy/` and
 * `.github/workflows/` are deliberately NOT never-write, because lanes own
 * some of them. So "no grant can reach a never-write path" is true and also
 * much weaker than it sounds, and an earlier revision of this file overstated
 * it into "secrets, CI and deploy config are unreachable", which was false.
 *
 * `grantExcluded` is what actually makes CI and deploy unreachable *by grant*:
 * paths on that list are refused to a grant even when the granted lane owns
 * them, while the owning lane still writes them normally on its own PR. See
 * `GRANT_EXCLUDED_PATHS`.
 *
 * Each lane is evaluated with its own `owned`/`notOwned` pair, never a
 * flattened union: flattening would break longest-match, letting desktop's
 * `tests/` grant cancel backend's `tests/` exclusion and making a path
 * writable that neither lane can write on its own.
 */
export function checkScopeAcross(
  changed: string[],
  ownScope: LaneScope,
  grantedScopes: LaneScope[],
  neverWrite: string[],
  grantExcluded: string[] = [],
): { forbidden: string[]; strayed: string[] } {
  const forbidden: string[] = []
  const strayed: string[] = []
  // Only the PR's own lane may be unrestricted. A granted lane with no owned
  // paths grants nothing at all.
  const unrestricted = ownScope.owned.length === 0
  const granted = grantedScopes.filter((s) => s.owned.length > 0)
  for (const f of changed) {
    if (neverWrite.some((p) => matchesSecretPath(f, p))) {
      forbidden.push(f)
      continue
    }
    if (unrestricted) continue
    // The PR's own lane is checked first and is never subject to the grant
    // exclusion: infra writes its own workflows on its own PR.
    if (checkScope([f], ownScope, []).strayed.length === 0) continue
    // Beyond the own lane, a grant may not reach the supply chain even when
    // the granted lane owns it.
    if (grantExcluded.some((p) => matchesPath(f, p))) {
      strayed.push(f)
      continue
    }
    if (!granted.some((s) => checkScope([f], s, []).strayed.length === 0)) strayed.push(f)
  }
  return { forbidden, strayed }
}
