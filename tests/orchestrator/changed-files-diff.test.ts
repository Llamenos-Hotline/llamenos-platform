import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  loadWorkflow, getJob, getStep, resolveEnv, resolveExpressions, runShellStep,
} from './helpers/workflow-shell'

/**
 * Rail for #1396: on `pull_request`, every "which files did this change
 * touch" step diffed `base.sha` against `head.sha` two-dot. `base.sha` is the
 * base branch's tip NOW, not the PR's fork point, so a branch sitting behind
 * `main` also got every file `main` changed since the fork — `lint` failed
 * #1392 on 43 files it never touched, and the `changes` steps switched on
 * platform jobs (including the scarce macOS iOS e2e) for code the PR never
 * touched either.
 *
 * Runs each step's real `run:` block — parsed from the workflow, never a
 * hand-copied string — against a scratch repo shaped exactly like the
 * failure: `main` has moved on since the PR forked, touching files the PR
 * did not. The checkout is the same synthetic merge commit actions/checkout
 * produces for a PR. The `merge_group` and `push` cases pin the two events
 * that must stay two-dot: their base is a direct ancestor of their head, so
 * the diff already is exactly the change under test.
 */

// The PR changes one lintable file and one Android file; `main`, after the
// fork, changes a different lintable file and an iOS file.
const PR_LINTABLE = 'src/client/pr-only.ts'
const PR_PLATFORM_FILE = 'apps/android/PrOnly.kt'
const MAIN_LINTABLE = 'src/client/main-only.ts'
const MAIN_PLATFORM_FILE = 'apps/ios/MainOnly.swift'

interface Repo {
  dir: string
  fork: string
  base: string
  prHead: string
  queueHead: string
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

function write(dir: string, path: string, body: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true })
  writeFileSync(join(dir, path), body)
}

function commitAll(dir: string, message: string): string {
  git(dir, 'add', '--all')
  git(dir, 'commit', '--quiet', '-m', message)
  return git(dir, 'rev-parse', 'HEAD')
}

function buildRepo(): Repo {
  const dir = mkdtempSync(join(tmpdir(), 'changed-files-diff-'))
  git(dir, 'init', '--quiet', '--initial-branch=main')
  for (const f of [PR_LINTABLE, PR_PLATFORM_FILE, MAIN_LINTABLE, MAIN_PLATFORM_FILE]) write(dir, f, 'v1\n')
  const fork = commitAll(dir, 'fork point')

  git(dir, 'checkout', '--quiet', '-b', 'pr')
  write(dir, PR_LINTABLE, 'pr\n')
  write(dir, PR_PLATFORM_FILE, 'pr\n')
  const prHead = commitAll(dir, 'the PR')

  git(dir, 'checkout', '--quiet', 'main')
  write(dir, MAIN_LINTABLE, 'main moved on\n')
  write(dir, MAIN_PLATFORM_FILE, 'main moved on\n')
  const base = commitAll(dir, 'main moves on after the fork')

  // The merge queue's own commit: the PR squashed onto the queue base.
  git(dir, 'checkout', '--quiet', '--detach', base)
  git(dir, 'merge', '--quiet', '--squash', prHead)
  const queueHead = commitAll(dir, 'merge queue entry')

  // What actions/checkout leaves on disk for a `pull_request` run: the
  // synthetic refs/pull/N/merge commit, parents (base, PR head).
  git(dir, 'checkout', '--quiet', '--detach', base)
  git(dir, 'merge', '--quiet', '--no-ff', '-m', 'refs/pull/N/merge', prHead)

  // The `changes` steps shell out to the real platform classifier by a
  // repo-relative path. Untracked, so it never appears in any diff.
  const detect = '.github/scripts/detect-changed-platforms.sh'
  mkdirSync(join(dir, '.github', 'scripts'), { recursive: true })
  copyFileSync(join(process.cwd(), detect), join(dir, detect))

  return { dir, fork, base, prHead, queueHead }
}

type EventName = 'pull_request' | 'merge_group' | 'push'

