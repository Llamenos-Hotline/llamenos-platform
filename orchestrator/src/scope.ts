import { matchesPath, type LaneScope } from './fragments.js'
import { secretFinding, type FileContent } from './write-gate.js'

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
 * secrets. (CI and deploy config are NOT never-write — see
 * `GRANT_EXCLUDED_PATHS` and `checkScopeRouting`.) `strayed` is everything
 * else that falls outside the lane once neverWrite is out of the way.
 *
 * The neverWrite comparison is `secretFinding` (write-gate.ts), whose path
 * half is `matchesSecretPath`, not `matchesPath`: a
 * committed template (`deploy/docker/.env.example`) is not the secret it is
 * a template of, and the prefix match that makes `.env` catch
 * `.env.production` had been making all five of this repo's tracked
 * `*.example` secret templates permanently unwritable. Ownership still uses
 * plain `matchesPath` — a template is owned by whichever lane owns its
 * directory, exactly as before. See `SECRET_TEMPLATE_SUFFIXES`.
 *
 * `contentOf` hands in the head commit's bytes, which the secret class
 * needs in two ways (`secretFinding`, write-gate.ts): to admit a `*.pem` that
 * is provably public certificate material (#1610, widened to annotated
 * chains by #2556), and to refuse a private key in ANY file whatever its
 * path (#2556). It is optional, and its ABSENCE is the fail-closed default
 * for the first — every `*.pem` is a secret — but it also silences the
 * second, so a caller that can read the bytes must pass them; `verify.ts`
 * does, for every file present at the head. These functions stay pure: the
 * caller does the reading and hands in a lookup, so the gate's own trust
 * boundary (git in the base checkout, the head as data) is decided where it
 * is already decided, in `verify.ts`.
 *
 * Trust anchors (`TRUST_ANCHOR_FILES`) are deliberately NOT decided here.
 * They are not a scope question — android still owns `ApiService.kt` — and
 * their remedy is a human approval, not leaving the PR; `verifyMechanical`
 * classifies them separately and says so in its own refusal.
 */
export function checkScope(
  changed: string[],
  scope: LaneScope,
  neverWrite: readonly string[],
  contentOf?: (file: string) => FileContent | undefined,
): { forbidden: string[]; strayed: string[] } {
  const forbidden: string[] = []
  const strayed: string[] = []
  for (const f of changed) {
    if (secretFinding(f, neverWrite, contentOf?.(f)) !== undefined) {
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
 * What `fleet/verify` makes of a diff's paths: which of them it REFUSES, and
 * which merely name another lane that should review (#3056).
 *
 * The old gate treated every path outside the authoring lane as a failure and
 * let a `scope:<lane>` label excuse it. That was built to stop concurrent
 * per-platform workers overwriting each other's slice of one change. Under
 * one-issue-one-PR (#2979) one worker authors the whole change, so a diff that
 * spans lanes is the intended shape of a full-stack PR and the label recorded
 * nothing the diff did not already say. The two halves are therefore split:
 *
 * - `forbidden` — never-write (secrets, private keys). A security control,
 *   ABSOLUTE, and it binds even an unrestricted lane. Unchanged.
 * - `supplyChain` — a path in `grantExcluded` (CI, deploy, supply chain) that
 *   the PR's own lane does not own. Still a refusal: the issue relaxed lane
 *   bookkeeping, not who may rewrite the build system, and it was the one
 *   outside-the-lane class no label could ever excuse. Only the owning lane's
 *   own PR writes these. An unrestricted own lane (`UNSCOPED_LANE`, a branch
 *   that is not `fleet/<lane>/…`) never had this check and still does not.
 * - `outside` — every other path the own lane does not own. NOT a failure:
 *   routing metadata naming who should review. An unrestricted own lane owns
 *   nothing, so for routing purposes every non-secret path is outside it, which
 *   is what lets a PR whose branch is not `fleet/<lane>/…` still say which
 *   lanes to ask.
 *
 * Each own-lane comparison is `checkScope`'s (longest match wins, owned vs
 * notOwned), and `secretFinding` decides never-write exactly as there.
 */
export function checkScopeRouting(
  changed: string[],
  ownScope: LaneScope,
  neverWrite: readonly string[],
  grantExcluded: readonly string[] = [],
  contentOf?: (file: string) => FileContent | undefined,
): { forbidden: string[]; supplyChain: string[]; outside: string[] } {
  const forbidden: string[] = []
  const supplyChain: string[] = []
  const outside: string[] = []
  const unrestricted = ownScope.owned.length === 0
  for (const f of changed) {
    if (secretFinding(f, neverWrite, contentOf?.(f)) !== undefined) {
      forbidden.push(f)
      continue
    }
    if (!unrestricted && checkScope([f], ownScope, []).strayed.length === 0) continue
    outside.push(f)
    if (!unrestricted && grantExcluded.some((p) => matchesPath(f, p))) supplyChain.push(f)
  }
  return { forbidden, supplyChain, outside }
}
