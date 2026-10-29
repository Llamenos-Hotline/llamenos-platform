import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, appendFile, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gh, ghJson, describeGhFailure, REPO } from './gh.js'

/**
 * `fleet/review` moved to running once per PR, on `merge_group`, instead of
 * on every push (#812) — but a PR still re-enters the queue on every rebase
 * the queue itself performs against other entries, and each re-entry is a
 * fresh `merge_group` event with a full review, even when the PR's OWN diff
 * has not changed at all. This is the second half of the same fix: exactly
 * one review per PR per JUDGED (TREE, CLAIM), not per queue attempt.
 *
 * Keyed by the head commit's TREE sha (`.commit.tree.sha`), never the head
 * SHA and never the diff (#2014), AND by a digest of the PR's title and body
 * as the reviewer read them (`claimDigest`, review.ts; #2336). A verdict is a
 * judgement of the code a merge would land — exactly the head's tree — and,
 * because every reviewer is told to FAIL a description that misstates the
 * diff, of that description too:
 *
 *  - an UNCHANGED tree is the same code whatever commit carries it — a no-op
 *    rebase, a re-request, a rebase whose result is content-identical
 *    (#1987) — so it must still hit; keying on the head SHA would re-spend a
 *    review on every one of those, on a gate that runs on ONE shared runner;
 *  - a CHANGED tree is different code, even when the PR's own diff text is
 *    byte-identical. It used to be keyed on `sha256(git diff base...head)`,
 *    and #1975 is what that cost: rebased onto a newer `main`, its diff was
 *    unchanged, so the `crypto-security-reviewer` + general PASS earned on
 *    tree `f3655875…` was re-published four times as a green `fleet/review`
 *    on tree `4eeb09ad…`, which nobody had judged. The diff a reviewer reads
 *    is only half the code under judgement; the base it now sits on is the
 *    other half;
 *  - a CHANGED claim is a different judgement on the same tree. Keyed on the
 *    tree alone, #2332 was FAILed for a body claiming 36 keys where its diff
 *    delivered 35, had its body corrected with the tree deliberately left
 *    alone, and the re-request replayed the FAIL in 23 seconds with no new
 *    verdict comment — a PR with no legitimate way out, since the only
 *    "fix" left was perturbing the tree to defeat the cache. The tree stays
 *    in the key (dropping it would re-open #2014); the claim is ADDED to it.
 *    An unchanged tree AND claim still hits, so a plain re-request with
 *    nothing changed costs no review.
 *
 * Both a PASS and a SUBSTANTIVE FAIL are recorded (#1158). Caching only the
 * PASS was measurably expensive: in one 12-hour window there were 60 Fleet
 * Review runs, 10 of them on one PR and 8 on another — the two PRs that were
 * FAILING. Every branch-freshness rebase re-fired the gate, and the identical
 * diff was reviewed from scratch to reach the identical conclusion, burning a
 * provider call each time. The moment the tree changes — the author pushes
 * anything, or the branch is rebased onto a `main` that moved — the cache is
 * bypassed naturally, which is exactly when a re-review is warranted.
 *
 * An INFRASTRUCTURE failure is never recorded, and the distinction is not
 * negotiable: a parsed `VERDICT: FAIL` means the reviewer looked and decided;
 * an UNREADABLE (an API error, a timeout, exhausted quota, an unparseable
 * response) means it could not look at all. Pinning a transient outage to a
 * tree would be far worse than the waste it saves — the PR would stay
 * red until someone pushed a commit, for a reason that had already gone away.
 * `runReviewCi` (ci.ts) is the only caller, and it records nothing when any
 * member of the review set came back UNREADABLE.
 */
