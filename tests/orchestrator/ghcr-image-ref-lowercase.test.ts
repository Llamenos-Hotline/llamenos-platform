import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  loadWorkflow, getJob, getStep, resolveEnv, runShellStep,
  type WorkflowJob, type WorkflowDoc,
} from './helpers/workflow-shell.js'

/**
 * Rail: no workflow may put a mixed-case repository path into a container
 * image reference it derives from `github.repository`.
 *
 * What went wrong. The repo moved to the `Llamenos-Hotline` org, so
 * `github.repository` now evaluates to `Llamenos-Hotline/llamenos-platform`
 * — the owner's *display* casing. OCI registries reject a mixed-case
 * repository path outright, and every workflow that pasted the raw value
 * into a tag broke at once:
 *
 *   ERROR: failed to build: invalid tag
 *   "ghcr.io/Llamenos-Hotline/llamenos-platform:buildcache":
 *   repository name must be lowercase
 *
 * Scope note. This rail covers every address this project DERIVES from
 * `github.repository` and hands to a registry: the two build caches
 * (docker-buildcache.yml, image-smoke.yml) and the release publish
 * (release.yml's `docker-stable`).
 *
 * `docker-stable` used to be excluded here on the theory that folding its
 * case "would make an unwritable push *look* fixed". That reasoning was
 * backwards and is retired. The address this repo's GITHUB_TOKEN cannot
 * write is the *advertised* one — `ghcr.io/rhonda-rodododo/...`, still the
 * value of `registry.app` in site/src/config.ts, whose package lives under
 * an owner this repository has no `packages: write` on (`denied:
 * permission_denied`, ci-base-image-nightly run 36309067787). The address
 * the fold produces is this repository's OWN namespace, which the job's
 * `packages: write` token can write. So folding does not mask an unwritable
 * push — without it the push is unwritable *and* malformed, rejected by the
 * registry before a permission is ever consulted. With it, `docker-stable`
 * has the only publishable address available to it.
 *
 * The consequence is a knowing, tracked divergence: the address computed
 * and pushed here (`ghcr.io/llamenos-hotline/llamenos-platform`) is NOT the
 * address site/src/config.ts advertises. #1223 is the follow-up that moves
 * the advertised one onto the pushed one, once the new package exists and
 * is public. That divergence is pinned from both ends — and made to fail
 * loudly the moment either end moves — in
 * tests/orchestrator/release-ghcr-publish.test.ts. This file only asserts
 * the narrower property: whatever address is computed, it is lowercase and
 * therefore legal for a registry to accept.
 *
 * Why a rail and not a code read. GitHub Actions has no lowercase function
 * in `${{ }}` expressions, and `with:` inputs are not shell — so `${VAR,,}`
 * written at a `with:` use site is inert text that *looks* like a fix. The
 * only place the fold can happen is a `run:` block that emits an
 * already-folded step output. That makes "is it folded?" a question about
 * shell behaviour, not about YAML text, so this rail **executes the real
 * run block** from each workflow with a mixed-case repository and reads the
 * `$GITHUB_OUTPUT` it produces. A grep for `,,` would pass on the inert
 * version; this does not.
 *
 * Each case carries a MUTATION that strips the fold from that same real run
 * block and shows the assertion catches it — proving the check is not
 * vacuously green just because today's owner happens to be lowercase.
 */

/** The owner casing that actually broke production. */
const MIXED_CASE_REPOSITORY = 'Llamenos-Hotline/llamenos-platform'
const FOLDED_REPOSITORY = 'ghcr.io/llamenos-hotline/llamenos-platform'

const EXPRESSIONS: Readonly<Record<string, string>> = {
  'github.repository': MIXED_CASE_REPOSITORY,
  'needs.check.outputs.version': '9.9.9',
}

/** Strips bash's lowercase fold, reproducing the pre-fix defect exactly. */
function withoutTheFold(script: string): string {
  const mutated = script.replaceAll(',,}', '}')
  if (mutated === script) {
    throw new Error('mutation was a no-op — the step under test does not fold at all')
  }
  return mutated
}

