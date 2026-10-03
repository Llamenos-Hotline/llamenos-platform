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
 *    (`${REGISTRY}/${IMAGE_NAME}`, lowercase-folded, computed from the real
 *    workflow YAML) and `registry.app` in `site/src/config.ts` — the
 *    address the download page tells operators to `docker pull` — are
 *    currently DIFFERENT, knowingly, and both ends are pinned here.
 *
 *    This used to assert the two were equal, and passed only because the
 *    resolver below returned the pre-org-move literal
 *    `rhonda-rodododo/llamenos-platform` for `${{ github.repository }}`.
 *    That is not what the workflow computes: the repository moved to
 *    `Llamenos-Hotline`, so the job pushes to
 *    `ghcr.io/llamenos-hotline/llamenos-platform` while the site still
 *    advertises `ghcr.io/rhonda-rodododo/llamenos-platform`. The old
 *    assertion therefore reported parity between two addresses that had
 *    already diverged — it papered over exactly the drift it claimed to
 *    police.
 *
 *    So the resolver now resolves to the real current repository and
 *    applies the same fold the workflow applies, and the rail pins BOTH
 *    addresses explicitly. The divergence is a tracked state, not an
 *    accident: the advertised package lives under an owner this repo has no
 *    `packages: write` on, and GHCR creates new packages private, so moving
 *    the advertised address before the new package exists and is public
 *    would replace a working `docker pull` with a 404. #1223 moves it. When
 *    #1223 lands, this rail MUST go red and force the two pins to be
 *    collapsed back into one — it accepts no other pairing, in either
 *    direction. A MUTATION proves the pin is not vacuous.
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

/**
 * What `${{ github.repository }}` actually evaluates to on this repository
 * today — the owner in GitHub's display casing, which is what broke the
 * push in the first place (OCI rejects a mixed-case repository path).
 */
const GITHUB_REPOSITORY = 'Llamenos-Hotline/llamenos-platform'

/**
 * The address `docker-stable` genuinely pushes to: `${REGISTRY}/${IMAGE_NAME}`
 * after the `${IMAGE,,}` fold in the "Compute stable tags" step. This
 * repository's own namespace, writable by the job's `packages: write` token.
 */
const EXPECTED_PUSH_IMAGE = 'ghcr.io/llamenos-hotline/llamenos-platform'

/**
 * The address `registry.app` in site/src/config.ts still advertises. Under
 * the pre-move owner, where the live, public package actually is — and which
 * this repository's GITHUB_TOKEN cannot write.
 */
const EXPECTED_ADVERTISED_IMAGE = 'ghcr.io/rhonda-rodododo/llamenos-platform'

/** Failure text for either pin, so a red run says what to do about it. */
const DIVERGENCE_NOTE =
  'The pushed and advertised GHCR addresses are pinned as a known #1223 divergence. ' +
  `Expected push=${EXPECTED_PUSH_IMAGE} and advertised=${EXPECTED_ADVERTISED_IMAGE}. ` +
  'One of them moved. If this is #1223 landing, collapse BOTH pins onto the single ' +
  'address and delete this note; do not just re-pin the value that changed.'

/** Resolves `${{ github.repository }}` to the value the runner supplies. */
function resolveImageName(rawImageNameEnv: string): string {
  if (rawImageNameEnv === '${{ github.repository }}') return GITHUB_REPOSITORY
  return rawImageNameEnv
}

/**
 * Reproduces the address the job computes: join, then apply the shell fold
 * `IMAGE="${IMAGE,,}"` the "Compute stable tags" step performs. (That the
 * step really performs it — rather than merely saying so in YAML — is
 * executed for real in tests/orchestrator/ghcr-image-ref-lowercase.test.ts,
 * and asserted textually below.)
 */
function computePushImage(j: WorkflowJob): string {
  const registry = j.env?.['REGISTRY']
  const imageName = resolveImageName(j.env?.['IMAGE_NAME'] ?? '')
  expect(registry, 'docker-stable has no REGISTRY env').toBeTruthy()
  expect(imageName, 'docker-stable has no IMAGE_NAME env').toBeTruthy()
  return `${registry}/${imageName}`.toLowerCase()
}

/** Reads `registry.app` out of site/src/config.ts. */
function advertisedImage(): string {
  const siteConfigSrc = readFileSync(SITE_CONFIG_TS, 'utf8')
  const app = siteConfigSrc.match(/app:\s*'([^']+)'/)?.[1]
  if (!app) throw new Error('could not find registry.app in site/src/config.ts — the parser must not pass vacuously')
  return app
}

describe('rail: docker-stable publishes to GHCR under this repository\'s own lowercase namespace, diverging from the advertised address only as tracked by #1223', () => {
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

  // Both ends of the #1223 divergence, pinned. Neither is allowed to move
  // on its own: the pushed address is the only one the job's token can
  // write, the advertised one is the only one that currently serves images,
  // and they are reunited by #1223 — at which point this test goes red on
  // purpose and whoever lands it must collapse the two pins into one.
  it('the pushed address and the advertised registry.app are the pinned, tracked #1223 divergence', () => {
    const computedImage = computePushImage(dockerStableJob(loadWorkflow()))

    expect(computedImage, DIVERGENCE_NOTE).toBe(EXPECTED_PUSH_IMAGE)
    expect(advertisedImage(), DIVERGENCE_NOTE).toBe(EXPECTED_ADVERTISED_IMAGE)
  })

  // MUTATION GUARD: prove the pin above is a real rail, not a string that
  // happens to match today. Both ways the computed address can go wrong —
  // a renamed repository, and a dropped lowercase fold — are shown to miss
  // the pin, and to be equally unusable as the advertised address.
  it('MUTATION: a drifted IMAGE_NAME, or a dropped lowercase fold, misses the pinned push address', () => {
    const j = dockerStableJob(loadWorkflow())
    const registry = j.env?.['REGISTRY']
    const realImageName = resolveImageName(j.env?.['IMAGE_NAME'] ?? '')
    const advertised = advertisedImage()

    // 1. The repository is renamed and nothing else changes.
    const drifted = `${registry}/${realImageName}-renamed`.toLowerCase()
    expect(drifted).not.toBe(EXPECTED_PUSH_IMAGE)
    expect(drifted).not.toBe(advertised)

    // 2. The `${IMAGE,,}` fold is removed from "Compute stable tags". This is
    //    the defect that made the release image unpushable at all: the raw
    //    display casing reaches the ref and the registry rejects it.
    const unfolded = `${registry}/${realImageName}`
    expect(unfolded).toContain('Llamenos-Hotline')
    expect(unfolded).not.toBe(EXPECTED_PUSH_IMAGE)
    expect(unfolded).not.toBe(advertised)

    // Sanity: the unmutated computation does hit the pin, so the assertions
    // above are discriminating rather than universally true.
    expect(computePushImage(j)).toBe(EXPECTED_PUSH_IMAGE)
  })

  it('the "Compute stable tags" step derives its image from job env, folded to lowercase, not a hardcoded literal', () => {
    const doc = loadWorkflow()
    const j = dockerStableJob(doc)
    const metaStep = step(j, 'Compute stable tags')
    expect(metaStep.run).toContain('${REGISTRY}')
    expect(metaStep.run).toContain('${IMAGE_NAME}')
    // The fold this rail's EXPECTED_PUSH_IMAGE assumes. Asserted textually
    // here; executed for real against a mixed-case owner in
    // tests/orchestrator/ghcr-image-ref-lowercase.test.ts.
    expect(metaStep.run).toContain('${IMAGE,,}')
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