export interface ReviewCacheKey {
  /** `CiContext.pr` — a PR number as a string, or `'(unknown)'`. Part of the
   *  key (not just the hash) so a diff that happens to match byte-for-byte
   *  across two different PRs is never cross-published between them. */
  pr: string
  /** `sha256` of the PR's diff — logged, written into the record for
   *  continuity, and NOT part of the lookup: the same diff on a different
   *  tree is different code (see the module docstring). */
  diffHash: string
  /** The head commit's tree sha — the code half of the key. `undefined` when
   *  it could not be read, and then there is no key at all: a lookup misses
   *  and nothing is recorded, so an unreadable tree can never become a hit. */
  headTree: string | undefined
  /** `claimDigest` (review.ts) of the PR's title and body — the claim half of
   *  the key (#2336). `undefined` when the PR could not be read, and then,
   *  exactly as for the tree, there is no key: a verdict formed against "no
   *  claim was stated" is never recorded, and nothing is looked up under a
   *  guessed description. */
  claimDigest: string | undefined
}

export interface CachedVerdict {
  verdict: 'PASS' | 'FAIL'
  text: string
}

export interface ReviewCache {
  /** `undefined` for a genuine miss AND for a lookup that could not be
   *  answered — callers cannot and must not tell those apart, because both
   *  mean the same thing: run the engine. See `artifactReviewCache`. */
  lookup(key: ReviewCacheKey): Promise<CachedVerdict | undefined>
  /** Called only with a fresh, SUBSTANTIVE verdict this process itself just
   *  produced — never a cache hit it is re-publishing, and never an
   *  UNREADABLE (see the module docstring: an infrastructure failure must
   *  never be pinned to a tree). */
  record(key: ReviewCacheKey, verdict: CachedVerdict): Promise<void>
}

/** `sha256(diff)`, hex. Pure and exported so `diffHash('') !== diffHash('x')`
 *  and similar shape assertions don't need a `ReviewCache` at all. */
export function diffHash(diff: string): string {
  return createHash('sha256').update(diff).digest('hex')
}

/**
 * A git tree object id: 40 hex (SHA-1) or 64 hex (SHA-256 object format).
 * Anything else is not a tree this cache can be keyed on.
 */
export function isTreeSha(s: string | undefined): s is string {
  return s !== undefined && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(s)
}

/** A `claimDigest` (review.ts): 64 hex, sha256. */
export function isClaimDigest(s: string | undefined): s is string {
  return s !== undefined && /^[0-9a-f]{64}$/.test(s)
}

/** How many hex characters of the claim digest go into an artifact name —
 *  128 bits, far past any accidental collision, and it keeps the name short. */
export const CLAIM_DIGEST_NAME_CHARS = 32

/** Both halves of the key readable — the only condition under which this
 *  cache is ever read or written. */
export function hasCacheKey(key: ReviewCacheKey): key is ReviewCacheKey & { headTree: string; claimDigest: string } {
  return isTreeSha(key.headTree) && isClaimDigest(key.claimDigest)
}

/**
 * The artifact name IS the cache key, so a lookup is one filtered list call
 * and needs no content downloaded (existence alone proves PASS, since
 * nothing is ever uploaded under this name for anything else — see the
 * module docstring). GitHub artifact names accept far more than this, but
 * `pr` and a hex tree sha are already exactly the safe subset: no path
 * separators, no characters a URL query parameter would need to escape.
 *
 * The FULL tree sha, after a literal `tree-`: the name states exactly which
 * tree was judged, and no record from the diff-keyed era (whose names end in
 * 24 hex characters of a diff hash) can ever be found under it (#2014).
 *
 * Then the claim, after a literal `-claim-` (#2336). A record from the
 * tree-only era ends at the tree, so it can never be found under a new name:
 * every such record judged a description nobody can now name, and the one
 * re-review each open PR pays the first time is the price of not replaying
 * a verdict on a claim it may never have read.
 */