/**
 * A repo-derived reference must be a legal OCI repository path: a single
 * uppercase letter anywhere is what the registry rejects.
 */
function expectPublishableRef(actual: string | undefined, expected: string): void {
  expect(actual, 'the meta step emitted no such output at all').toBeTruthy()
  expect(actual).toBe(expected)
  expect(actual).toMatch(/^[a-z0-9.\-_/:]+$/)
  expect(actual).not.toMatch(/[A-Z]/)
}

/** The workflows that derive an image address from `github.repository`. */
const CASES: ReadonlyArray<{
  file: string
  job: string
  step: string
  /** Job- and workflow-level env the run block reads, beyond the step's own. */
  inheritedEnv: (doc: WorkflowDoc, j: WorkflowJob) => Record<string, string>
  /** Every `with:` value that must consume a meta output, never the raw name. */
  consumers: (j: WorkflowJob) => string[]
  /** The output that is derived from `github.repository` and so must be folded. */
  foldedOutput: string
  /** What that output must be once folded. */
  expectedFolded: string
}> = [
  {
    file: 'docker-buildcache.yml',
    job: 'refresh',
    step: 'Compute cache image reference',
    inheritedEnv: (doc) => resolveEnv(doc.env, EXPRESSIONS),
    foldedOutput: 'image',
    expectedFolded: FOLDED_REPOSITORY,
    consumers: (j) => {
      const build = getStep(j, 'Build app image and export layer cache')
      return [
        String(build.with?.['tags']),
        String(build.with?.['cache-from']),
        String(build.with?.['cache-to']),
      ]
    },
  },
  {
    file: 'image-smoke.yml',
    job: 'smoke',
    step: 'Compute cache image reference',
    inheritedEnv: () => ({}),
    foldedOutput: 'image',
    expectedFolded: FOLDED_REPOSITORY,
    consumers: (j) => [String(getStep(j, 'Build app image').with?.['cache-from'])],
  },
  {
    // The release publish itself. Unlike the two cache refreshes above, this
    // step reads its `REGISTRY`/`IMAGE_NAME` from JOB-level env, not
    // workflow-level — so the inherited env comes off the job.
    file: 'release.yml',
    job: 'docker-stable',
    step: 'Compute stable tags',
    inheritedEnv: (_doc, j) => resolveEnv(j.env, EXPRESSIONS),
    foldedOutput: 'image',
    expectedFolded: FOLDED_REPOSITORY,
    consumers: (j) => {
      const smoke = getStep(j, 'Build image for the pre-publish smoke')
      const push = getStep(j, 'Build and push stable image')
      return [
        String(smoke.with?.['cache-from']),
        String(push.with?.['tags']),
        String(push.with?.['cache-from']),
        String(push.with?.['cache-to']),
      ]
    },
  },
]

