import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  WORKFLOWS_DIR, loadWorkflow, getJob, getStep, resolveEnv, resolveExpressions, runShellStep,
} from './helpers/workflow-shell'

/**
 * Rail for #2094: knope rewrites the `release` PR on every merge to main
 * (16 times in one day), and its diff — version lines plus a changelog —
 * used to switch on twenty CI jobs. `changes` now classifies such a diff as
 * an empty change set, but ONLY after is-release-bump.sh has inspected the
 * diff's content: the branch name alone must never buy a narrowed gate.
 *
 * Runs ci.yml's real `Detect changes` step (parsed from the workflow, never
 * a hand-copied string) against scratch repos shaped like a release PR and
 * like each way a `release` branch could carry something else.
 */

const SCRIPTS = ['.github/scripts/detect-changed-platforms.sh', '.github/scripts/is-release-bump.sh', 'knope.toml']

const BASE_FILES: Record<string, string> = {
  'package.json': '{\n  "name": "x",\n  "version": "1.0.0"\n}\n',
  'apps/desktop/Cargo.lock':
    '[[package]]\nname = "llamenos-desktop"\nversion = "1.0.0"\n\n[[package]]\nname = "serde"\nversion = "1.0.0"\n',
  'apps/android/app/build.gradle.kts': '        versionName = "1.0.0"\n',
  'CHANGELOG.md': '# Changelog\n',
  'apps/worker/app.ts': 'export const app = 1\n',
}

/** What `knope prepare-release` does to the base tree. */
const KNOPE_BUMP: Record<string, string> = {
  'package.json': '{\n  "name": "x",\n  "version": "1.0.1"\n}\n',
  'apps/desktop/Cargo.lock':
    '[[package]]\nname = "llamenos-desktop"\nversion = "1.0.1"\n\n[[package]]\nname = "serde"\nversion = "1.0.0"\n',
  'apps/android/app/build.gradle.kts': '        versionName = "1.0.1"\n',
  'CHANGELOG.md': '# Changelog\n\n## 1.0.1\n\n- a fix\n',
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'rail', GIT_AUTHOR_EMAIL: 'rail@example.invalid',
      GIT_COMMITTER_NAME: 'rail', GIT_COMMITTER_EMAIL: 'rail@example.invalid',
    },
  }).trim()
}

function write(dir: string, files: Record<string, string>): void {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), body)
  }
}

function commitAll(dir: string, message: string): string {
  git(dir, 'add', '--all')
  git(dir, 'commit', '--quiet', '-m', message)
  return git(dir, 'rev-parse', 'HEAD')
}

interface Scratch { dir: string; originDir: string; base: string }
let scratch: Scratch

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'release-bump-'))
  git(dir, 'init', '--quiet', '--initial-branch=main')
  // The scripts live in the base commit, so no PR diff ever contains them.
  for (const f of SCRIPTS) {
    mkdirSync(join(dir, dirname(f)), { recursive: true })
    copyFileSync(join(process.cwd(), f), join(dir, f))
  }
  write(dir, BASE_FILES)
  const base = commitAll(dir, 'base')
  const originDir = `${dir}-origin`
  git(dir, 'clone', '--bare', '--quiet', '.', originDir)
  git(dir, 'remote', 'add', 'origin', originDir)
  scratch = { dir, originDir, base }
})
afterAll(() => {
  rmSync(scratch.dir, { recursive: true, force: true })
  rmSync(scratch.originDir, { recursive: true, force: true })
})

/** Commits `files` on a branch off base and returns its head. */
function branch(name: string, files: Record<string, string>): string {
  git(scratch.dir, 'checkout', '--quiet', '--detach', scratch.base)
  write(scratch.dir, files)
  const head = commitAll(scratch.dir, name)
  git(scratch.dir, 'checkout', '--quiet', '--detach', scratch.base)
  return head
}

interface Shape { headRef?: string; headRepo?: string; event?: 'pull_request' | 'merge_group' }

function detect(head: string, { headRef = 'release', headRepo = 'org/repo', event = 'pull_request' }: Shape = {}) {
  const step = getStep(getJob(loadWorkflow('ci.yml'), 'changes'), 'Detect changes')
  if (typeof step.run !== 'string') throw new Error('Detect changes has no run: block')
  git(scratch.dir, 'checkout', '--quiet', '--detach', head)
  const fixtures = {
    'github.event_name': event,
    'github.event.pull_request.base.sha': event === 'pull_request' ? scratch.base : '',
    'github.event.pull_request.head.sha': event === 'pull_request' ? head : '',
    'github.head_ref': headRef,
    'github.event.pull_request.head.repo.full_name': headRepo,
    'github.repository': 'org/repo',
    'github.event.merge_group.base_sha': event === 'merge_group' ? scratch.base : '',
    'github.event.merge_group.head_sha': event === 'merge_group' ? head : '',
    'github.event.merge_group.base_ref': event === 'merge_group' ? 'refs/heads/main' : '',
    'github.event.before': '',
    'github.event.after': '',
  }
  const script = resolveExpressions(step.run, fixtures, 'ci.yml changes/"Detect changes"')
  const result = runShellStep(script, resolveEnv(step.env, fixtures), scratch.dir)
  expect(result.status, `step exited ${result.status}: ${result.stderr}`).toBe(0)
  return result.outputs
}