export function cacheArtifactName(
  pr: string, headTree: string, claimDigest: string, scope?: string, verdict: 'PASS' | 'FAIL' = 'PASS',
): string {
  // `scope` namespaces a PASS to the exact REVIEW SET that produced it
  // (`reviewSetTag` below). Without it, a PR reviewed by the general
  // reviewer alone and then labelled `crypto-security-reviewer` would find
  // its own earlier PASS for the identical diff and re-publish it as a
  // crypto review that never happened — the fail-open #1158 had to close
  // when the specialists' separate `fleet/review/<agent>` checks went away.
  // A review set of just the general reviewer has NO scope, so every
  // artifact recorded before this existed stays a hit.
  // The VERDICT is in the name, so a lookup for one can never find the
  // other, and `pass` is spelled exactly as it always was — every artifact
  // recorded before FAILs were cached at all stays a hit.
  const prefix = scope === undefined ? '' : `${scope}-`
  return `fleet-review-${prefix}${verdict.toLowerCase()}-pr${pr}-tree-${headTree}` +
    `-claim-${claimDigest.slice(0, CLAIM_DIGEST_NAME_CHARS)}`
}

/**
 * The cache namespace for a review set — `undefined` for the general
 * reviewer alone (the overwhelmingly common case, and the name every
 * pre-#1158 artifact already uses).
 *
 * Hashed rather than joined so the name stays short and inside the safe
 * subset `cacheArtifactName` documents no matter how many profiles are in
 * the set; SORTED first so the same set never produces two names.
 */
export function reviewSetTag(profiles: readonly string[]): string | undefined {
  if (profiles.length === 0) return undefined
  const sorted = [...new Set(profiles)].sort()
  return `set-${createHash('sha256').update(sorted.join('\n')).digest('hex').slice(0, 12)}`
}

interface ArtifactListResponse {
  artifacts: { id: number; expired: boolean; workflow_run?: { id: number } | null }[]
}

/**
 * The ONLY workflow whose artifacts may be believed. An artifact's
 * EXISTENCE is the whole PASS verdict, and any workflow run in this
 * repository can create an artifact with any name it likes — so without
 * this check a same-repo PR could add its own `pull_request`-triggered
 * workflow that uploads an empty artifact named
 * `fleet-review-pass-pr<N>-tree-<head tree>-claim-<digest>` and the next review
 * request would find it, conclude `cache-hit`, and go green with no review
 * ever run. The name is not a capability; the producing workflow is.
 */
const CACHE_WRITER_WORKFLOW = '.github/workflows/fleet-review.yml'

/** The one unexpired artifact under `name` that `fleet-review.yml` itself
 *  produced, or `undefined` — for a genuine miss, for one written by
 *  anything else, AND for a lookup that could not be answered, which
 *  callers must not tell apart (see `artifactReviewCache`). */
async function findArtifact(
  name: string, log: (msg: string) => void,
): Promise<{ id: number; runId: number } | undefined> {
  const data = await ghJson<ArtifactListResponse>(
    // `per_page=5`, not 1: the most recent artifact under this name may be
    // expired, or (see above) forged by another workflow, and neither may
    // mask a real one behind it.
    ['api', `repos/${REPO}/actions/artifacts?name=${encodeURIComponent(name)}&per_page=5`],
    30_000,
    (detail) => log(`review cache lookup failed for ${name} — running the engine (fail safe): ${detail}`),
  )
  for (const candidate of data?.artifacts ?? []) {
    const runId = candidate.workflow_run?.id
    if (candidate.expired || runId === undefined) continue
    const run = await ghJson<{ path?: string }>(
      ['api', `repos/${REPO}/actions/runs/${runId}`],
      30_000,
      (detail) => log(`could not read run ${runId} behind cache artifact ${name} — ignoring it (fail safe): ${detail}`),
    )
    if (run?.path !== CACHE_WRITER_WORKFLOW) {
      log(`ignoring cache artifact ${name}: run ${runId} came from ${run?.path ?? '(unreadable)'}, not ${CACHE_WRITER_WORKFLOW}`)
      continue
    }
    return { id: candidate.id, runId }
  }
  return undefined
}

/**
 * The recorded FAIL's own text, so a re-published FAIL shows the reviewer's
 * reasoning rather than a bare red check with no explanation.
 *
 * A PASS needs none of this — its artifact's EXISTENCE is the whole verdict,
 * and that lookup stays one list call with nothing downloaded. A FAIL is the
 * only case whose content matters, so it is the only case that pays for a
 * download.
 *
 * `undefined` on ANY failure, and the caller treats that as a MISS: a review
 * is run again rather than a FAIL published without the reason for it. That
 * costs one re-review in the rare case and can never pin a verdict this
 * process could not actually read.
 */
