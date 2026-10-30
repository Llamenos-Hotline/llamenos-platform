/**
 * Rails for scripts/check-migration-claims.ts — the PR-time guard for a
 * migration that cannot land as named (#2391).
 *
 *   bun test scripts/check-migration-claims.test.ts
 *
 * End to end through the CLI, in a scratch git repo holding a copy of this
 * repo's drizzle tree as "main". The open-PR sweep runs against a stand-in
 * `gh` (MIGRATION_CLAIMS_GH) that serves a fixture and records that it was
 * called, so the test can also pin when the sweep is NOT made.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const scratch: string[] = []

afterEach(() => {
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true })
})

function git(root: string, ...args: string[]): string {
  const r = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`)
  return r.stdout.toString().trim()
}

interface Repo {
  root: string
  base: string
  meta: string
  migrations: string
}

/** A repo whose only commit, `base`, is this tree's drizzle/ — origin/main as of this change. */
function repo(): Repo {
  const root = mkdtempSync(join(tmpdir(), 'migration-claims-'))
  scratch.push(root)
  cpSync(join(ROOT, 'drizzle'), join(root, 'drizzle'), { recursive: true })
  git(root, 'init', '-q', '-b', 'my-branch')
  git(root, 'config', 'user.email', 'test@example.invalid')
  git(root, 'config', 'user.name', 'test')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'main')
  const migrations = join(root, 'drizzle', 'migrations')
  return { root, base: git(root, 'rev-parse', 'HEAD'), meta: join(migrations, 'meta'), migrations }
}

function snapshotOf(r: Repo, file: string): Record<string, unknown> & { id: string } {
  return JSON.parse(readFileSync(join(r.meta, file), 'utf-8'))
}

/** A numbered migration as drizzle-kit generate wrote them before the cutover. */
function addNumbered(r: Repo, n: string, name: string, prevFrom = '0069_snapshot.json'): void {
  const parent = snapshotOf(r, prevFrom)
  writeFileSync(join(r.meta, `${n}_snapshot.json`), JSON.stringify({ ...parent, id: randomUUID(), prevId: parent.id }))
  writeFileSync(join(r.migrations, `${n}_${name}.sql`), `CREATE TABLE "${name}" ("id" text);`)
}

/** A timestamped migration as `bun run db:generate` writes it. */
function addTimestamped(r: Repo, prefix: string, name: string, parents = ['0069_snapshot.json']): void {
  const ids = parents.map((p) => snapshotOf(r, p).id)
  const body = snapshotOf(r, parents[0])
  writeFileSync(join(r.meta, `${prefix}_snapshot.json`), JSON.stringify({ ...body, id: randomUUID(), prevId: ids[0], prevIds: ids }))
  writeFileSync(join(r.migrations, `${prefix}_${name}.sql`), `CREATE TABLE "${name}" ("id" text);`)
}

interface FakePr {
  number: number
  createdAt: string
  headRefName: string
  files: { path: string }[]
}

/** A stand-in `gh` serving `prs`, recording every call to `<root>/gh-called`. */
function fakeGh(r: Repo, prs: FakePr[] | 'fail'): string {
  const bin = join(r.root, 'fake-gh')
  const fixture = join(r.root, 'prs.json')
  writeFileSync(fixture, prs === 'fail' ? '' : JSON.stringify(prs))
  writeFileSync(
    bin,
    prs === 'fail'
      ? `#!/bin/sh\necho called >> "${r.root}/gh-called"\necho "HTTP 502" >&2\nexit 1\n`
      : `#!/bin/sh\necho "$@" >> "${r.root}/gh-called"\ncat "${fixture}"\n`,
  )
  chmodSync(bin, 0o755)
  return bin
}

function run(r: Repo, args: string[], gh?: string): { code: number; out: string } {
  const p = Bun.spawnSync([process.execPath, join(ROOT, 'scripts', 'check-migration-claims.ts'), '--root', r.root, '--base', r.base, ...args], {
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...(gh ? { MIGRATION_CLAIMS_GH: gh } : {}) },
  })
  return { code: p.exitCode, out: `${p.stdout.toString()}${p.stderr.toString()}` }
}

const ghCalled = (r: Repo) => existsSync(join(r.root, 'gh-called'))

const OLDER = '2026-10-29T10:00:00Z'
const NEWER = '2026-10-30T10:00:00Z'

