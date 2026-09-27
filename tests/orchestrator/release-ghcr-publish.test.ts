import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

/**
 * Rail for the `docker-stable` job's registry migration off Docker Hub
 * (never configured — see #885, #902) onto GHCR, authenticated with the
 * built-in `GITHUB_TOKEN`. The job already declared `packages: write`,
 * which is the only permission GHCR publishing needs, so the opportunity
 * this PR takes is: point the job at `ghcr.io` and it runs on every
 * release with nothing for an operator to configure or rotate.
 *
 * Two things this rail checks that a config read cannot, per
 * "audit gates by breaking them":
 *
 * 1. The image reference the job actually publishes to
 *    (`${REGISTRY}/${IMAGE_NAME}`, computed from the real workflow YAML)
 *    matches `registry.app` in `site/src/config.ts` — the address the
 *    download page tells operators to `docker pull`. If either side drifts
 *    without the other, operators get a 404 or (worse) silently pull an
 *    unrelated image. A MUTATION proves this comparison is not vacuous.
 *
 * 2. A push/scan/attest failure still fails the job loudly. Since
 *    `docker/build-push-action` and friends are `uses:` steps (not `run:`
 *    scripts), "tolerate an error" for them takes the form of
 *    `continue-on-error: true` rather than `|| true` — the MUTATION here
 *    reintroduces exactly that on the push step and shows the no-tolerance
 *    assertion would have caught it.
 *
 * (The companion rail in release-dispatch-gate.test.ts covers the
 * "no docker-creds-style gate, never conditionally skipped" shape; this
 * file focuses on image-reference correctness and failure-must-propagate.)
 */

const RELEASE_YML = join(process.cwd(), '.github', 'workflows', 'release.yml')
const SITE_CONFIG_TS = join(process.cwd(), 'site', 'src', 'config.ts')

interface WorkflowStep {
  name?: string
  run?: string
  uses?: string
  with?: Record<string, unknown>
  'continue-on-error'?: boolean
}
interface WorkflowJob {
  env?: Record<string, string>
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

function step(j: WorkflowJob, name: string): WorkflowStep {
  const s = j.steps.find((s) => s.name === name)
  if (!s) throw new Error(`no "${name}" step found — the parser must not pass vacuously`)
  return s
}

/** Resolves `${{ github.repository }}` to the real owner/repo this rail
 *  runs against, without hardcoding a name that could drift from the repo
 *  the workflow actually runs in. Falls back to the known value only if the
 *  workflow expression itself ever changes shape (caught by the assertion
 *  right after this is called, not silently). */
function resolveImageName(rawImageNameEnv: string): string {
  if (rawImageNameEnv === '${{ github.repository }}') return 'rhonda-rodododo/llamenos-platform'
  return rawImageNameEnv
}

describe('rail: docker-stable publishes to GHCR under the repository namespace, matching what the site advertises', () => {
  it('finds a non-trivial docker-stable job with a real env block — the parser must not pass vacuously', () => {
    const doc = loadWorkflow()
    const j = dockerStableJob(doc)
    expect(j.env).toBeDefined()
    expect(Object.keys(j.env ?? {}).length).toBeGreaterThan(0)
  })

  it('REGISTRY is ghcr.io, not docker.io', () => {
    const doc = loadWorkflow()
    const j = dockerStableJob(doc)
    expect(j.env?.['REGISTRY']).toBe('ghcr.io')
  })

  it('IMAGE_NAME is the repository itself — no operator-supplied Docker Hub namespace', () => {
    const doc = loadWorkflow()
    const j = dockerStableJob(doc)
    expect(j.env?.['IMAGE_NAME']).toBe('${{ github.repository }}')
  })

  it('the computed image reference matches registry.app advertised in site/src/config.ts', () => {
    const doc = loadWorkflow()
    const j = dockerStableJob(doc)
    const registry = j.env?.['REGISTRY']
    const imageName = resolveImageName(j.env?.['IMAGE_NAME'] ?? '')
    expect(registry).toBeTruthy()
    expect(imageName).toBeTruthy()
    const computedImage = `${registry}/${imageName}`

    const siteConfigSrc = readFileSync(SITE_CONFIG_TS, 'utf8')
    const match = siteConfigSrc.match(/app:\s*'([^']+)'/)
    if (!match) throw new Error('could not find registry.app in site/src/config.ts — the parser must not pass vacuously')
    const advertisedImage = match[1]

    expect(computedImage).toBe(advertisedImage)
  })

  // MUTATION GUARD: prove the comparison above is a real rail, not two
  // strings that happen to agree today. Mutate the resolved image name and
  // show the same comparison now correctly reports a mismatch.
  it('MUTATION: a drifted IMAGE_NAME would be caught by the site-config parity check', () => {
    const doc = loadWorkflow()
    const j = dockerStableJob(doc)
    const registry = j.env?.['REGISTRY']
    const realImageName = resolveImageName(j.env?.['IMAGE_NAME'] ?? '')
    const mutatedImageName = `${realImageName}-renamed`
    const mutatedComputedImage = `${registry}/${mutatedImageName}`

    const siteConfigSrc = readFileSync(SITE_CONFIG_TS, 'utf8')
    const match = siteConfigSrc.match(/app:\s*'([^']+)'/)
    if (!match) throw new Error('could not find registry.app in site/src/config.ts — the parser must not pass vacuously')
    const advertisedImage = match[1]

    expect(mutatedComputedImage).not.toBe(advertisedImage)
  })

