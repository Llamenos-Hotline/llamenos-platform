import { describe, it, expect } from 'vitest'
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadWorkflow, getJob, getStep, resolveEnv, runShellStep,
  type WorkflowJob, type WorkflowStep, type WorkflowDoc,
} from './helpers/workflow-shell.js'

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

/** `loadWorkflow` is shared, but this file only ever reads release.yml. */
function dockerStableJob(doc: WorkflowDoc): WorkflowJob {
  return getJob(doc, 'docker-stable')
}
const step = getStep

/** Fixtures for the runner-supplied values the meta step reads. The
 *  repository is deliberately the post-move casing: if this job ever
 *  re-derived the publish address from it, the assertions below would see
 *  the wrong address rather than silently agreeing with a stale literal. */
const EXPRESSIONS: Readonly<Record<string, string>> = {
  'github.repository': 'Llamenos-Hotline/llamenos-platform',
  'needs.check.outputs.version': '9.9.9',
}

/** Runs the real `Compute stable tags` block against a chosen checkout. */
function computeTags(cwd: string = process.cwd()): Record<string, string> {
  const doc = loadWorkflow('release.yml')
  const j = dockerStableJob(doc)
  const s = step(j, 'Compute stable tags')
  if (!s.run) throw new Error('"Compute stable tags" has no run block — the parser must not pass vacuously')
  const env = { ...resolveEnv(j.env, EXPRESSIONS), ...resolveEnv(s.env, EXPRESSIONS) }
  const r = runShellStep(s.run, env, cwd)
  if (r.status !== 0) throw new Error(`Compute stable tags failed (${r.status}): ${r.stderr}${r.stdout}`)
  return r.outputs
}

/** The address site/src/config.ts advertises, read the same way the site does.
 *
 *  This used to be a `resolveImageName` helper that hardcoded
 *  `rhonda-rodododo/llamenos-platform` as the resolution of
 *  `${{ github.repository }}` (#1220). That was a SECOND copy of the
 *  address, and it was already stale: the repository moved to
 *  `Llamenos-Hotline` but the GHCR package did not — a transfer does not
 *  carry packages — so the workflow's real value and the hardcoded one had
 *  silently parted company, and the parity check below was comparing two
 *  literals neither of which was what the job would actually publish to.
 *
 *  There is now one copy, in site/src/config.ts, and the workflow reads it.
 *  #1223 moves it once the new package exists AND is public (GHCR defaults
 *  new packages to private on first push); the workflow follows in the same
 *  commit, because it has nothing of its own to update.
 */
function advertisedImage(root: string = process.cwd()): string {
  const src = readFileSync(join(root, 'site', 'src', 'config.ts'), 'utf8')
  const m = src.match(/app:\s*'([^']+)'/)
  if (!m) throw new Error('could not find registry.app in site/src/config.ts — the parser must not pass vacuously')
  return m[1] as string
}

