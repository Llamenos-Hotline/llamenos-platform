/**
 * Rails for scripts/ci/migration-base.ts (#3023): every event the CI workflow
 * runs on yields a base the migration gates can judge against, and a run that
 * cannot get one says so (exit 2) instead of handing the gates an empty string.
 *
 *   bun test scripts/ci/migration-base.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decideBase, NoBase } from './migration-base'

const SCRIPT = join(import.meta.dir, 'migration-base.ts')
const A = 'a'.repeat(40)
const ZERO = '0'.repeat(40)

let tmp: string
let origin: string
/** main's commits oldest first; `feature` forks off main[FORK]. */
let main: string[] = []
const FORK = 3

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} (exit ${r.exitCode}): ${r.stderr}`)
  return r.stdout.toString().trim()
}

/** main c0..c6, feature f1..f2 off c3, orphan o1 — one fast-import stream. */
function fixtureStream(): string {
  let mark = 0
  const data = (t: string) => `data ${Buffer.byteLength(t)}\n${t}`
  const commit = (ref: string, msg: string, from?: number) => {
    mark++
    return [
      `commit ${ref}`,
      `mark :${mark}`,
      `committer t <t@t> ${1_700_000_000 + mark} +0000`,
      data(msg),
      ...(from === undefined ? [] : [`from :${from}`]),
      'M 100644 inline f',
      data(msg),
    ].join('\n')
  }
  const parts: string[] = []
  for (let i = 0; i <= 6; i++) parts.push(commit('refs/heads/main', `c${i}`))
  parts.push(commit('refs/heads/feature', 'f1', FORK + 1), commit('refs/heads/feature', 'f2'))
  mark++
  parts.push(
    ['commit refs/heads/orphan', `mark :${mark}`, `committer t <t@t> ${1_700_000_000 + mark} +0000`, data('o1'), 'M 100644 inline f', data('o1')].join('\n'),
  )
  return `${parts.join('\n')}\n`
}

/** A depth-1 clone of `branch`, the way actions/checkout leaves a workflow_dispatch run. */
function checkout(name: string, branch: string): string {
  const dir = join(tmp, name)
  git(tmp, 'clone', '-q', '--depth=1', '--branch', branch, `file://${origin}`, dir)
  return dir
}

function runScript(cwd: string, env: Record<string, string>) {
  const githubEnv = join(cwd, '..', `${cwd.split('/').at(-1)}.env`)
  const r = Bun.spawnSync(['bun', SCRIPT], {
    cwd,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', GITHUB_ENV: githubEnv, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let written = ''
  try {
    written = readFileSync(githubEnv, 'utf8')
  } catch {}
  return { exitCode: r.exitCode, stdout: r.stdout.toString().trim(), stderr: r.stderr.toString(), written }
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'migration-base-'))
  origin = join(tmp, 'origin.git')
  git(tmp, 'init', '-q', '--bare', '-b', 'main', origin)
  git(origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true')
  const imp = Bun.spawnSync(['git', 'fast-import', '--quiet'], { cwd: origin, stdin: Buffer.from(fixtureStream()), stderr: 'pipe' })
  if (imp.exitCode !== 0) throw new Error(imp.stderr.toString())
  main = git(origin, 'rev-list', '--reverse', 'main').split('\n')
  if (main.length !== 7) throw new Error(`fixture main has ${main.length} commits, expected 7`)
  if (git(origin, 'merge-base', 'feature', 'main') !== main[FORK]) throw new Error('fixture feature does not fork at c3')
})

afterAll(() => rmSync(tmp, { recursive: true, force: true }))

describe('decideBase', () => {
  test('pull_request and merge_group use the base their payload names', () => {
    expect(decideBase({ event: 'pull_request', prBase: A })).toMatchObject({ kind: 'given', base: A })
    expect(decideBase({ event: 'merge_group', groupBase: A })).toMatchObject({ kind: 'given', base: A })
  })

  test('push uses before, unless it is the all-zeros sha of a first push', () => {
    expect(decideBase({ event: 'push', pushBefore: A })).toMatchObject({ kind: 'given', base: A })
    expect(decideBase({ event: 'push', pushBefore: ZERO, defaultBranch: 'main' })).toMatchObject({ kind: 'merge-base', branch: 'main' })
  })

  test('workflow_dispatch forks off the default branch', () => {
    expect(decideBase({ event: 'workflow_dispatch', defaultBranch: 'main' })).toMatchObject({ kind: 'merge-base', branch: 'main' })
  })

  test('BREAK IT: an empty or malformed payload base is refused, never passed on', () => {
    expect(() => decideBase({ event: 'pull_request', prBase: '' })).toThrow(NoBase)
    expect(() => decideBase({ event: 'merge_group' })).toThrow(/empty/)
    expect(() => decideBase({ event: 'push', pushBefore: 'main' })).toThrow(/not a commit sha/)
  })

  test('BREAK IT: workflow_dispatch without a default branch, or an unknown event, is refused', () => {
    expect(() => decideBase({ event: 'workflow_dispatch', defaultBranch: '' })).toThrow(/DEFAULT_BRANCH is empty/)
    expect(() => decideBase({ event: 'schedule' })).toThrow(/no defined migration base/)
  })
})

describe('migration-base.ts on a shallow workflow_dispatch checkout', () => {
  test('a branch resolves to the commit it forked from, written to GITHUB_ENV', () => {
    const r = runScript(checkout('dispatch-feature', 'feature'), { EVENT_NAME: 'workflow_dispatch', DEFAULT_BRANCH: 'main' })
    expect(r.stderr).toContain('merge-base of HEAD with main')
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe(main[FORK])
    expect(r.written).toBe(`MIGRATION_BASE=${main[FORK]}\n`)
  })

  test('the default branch itself resolves to its own head', () => {
    const r = runScript(checkout('dispatch-main', 'main'), { EVENT_NAME: 'workflow_dispatch', DEFAULT_BRANCH: 'main' })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe(main[6])
  })

  test('a pull_request passes its base through without touching git', () => {
    const r = runScript(checkout('pr', 'feature'), { EVENT_NAME: 'pull_request', PR_BASE_SHA: A })
    expect(r.exitCode).toBe(0)
    expect(r.written).toBe(`MIGRATION_BASE=${A}\n`)
  })

  test('BREAK IT: a branch with no history in common with main exits 2 and writes nothing', () => {
    const r = runScript(checkout('dispatch-orphan', 'orphan'), { EVENT_NAME: 'workflow_dispatch', DEFAULT_BRANCH: 'main' })
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toContain('shares no history with main')
    expect(r.written).toBe('')
  })

  test('BREAK IT: the empty dispatch payload that #3023 reported exits 2 instead of yielding ""', () => {
    const r = runScript(checkout('dispatch-nodefault', 'feature'), { EVENT_NAME: 'workflow_dispatch' })
    expect(r.exitCode).toBe(2)
    expect(r.stdout).toBe('')
    expect(r.written).toBe('')
  })
})