describe('numbered migrations (the PRs in flight at the cutover)', () => {
  test('BREAK IT: two open PRs claiming the same number — the newer one fails, naming the older', () => {
    const r = repo()
    addNumbered(r, '0070', 'active_calls_push_ref')
    const gh = fakeGh(r, [
      { number: 2346, createdAt: OLDER, headRefName: 'captcha', files: [{ path: 'drizzle/migrations/0070_captcha_attempts.sql' }] },
      { number: 2382, createdAt: NEWER, headRefName: 'my-branch', files: [{ path: 'drizzle/migrations/0070_active_calls_push_ref.sql' }] },
    ])
    const res = run(r, ['--against-open-prs'], gh)
    expect(res.code).toBe(1)
    expect(res.out).toContain('open PR #2346')
    expect(res.out).toContain('already claims 0070 with drizzle/migrations/0070_captcha_attempts.sql')
    expect(res.out).toContain('bun run db:generate --name active_calls_push_ref')
  })

  test('…and the older claimant passes, so the two never block each other', () => {
    const r = repo()
    addNumbered(r, '0070', 'captcha_attempts')
    const gh = fakeGh(r, [
      { number: 2346, createdAt: OLDER, headRefName: 'my-branch', files: [{ path: 'drizzle/migrations/0070_captcha_attempts.sql' }] },
      { number: 2382, createdAt: NEWER, headRefName: 'other', files: [{ path: 'drizzle/migrations/0070_active_calls_push_ref.sql' }] },
    ])
    const res = run(r, ['--against-open-prs'], gh)
    expect(res.out).toContain('OK: 0070_captcha_attempts.sql can land')
    expect(res.code).toBe(0)
  })

  test('--pr names this branch when its PR is not found by branch name', () => {
    const r = repo()
    addNumbered(r, '0070', 'mine')
    const gh = fakeGh(r, [
      { number: 1, createdAt: OLDER, headRefName: 'elsewhere', files: [{ path: 'drizzle/migrations/0070_theirs.sql' }] },
      { number: 2, createdAt: NEWER, headRefName: 'renamed', files: [{ path: 'drizzle/migrations/0070_mine.sql' }] },
    ])
    expect(run(r, ['--against-open-prs', '--pr', '2'], gh).out).toContain('open PR #1')
  })

  test('a branch with no PR yet loses to every open claimant', () => {
    const r = repo()
    addNumbered(r, '0070', 'mine')
    const gh = fakeGh(r, [{ number: 9, createdAt: NEWER, headRefName: 'x', files: [{ path: 'drizzle/migrations/0070_theirs.sql' }] }])
    expect(run(r, ['--against-open-prs'], gh).code).toBe(1)
  })

  test('BREAK IT: a number that exists on the base fails, naming the file that holds it', () => {
    const r = repo()
    addNumbered(r, '0069', 'duplicate')
    const res = run(r, [])
    expect(res.code).toBe(1)
    expect(res.out).toContain('0069 is already taken on')
    expect(res.out).toContain('0069_hub_incidents.sql')
  })

  test('BREAK IT: a stale prevId fails, naming the id it must be', () => {
    const r = repo()
    addNumbered(r, '0070', 'stale', '0068_snapshot.json')
    const res = run(r, [])
    expect(res.code).toBe(1)
    expect(res.out).toContain(`prevId is ${snapshotOf(r, '0068_snapshot.json').id}`)
    expect(res.out).toContain(`newest snapshot 0069_snapshot.json has id ${snapshotOf(r, '0069_snapshot.json').id}`)
    expect(res.out).toContain('editing prevId by hand passes locally and fails')
  })

  test('BREAK IT: a skipped number fails, naming the next free one and who claims it', () => {
    const r = repo()
    addNumbered(r, '0071', 'hub_escrow_pubkey')
    const gh = fakeGh(r, [{ number: 2346, createdAt: OLDER, headRefName: 'captcha', files: [{ path: 'drizzle/migrations/0070_captcha_attempts.sql' }] }])
    const res = run(r, ['--against-open-prs'], gh)
    expect(res.code).toBe(1)
    expect(res.out).toContain('0071 is not the next free number')
    expect(res.out).toContain('that is 0070. Open PR #2346 claims 0070')
  })

  test('the next free number with the right prevId passes, open PRs and all', () => {
    const r = repo()
    addNumbered(r, '0070', 'next')
    const gh = fakeGh(r, [{ number: 5, createdAt: OLDER, headRefName: 'x', files: [{ path: 'drizzle/migrations/20261030110000_other.sql' }] }])
    const res = run(r, ['--against-open-prs'], gh)
    expect(res.out).toContain('OK: 0070_next.sql can land')
    expect(res.out).toContain('checked against 1 other open PR(s)')
    expect(res.code).toBe(0)
  })

  test('two numbered files on one branch chain: the second must follow the first', () => {
    const r = repo()
    addNumbered(r, '0070', 'first')
    addNumbered(r, '0071', 'second', '0070_snapshot.json')
    expect(run(r, []).code).toBe(0)
    const bad = repo()
    addNumbered(bad, '0070', 'first')
    addNumbered(bad, '0071', 'second') // still points at 0069
    expect(run(bad, []).out).toContain('0071_snapshot.json: prevId is')
  })

  test('BREAK IT: numbering is closed once a timestamped migration is on the base', () => {
    const r = repo()
    addTimestamped(r, '20261030110000', 'first_timestamped')
    git(r.root, 'add', '-A')
    git(r.root, 'commit', '-q', '-m', 'timestamped lands')
    r.base = git(r.root, 'rev-parse', 'HEAD')
    addNumbered(r, '0070', 'late')
    const res = run(r, [])
    expect(res.code).toBe(1)
    expect(res.out).toContain('numbered migrations closed when 20261030110000_first_timestamped.sql landed')
  })
})

