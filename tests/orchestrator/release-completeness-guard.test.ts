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

// ── Following the indirection through scripts/release/release-assets.sh ──────
// The workflows no longer say `gh release …`: every create/upload/download/publish
// is a call into the sourced helper. These read the helper's own function bodies
// and call graph, so the rails below judge what a call DOES, not what it is named.

const HELPER = join(process.cwd(), 'scripts', 'release', 'release-assets.sh')

/** Shell without comments and echo lines (prose there is not behaviour). */
const code = (run: string) =>
  run
    .split('\n')
    .filter((l) => !/^\s*#/.test(l) && !/^\s*echo /.test(l))
    .join('\n')

/** name -> body for every top-level function in the helper, one-liners included. */
function helperFunctions(): Map<string, string> {
  const src = readFileSync(HELPER, 'utf8')
  const fns = new Map<string, string>()
  const oneLine = /^([A-Za-z_][A-Za-z0-9_]*)\(\) \{(.*)\}\s*(?:#.*)?$/
  const opener = /^([A-Za-z_][A-Za-z0-9_]*)\(\) \{/
  const lines = src.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const one = oneLine.exec(lines[i]!)
    if (one) {
      fns.set(one[1]!, code(one[2]!))
      continue
    }
    const open = opener.exec(lines[i]!)
    if (!open) continue
    const end = lines.findIndex((l, j) => j > i && l === '}')
    if (end < 0) throw new Error(`helper function ${open[1]} has no closing brace`)
    fns.set(open[1]!, code(lines.slice(i + 1, end).join('\n')))
    i = end
  }
  const declared = src.match(/^[A-Za-z_][A-Za-z0-9_]*\(\) \{/gm)?.length ?? 0
  if (fns.size !== declared || fns.size < 10 || !fns.has('ra_publish') || !fns.has('ra_create_draft') || !fns.has('ra_download')) {
    throw new Error(`parsed ${fns.size} of ${declared} helper functions — the parser must not pass vacuously`)
  }
  return fns
}

/** <fn> and every helper function it reaches. */
function helperClosure(fn: string): string[] {
  const fns = helperFunctions()
  const seen = new Set<string>()
  const walk = (f: string) => {
    if (seen.has(f)) return
    seen.add(f)
    for (const other of fns.keys()) if (other !== f && new RegExp(`\\b${other}\\b`).test(fns.get(f)!)) walk(other)
  }
  walk(fn)
  return [...seen].sort()
}

/** Anything that turns a release public: the REST field (jq or quoted JSON), gh's flag, or gh api's -F form. */
const PUBLISH_WRITE = /\bdraft\\?"?\s*[:=]\s*false\b/

/** Every helper function that can reach a publish write. */
function publishFunctions(): string[] {
  const fns = helperFunctions()
  return [...fns.keys()].filter((f) => helperClosure(f).some((g) => PUBLISH_WRITE.test(fns.get(g)!))).sort()
}

const callsAny = (run: string, fns: string[]) => fns.some((f) => new RegExp(`\\b${f}\\b`).test(code(run)))

function publishes(run: string): boolean {
  return PUBLISH_WRITE.test(code(run)) || callsAny(run, publishFunctions())
}

function createsDraft(run: string): boolean {
  const c = code(run)
  return (/gh release create/.test(c) && /--draft/.test(c)) || callsAny(run, ['ra_create_draft'])
}

const PUBLISH_OR_CREATE_CALL = /\b(ra_publish|ra_create_draft)\b[^\n|;&]*/g

/** Source the helper with its network-facing internals replaced, and run <script>. */
function withHelper(script: string): string {
  const r = spawnSync('bash', ['-c', `set -euo pipefail\nsource "$HELPER"\n${script}`], {
    cwd: scratch,
    encoding: 'utf8',
    env: { ...process.env, HELPER, GH_TOKEN: 'x', GITHUB_REPOSITORY: 'o/r' },
  })
  if (r.status !== 0) throw new Error(`helper probe failed (${r.status}): ${r.stderr}`)
  return r.stdout
}

/** The JSON ra_create_draft would POST. */
function createPayload(): { draft?: unknown } {
  writeFileSync(join(scratch, 'notes.md'), 'notes')
  const out = withHelper(`
    ra_published_url() { :; }
    ra_retry() { shift; "$@"; }
    _ra_create_once() { cat "$2"; }
    ra_create_draft v9.9.9 "v9.9.9 API" notes.md "" false`)
  return JSON.parse(out) as { draft?: unknown }
}

/** What ra_download's per-attempt worker finds in the target dir: '' = fresh. */
function downloadSeesFreshDir(): string {
  mkdirSync(join(scratch, 'view'), { recursive: true })
  writeFileSync(join(scratch, 'view', 'llamenos-android.apk'), 'a LOCAL copy that must not be judged')
  return withHelper(`
    ra_retry() { shift; "$@"; }
    _ra_download_once() { [ -d "$2" ] || { echo "no dir"; return 1; }; ls -A "$2"; }
    ra_download v9.9.9 view`)
}

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
    // The helper's own semantics first: a call site is only evidence if the
    // function it calls does what its name says.
    expect(createPayload().draft, 'ra_create_draft must POST draft: true').toBe(true)
    // Every helper route to `draft: false`, followed through the helper's own call
    // graph. Exact, so a new publish route must be taught to this rail.
    expect(publishFunctions()).toEqual(['_ra_publish_once', 'ra_publish'])
    expect(helperClosure('ra_create_draft').some((f) => PUBLISH_WRITE.test(helperFunctions().get(f)!))).toBe(false)

    const doc = loadRelease()
    const drafts: string[] = []
    const publishers: string[] = []
    for (const [name, job] of Object.entries(doc.jobs)) {
      for (const step of job.steps ?? []) {
        if (createsDraft(step.run ?? '')) drafts.push(name)
        if (publishes(step.run ?? '')) publishers.push(name)
      }
    }
    expect(drafts).toEqual(['draft'])
    expect(publishers).toEqual(['release'])

    // ... and they act on the version tag itself.
    const createStep = doc.jobs['draft']!.steps!.find((s) => createsDraft(s.run ?? ''))!
    expect(code(createStep.run!)).toMatch(/\bra_create_draft "v\$\{NEW_VERSION\}" /)
    const publishSteps = releaseJob(doc).steps!.filter((s) => publishes(s.run ?? ''))
    expect(publishSteps.map((s) => s.name)).toEqual(['Publish release'])
    expect(code(publishSteps[0]!.run!)).toMatch(/\bra_publish "v\$\{NEW_VERSION\}" true\b/)
  })

  it('the called build workflows publish only their own per-platform tag, never the v<version> draft', () => {
    // desktop/android run inside the release: if either could publish
    // RELEASE_TAG, `v<version>` would go public before the guard ran.
    for (const f of ['tauri-release.yml', 'mobile-release.yml']) {
      const doc = parseYaml(readFileSync(join(WORKFLOWS, f), 'utf8')) as WorkflowDoc
      const calls: string[] = []
      for (const job of Object.values(doc.jobs)) {
        for (const step of job.steps ?? []) {
          const c = code(step.run ?? '')
          for (const m of c.matchAll(PUBLISH_OR_CREATE_CALL)) calls.push(m[0])
          expect(c, `${f} step "${step.name}" must not publish with a bare gh call`).not.toMatch(PUBLISH_WRITE)
          for (const m of c.matchAll(/^\s*TAG=(.*)$/gm)) {
            expect(m[1], `${f} step "${step.name}" assigns TAG`).toMatch(/^"v\$\{[A-Z_]+\}-(desktop|android|ios)"$/)
          }
        }
      }
      expect(calls.length, `${f} must still create and publish its own release`).toBeGreaterThan(0)
      for (const c of calls) expect(c, `${f}: ${c}`).toMatch(/^(ra_publish|ra_create_draft) "\$TAG"/)
    }
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
    const steps = releaseJob().steps!
    const guardIdx = steps.findIndex((s) => s.name === GUARD_STEP)
    const view = steps[guardIdx]?.env?.['ASSET_DIR']
    expect(view).toBe('published-view')

    // The view is downloaded from the draft by the helper, into ASSET_DIR ...
    const dl = steps.findIndex((s) => s.name === 'Re-download the draft as it will be published')
    expect(dl).toBeGreaterThan(-1)
    expect(code(steps[dl]!.run ?? '')).toMatch(new RegExp(`\\bra_download "v\\$\\{NEW_VERSION\\}" ${view}\\b`))
    // ... and ra_download starts from an EMPTY directory, so nothing local survives into it.
    expect(downloadSeesFreshDir()).toBe('')

    // ... after the last thing attached to the draft, before the guard, and
    // nothing in between writes to the view.
    const lastUpload = steps.map((s) => /\bra_upload\b/.test(code(s.run ?? ''))).lastIndexOf(true)
    expect(lastUpload).toBeGreaterThan(-1)
    expect(dl).toBeGreaterThan(lastUpload)
    expect(guardIdx).toBeGreaterThan(dl)
    for (const s of steps.slice(dl + 1, guardIdx)) {
      expect(s.run ?? '', `step "${s.name}" must not touch ${view}`).not.toContain(view!)
    }
    // The guard reads only the view: it neither downloads nor reads the local copies.
    const guard = code(guardScript())
    expect(guard).toContain('cd "$ASSET_DIR"')
    expect(guard).not.toMatch(/release-assets|\bra_[a-z_]+\b|gh release/)
    // And publish is still the step after it (see the ordering test above).
    expect(steps.findIndex((s) => publishes(s.run ?? ''))).toBeGreaterThan(guardIdx)
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
