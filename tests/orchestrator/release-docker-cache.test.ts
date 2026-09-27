import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

/**
 * Rail for the `docker-stable` job's cache export, which failed on every
 * attempt at release 0.19.14 (run 35520224670, three consecutive re-runs,
 * identical error each time):
 *
 *   #47 ERROR: error writing layer blob: failed to reserve cache
 *   ERROR: failed to build: failed to solve: error writing layer blob:
 *   failed to reserve cache
 *
 * Root cause: `cache-to: type=gha,mode=max` exports every intermediate
 * layer of this multi-stage build into the repo's single Actions cache,
 * which is a fixed 10GB quota SHARED with docker.yml, ci.yml and
 * security-audit.yml (also `type=gha,mode=max` — see the PR body; not
 * changed here, #902/#903 own CI caching strategy). At the time of the
 * failure the quota was pinned at its ceiling — 10.19GB across 224
 * entries, 167 of them `buildkit-blob-*` layers from this exact export.
 * Purging those entries did not fix the underlying failure: any one of
 * the four `mode=max` exporters refills the same shared quota and
 * reproduces the reserve-cache error on the next release.
 *
 * Fix: move `docker-stable`'s cache to a registry-backed cache
 * (`type=registry`, a dedicated `:buildcache` tag under the same GHCR
 * image this job already authenticates to and pushes into). GHCR has no
 * shared/fixed quota analogous to the Actions cache, and this job no
 * longer competes with the other three workflows for it.
 *
 * Per "audit gates by breaking them": the MUTATION below reintroduces the
 * exact defect (`type=gha,mode=max`) and proves the rail would have
 * caught it, rather than merely reading the config and trusting it says
 * the right thing.
 */

const RELEASE_YML = join(process.cwd(), '.github', 'workflows', 'release.yml')

interface WorkflowStep {
  name?: string
  id?: string
  run?: string
  uses?: string
  with?: Record<string, unknown>
  'continue-on-error'?: boolean
}
interface WorkflowJob {
  steps: WorkflowStep[]
}
interface WorkflowDoc {
  jobs: Record<string, WorkflowJob>
}

function loadWorkflow(): WorkflowDoc {
  return parseYaml(readFileSync(RELEASE_YML, 'utf8')) as WorkflowDoc
}

function dockerStableJob(doc: WorkflowDoc): WorkflowJob {
  const j = doc.jobs['docker-stable']
  if (!j) throw new Error('no "docker-stable" job found in release.yml — the parser must not pass vacuously')
  return j
}

function buildPushStep(j: WorkflowJob): WorkflowStep {
  const s = j.steps.find((s) => s.name === 'Build and push stable image')
  if (!s) throw new Error('no "Build and push stable image" step found — the parser must not pass vacuously')
  return s
}

/** A cache value is on the shared Actions cache quota iff it names the
 *  `gha` buildx cache backend — this is the exact shape that filled the
 *  quota and produced the reserve-cache failure. */
function usesSharedActionsCacheQuota(cacheValue: unknown): boolean {
  return typeof cacheValue === 'string' && cacheValue.startsWith('type=gha')
}

describe('rail: docker-stable cache export no longer draws on the shared Actions cache quota', () => {
  it('finds a non-trivial "Build and push stable image" step with real cache-from/cache-to', () => {
    const doc = loadWorkflow()
    const step = buildPushStep(dockerStableJob(doc))
    expect(step.with?.['cache-from']).toBeTruthy()
    expect(step.with?.['cache-to']).toBeTruthy()
  })

  it('cache-from is not type=gha — reading from the shared quota was never the failure, but this pins the migration as complete on both sides', () => {
    const doc = loadWorkflow()
    const step = buildPushStep(dockerStableJob(doc))
    expect(usesSharedActionsCacheQuota(step.with?.['cache-from'])).toBe(false)
  })

  it('cache-to is not type=gha,mode=max — this exact string is what filled the shared 10GB quota and caused "failed to reserve cache" on three consecutive 0.19.14 runs', () => {
    const doc = loadWorkflow()
    const step = buildPushStep(dockerStableJob(doc))
    expect(usesSharedActionsCacheQuota(step.with?.['cache-to'])).toBe(false)
  })

  it('cache-to is registry-backed, mode=max, and targets the same image this job authenticates to and pushes (GHCR) — not a re-derived or hardcoded ref', () => {
    const doc = loadWorkflow()
    const step = buildPushStep(dockerStableJob(doc))
    const cacheTo = step.with?.['cache-to']
    expect(cacheTo).toContain('type=registry')
    expect(cacheTo).toContain('mode=max')
    // Must reference the job's own computed image output (steps.meta.outputs.image),
    // never a literal registry/namespace, so the cache always lands in the same
    // place the image itself is pushed.
    expect(cacheTo).toContain('${{ steps.meta.outputs.image }}')
  })

  it('cache-from matches the same registry ref cache-to writes to, so the cache is actually reusable across runs', () => {
    const doc = loadWorkflow()
    const step = buildPushStep(dockerStableJob(doc))
    const cacheFrom = step.with?.['cache-from'] as string
    const cacheTo = step.with?.['cache-to'] as string
    const refFrom = cacheFrom.match(/ref=([^,]+)/)?.[1]
    const refTo = cacheTo.match(/ref=([^,]+)/)?.[1]
    expect(refFrom).toBeTruthy()
    expect(refFrom).toBe(refTo)
  })

  // -------------------------------------------------------------------
  // MUTATION GUARD (mandatory per the task's rail instructions): revert
  // to the exact defect and prove the assertions above would catch it.
  // -------------------------------------------------------------------
  it('MUTATION: reverting cache-to to type=gha,mode=max is caught by the shared-quota assertion', () => {
    const mutatedCacheTo = 'type=gha,mode=max'
    expect(usesSharedActionsCacheQuota(mutatedCacheTo)).toBe(true)

    let caught: unknown
    try {
      expect(usesSharedActionsCacheQuota(mutatedCacheTo)).toBe(false)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeDefined()
  })

  // -------------------------------------------------------------------
  // Failure must still propagate loudly. The push step must not tolerate
  // an error just because its cache backend changed — a green job that
  // pushes nothing is not success.
  // -------------------------------------------------------------------
  it('the push step still does not tolerate failure after the cache backend change', () => {
    const doc = loadWorkflow()
    const step = buildPushStep(dockerStableJob(doc))
    expect(step['continue-on-error']).not.toBe(true)
  })

  it('MUTATION: making the push step tolerate an error is caught by the no-tolerance assertion', () => {
    const doc = loadWorkflow()
    const step = buildPushStep(dockerStableJob(doc))
    const mutated: WorkflowStep = { ...step, 'continue-on-error': true }

    expect(mutated['continue-on-error']).toBe(true)
    expect(step['continue-on-error']).not.toBe(true)

    let caught: unknown
    try {
      expect(mutated['continue-on-error']).not.toBe(true)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeDefined()
  })
})
