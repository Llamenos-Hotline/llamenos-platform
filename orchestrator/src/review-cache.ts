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
 * one review per PR per DIFF, not per queue attempt.
 *
 * Keyed by a hash of the diff's own content, never the head SHA — a rebase
 * that only replays the PR on top of a newer `main` changes the head SHA but
 * not what the PR actually touches, and that replayed diff must still hit.
 *
 * Both a PASS and a SUBSTANTIVE FAIL are recorded (#1158). Caching only the
 * PASS was measurably expensive: in one 12-hour window there were 60 Fleet
 * Review runs, 10 of them on one PR and 8 on another — the two PRs that were
 * FAILING. Every branch-freshness rebase re-fired the gate, and the identical
 * diff was reviewed from scratch to reach the identical conclusion, burning a
 * provider call each time. The moment the author pushes anything the diff
 * hash changes and the cache is bypassed naturally, which is exactly when a
 * re-review is warranted.
 *
 * An INFRASTRUCTURE failure is never recorded, and the distinction is not
 * negotiable: a parsed `VERDICT: FAIL` means the reviewer looked and decided;
 * an UNREADABLE (an API error, a timeout, exhausted quota, an unparseable
 * response) means it could not look at all. Pinning a transient outage to a
 * diff hash would be far worse than the waste it saves — the PR would stay
 * red until someone pushed a commit, for a reason that had already gone away.
 * `runReviewCi` (ci.ts) is the only caller, and it records nothing when any
 * member of the review set came back UNREADABLE.
 */
export interface ReviewCacheKey {
  /** `CiContext.pr` — a PR number as a string, or `'(unknown)'`. Part of the
   *  key (not just the hash) so a diff that happens to match byte-for-byte
   *  across two different PRs is never cross-published between them. */
  pr: string
  diffHash: string
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
   *  never be pinned to a diff hash). */
  record(key: ReviewCacheKey, verdict: CachedVerdict): Promise<void>
}

/** `sha256(diff)`, hex. Pure and exported so `diffHash('') !== diffHash('x')`
 *  and similar shape assertions don't need a `ReviewCache` at all. */
export function diffHash(diff: string): string {
  return createHash('sha256').update(diff).digest('hex')
}

/**
 * The artifact name IS the cache key, so a lookup is one filtered list call
 * and needs no content downloaded (existence alone proves PASS, since
 * nothing is ever uploaded under this name for anything else — see the
 * module docstring). GitHub artifact names accept far more than this, but
 * `pr` and a hex hash are already exactly the safe subset: no path
 * separators, no characters a URL query parameter would need to escape.
 * Truncated to 24 hex characters (96 bits) — short enough to stay readable
 * in the Actions UI artifact list, far more collision resistance than a
 * per-repo review cache will ever need.
 */
export function cacheArtifactName(pr: string, hash: string, scope?: string, verdict: 'PASS' | 'FAIL' = 'PASS'): string {
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
  return `fleet-review-${prefix}${verdict.toLowerCase()}-pr${pr}-${hash.slice(0, 24)}`
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
 * `fleet-review-pass-pr<N>-<sha256(diff)[0:24]>` and the next review
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
      log(`cached FAIL artifact ${name} did not contain a FAIL verdict with text — reviewing again (fail safe)`)
      return undefined
    }
    return parsed.text
  } catch (e) {
    log(`could not read the cached FAIL ${name} — reviewing again rather than publishing a verdict without its reason: ${describeGhFailure(e)}`)
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
      // PASS first: it is the common case, and its artifact's existence
      // alone is the verdict, so the whole lookup is one list call.
      const passName = cacheArtifactName(key.pr, key.diffHash, scope, 'PASS')
      const pass = await findArtifact(passName, log)
      if (pass !== undefined) {
        return {
          verdict: 'PASS',
          text: `VERDICT: PASS (cached)\n\nan earlier run already reviewed this exact diff ` +
            `(PR #${key.pr}, sha256:${key.diffHash.slice(0, 12)}…) and it passed — re-published from artifact ` +
            `"${passName}" (id ${pass.id}) instead of invoking the review engine again.`,
        }
      }
      // Then the SUBSTANTIVE FAIL (#1158). A rebase that does not change the
      // diff must not re-spend a review to reach the same conclusion.
      const failName = cacheArtifactName(key.pr, key.diffHash, scope, 'FAIL')
      const fail = await findArtifact(failName, log)
      if (fail === undefined) return undefined
      const original = await recordedText(fail, failName, log)
      if (original === undefined) return undefined
      return {
        verdict: 'FAIL',
        text: `VERDICT: FAIL (cached)\n\nan earlier run already reviewed this exact diff ` +
          `(PR #${key.pr}, sha256:${key.diffHash.slice(0, 12)}…) and it FAILED; nothing in the diff has ` +
          `changed since, so it has not been reviewed again. Push a fix — the cache is keyed on the diff's ` +
          `own content, so any real change is reviewed afresh. The original verdict follows, from artifact ` +
          `"${failName}" (id ${fail.id}).\n\n---\n\n${original}`,
      }
    },
    async record(key, verdict) {
      // `outputDir` unset means the workflow gave this run nowhere to put a
      // record — a missing cache write is never fatal to the review that
      // just passed; it only costs the NEXT identical diff its cache hit.
      if (outputDir === undefined) return
      const name = cacheArtifactName(key.pr, key.diffHash, scope, verdict.verdict)
      await mkdir(outputDir, { recursive: true })
      await writeFile(
        join(outputDir, `${name}.json`),
        JSON.stringify({ pr: key.pr, diffHash: key.diffHash, ...verdict, recordedAt: new Date().toISOString() }),
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
      // profile (every crypto-content PR) could never be a cache hit: under
      // a standing review request, every rebase of it was a full review.
      const ghOutput = process.env['GITHUB_OUTPUT']
      const outputKey = scope === undefined ? CACHE_ARTIFACT_OUTPUT : CACHE_ARTIFACT_OUTPUT_SCOPED
      if (ghOutput !== undefined) await appendFile(ghOutput, `${outputKey}=${name}\n`)
    },
  }
}
