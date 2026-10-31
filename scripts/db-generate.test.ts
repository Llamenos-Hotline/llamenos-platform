/**
 * The acceptance test for #2391: two branches each add a migration with
 * `bun run db:generate`, knowing nothing of each other, and both land — in
 * EITHER order — with every migration gate green and nothing renumbered or
 * regenerated.
 *
 *   bun test scripts/db-generate.test.ts
 *
 * Runs the real generator and the real gates (drift, safety, claims, order)
 * as CLIs in a scratch git repo that holds a copy of this repo's schema,
 * migrations and scripts. migration:order needs Postgres:
 * MIGRATION_ORDER_ADMIN_URL, or a throwaway container (as in CI).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scratchPostgres, type Scratch } from './check-migration-order'
import { nextPrefix, timestampPrefix } from './db-generate'

const ROOT = join(import.meta.dir, '..')
let pg: Scratch
const scratch: string[] = []

beforeAll(async () => {
  pg = await scratchPostgres(ROOT)
}, 120_000)

afterAll(async () => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
  await pg?.close()
}, 120_000)

function git(root: string, ...args: string[]): string {
  const r = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`)
  return r.stdout.toString().trim()
}

function bun(root: string, script: string, ...args: string[]): { code: number; out: string } {
  const r = Bun.spawnSync([process.execPath, '--no-env-file', join(root, 'scripts', script), ...args], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      MIGRATION_ORDER_ADMIN_URL: pg.adminUrl,
    },
  })
  return { code: r.exitCode, out: `${r.stdout.toString()}${r.stderr.toString()}` }
}

/** main: this repo's schema, migrations and scripts, as one commit. */
function mainRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'db-generate-'))
  scratch.push(root)
  for (const p of ['drizzle', 'scripts', 'apps/worker/db', 'deploy/docker/docker-compose.dev.yml', 'package.json', 'tsconfig.json']) {
    cpSync(join(ROOT, p), join(root, p), { recursive: true })
  }
  symlinkSync(join(ROOT, 'node_modules'), join(root, 'node_modules'))
  writeFileSync(join(root, '.gitignore'), 'node_modules\n')
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 'test@example.invalid')
  git(root, 'config', 'user.name', 'test')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'main')
  return root
}

/** On a new branch from main: declare a table, generate its migration, commit. */
function branch(root: string, name: string, table: string): void {
  git(root, 'checkout', '-q', '-b', name, 'main')
  writeFileSync(
    join(root, 'apps', 'worker', 'db', 'schema', `zz-${name}.ts`),
    `import { pgTable, text } from 'drizzle-orm/pg-core'\n\nexport const ${table.replace(/_(\w)/g, (_, c) => c.toUpperCase())} = pgTable('${table}', {\n  id: text('id').primaryKey(),\n  note: text('note'),\n})\n`,
  )
  const gen = bun(root, 'db-generate.ts', '--name', name)
  expect(gen.code, gen.out).toBe(0)
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', name)
}

/** Every migration gate, as CI runs them on a PR (`base` = main) — all must pass. Returns their output. */
function gates(root: string, base: string): string {
  let all = ''
  for (const [script, ...args] of [
    ['check-migration-drift.ts', '--ci'],
    ['check-migration-safety.ts', '--ci', '--base', base],
    ['check-migration-claims.ts', '--base', base],
    ['check-migration-order.ts', '--base', base],
  ]) {
    const r = bun(root, script, ...args)
    expect(r.code, `${script} on ${git(root, 'rev-parse', '--abbrev-ref', 'HEAD')}:\n${r.out}`).toBe(0)
    all += r.out
  }
  return all
}

/** Land `name` on main the way the merge queue does: a squash commit on top. */
function land(root: string, name: string): void {
  git(root, 'checkout', '-q', 'main')
  git(root, 'merge', '-q', '--squash', name)
  git(root, 'commit', '-q', '-m', `land ${name}`)
}