async function recordedText(
  artifact: { id: number; runId: number }, name: string, log: (msg: string) => void,
  consequence = 'reviewing again rather than publishing a verdict without its reason',
): Promise<string | undefined> {
  let dir: string | undefined
  try {
    dir = await mkdtemp(join(tmpdir(), 'fleet-review-cache-'))
    // `gh run download` rather than a raw `GET .../zip`: `gh` handles the
    // redirect and the unzip, so no binary ever crosses this process's
    // stdout (`gh()` decodes stdout as text, which would corrupt a zip).
    // Read-only, and covered by the `actions: read` the lookup already has.
    await gh(['run', 'download', String(artifact.runId), '-n', name, '-D', dir], 60_000)
    const parsed = JSON.parse(await readFile(join(dir, `${name}.json`), 'utf8')) as { verdict?: unknown; text?: unknown }
    if (parsed.verdict !== 'FAIL' || typeof parsed.text !== 'string' || parsed.text.trim().length === 0) {
      log(`cached FAIL artifact ${name} did not contain a FAIL verdict with text — ${consequence}`)
      return undefined
    }
    return parsed.text
  } catch (e) {
    log(`could not read the cached FAIL ${name} — ${consequence}: ${describeGhFailure(e)}`)
    return undefined
  } finally {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  }
}

/**
 * The real, CI-only cache. `scope` namespaces the PASS to its review set
 * (see `cacheArtifactName`/`reviewSetTag`); omitted, it is the general
 * reviewer alone. Lookup is a single `GET .../actions/artifacts
 * ?name=...` — read-only, so it costs the review job only `actions: read`,
 * never the `: write` the rest of this job is built to never need (see the
 * "no write permission" rail in guards.test.ts). Record does not call the
 * API at all: it writes one small JSON file to `outputDir`, which the
 * workflow then uploads with the already-pinned `actions/upload-artifact`
 * step — record() never becomes a second place this codebase talks to the
 * Actions API to create something, only to read something.
 *
 * `ghJson` (gh.ts) already returns `undefined` on ANY failure — auth,
 * network, an unrecognised response shape — never throws. That is the whole
 * fail-safe mechanism `lookup` relies on: a broken lookup and a genuine miss
 * are literally the same return value, and both mean "run the engine".
 */
/** The review step's output naming the artifact to upload for the GENERAL
 *  namespace (a review set of the general reviewer alone, or the general
 *  half of a larger set's record). */
export const CACHE_ARTIFACT_OUTPUT = 'cache_artifact_name'

/** The same, for the EXACT review set's namespace when it carries a profile
 *  (`reviewSetTag`). Its own key, so `fleet-review.yml` uploads both. */
export const CACHE_ARTIFACT_OUTPUT_SCOPED = 'cache_artifact_name_scoped'

