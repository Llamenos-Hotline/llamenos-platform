import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

/**
 * Rail for #1229: v0.19.17 .. v0.19.19 each published exactly eight assets —
 * CHECKSUMS.txt, provenance.json, sbom.cdx.json and their signatures — and not
 * one installer. The pipeline reported success while producing nothing a person
 * could run, and the signed CHECKSUMS.txt listed the web bundle's files, none of
 * which were attached to the release.
 *
 * Cause: release.yml published `v<version>` (immutable once public) BEFORE the
 * desktop/Android builds ran, so the installers could not be attached to it.
 * The release is now held as a draft until the installers are on it, and the
 * "Assert the release is complete" step refuses to let an incomplete one out.
 *
 * Like release-signing-step.test.ts this is a functional test: it parses the
 * step's real `run:` script out of release.yml and executes it with `bash -e`
 * against fixture release directories. Every "must fail" case is a MUTATION of
 * the passing fixture, so a guard that merely always fails (or always passes)
 * cannot satisfy this file.
 */

const WORKFLOWS = join(process.cwd(), '.github', 'workflows')
const RELEASE_YML = join(WORKFLOWS, 'release.yml')
const GUARD_STEP = 'Assert the release is complete'

interface WorkflowStep {
  name?: string
  run?: string
  uses?: string
  env?: Record<string, string>
}
interface WorkflowJob {
  needs?: string | string[]
  uses?: string
  with?: Record<string, string>
  steps?: WorkflowStep[]
}
interface WorkflowDoc {
  jobs: Record<string, WorkflowJob>
}

function loadRelease(): WorkflowDoc {
  return parseYaml(readFileSync(RELEASE_YML, 'utf8')) as WorkflowDoc
}

function releaseJob(doc = loadRelease()): WorkflowJob {
  const job = doc.jobs['release']
  if (!job?.steps) throw new Error('no "release" job with steps in release.yml — the parser must not pass vacuously')
  return job
}

function guardScript(): string {
  const step = releaseJob().steps!.find((s) => s.name === GUARD_STEP)
  if (!step || typeof step.run !== 'string') throw new Error(`no "${GUARD_STEP}" step with a run: block`)
  return step.run
}

/** The names the guard requires, read from the guard itself so this file can never drift from it. */
function requiredNames(): string[] {
  const block = /REQUIRED="([^"]*)"/.exec(guardScript())
  if (!block?.[1]) throw new Error('could not find the REQUIRED="…" list in the guard')
  return block[1].split(/\s+/).filter(Boolean)
}

const sha256 = (data: string) => createHash('sha256').update(data).digest('hex')

let scratch: string
let dir: string

/** A complete release: every required file (with distinct bytes), the optional
 *  .asc and macOS dmg, and a CHECKSUMS.txt that covers everything it can. */
function writeCompleteRelease(): Record<string, string> {
  const SEALS = new Set([
    'CHECKSUMS.txt',
    'CHECKSUMS.txt.asc',
    'CHECKSUMS.txt.cosign.sig',
    'CHECKSUMS.txt.cosign.pem',
    'provenance.json.cosign.sig',
    'provenance.json.cosign.pem',
    'sbom.cdx.json.att',
  ])
  const files: Record<string, string> = {}
  for (const name of requiredNames()) files[name] = `bytes of ${name}`
  files['llamenos-macos-universal.dmg'] = 'bytes of the dmg'
  files['CHECKSUMS.txt.asc'] = 'gpg'
  const manifest = Object.entries(files)
    .filter(([name]) => !SEALS.has(name))
    .map(([name, body]) => `${sha256(body)}  ${name}`)
    .sort()
    .join('\n')
  files['CHECKSUMS.txt'] = `${manifest}\n`
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
  return files
}

function runGuard(): { status: number | null; output: string } {
  const scriptPath = join(scratch, 'guard.sh')
  writeFileSync(scriptPath, guardScript())
  const r = spawnSync('bash', ['-e', scriptPath], {
    cwd: scratch,
    encoding: 'utf8',
    env: { ...process.env, ASSET_DIR: 'release', NEW_VERSION: '9.9.9' },
  })
  return { status: r.status, output: `${r.stdout}\n${r.stderr}` }
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'llamenos-release-guard-'))
  dir = join(scratch, 'release')
  mkdirSync(dir)
})
afterEach(() => rmSync(scratch, { recursive: true, force: true }))