describe('timestamped migrations', () => {
  test('one generated before main moved still passes: its parent is old, not missing', () => {
    const r = repo()
    addTimestamped(r, '20261030120000', 'landed_first')
    git(r.root, 'add', '-A')
    git(r.root, 'commit', '-q', '-m', 'B lands')
    r.base = git(r.root, 'rev-parse', 'HEAD')
    addTimestamped(r, '20261030110000', 'written_first') // forked from 0069, before B existed
    expect(run(r, []).code).toBe(0)
  })

  test('BREAK IT: no snapshot beside it fails', () => {
    const r = repo()
    writeFileSync(join(r.migrations, '20261030110000_bare.sql'), 'SELECT 1;')
    const res = run(r, [])
    expect(res.code).toBe(1)
    expect(res.out).toContain('ships no meta/20261030110000_snapshot.json')
  })

  test('BREAK IT: a prevId no snapshot has fails, naming the heads', () => {
    const r = repo()
    addTimestamped(r, '20261030110000', 'dangling')
    const p = join(r.meta, '20261030110000_snapshot.json')
    writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, 'utf-8')), prevIds: ['not-a-snapshot'] }))
    const res = run(r, [])
    expect(res.code).toBe(1)
    expect(res.out).toContain('names not-a-snapshot, which no snapshot in this tree has')
    expect(res.out).toContain(`heads are 0069_snapshot.json (${snapshotOf(r, '0069_snapshot.json').id})`)
  })

  test('BREAK IT: re-adding the retired journal fails', () => {
    const r = repo()
    writeFileSync(join(r.meta, '_journal.json'), '{"entries":[]}')
    const res = run(r, [])
    expect(res.code).toBe(1)
    expect(res.out).toContain('_journal.json is retired')
  })
})

describe('the open-PR sweep', () => {
  test('a branch with no migration passes and does NOT call gh', () => {
    const r = repo()
    writeFileSync(join(r.root, 'unrelated.ts'), 'export {}\n')
    const gh = fakeGh(r, [{ number: 1, createdAt: OLDER, headRefName: 'x', files: [{ path: 'drizzle/migrations/0070_a.sql' }] }])
    const res = run(r, ['--against-open-prs'], gh)
    expect(res.out).toContain('adds no migration')
    expect(res.code).toBe(0)
    expect(ghCalled(r)).toBe(false)
  })

  test('a branch with a migration makes exactly one gh call', () => {
    const r = repo()
    addTimestamped(r, '20261030110000', 'x')
    const gh = fakeGh(r, [])
    expect(run(r, ['--against-open-prs'], gh).code).toBe(0)
    expect(readFileSync(join(r.root, 'gh-called'), 'utf-8').trim().split('\n')).toHaveLength(1)
  })

  test('without --against-open-prs there is no sweep at all', () => {
    const r = repo()
    addTimestamped(r, '20261030110000', 'x')
    const gh = fakeGh(r, [])
    expect(run(r, [], gh).code).toBe(0)
    expect(ghCalled(r)).toBe(false)
  })

  test('a failed sweep is a failed check (exit 2), never a pass', () => {
    const r = repo()
    addTimestamped(r, '20261030110000', 'x')
    const res = run(r, ['--against-open-prs'], fakeGh(r, 'fail'))
    expect(res.code).toBe(2)
    expect(res.out).toContain('gh pr list failed: HTTP 502')
  })
})
