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
 *
 * Rail for #1594, added to the same repo: the queue stacks each entry on the
 * PREVIOUS entry's group head, so from the SECOND entry onward
 * `merge_group.base_sha` already contains the earlier entries' files. A
 * platform-detection diff against it therefore sees only the last entry's
 * files and filters away the suites the earlier entry's own changes require
 * — while the tree about to land still carries them. Measured live: group
 * `pr-1556-b1801eb8` (run 37467885061) ran android-e2e and ios-e2e; group
 * `pr-1482-35d61e96`, whose base was that group's head, skipped
 * android-build-test, ios-build-test, android-e2e and ios-e2e and reported
 * `ci-status: success` with #1556's Android and iOS changes in its tree.
 */

// The PR changes one lintable file and one Android file; `main`, after the
// fork, changes a different lintable file and an iOS file.
const PR_LINTABLE = 'src/client/pr-only.ts'
const PR_PLATFORM_FILE = 'apps/android/PrOnly.kt'
const MAIN_LINTABLE = 'src/client/main-only.ts'
const MAIN_PLATFORM_FILE = 'apps/ios/MainOnly.swift'
// The SECOND queue entry, stacked on the first. Backend-only on purpose: it
// triggers no platform the first entry needed, so if detection runs against
// the first entry's head the Android and iOS flags go false.
const SECOND_ENTRY_FILE = 'apps/worker/second-entry.ts'

interface Repo {
  dir: string
  /** A bare repo standing in for `origin`, with `main` still at {@link base}. */
  originDir: string
  fork: string
  base: string
  prHead: string
  queueHead: string
  /** The second queue entry's group head, stacked on {@link queueHead}. */
  queueHead2: string
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

  // `origin` as the runner sees it mid-queue: `main` is still at `base`,
  // because no queue entry has merged yet. Cloned BEFORE the group commits
  // exist, so they are local-only — exactly what actions/checkout leaves
  // behind, since it fetches the queue ref and nothing else (which is why
  // the merge_group branch has to fetch the target itself).
  const originDir = `${dir}-origin`
  git(dir, 'clone', '--bare', '--quiet', '.', originDir)
  git(dir, 'remote', 'add', 'origin', originDir)

  // The merge queue's own commit: the PR squashed onto the queue base.
  git(dir, 'checkout', '--quiet', '--detach', base)
  git(dir, 'merge', '--quiet', '--squash', prHead)
  const queueHead = commitAll(dir, 'merge queue entry')

  // The SECOND entry, stacked on the first — the #1594 shape. Its own diff
  // touches no Android or iOS path; the first entry's does.
  write(dir, SECOND_ENTRY_FILE, 'second entry\n')
  const queueHead2 = commitAll(dir, 'merge queue entry 2')

  // What actions/checkout leaves on disk for a `pull_request` run: the
  // synthetic refs/pull/N/merge commit, parents (base, PR head).
  git(dir, 'checkout', '--quiet', '--detach', base)
  git(dir, 'merge', '--quiet', '--no-ff', '-m', 'refs/pull/N/merge', prHead)

  // The `changes` steps shell out to the real platform classifier by a
  // repo-relative path. Untracked, so it never appears in any diff.
  const detect = '.github/scripts/detect-changed-platforms.sh'
  mkdirSync(join(dir, '.github', 'scripts'), { recursive: true })
  copyFileSync(join(process.cwd(), detect), join(dir, detect))

  return { dir, originDir, fork, base, prHead, queueHead, queueHead2 }
}

type EventName =
  | 'pull_request'
  | 'merge_group'
  /** The second entry in the same queue chain: base_sha IS the first entry's head. */
  | 'merge_group_second'
  /** A merge group whose target branch cannot be resolved on `origin`. */
  | 'merge_group_unresolvable_target'
  | 'push'