describe('rail: a release that ships no installable artifact must fail (#1229)', () => {
  it('finds a non-trivial guard with real required names — the parser must not pass vacuously', () => {
    expect(guardScript().length).toBeGreaterThan(500)
    const names = requiredNames()
    expect(names).toContain('llamenos-android.apk')
    expect(names).toContain('llamenos-linux-x86_64.AppImage')
    expect(names).toContain('llamenos-windows-x64.msi')
    expect(names).toContain('CHECKSUMS.txt')
  })

  it('passes a complete release (including an attached macOS dmg and a GPG signature)', () => {
    writeCompleteRelease()
    const { status, output } = runGuard()
    expect(output).toContain('is complete')
    expect(status).toBe(0)
  })

  it('REGRESSION: a successful match must not fail the pipeline when the manifest is larger than a pipe buffer (SIGPIPE under pipefail)', () => {
    // `printf '%s\n' "$listed" | grep -qxF` under `set -o pipefail`: grep -q exits
    // on the first match, printf then dies of SIGPIPE on the unwritten remainder,
    // and pipefail reports the pipeline as failed although the match SUCCEEDED.
    // Whether it trips depends on how much is left to write, so the manifest is
    // made larger than a 64 KiB pipe buffer (~120 KiB here) — the failure is
    // then a certainty rather than a race against the scheduler.
    const files = writeCompleteRelease()
    const filler = Object.fromEntries(
      Array.from({ length: 480 }, (_, i) => [`filler-${String(i).padStart(5, '0')}-${'x'.repeat(230)}.bin`, `filler ${i}`]),
    )
    for (const [name, body] of Object.entries(filler)) writeFileSync(join(dir, name), body)
    const covered = Object.entries(filler).map(([name, body]) => `${sha256(body)}  ${name}\n`)
    writeFileSync(join(dir, 'CHECKSUMS.txt'), `${files['CHECKSUMS.txt']}${covered.join('')}`)
    const { status, output } = runGuard()
    expect(output).not.toContain('is published but not covered by CHECKSUMS.txt')
    expect(output).toContain('is complete')
    expect(status).toBe(0)
  }, 30_000)

  it('REGRESSION: the exact v0.19.19 shape — eight metadata assets, a manifest of web-bundle files — fails', () => {
    for (const name of [
      'CHECKSUMS.txt.cosign.pem',
      'CHECKSUMS.txt.cosign.sig',
      'provenance.json',
      'provenance.json.cosign.pem',
      'provenance.json.cosign.sig',
      'sbom.cdx.json',
      'sbom.cdx.json.att',
    ]) {
      writeFileSync(join(dir, name), `bytes of ${name}`)
    }
    // What CHECKSUMS.txt actually contained: files under client/ that were never uploaded.
    writeFileSync(
      join(dir, 'CHECKSUMS.txt'),
      `${sha256('a')}  client/assets/uk-C-k8heMy.js\n${sha256('b')}  bun.lockb\n`,
    )
    const { status, output } = runGuard()
    expect(status).toBe(1)
    expect(output).toContain('required asset llamenos-linux-x86_64.AppImage is missing')
    expect(output).toContain('required asset llamenos-android.apk is missing')
    expect(output).toContain('CHECKSUMS.txt lists files that are absent or whose SHA-256 does not match')
  })

  it('MUTATION: removing any single required file fails the release and names it', () => {
    for (const victim of requiredNames()) {
      rmSync(scratch, { recursive: true, force: true })
      scratch = mkdtempSync(join(tmpdir(), 'llamenos-release-guard-'))
      dir = join(scratch, 'release')
      mkdirSync(dir)
      const files = writeCompleteRelease()
      rmSync(join(dir, victim))
      const { status, output } = runGuard()
      expect(status, `release without ${victim} must fail`).toBe(1)
      expect(output).toContain(`${victim} is missing`)
      expect(files[victim]).toBeDefined()
    }
  })

  it('MUTATION: an empty installer fails', () => {
    writeCompleteRelease()
    writeFileSync(join(dir, 'llamenos-android.apk'), '')
    const { status, output } = runGuard()
    expect(status).toBe(1)
    expect(output).toContain('required asset llamenos-android.apk is empty')
  })

  it('MUTATION: an attached file CHECKSUMS.txt does not cover fails (a manifest that omits artifacts is worse than none)', () => {
    writeCompleteRelease()
    writeFileSync(join(dir, 'llamenos-macos-arm64.dmg'), 'extra')
    const { status, output } = runGuard()
    expect(status).toBe(1)
    expect(output).toContain('llamenos-macos-arm64.dmg is published but not covered by CHECKSUMS.txt')
  })

  it('MUTATION: an installer whose bytes differ from the manifest fails', () => {
    writeCompleteRelease()
    writeFileSync(join(dir, 'llamenos-windows-x64.msi'), 'tampered')
    const { status, output } = runGuard()
    expect(status).toBe(1)
    expect(output).toContain('SHA-256 does not match')
  })

  it('MUTATION: a manifest line for a file that is not attached fails', () => {
    const files = writeCompleteRelease()
    writeFileSync(join(dir, 'CHECKSUMS.txt'), `${files['CHECKSUMS.txt']}${sha256('ghost')}  ghost-installer.exe\n`)
    const { status, output } = runGuard()
    expect(status).toBe(1)
    expect(output).toContain('absent or whose SHA-256 does not match')
  })

  it('MUTATION: an empty CHECKSUMS.txt fails', () => {
    writeCompleteRelease()
    writeFileSync(join(dir, 'CHECKSUMS.txt'), '')
    const { status } = runGuard()
    expect(status).toBe(1)
  })
})

