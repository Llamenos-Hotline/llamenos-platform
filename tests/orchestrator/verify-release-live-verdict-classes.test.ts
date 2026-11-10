import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parse as parseYaml } from 'yaml'

/**
 * Rail for verify-release-live keeping "the check could not run" apart from
 * "the release is broken".
 *
 * Three runs in a row went red with a Play secret that was not JSON, reported
 * as `SURFACE BROKEN: Play internal track` — the same words a genuinely
 * missing build gets. A malformed credential says nothing about the release,
 * and a broken release is not fixed by reissuing a secret, so each needs its
 * own verdict. Both still FAIL: an unchecked surface is never green.
 *
 * The Summary script is executed for real with synthetic `needs` JSON, so
 * this checks shell behaviour rather than YAML text.
 */

const WORKFLOWS = join(process.cwd(), '.github', 'workflows')
const VERIFY_YML = join(WORKFLOWS, 'verify-release-live.yml')
const SURFACES_JSON = join(WORKFLOWS, 'verify-release-live.surfaces.json')

interface Step {
  id?: string
  name?: string
  run?: string
}
interface Job {
  outputs?: Record<string, string>
  steps: Step[]
}
const doc = parseYaml(readFileSync(VERIFY_YML, 'utf8')) as { jobs: Record<string, Job> }

function job(id: string): Job {
  const j = doc.jobs[id]
  if (!j) throw new Error(`no "${id}" job in verify-release-live.yml — the rail must not pass vacuously`)
  return j
}

function reportScript(): string {
  const s = job('report').steps.find((st) => st.run?.includes('Internal Availability'))
  if (!s?.run) throw new Error('no Summary step that reports Internal Availability — the rail must not pass vacuously')
  return s.run
}

type Result = 'success' | 'failure' | 'skipped'
interface SurfaceNeed {
  result: Result
  outputs?: Record<string, string>
}

/** Runs the real Summary script against `needs` built from `surfaces`. */
function runSummary(surfaces: Record<string, SurfaceNeed>): { status: number | null; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'vrl-summary-'))
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true })
  copyFileSync(SURFACES_JSON, join(dir, '.github', 'workflows', 'verify-release-live.surfaces.json'))
  const script = join(dir, 'report.sh')
  writeFileSync(script, reportScript())

  const ids = ['desktop-installer', 'play-track', 'testflight', 'desktop-updater', 'container-image']
  const needs: Record<string, unknown> = {
    config: {
      result: 'success',
      outputs: Object.fromEntries(ids.map((id) => [id, id in surfaces ? 'true' : 'false'])),
    },
  }
  for (const id of ids) needs[id] = surfaces[id] ?? { result: 'skipped', outputs: {} }

  const r = spawnSync('bash', [script], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      PATH: process.env['PATH'] ?? '',
      NEEDS_JSON: JSON.stringify(needs),
      OVERRIDE: '',
      GITHUB_STEP_SUMMARY: join(dir, 'summary.md'),
    },
  })
  return { status: r.status, out: `${r.stdout}${r.stderr}` }
}

describe('verify-release-live: a malformed credential is UNVERIFIED, never "broken", and never green', () => {
  it('play-track exposes its failure class to the Summary', () => {
    expect(job('play-track').outputs?.['failure-class']).toBe('${{ steps.query.outputs.failure-class }}')
    const query = job('play-track').steps.find((s) => s.id === 'query')
    expect(query?.run).toContain('failure-class=credential')
  })

  it('a credential failure fails the aggregate as NOT VERIFIED, not as BROKEN', () => {
    const r = runSummary({
      'desktop-installer': { result: 'success' },
      'play-track': { result: 'failure', outputs: { 'failure-class': 'credential' } },
    })
    expect(r.status).toBe(1)
    expect(r.out).toContain('NOT VERIFIED')
    expect(r.out).toContain('play-track')
    expect(r.out).not.toContain('BROKEN')
  })

  it('any other failure is still BROKEN', () => {
    const r = runSummary({
      'desktop-installer': { result: 'success' },
      'play-track': { result: 'failure', outputs: {} },
    })
    expect(r.status).toBe(1)
    expect(r.out).toContain('BROKEN: play-track=failure')
    expect(r.out).not.toContain('NOT VERIFIED')
  })

  it('both classes are reported side by side when both happen', () => {
    const r = runSummary({
      'play-track': { result: 'failure', outputs: { 'failure-class': 'credential' } },
      'container-image': { result: 'failure', outputs: {} },
    })
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/NOT VERIFIED[^\n]*play-track/)
    expect(r.out).toContain('BROKEN: container-image=failure')
  })

  // MUTATION: the class only downgrades the LABEL. A `credential` class on a
  // job that did not fail (it cannot happen, but a broken wiring could make it
  // look that way) must not turn a cancelled run into anything but a failure.
  it('MUTATION: a cancelled surface carrying the credential class is still BROKEN', () => {
    const r = runSummary({
      'play-track': { result: 'skipped', outputs: { 'failure-class': 'credential' } },
    })
    expect(r.status).toBe(1)
    expect(r.out).toContain('BROKEN: play-track=skipped')
  })

  it('all required surfaces green is the only way to exit 0', () => {
    const r = runSummary({
      'desktop-installer': { result: 'success' },
      'play-track': { result: 'success' },
      'container-image': { result: 'success' },
    })
    expect(r.status).toBe(0)
    expect(r.out).toContain('3 required surface(s) verified live')
  })
})

describe('verify-release-live container-image surface: one address, and private told apart from missing', () => {
  const run = job('container-image').steps.map((s) => s.run ?? '').join('\n')

  it('probes the address docker-stable publishes to, computed from the repository — not a second copy read from the site', () => {
    expect(run).toContain('IMAGE_PATH="${REPO,,}"')
    expect(run).not.toContain('site/src/config.ts')
  })

  it('names "private" and "never published" as different causes', () => {
    expect(run).toMatch(/UNAUTHORIZED\)[\s\S]*PRIVATE/)
    expect(run).toMatch(/DENIED\)[\s\S]*never published/)
  })
})