describe('two independent migration PRs (#2391)', () => {
  for (const order of [
    ['a', 'b'],
    ['b', 'a'],
  ] as const) {
    test(`both land with every gate green, ${order[0]} first, nothing renumbered`, () => {
      const root = mainRepo()
      branch(root, 'a', 'branch_a_items')
      // Distinct timestamps: one generated a second after the other.
      Bun.sleepSync(1100)
      branch(root, 'b', 'branch_b_items')
      const named = (b: string) => git(root, 'diff', '--name-only', 'main', b, '--', 'drizzle').split('\n').sort()
      const before = { a: named('a'), b: named('b') }

      for (const pr of order) {
        // The PR's own CI, against main as it is now — after the other landed.
        git(root, 'checkout', '-q', pr)
        git(root, 'rebase', '-q', 'main')
        const out = gates(root, 'main')
        if (pr === 'a' && order[0] === 'b') {
          // a was written first, so it sorts before b, which main already has:
          // a deployment on main runs a AFTER b. That is allowed, and proven.
          expect(out).toContain('_a.sql (before ')
          expect(out).toContain('concurrent migrations')
          expect(out).toContain('OK: 1 upgrade order(s) build the same schema as a fresh install')
        } else {
          expect(out).toContain('nothing to prove')
        }
        land(root, pr)
      }
      gates(root, 'HEAD~2')

      // Neither PR's files changed on the way: no renumber, no regenerated snapshot.
      expect(git(root, 'diff', '--name-only', 'HEAD~2', 'HEAD', '--', 'drizzle').split('\n').sort()).toEqual(
        [...before.a, ...before.b].sort(),
      )

      // The next migration joins the two heads again.
      git(root, 'checkout', '-q', '-b', 'c', 'main')
      writeFileSync(join(root, 'apps', 'worker', 'db', 'schema', 'zz-c.ts'), "import { pgTable, text } from 'drizzle-orm/pg-core'\n\nexport const cItems = pgTable('c_items', { id: text('id').primaryKey() })\n")
      const gen = bun(root, 'db-generate.ts', '--name', 'c')
      expect(gen.out).toContain('parents: ')
      const meta = join(root, 'drizzle', 'migrations', 'meta')
      const newest = readdirSync(meta).filter((f) => f.endsWith('_snapshot.json')).sort().at(-1) as string
      expect((JSON.parse(readFileSync(join(meta, newest), 'utf-8')) as { prevIds: string[] }).prevIds).toHaveLength(2)
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'c')
      gates(root, 'main')
    }, 300_000)
  }

  test('BREAK IT: two branches changing the same column differently do not merge silently', () => {
    const root = mainRepo()
    const users = join(root, 'apps', 'worker', 'db', 'schema', 'users.ts')
    const original = readFileSync(users, 'utf-8')
    for (const [name, value] of [
      ['x', 'x'],
      ['y', 'y'],
    ]) {
      git(root, 'checkout', '-q', '-b', name, 'main')
      // Both add the same column, with different defaults.
      writeFileSync(users, original.replace(/(\n\s*pubkey: text\('pubkey'\))/, `\n  clash: text('clash').default('${value}'),$1`))
      const gen = bun(root, 'db-generate.ts', '--name', `clash_${name}`)
      expect(gen.code, gen.out).toBe(0)
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', name)
      Bun.sleepSync(1100)
    }
    land(root, 'x')
    git(root, 'checkout', '-q', 'y')
    // The schema file conflicts in git, as it should; take main's version of
    // it and keep y's migration — the state a careless rebase produces.
    const rebase = Bun.spawnSync(['git', 'rebase', '-q', 'main'], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
    if (rebase.exitCode !== 0) {
      git(root, 'checkout', '--theirs', '--', 'apps/worker/db/schema/users.ts')
      git(root, 'add', '-A')
      Bun.spawnSync(['git', '-c', 'core.editor=true', 'rebase', '--continue'], { cwd: root })
    }
    const drift = bun(root, 'check-migration-drift.ts', '--ci')
    expect(drift.code).toBe(1)
    expect(drift.out).toContain('clash')
    expect(drift.out).toContain('changed differently by')
  }, 300_000)
})

describe('naming', () => {
  test('a prefix is UTC YYYYMMDDHHMMSS', () => {
    expect(timestampPrefix(new Date('2026-10-30T14:15:23.456Z'))).toBe('20261030141523')
  })

  test('a new prefix sorts after every existing one, even with a slow clock', () => {
    expect(nextPrefix(new Date('2026-10-30T14:15:23Z'), ['0069', '20261030141523'])).toBe('20261030141524')
    expect(nextPrefix(new Date('2026-10-30T14:15:23Z'), ['0069', '20261101000000'])).toBe('20261101000001')
    expect(nextPrefix(new Date('2026-10-30T14:15:23Z'), ['0069'])).toBe('20261030141523')
  })
})