describe('rail: the release is only published after the installers are attached and the guard has passed', () => {
  const needsOf = (j: WorkflowJob) => (j.needs === undefined ? [] : Array.isArray(j.needs) ? j.needs : [j.needs])

  it('the `release` job waits for the draft, the desktop build and the Android build', () => {
    const needs = needsOf(releaseJob())
    for (const n of ['draft', 'desktop', 'android']) expect(needs).toContain(n)
  })

  it('desktop and android are CALLED (so release can wait on them) with the draft tag as release-tag', () => {
    const doc = loadRelease()
    expect(doc.jobs['desktop']?.uses).toBe('./.github/workflows/tauri-release.yml')
    expect(doc.jobs['android']?.uses).toBe('./.github/workflows/mobile-release.yml')
    for (const n of ['desktop', 'android']) {
      expect(doc.jobs[n]?.with?.['release-tag'], `${n} must be handed the v<version> draft`).toBe(
        'v${{ needs.check.outputs.version }}',
      )
    }
    expect(doc.jobs['android']?.with?.['platform']).toBe('android')
  })

  it('the version tag is created as a DRAFT, and only the `release` job ever makes it public', () => {
    const doc = loadRelease()
    const drafts: string[] = []
    const publishers: string[] = []
    for (const [name, job] of Object.entries(doc.jobs)) {
      for (const step of job.steps ?? []) {
        if (/gh release create/.test(step.run ?? '') && /--draft/.test(step.run ?? '')) drafts.push(name)
        if (/--draft=false/.test(step.run ?? '')) publishers.push(name)
      }
    }
    expect(drafts).toEqual(['draft'])
    expect(publishers).toEqual(['release'])
  })

  it('"Publish release" comes after the guard, and nothing between them can skip the guard', () => {
    const steps = releaseJob().steps!
    const names = steps.map((s) => s.name)
    const guard = names.indexOf(GUARD_STEP)
    const publish = names.indexOf('Publish release')
    expect(guard).toBeGreaterThan(-1)
    expect(publish).toBeGreaterThan(guard)
    for (const s of steps.slice(guard, publish + 1)) {
      expect((s as { 'continue-on-error'?: boolean })['continue-on-error']).not.toBe(true)
      expect((s as { if?: string }).if, `step "${s.name}" must not be conditional`).toBeUndefined()
    }
  })

  it('the guard judges the draft as it will land (a fresh download), not local copies', () => {
    const step = releaseJob().steps!.find((s) => s.name === GUARD_STEP)
    expect(step?.env?.['ASSET_DIR']).toBe('published-view')
    const run = releaseJob().steps!.find((s) => s.name === 'Re-download the draft as it will be published')?.run ?? ''
    expect(run).toContain('gh release download')
  })

  it('CHECKSUMS.txt is computed from the release assets, not from the web bundle', () => {
    const run = releaseJob().steps!.find((s) => s.name === 'Compute CHECKSUMS.txt over every published file')?.run ?? ''
    expect(run).toContain('release-assets')
    expect(run).not.toMatch(/dist\b/)
    expect(run).not.toContain('bun.lockb')
  })
})

describe('rail: every alias the guard requires is actually produced by a build workflow', () => {
  it('each required installer name appears literally in the workflow that creates it', () => {
    const tauri = readFileSync(join(WORKFLOWS, 'tauri-release.yml'), 'utf8')
    const mobile = readFileSync(join(WORKFLOWS, 'mobile-release.yml'), 'utf8')
    const installers = requiredNames().filter((n) => n.startsWith('llamenos-'))
    expect(installers.length).toBeGreaterThanOrEqual(10)
    for (const name of installers) {
      const haystack = name.endsWith('.apk') ? mobile : tauri
      expect(haystack, `no workflow produces the required alias ${name}`).toContain(name)
    }
  })

  it('both build workflows can be called and attach aliases only when handed a release-tag', () => {
    for (const f of ['tauri-release.yml', 'mobile-release.yml']) {
      const doc = parseYaml(readFileSync(join(WORKFLOWS, f), 'utf8')) as { on: Record<string, unknown> }
      expect(doc.on['workflow_call'], `${f} must declare workflow_call`).toBeDefined()
      expect(doc.on['workflow_dispatch'], `${f} must stay manually dispatchable`).toBeDefined()
      expect(readFileSync(join(WORKFLOWS, f), 'utf8')).toContain('if [ -n "${RELEASE_TAG:-}" ]')
    }
  })

  it('no workflow submits to an app store (publishing stays local-only)', () => {
    for (const f of ['release.yml', 'tauri-release.yml', 'mobile-release.yml']) {
      const text = readFileSync(join(WORKFLOWS, f), 'utf8')
        .split('\n')
        .filter((l) => !l.trim().startsWith('#'))
        .join('\n')
      expect(text, `${f} must not run fastlane or upload to a store`).not.toMatch(
        /fastlane\s+(deliver|supply|pilot|upload)|upload_to_(play_store|testflight)|altool|notarytool\s+submit\s+.*testflight/i,
      )
    }
  })
})