describe('ci.yml changes — knope release PR narrowing (#2094)', () => {
  it('a pure knope bump schedules nothing', () => {
    const o = detect(branch('bump', KNOPE_BUMP))
    expect(o['release_only']).toBe('true')
    for (const flag of ['android', 'ios', 'desktop', 'backend', 'crypto', 'ansible', 'audit', 'orchestrator']) {
      expect(o[flag], `${flag} must be off for a release bump`).toBe('false')
    }
    expect(o['docs_only']).toBe('true')
  })

  it('a bump that also touches real code runs the full matrix', () => {
    const o = detect(branch('bump+code', { ...KNOPE_BUMP, 'apps/worker/app.ts': 'export const app = 2\n' }))
    expect(o['release_only']).toBe('false')
    expect(o['backend']).toBe('true')
  })

  it('a versioned file changed beyond its one version line is not a bump', () => {
    const o = detect(branch('extra-line', {
      ...KNOPE_BUMP,
      'package.json': '{\n  "name": "x",\n  "version": "1.0.1",\n  "scripts": {"postinstall": "evil"}\n}\n',
    }))
    expect(o['release_only']).toBe('false')
    expect(o['backend']).toBe('true')
  })

  it('a dependency version bump in Cargo.lock is not the desktop package', () => {
    const o = detect(branch('dep-bump', {
      ...KNOPE_BUMP,
      'apps/desktop/Cargo.lock':
        '[[package]]\nname = "llamenos-desktop"\nversion = "1.0.1"\n\n[[package]]\nname = "serde"\nversion = "1.0.9"\n',
    }))
    expect(o['release_only']).toBe('false')
  })

  it('a bump diff on a branch not named release gets no narrowing', () => {
    const head = branch('bump-other-name', KNOPE_BUMP)
    expect(detect(head, { headRef: 'feature/not-release' })['release_only']).toBe('false')
  })

  it('a fork branch named release gets no narrowing', () => {
    const head = branch('bump-fork', KNOPE_BUMP)
    expect(detect(head, { headRepo: 'attacker/repo' })['release_only']).toBe('false')
  })

  it('merge_group never narrows, even over a pure bump', () => {
    const o = detect(branch('bump-queue', KNOPE_BUMP), { event: 'merge_group', headRef: '' })
    expect(o['release_only']).toBe('false')
    expect(o['android'], 'the queue must still run the suites the diff earns').toBe('true')
  })
})

describe('ci.yml — release_only feeds only the ungated guards, never ci-status', () => {
  const wf = loadWorkflow('ci.yml')
  const jobs = wf['jobs'] as Record<string, { if?: string; needs?: string | string[] }>

  it('ci-status itself is never conditionally skipped on release_only', () => {
    const status = jobs['ci-status']!
    expect(status.if).toBe('always()')
  })

  it.each(['no-generated-files-in-git', 'verify-updater-config', 'build', 'lint', 'docs-guard'])(
    '%s skips on release_only but still runs when `changes` fails',
    (name) => {
      const cond = jobs[name]!.if ?? ''
      expect(cond).toContain("needs.changes.outputs.release_only != 'true'")
      expect(cond).toContain('!cancelled()')
    },
  )
})

describe('every workflow — superseded PR runs cancel, merge_group runs never do (#2094)', () => {
  const files = readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('.yml'))
  const loaded = files.map((file) => {
    const doc = loadWorkflow(file) as unknown as {
      on?: Record<string, unknown> | string | string[]
      true?: Record<string, unknown>
      concurrency?: { group?: string; 'cancel-in-progress'?: boolean | string }
    }
    // YAML 1.1 parses a bare `on:` key as boolean true.
    const on = doc.on ?? doc.true ?? {}
    const triggers = typeof on === 'string' ? [on] : Array.isArray(on) ? on : Object.keys(on)
    return { file, triggers, concurrency: doc.concurrency }
  })

  it('finds the workflows — a vacuous directory scan must not pass', () => {
    expect(loaded.length).toBeGreaterThan(20)
    expect(loaded.filter((w) => w.triggers.includes('merge_group')).length).toBeGreaterThan(3)
  })

  it.each(loaded.filter((w) => w.triggers.includes('pull_request')))(
    '$file groups its pull_request runs so a re-push can supersede them',
    ({ concurrency }) => {
      expect(concurrency?.group, 'a PR-triggered workflow without a workflow-level concurrency group never cancels').toBeTruthy()
    },
  )

  it.each(loaded.filter((w) => w.triggers.includes('merge_group') && w.concurrency))(
    '$file cannot cancel a merge_group run',
    ({ concurrency }) => {
      const cancel = concurrency?.['cancel-in-progress']
      const safe =
        cancel === false ||
        cancel === 'false' ||
        (typeof cancel === 'string' && /^\$\{\{\s*github\.event_name == 'pull_request'\s*\}\}$/.test(cancel))
      expect(safe, `cancel-in-progress is ${String(cancel)} — a cancelled queue check ejects the entry`).toBe(true)
    },
  )
})
