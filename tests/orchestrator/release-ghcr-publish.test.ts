import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { siteConfig } from '../../site/src/config.js'
import { actualRepository } from './repo-identity.js'

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
 *    workflow YAML with `${{ github.repository }}` resolved from outside the
 *    tree) is the ONLY app-image address anything advertises: `registry.app`
 *    in `site/src/config.ts`, and every deploy doc that names one.
 *
 *    History, because it is the reason this is a scan and not a pin. After
 *    the org move the job pushed to `ghcr.io/llamenos-hotline/…` while the
 *    site and 22 localized coopcloud.md copies kept advertising
 *    `ghcr.io/rhonda-rodododo/…` (#1223), whose last tag is 0.19.18. That
 *    divergence used to be pinned here from both ends; a pin only restates
 *    an answer, so it went on agreeing while self-hosters were left 2 minor
 *    versions behind. `registry.app` is now derived the same way the job
 *    derives its address, and the docs are scanned for any other owner.
 *    Whether that one address is anonymously PULLABLE is a live property,
 *    checked by verify-release-live.yml's container-image surface.
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

/** Resolves `${{ github.repository }}` to the value the runner supplies —
 *  read from outside the source tree (repo-identity.ts), never from a literal
 *  here, because a literal is what let this rail agree with a stale address. */
function resolveImageName(rawImageNameEnv: string): string {
  if (rawImageNameEnv === '${{ github.repository }}') return actualRepository()
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

/** `registry.app` from site/src/config.ts, evaluated — it is derived there,
 *  so reading its source text would test the template, not the value. */
function advertisedImage(): string {
  return siteConfig.registry.app
}

/**
 * Every place outside the build itself that tells an operator which app image
 * to pull. Docs are hand-maintained per locale (there is no codegen for
 * `site/src/content/docs/`), so each copy can go stale on its own — which is
 * what 22 copies of coopcloud.md did after the org move.
 *
 * Deliberately NOT scanned: `docs/superpowers/`, `docs/epics/` and the
 * changelogs, which are dated records of what was true at the time.
 */
const DEPLOY_DOC_ROOTS = [
  join('site', 'src', 'content', 'docs'),
  join('docs', 'runbooks'),
  join('docs', 'deployment'),
  'deploy',
]
const DEPLOY_DOC_EXT = /\.(md|mdx|ya?ml|j2|example|sh)$/

/** `ghcr.io/<owner>/llamenos-platform`, with a concrete owner. A documented
 *  placeholder such as `ghcr.io/<owner>/…` is not an address and is skipped
 *  by construction (the owner must start with a letter or digit). */
const APP_IMAGE_REF = /ghcr\.io\/([A-Za-z0-9][-A-Za-z0-9_.]*)\/llamenos-platform\b/g

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const rel = join(dir, entry.name)
    if (entry.isDirectory()) walk(rel, out)
    else if (DEPLOY_DOC_EXT.test(entry.name)) out.push(rel)
  }
}

/** Every concrete app-image address in `text`, as `ghcr.io/<owner>/llamenos-platform`. */
function appImageRefs(text: string): string[] {
  return [...text.matchAll(APP_IMAGE_REF)].map((m) => m[0])
}

/** file -> addresses in it that are not `expected`. Throws if the scan found
 *  no address at all: a rail that finds nothing to check must not pass. */
function staleDeployDocRefs(expected: string): Record<string, string[]> {
  const files: string[] = []
  for (const root of DEPLOY_DOC_ROOTS) walk(join(process.cwd(), root), files)
  let seen = 0
  const stale: Record<string, string[]> = {}
  for (const file of files) {
    const refs = appImageRefs(readFileSync(file, 'utf8'))
    seen += refs.length
    const wrong = [...new Set(refs.filter((r) => r !== expected))]
    if (wrong.length > 0) stale[relative(process.cwd(), file)] = wrong
  }
  if (seen === 0) {
    throw new Error('no ghcr.io/<owner>/llamenos-platform reference found in any deploy doc — the scan must not pass vacuously')
  }
  return stale
}

describe('rail: docker-stable publishes to GHCR under this repository\'s own lowercase namespace, and that is the only address advertised', () => {
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

  // One address. The advertised one is derived in site/src/config.ts the way
  // docker-stable derives the pushed one, and both are compared here against
  // the repository as resolved from outside the tree — so a rename on either
  // side, or a dropped fold, turns this red instead of agreeing with itself.
  it('the advertised registry.app is exactly the address docker-stable pushes to', () => {
    const pushed = computePushImage(dockerStableJob(loadWorkflow()))
    expect(pushed).toBe(`ghcr.io/${actualRepository().toLowerCase()}`)
    expect(advertisedImage()).toBe(pushed)
  })

  it('every deploy doc that names the app image names the address docker-stable pushes to', () => {
    const pushed = computePushImage(dockerStableJob(loadWorkflow()))
    expect(
      staleDeployDocRefs(pushed),
      `these docs tell an operator to pull an app image from somewhere docker-stable does not publish (${pushed}) — ` +
        'whoever follows them gets an old release or nothing',
    ).toEqual({})
  })

  // MUTATION GUARD: prove the comparisons above are discriminating rather
  // than universally true.
  it('MUTATION: a drifted IMAGE_NAME, a dropped lowercase fold, or a stale doc owner is caught', () => {
    const j = dockerStableJob(loadWorkflow())
    const registry = j.env?.['REGISTRY']
    const realImageName = resolveImageName(j.env?.['IMAGE_NAME'] ?? '')
    const advertised = advertisedImage()

    // 1. The repository is renamed and nothing else changes.
    expect(`${registry}/${realImageName}-renamed`.toLowerCase()).not.toBe(advertised)

    // 2. The `${IMAGE,,}` fold is removed from "Compute stable tags". This is
    //    the defect that made the release image unpushable at all: the raw
    //    display casing reaches the ref and the registry rejects it.
    const unfolded = `${registry}/${realImageName}`
    expect(unfolded).not.toBe(unfolded.toLowerCase())
    expect(unfolded).not.toBe(advertised)

    // 3. A doc still on the pre-move owner — the exact state this replaced.
    const staleDoc = '| **app** | `ghcr.io/rhonda-rodododo/llamenos-platform` | Bun application server |'
    expect(appImageRefs(staleDoc).filter((r) => r !== advertised)).toEqual([
      'ghcr.io/rhonda-rodododo/llamenos-platform',
    ])
    // ...while a placeholder owner is not mistaken for an address.
    expect(appImageRefs('llamenos_app_image: ghcr.io/<owner>/llamenos-platform:<version>')).toEqual([])

    // Sanity: the unmutated computation does match.
    expect(computePushImage(j)).toBe(advertised)
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