/** Every event field these steps read, blank where GitHub leaves it blank. */
function eventFixtures(r: Repo, event: EventName): Record<string, string> {
  const blank = {
    'github.event_name': event,
    'github.event.pull_request.base.sha': '',
    'github.event.pull_request.head.sha': '',
    'github.event.merge_group.base_sha': '',
    'github.event.merge_group.head_sha': '',
    'github.event.before': '',
    'github.event.after': '',
  }
  switch (event) {
    case 'pull_request':
      return { ...blank, 'github.event.pull_request.base.sha': r.base, 'github.event.pull_request.head.sha': r.prHead }
    case 'merge_group':
      return { ...blank, 'github.event.merge_group.base_sha': r.base, 'github.event.merge_group.head_sha': r.queueHead }
    case 'push':
      return { ...blank, 'github.event.before': r.fork, 'github.event.after': r.base }
  }
}

function runStep(r: Repo, file: string, job: string, step: string, event: EventName) {
  const s = getStep(getJob(loadWorkflow(file), job), step)
  if (typeof s.run !== 'string') throw new Error(`${file} ${job}/"${step}" has no run: block`)
  const fixtures = eventFixtures(r, event)
  const script = resolveExpressions(s.run, fixtures, `${file} ${job}/"${step}"`)
  const result = runShellStep(script, resolveEnv(s.env, fixtures), r.dir)
  expect(result.status, `${file} ${job}/"${step}" exited ${result.status}: ${result.stderr}`).toBe(0)
  return result
}

function lintedFiles(r: Repo, event: EventName): string[] {
  const { outputs } = runStep(r, 'ci.yml', 'lint', 'Determine changed files', event)
  expect(outputs, 'the step wrote no `files` output — this rail would pass vacuously').toHaveProperty('files')
  return (outputs['files'] ?? '').split('\n').filter(Boolean).sort()
}

const DETECT_STEPS = [
  { file: 'ci.yml', job: 'changes' },
  { file: 'desktop-e2e.yml', job: 'changes' },
  // ios-e2e.yml had a `changes` job of its own; it was removed on main so the
  // iOS matrix starts from ci.yml's filter and the e2e build instead of
  // recomputing its own (#1420/#1428). Nothing to assert there any more.
] as const

let repo: Repo
beforeAll(() => { repo = buildRepo() })
afterAll(() => { rmSync(repo.dir, { recursive: true, force: true }) })

describe('ci.yml lint "Determine changed files" (#1396)', () => {
  it('pull_request behind main: lints only the PR\'s own files, not what main changed since the fork', () => {
    expect(lintedFiles(repo, 'pull_request')).toEqual([PR_LINTABLE])
  })

  it('merge_group: lints exactly the queued change', () => {
    expect(lintedFiles(repo, 'merge_group')).toEqual([PR_LINTABLE])
  })

  it('push: lints what the push moved main by', () => {
    expect(lintedFiles(repo, 'push')).toEqual([MAIN_LINTABLE])
  })
})

describe.each(DETECT_STEPS)('$file $job "Detect changes" (#1396)', ({ file, job }) => {
  it('pull_request behind main: only the PR\'s own platforms switch on', () => {
    const { outputs } = runStep(repo, file, job, 'Detect changes', 'pull_request')
    expect(outputs['android'], `${PR_PLATFORM_FILE} is the PR's own change`).toBe('true')
    expect(outputs['ios'], `${MAIN_PLATFORM_FILE} changed on main, not in the PR`).toBe('false')
  })

  it('push: the platforms the push moved main by switch on', () => {
    const { outputs } = runStep(repo, file, job, 'Detect changes', 'push')
    expect(outputs['ios']).toBe('true')
    expect(outputs['android']).toBe('false')
  })
})

describe.each(DETECT_STEPS.filter((d) => d.file !== 'desktop-e2e.yml'))(
  '$file $job "Detect changes" on merge_group (#1396)',
  ({ file, job }) => {
    it('merge_group: exactly the queued change\'s platforms switch on', () => {
      const { outputs } = runStep(repo, file, job, 'Detect changes', 'merge_group')
      expect(outputs['android']).toBe('true')
      expect(outputs['ios']).toBe('false')
    })
  },
)