/** Every event field these steps read, blank where GitHub leaves it blank. */
function eventFixtures(r: Repo, event: EventName): Record<string, string> {
  const blank = {
    'github.event_name': event.startsWith('merge_group') ? 'merge_group' : event,
    'github.event.pull_request.base.sha': '',
    'github.event.pull_request.head.sha': '',
    'github.event.merge_group.base_sha': '',
    'github.event.merge_group.head_sha': '',
    'github.event.merge_group.base_ref': '',
    'github.event.before': '',
    'github.event.after': '',
  }
  switch (event) {
    case 'pull_request':
      return { ...blank, 'github.event.pull_request.base.sha': r.base, 'github.event.pull_request.head.sha': r.prHead }
    case 'merge_group':
      return {
        ...blank,
        'github.event.merge_group.base_sha': r.base,
        'github.event.merge_group.head_sha': r.queueHead,
        'github.event.merge_group.base_ref': 'refs/heads/main',
      }
    case 'merge_group_second':
      return {
        ...blank,
        'github.event.merge_group.base_sha': r.queueHead,
        'github.event.merge_group.head_sha': r.queueHead2,
        'github.event.merge_group.base_ref': 'refs/heads/main',
      }
    case 'merge_group_unresolvable_target':
      return {
        ...blank,
        'github.event.merge_group.base_sha': r.queueHead,
        'github.event.merge_group.head_sha': r.queueHead2,
        'github.event.merge_group.base_ref': 'refs/heads/no-such-branch',
      }
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
afterAll(() => {
  rmSync(repo.dir, { recursive: true, force: true })
  rmSync(repo.originDir, { recursive: true, force: true })
})

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

describe('ci.yml changes "Detect changes" on a stacked merge group (#1594)', () => {
  it('second queue entry: the FIRST entry\'s platforms still switch on, because the group lands both', () => {
    const { outputs, stdout } = runStep(repo, 'ci.yml', 'changes', 'Detect changes', 'merge_group_second')
    // The group head carries both entries. `apps/android/` came from the
    // first entry, which `base_sha` has already absorbed — this is the flag
    // that read `false` before the fix, with android-build-test and all four
    // android-e2e shards filtered away in a group reporting success.
    expect(outputs['android'], 'the first entry\'s Android change is in the tree this group lands').toBe('true')
    expect(outputs['backend'], 'the second entry\'s own change').toBe('true')
    expect(outputs['desktop'], 'the first entry touched src/client/').toBe('true')
    // It must be the queue TARGET it diffed against, not HEAD^ and not the
    // whole tree: `apps/ios/` moved on `main` before either entry and is
    // outside both, so iOS stays off and the scarce macOS runners stay free.
    expect(outputs['ios'], 'apps/ios/ changed on main, in neither queue entry').toBe('false')
    expect(stdout).toContain(SECOND_ENTRY_FILE)
    expect(stdout).toContain(PR_PLATFORM_FILE)
    expect(stdout).not.toContain(MAIN_PLATFORM_FILE)
  })

  it('unresolvable queue target: every flag switches on rather than narrowing the gate', () => {
    const { outputs, stdout } = runStep(
      repo, 'ci.yml', 'changes', 'Detect changes', 'merge_group_unresolvable_target',
    )
    // The one thing this must never do is fall back to HEAD^ — which on a
    // merge group IS base_sha, i.e. the defect. Nor may it fail the job and
    // stall the queue. It over-runs instead.
    expect(stdout).toContain('Queue target unresolved')
    // Every flag this scratch tree can set — it holds no packages/crypto/
    // path, so `crypto` is not assertable here.
    for (const flag of ['android', 'ios', 'desktop', 'backend']) {
      expect(outputs[flag], `${flag} must fail toward running`).toBe('true')
    }
    expect(outputs['ios_tier']).toBe('full')
    expect(outputs['docs_only']).toBe('false')
    expect(stdout).toContain(MAIN_PLATFORM_FILE)
  })
})
