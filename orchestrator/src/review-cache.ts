import { createHash } from 'node:crypto'
import { mkdir, appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ghJson, REPO } from './gh.js'

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
 * Only a PASS is ever recorded (`record` is never called with anything
 * else — see `runReviewCi` in `ci.ts`), which is what makes "a FAIL is never
 * reused" true by construction: there is nothing to look up for a diff that
 * previously failed, so it is reviewed again every time, exactly like a diff
 * seen for the first time.
 */
export interface ReviewCacheKey {
  /** `CiContext.pr` — a PR number as a string, or `'(unknown)'`. Part of the
   *  key (not just the hash) so a diff that happens to match byte-for-byte
   *  across two different PRs is never cross-published between them. */
  pr: string
  diffHash: string
}

export interface CachedVerdict {
  verdict: 'PASS'
  text: string
}

export interface ReviewCache {
  /** `undefined` for a genuine miss AND for a lookup that could not be
   *  answered — callers cannot and must not tell those apart, because both
   *  mean the same thing: run the engine. See `artifactReviewCache`. */
  lookup(key: ReviewCacheKey): Promise<CachedVerdict | undefined>
  /** Called only with a fresh PASS this process itself just produced — never
   *  with a cache hit it is re-publishing, and never with anything but PASS. */
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
export function cacheArtifactName(pr: string, hash: string, reviewer?: string): string {
  // `reviewer` (a specialist agent name, already validated against the agent
  // registry by `resolveSpecialistLabel` in specialist.ts — lowercase
  // `[a-z0-9-]` only) namespaces the specialist's PASSes away from the
  // generalist's. Without it, a specialist lookup would find the GENERALIST's
  // PASS for the identical diff and re-publish it as a crypto review that
  // never happened. The generalist's own name is unchanged (no `reviewer`),
  // so every artifact it already recorded stays a hit.
  const scope = reviewer === undefined ? '' : `${reviewer}-`
  return `fleet-review-${scope}pass-pr${pr}-${hash.slice(0, 24)}`
}

interface ArtifactListResponse { artifacts: { id: number; expired: boolean }[] }

/**
 * The real, CI-only cache. `reviewer` selects a specialist's own namespace
 * (see `cacheArtifactName`); omitted, it is the generalist `fleet/review`'s. Lookup is a single `GET .../actions/artifacts
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
export function artifactReviewCache(
  outputDir: string | undefined,
  log: (msg: string) => void,
  reviewer?: string,
): ReviewCache {
  return {
    async lookup(key) {
      const name = cacheArtifactName(key.pr, key.diffHash, reviewer)
      const data = await ghJson<ArtifactListResponse>(
        ['api', `repos/${REPO}/actions/artifacts?name=${encodeURIComponent(name)}&per_page=1`],
        30_000,
        (detail) => log(`review cache lookup failed for ${name} — running the engine (fail safe): ${detail}`),
      )
      const hit = data?.artifacts.find((a) => !a.expired)
      if (hit === undefined) return undefined
      return {
        verdict: 'PASS',
        text: `VERDICT: PASS (cached)\n\nan earlier merge-queue attempt already reviewed this exact diff ` +
          `(PR #${key.pr}, sha256:${key.diffHash.slice(0, 12)}…) and it passed — re-published from artifact ` +
          `"${name}" (id ${hit.id}) instead of invoking the review engine again.`,
      }
    },
    async record(key, verdict) {
      // `outputDir` unset means the workflow gave this run nowhere to put a
      // record — a missing cache write is never fatal to the review that
      // just passed; it only costs the NEXT identical diff its cache hit.
      if (outputDir === undefined) return
      const name = cacheArtifactName(key.pr, key.diffHash, reviewer)
      await mkdir(outputDir, { recursive: true })
      await writeFile(
        join(outputDir, `${name}.json`),
        JSON.stringify({ pr: key.pr, diffHash: key.diffHash, ...verdict, recordedAt: new Date().toISOString() }),
      )
      // The workflow's upload step reads this name back via
      // `steps.<review-step-id>.outputs.cache_artifact_name` — the one
      // source of truth for the name is this function, computed once, never
      // recomputed in bash where it could drift from what lookup() queries.
      const ghOutput = process.env['GITHUB_OUTPUT']
      if (ghOutput !== undefined) await appendFile(ghOutput, `cache_artifact_name=${name}\n`)
    },
  }
}