export function artifactReviewCache(
  outputDir: string | undefined,
  log: (msg: string) => void,
  scope?: string,
): ReviewCache {
  return {
    async lookup(key) {
      // No tree or no claim, no key: a miss, never a lookup under a guessed name.
      if (!hasCacheKey(key)) {
        log(`review cache: no readable head tree or PR description for PR #${key.pr} — treating it as a miss (fail safe)`)
        return undefined
      }
      // PASS first: it is the common case, and its artifact's existence
      // alone is the verdict, so the whole lookup is one list call.
      const passName = cacheArtifactName(key.pr, key.headTree, key.claimDigest, scope, 'PASS')
      const pass = await findArtifact(passName, log)
      if (pass !== undefined) {
        return {
          verdict: 'PASS',
          text: `VERDICT: PASS (cached)\n\nan earlier run already reviewed this exact tree and this exact ` +
            `title and description (PR #${key.pr}, tree ${key.headTree}, claim ` +
            `${key.claimDigest.slice(0, 12)}) and it passed — re-published from artifact ` +
            `"${passName}" (id ${pass.id}) instead of invoking the review engine again.`,
        }
      }
      // Then the SUBSTANTIVE FAIL (#1158). A rebase that does not change the
      // tree, on a PR whose description did not change, must not re-spend a
      // review to reach the same conclusion.
      const failName = cacheArtifactName(key.pr, key.headTree, key.claimDigest, scope, 'FAIL')
      const fail = await findArtifact(failName, log)
      if (fail === undefined) return undefined
      const original = await recordedText(fail, failName, log)
      if (original === undefined) return undefined
      return {
        verdict: 'FAIL',
        text: `VERDICT: FAIL (cached)\n\nan earlier run already reviewed this exact tree and this exact ` +
          `title and description (PR #${key.pr}, tree ${key.headTree}, claim ${key.claimDigest.slice(0, 12)}) ` +
          `and it FAILED; neither has changed since, so it has not been reviewed again. Push a fix, or — ` +
          `if the finding is about the description — correct the description, then request the review ` +
          `again: the cache is keyed on the head's tree AND the PR's title and description, so a change ` +
          `to either is reviewed afresh. The original verdict follows, from artifact ` +
          `"${failName}" (id ${fail.id}).\n\n---\n\n${original}`,
      }
    },
    async record(key, verdict) {
      // `outputDir` unset means the workflow gave this run nowhere to put a
      // record — a missing cache write is never fatal to the review that
      // just passed; it only costs the NEXT identical diff its cache hit.
      if (outputDir === undefined) return
      // No tree or no claim, no key — and a verdict recorded under neither
      // could only ever be found by a guess. Costs the next run its hit,
      // nothing more.
      if (!hasCacheKey(key)) {
        log(`review cache: no readable head tree or PR description for PR #${key.pr} — not recording this verdict`)
        return
      }
      const name = cacheArtifactName(key.pr, key.headTree, key.claimDigest, scope, verdict.verdict)
      await mkdir(outputDir, { recursive: true })
      await writeFile(
        join(outputDir, `${name}.json`),
        JSON.stringify({
          pr: key.pr, headTree: key.headTree, claimDigest: key.claimDigest, diffHash: key.diffHash,
          ...verdict, recordedAt: new Date().toISOString(),
        }),
      )
      // The workflow's upload steps read this name back via
      // `steps.<review-step-id>.outputs.<CACHE_ARTIFACT_OUTPUT…>` — the one
      // source of truth for the name is this function, computed once, never
      // recomputed in bash where it could drift from what lookup() queries.
      //
      // ONE OUTPUT KEY PER NAMESPACE. `runReviewCi` records a verdict under
      // the exact review set AND under the general namespace, and both used
      // to be appended to one key — GitHub keeps the LAST value, so only the
      // general name was ever uploaded, and a PR whose review set carries a
      // profile (every crypto-content PR) could never be a cache hit: every
      // re-request after a rebase of it was a full review.
      const ghOutput = process.env['GITHUB_OUTPUT']
      const outputKey = scope === undefined ? CACHE_ARTIFACT_OUTPUT : CACHE_ARTIFACT_OUTPUT_SCOPED
      if (ghOutput !== undefined) await appendFile(ghOutput, `${outputKey}=${name}\n`)
    },
  }
}

/**
 * The verdict a PR last EARNED — a fresh, substantive review this workflow
 * ran and recorded — on whatever head it was earned on.
 */
export interface EarnedVerdict {
  verdict: 'PASS' | 'FAIL'
  /** The head the reviewers read. Named on the check so anyone reading it
   *  knows which commit the verdict is about. */
  headSha: string
  /** The run that earned it. */
  runUrl: string
  /** What the check states: the verdict, where it came from, and for a FAIL
   *  the reviewer's own text when it can still be read. */
  text: string
}

/** `lastEarnedVerdict`'s answer. `none` and `unreadable` are deliberately
 *  distinct — unlike a cache miss — because a push concludes GREEN on
 *  `none`: "could not look" must never become "there was nothing to find",
 *  or an unreadable history would carry a PR's FAIL into a pass. */