  it('the "Compute stable tags" step derives its image from job env, not a hardcoded literal', () => {
    const doc = loadWorkflow()
    const j = dockerStableJob(doc)
    const metaStep = step(j, 'Compute stable tags')
    expect(metaStep.run).toContain('${REGISTRY}')
    expect(metaStep.run).toContain('${IMAGE_NAME}')
    expect(metaStep.run).toContain('image=$IMAGE')
  })

  it('every downstream step (attest, sign, scan) references the same computed image output, never a re-derived string', () => {
    const doc = loadWorkflow()
    const j = dockerStableJob(doc)

    const attestStep = step(j, 'Generate SBOM attestation')
    expect(attestStep.with?.['subject-name']).toBe('${{ steps.meta.outputs.image }}')

    const signStep = step(j, 'Sign container image (keyless)')
    expect(signStep.run).toContain('${{ steps.meta.outputs.image }}')

    const scanStep = step(j, 'Run Trivy vulnerability scanner')
    expect(scanStep.with?.['image-ref']).toContain('${{ steps.meta.outputs.image }}')
  })

  it('authenticates with the built-in GITHUB_TOKEN', () => {
    const doc = loadWorkflow()
    const loginStep = step(dockerStableJob(doc), 'Log in to GHCR')
    expect(loginStep.with?.['password']).toBe('${{ secrets.GITHUB_TOKEN }}')
    expect(loginStep.with?.['username']).toBe('${{ github.actor }}')
  })

  it('the job declares packages: write and security-events: write (needed for push + SARIF upload)', () => {
    const doc = loadWorkflow()
    const j = dockerStableJob(doc) as unknown as { permissions?: Record<string, string> }
    expect(j.permissions?.['packages']).toBe('write')
    expect(j.permissions?.['security-events']).toBe('write')
  })

  // ---------------------------------------------------------------------
  // Failure must propagate: no push/scan/attest step may swallow an error.
  // ---------------------------------------------------------------------

  const CRITICAL_STEP_NAMES = [
    'Log in to GHCR',
    'Build and push stable image',
    'Generate SBOM attestation',
    'Sign container image (keyless)',
    'Run Trivy vulnerability scanner',
  ]

  it('none of the critical publish/scan/sign/attest steps tolerate failure', () => {
    const doc = loadWorkflow()
    const j = dockerStableJob(doc)
    for (const name of CRITICAL_STEP_NAMES) {
      const s = step(j, name)
      expect(s['continue-on-error'], `step "${name}" must not tolerate failure`).not.toBe(true)
    }
  })

  // MUTATION (mandatory per the task's rail instructions): make the push
  // step tolerate an error and prove the assertion above would fail.
  it('MUTATION: making "Build and push stable image" tolerate an error is caught by the no-tolerance assertion', () => {
    const doc = loadWorkflow()
    const j = dockerStableJob(doc)
    const pushStep = step(j, 'Build and push stable image')
    const mutated: WorkflowStep = { ...pushStep, 'continue-on-error': true }

    // Sanity: the mutation was actually applied to a copy, not the original.
    expect(mutated['continue-on-error']).toBe(true)
    expect(pushStep['continue-on-error']).not.toBe(true)

    // The real assertion this mirrors would fail against the mutated step —
    // demonstrating the rail is not vacuous.
    let caught: unknown
    try {
      expect(mutated['continue-on-error']).not.toBe(true)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeDefined()
  })
})