describe.each(CASES)('rail: $file folds the repository path to lowercase before it reaches a registry', (c) => {
  function metaStep() {
    const doc = loadWorkflow(c.file)
    const j = getJob(doc, c.job)
    const s = getStep(j, c.step)
    const { run } = s
    if (!run) throw new Error(`"${c.step}" has no run block — the fold cannot happen in \`with:\``)
    return { doc, j, s, run, env: { ...c.inheritedEnv(doc, j), ...resolveEnv(s.env, EXPRESSIONS) } }
  }

  function outputsOf(script: string): Record<string, string> {
    const { env } = metaStep()
    const r = runShellStep(script, env)
    if (r.status !== 0) throw new Error(`"${c.step}" exited ${r.status}: ${r.stderr}${r.stdout}`)
    return r.outputs
  }

  it('running the real step against a mixed-case owner emits a lowercase, publishable ref', () => {
    const { run } = metaStep()
    const outputs = outputsOf(run)
    expectPublishableRef(outputs[c.foldedOutput], c.expectedFolded)

    // No output of these steps may carry the raw casing — every one of them
    // is an image reference that reaches a registry.
    for (const [key, value] of Object.entries(outputs)) {
      for (const line of value.split('\n').filter(Boolean)) {
        expect(line, `output "${key}" line "${line}" is not a lowercase image ref`).not.toMatch(/[A-Z]/)
      }
    }
  })

  it('MUTATION: the same step without its lowercase fold emits the ref the registry rejected', () => {
    const { run } = metaStep()
    const mutated = outputsOf(withoutTheFold(run))[c.foldedOutput]

    // The defect, reproduced: the raw display casing reaches the ref.
    expect(mutated).toContain('Llamenos-Hotline')

    // ...and the assertion from the test above correctly rejects it.
    let caught: unknown
    try {
      expectPublishableRef(mutated, c.expectedFolded)
    } catch (e) {
      caught = e
    }
    expect(caught, 'the lowercase assertion is vacuous — it accepted a mixed-case ref').toBeDefined()
  })

  it('every image-consuming `with:` input reads the folded step output, never the raw repository', () => {
    const { j } = metaStep()
    const consumers = c.consumers(j)
    expect(consumers.length, 'found no consumers — the parser must not pass vacuously').toBeGreaterThan(0)

    for (const value of consumers) {
      expect(value, 'a consuming `with:` input is missing entirely').toBeTruthy()
      // `with:` is not shell. A raw `github.repository` here cannot be
      // folded downstream, and a `${VAR,,}` written here would be inert
      // text — both are the bug this rail exists to stop.
      expect(value, `"${value}" interpolates github.repository directly`).not.toContain('github.repository')
      expect(value, `"${value}" uses bash syntax in a non-shell context`).not.toContain(',,}')
      // Any output of the meta step is acceptable: they are all folded at
      // the source, and the test above proves every emitted output is
      // lowercase.
      expect(value).toContain('steps.meta.outputs.')
    }
  })
})

describe('rail: every buildcache consumer tracks the producer tag', () => {
  // docker-buildcache.yml PRODUCES `<repo>:buildcache`. Other places CONSUME
  // it, and a mismatch in any of them is *silent* — cache import is a soft
  // dependency, so a wrong address costs a full rebuild and fails nothing.
  // Nothing else would catch that, so it is pinned here against the address
  // the producer actually computes.
  function producedTag(): string {
    const doc = loadWorkflow('docker-buildcache.yml')
    const { run } = getStep(getJob(doc, 'refresh'), 'Compute cache image reference')
    if (!run) throw new Error('the cache-ref step has no run block — the parser must not pass vacuously')
    const r = runShellStep(run, resolveEnv(doc.env, EXPRESSIONS))
    expect(r.status, r.stderr).toBe(0)
    return `${r.outputs['image']}:buildcache`
  }

  it('docker-compose.test.yml cache_from matches the tag docker-buildcache.yml pushes', () => {
    // Compose has no expression context, so this one is a hand-written
    // mirror — the most drift-prone of the three.
    const composeSrc = readFileSync(
      join(process.cwd(), 'deploy', 'docker', 'docker-compose.test.yml'),
      'utf8',
    )
    const match = composeSrc.match(/cache_from:\s*\n\s*-\s*type=registry,ref=(\S+)/)
    if (!match) throw new Error('no cache_from ref in docker-compose.test.yml — the parser must not pass vacuously')
    expect(match[1]).toBe(producedTag())
  })

  it('image-smoke.yml imports the tag docker-buildcache.yml pushes', () => {
    const doc = loadWorkflow('image-smoke.yml')
    const j = getJob(doc, 'smoke')
    const { run } = getStep(j, 'Compute cache image reference')
    if (!run) throw new Error('no run block — the parser must not pass vacuously')
    const r = runShellStep(run, resolveEnv(getStep(j, 'Compute cache image reference').env, EXPRESSIONS))
    expect(r.status, r.stderr).toBe(0)
    expect(`${r.outputs['image']}:buildcache`).toBe(producedTag())
  })

})