export type LastVerdictLookup =
  | { kind: 'found'; earned: EarnedVerdict }
  | { kind: 'none'; runsSearched: number }
  | { kind: 'unreadable'; reason: string }

/**
 * How many of the PR branch's most recent completed `fleet-review.yml` runs
 * are searched — one page of the runs API. Every push adds a run with no
 * verdict in it, so this is the depth of push history a verdict survives;
 * the verdict artifacts themselves are kept 30 days.
 */
export const LAST_VERDICT_RUN_WINDOW = 100

interface WorkflowRunsResponse {
  workflow_runs: { id: number; head_sha: string; html_url: string; path?: string }[]
}

interface RunArtifactsResponse {
  artifacts: { id: number; name: string; expired: boolean }[]
}

export interface LastVerdictDeps {
  pr: string
  /** The PR's head branch — the runs API filters on it. */
  branch: string
  /** `GITHUB_RUN_ID` — this run, which is still in progress and has earned
   *  nothing, so it is skipped even if the API lists it. */
  currentRunId?: string | undefined
  /** A read-only `gh api` GET; `undefined` on ANY failure (`ghJson`). */
  api<T>(path: string): Promise<T | undefined>
  /** A recorded FAIL's own text, or `undefined` when it cannot be read. */
  failText(artifact: { id: number; runId: number }, name: string): Promise<string | undefined>
  log(msg: string): void
}

/**
 * The verdict this PR last earned, read from the artifacts `fleet-review.yml`
 * records when — and only when — a review reaches a substantive verdict
 * (`artifactReviewCache.record`). A republish, a push and an UNREADABLE
 * record nothing, so the newest run holding one IS the last earned verdict,
 * and that run's `head_sha` is the commit it was earned on.
 *
 * What a push under `fleet/review` reports when its tree changed (#1284,
 * `decideReviewGate`). The cache above answers the question that can turn
 * the check green — "was THIS tree judged by THIS review set" — and wins
 * where it hits; this answers "what did the last review say", which a push
 * that missed the cache can only REPORT. A FAIL carries forward as a red; a
 * PASS earned on another tree is not a verdict about this one (#2014) and
 * never concludes green — `decideReviewGate` turns it into `stale`.
 *
 * Whether a verdict was a PASS or a FAIL is read from the artifact NAME
 * (`cacheArtifactName`), so an EXPIRED record still carries its verdict —
 * a FAIL does not quietly become "never reviewed" after 30 days. Only the
 * FAIL's text needs the content, and a FAIL whose text is gone is still
 * carried as a FAIL, pointing at the run.
 *
 * Every read is one this job already has permission for (`actions: read`),
 * and every failure is `unreadable`, never `none` — see `LastVerdictLookup`.
 */