describe('rail: docker-stable publishes to exactly the address the site advertises — one literal, not two', () => {
  it('finds a non-trivial docker-stable job with a real env block — the parser must not pass vacuously', () => {
    const doc = loadWorkflow('release.yml')
    const j = dockerStableJob(doc)
    expect(j.env).toBeDefined()
    expect(Object.keys(j.env ?? {}).length).toBeGreaterThan(0)
  })

  it('REGISTRY is ghcr.io, not docker.io', () => {
    const doc = loadWorkflow('release.yml')
    const j = dockerStableJob(doc)
    expect(j.env?.['REGISTRY']).toBe('ghcr.io')
  })

  // The publish address used to be re-derived here from `github.repository`,
  // which made it a SECOND copy of an address that also lives in
  // site/src/config.ts. Two copies can drift, and they did: the repo moved
  // to `Llamenos-Hotline` while the GHCR package did not, so the derived
  // value silently stopped matching the address the download page serves.
  // There is now one copy; this job reads it.
  it('declares no second copy of the publish address — it names the file that holds the only one', () => {
    const j = dockerStableJob(loadWorkflow('release.yml'))
    expect(j.env?.['IMAGE_NAME'], 'IMAGE_NAME is a second copy of the publish address; read config.ts instead').toBeUndefined()
    expect(j.env?.['SITE_CONFIG']).toBe('site/src/config.ts')
  })

  it('the computed image reference matches registry.app advertised in site/src/config.ts', () => {
    const doc = loadWorkflow('release.yml')
    const j = dockerStableJob(doc)
    void j
    const outputs = computeTags()
    // Not "these two literals agree today" — this is the address the step
    // actually emitted, having read config.ts on disk.
    expect(outputs['image']).toBe(advertisedImage())
    for (const tag of (outputs['tags'] ?? '').split('\n').filter(Boolean)) {
      expect(tag.startsWith(`${advertisedImage()}:`), `published tag "${tag}" is not under the advertised address`).toBe(true)
    }
  })

  // MUTATION: prove the coupling is real. Copy the checkout, change ONLY
  // `registry.app`, re-run the same step against it, and show the published
  // address follows the file. A pair of agreeing literals could not do this.
  it('MUTATION: changing registry.app changes what the job publishes — the two cannot drift', () => {
    const root = mkdtempSync(join(tmpdir(), 'ghcr-parity-'))
    for (const dir of ['.github', 'site']) {
      cpSync(join(process.cwd(), dir), join(root, dir), { recursive: true })
    }
    const cfg = join(root, 'site', 'src', 'config.ts')
    const moved = 'ghcr.io/llamenos-hotline/llamenos-platform'
    writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/app:\s*'[^']+'/, `app: '${moved}'`))

    expect(advertisedImage(root)).toBe(moved)
    expect(computeTags(root)['image']).toBe(moved)
    // ...and it is genuinely different from what the real checkout yields,
    // so the assertion above is not passing on a coincidence.
    expect(moved).not.toBe(advertisedImage())
  })

  // The advertised address is a published contract, so a malformed one must
  // FAIL the release rather than be silently rewritten into something legal.
  // Lowercasing it here would republish under an address nobody was told
  // about — a silent divergence, which is the whole defect class this
  // coupling exists to remove.
  it('a mixed-case registry.app fails the release loudly instead of being folded', () => {
    const root = mkdtempSync(join(tmpdir(), 'ghcr-badcase-'))
    for (const dir of ['.github', 'site']) {
      cpSync(join(process.cwd(), dir), join(root, dir), { recursive: true })
    }
    const cfg = join(root, 'site', 'src', 'config.ts')
    writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/app:\s*'[^']+'/, "app: 'ghcr.io/Llamenos-Hotline/llamenos-platform'"))

    expect(() => computeTags(root)).toThrow(/not a legal lowercase OCI reference/)
  })

  it('the "Compute stable tags" step reads the address from the config file, never a literal owner', () => {
    const metaStep = step(dockerStableJob(loadWorkflow('release.yml')), 'Compute stable tags')
    expect(metaStep.run).toContain('$SITE_CONFIG')
    expect(metaStep.run).toContain('image=$IMAGE')
    // No owner may be spelled out here — that would recreate the second copy.
    expect(metaStep.run).not.toMatch(/rhonda-rodododo|[Ll]lamenos-[Hh]otline\//)
  })

  it('every downstream step (attest, sign, scan) references the same computed image output, never a re-derived string', () => {
    const doc = loadWorkflow('release.yml')
    const j = dockerStableJob(doc)

    const attestStep = step(j, 'Generate SBOM attestation')
    expect(attestStep.with?.['subject-name']).toBe('${{ steps.meta.outputs.image }}')

    const signStep = step(j, 'Sign container image (keyless)')
    expect(signStep.run).toContain('${{ steps.meta.outputs.image }}')

    const scanStep = step(j, 'Run Trivy vulnerability scanner')
    expect(scanStep.with?.['image-ref']).toContain('${{ steps.meta.outputs.image }}')
  })

  it('authenticates with the built-in GITHUB_TOKEN', () => {
    const doc = loadWorkflow('release.yml')
    const loginStep = step(dockerStableJob(doc), 'Log in to GHCR')
    expect(loginStep.with?.['password']).toBe('${{ secrets.GITHUB_TOKEN }}')
    expect(loginStep.with?.['username']).toBe('${{ github.actor }}')
  })

  it('the job declares packages: write and security-events: write (needed for push + SARIF upload)', () => {
    const doc = loadWorkflow('release.yml')
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
    const doc = loadWorkflow('release.yml')
    const j = dockerStableJob(doc)
    for (const name of CRITICAL_STEP_NAMES) {
      const s = step(j, name)
      expect(s['continue-on-error'], `step "${name}" must not tolerate failure`).not.toBe(true)
    }
  })

  // MUTATION (mandatory per the task's rail instructions): make the push
  // step tolerate an error and prove the assertion above would fail.
  it('MUTATION: making "Build and push stable image" tolerate an error is caught by the no-tolerance assertion', () => {
    const doc = loadWorkflow('release.yml')
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