export async function lastEarnedVerdict(deps: LastVerdictDeps): Promise<LastVerdictLookup> {
  if (!/^[0-9]+$/.test(deps.pr)) return { kind: 'unreadable', reason: `pr "${deps.pr}" is not a PR number` }
  if (deps.branch.trim().length === 0) return { kind: 'unreadable', reason: 'no head branch to search' }
  const workflow = CACHE_WRITER_WORKFLOW.split('/').pop() ?? CACHE_WRITER_WORKFLOW
  const runs = await deps.api<WorkflowRunsResponse>(
    `repos/${REPO}/actions/workflows/${workflow}/runs?branch=${encodeURIComponent(deps.branch)}` +
    `&status=completed&per_page=${LAST_VERDICT_RUN_WINDOW}`,
  )
  if (runs === undefined || !Array.isArray(runs.workflow_runs)) {
    return { kind: 'unreadable', reason: `could not list ${workflow} runs on ${deps.branch}` }
  }
  // Same producing-workflow rule as the cache (`CACHE_WRITER_WORKFLOW`): an
  // artifact's name is not a capability, so a record from any other
  // workflow is never believed. Scoped or general, PASS or FAIL, THIS PR.
  // Every naming era: a (tree, claim)-keyed record (#2336), a tree-keyed one
  // (#2014) and a diff-keyed one from before both. Each is a verdict this PR
  // earned; none is a verdict about THIS head's tree and description, which
  // only a cache hit can be (`decideReviewGate`).
  const recordName = new RegExp(
    `^fleet-review-(?:set-[0-9a-f]{12}-)?(pass|fail)-pr${deps.pr}-` +
    `(?:[0-9a-f]{24}|tree-(?:[0-9a-f]{40}|[0-9a-f]{64})(?:-claim-[0-9a-f]{${CLAIM_DIGEST_NAME_CHARS}})?)$`,
  )
  let searched = 0
  for (const run of runs.workflow_runs) {
    if (String(run.id) === deps.currentRunId) continue
    if (run.path !== undefined && run.path !== CACHE_WRITER_WORKFLOW) continue
    searched += 1
    const listed = await deps.api<RunArtifactsResponse>(`repos/${REPO}/actions/runs/${run.id}/artifacts?per_page=100`)
    // Unreadable, never skipped: skipping a run could skip the FAIL that
    // run earned and carry an older PASS behind it.
    if (listed === undefined || !Array.isArray(listed.artifacts)) {
      return { kind: 'unreadable', reason: `could not list the artifacts of run ${run.id}` }
    }
    const records = listed.artifacts.filter((a) => recordName.test(a.name))
    if (records.length === 0) continue
    // One run records one verdict, under one or two namespaces — the same
    // PASS or FAIL in each. A disagreement is not something to pick from.
    const verdicts = new Set(records.map((a) => (recordName.exec(a.name)?.[1] === 'fail' ? 'FAIL' : 'PASS')))
    if (verdicts.size !== 1) {
      return { kind: 'unreadable', reason: `run ${run.id} recorded both a PASS and a FAIL for pr ${deps.pr}` }
    }
    const verdict: 'PASS' | 'FAIL' = verdicts.has('FAIL') ? 'FAIL' : 'PASS'
    const earnedOn = `PR #${deps.pr}'s last review — ${verdict} on ${run.head_sha} (${run.html_url})`
    if (verdict === 'PASS') {
      const covers = 'This head\'s tree, or the PR\'s title and description, differ from what that PASS judged, so ' +
        'it does not cover this head, and a push never starts a review: request one to have this head judged.'
      return { kind: 'found', earned: { verdict, headSha: run.head_sha, runUrl: run.html_url, text: `VERDICT: PASS (earlier tree)\n\n${earnedOn}. ${covers}` } }
    }
    const stands = 'This head\'s tree, or the PR\'s title and description, differ from what that FAIL judged, and a ' +
      'push never starts a review, so that FAIL stands until a review is requested again.'
    const live = records.find((a) => !a.expired)
    const original = live === undefined ? undefined : await deps.failText({ id: live.id, runId: run.id }, live.name)
    const body = original ?? `(the reviewer's text is no longer readable — see ${run.html_url})`
    return {
      kind: 'found',
      earned: {
        verdict, headSha: run.head_sha, runUrl: run.html_url,
        text: `VERDICT: FAIL (carried)\n\n${earnedOn}. ${stands} The original verdict follows.\n\n---\n\n${body}`,
      },
    }
  }
  deps.log(`no fleet/review verdict recorded for pr ${deps.pr} in the last ${searched} completed run(s) on ${deps.branch}`)
  return { kind: 'none', runsSearched: searched }
}

/** `LastVerdictDeps` wired to the live Actions API. */
export function liveLastVerdictDeps(
  pr: string, branch: string, currentRunId: string | undefined, log: (msg: string) => void,
): LastVerdictDeps {
  return {
    pr, branch, currentRunId, log,
    api: <T>(path: string) => ghJson<T>(['api', path], 30_000, (detail) => log(`gh api ${path} failed: ${detail}`)),
    failText: (artifact, name) => recordedText(artifact, name, log, 'carrying the FAIL without its text'),
  }
}
