#!/usr/bin/env bun
/**
 * check-migration-order.ts — prove, in a real Postgres, that every database
 * this tree can meet ends up with the same schema (#2391).
 *
 * The runner applies whatever its ledger has not seen, in filename order
 * (scripts/run-migrations.ts). Timestamped migrations are named when they are
 * written, not when they land, so one written earlier can land later and sort
 * before a file a deployed database has already applied. That database then
 * runs the two in the opposite order to a fresh install. `migration:safety`
 * allows that only between concurrent migrations; this is the proof that the
 * two orders really build the same thing.
 *
 * No prevIds are trusted here. The orders compared come from git:
 *
 *   - every main tip a deployment can be sitting on: --base, and each
 *     first-parent commit between it and HEAD (a merge group's entries);
 *   - for each, the order an upgrade from it applies: that tip's files first,
 *     then the rest of this tree's, each in filename order;
 *   - against a fresh install of this tree, which is applied twice: the second
 *     run must apply nothing and change nothing.
 *
 * A tip whose upgrade order IS filename order (nothing pending sorts before
 * something it has) needs no database, so the common case — no inversion
 * anywhere — costs one git log and exits.
 *
 * The schemas are compared by catalog fingerprint: every table, column (type,
 * nullability, default), constraint, index, trigger, function, enum (values in
 * order), sequence, view and policy in `public`. Column ORDER is ignored: an
 * ADD COLUMN appends, so it legitimately differs.
 *
 * MIGRATION_ORDER_ADMIN_URL names a role that may CREATE DATABASE (its own
 * name, not DATABASE_URL, which Bun loads from .env and which points at a
 * database people use). Without it, a throwaway Postgres container is started
 * (the image deploy/docker/docker-compose.dev.yml pins) and removed afterwards.
 *
 * Usage: bun run migration:order [--base <rev>] [--root <repo>]
 * Exit:  0 every order agrees, 1 two orders differ (or a run failed), 2 could not run.
 */
import { SQL } from 'bun'
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listMigrationFiles } from './lib/migration-statements'

const MIGRATIONS = 'drizzle/migrations'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function git(root: string, ...args: string[]): string {
  const r = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString().trim()}`)
  return r.stdout.toString()
}

/** The `.sql` migrations at a revision, in filename order. */
function migrationsAt(root: string, rev: string): string[] {
  return git(root, 'ls-tree', '--name-only', rev, '--', `${MIGRATIONS}/`)
    .split('\n')
    .filter((p) => p.endsWith('.sql'))
    .map((p) => p.slice(MIGRATIONS.length + 1))
    .sort()
}

export interface UpgradePlan {
  /** The tip a deployment sits on. */
  from: string
  /** Files that tip has applied. */
  applied: string[]
  /** What the upgrade then applies, in order. */
  then: string[]
  /** Files the upgrade applies that sort before one already applied. */
  inversions: string[]
}

/**
 * For each tip, the order its upgrade to `final` applies. Only plans with
 * inversions differ from a fresh install's order.
 */
export function upgradePlans(tips: { rev: string; files: string[] }[], final: string[]): UpgradePlan[] {
  return tips.map(({ rev, files }) => {
    const applied = files.filter((f) => final.includes(f)).sort()
    const then = final.filter((f) => !applied.includes(f))
    const last = applied.at(-1)
    return { from: rev, applied, then, inversions: last === undefined ? [] : then.filter((f) => f < last) }
  })
}

// ── Postgres ─────────────────────────────────────────────────────────────────

/** Every schema object in `public`, one canonical line each, sorted. */
export async function schemaFingerprint(url: string): Promise<string[]> {
  const sql = new SQL({ url, max: 1 })
  try {
    const rows = (await sql.unsafe(`
      SELECT 'table ' || c.relname AS line
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      UNION ALL
      SELECT 'column ' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
             || CASE WHEN a.attnotnull THEN ' not null' ELSE '' END
             || COALESCE(' default ' || pg_get_expr(d.adbin, d.adrelid), '')
             || CASE WHEN a.attidentity <> '' THEN ' identity ' || a.attidentity::text ELSE '' END
             || CASE WHEN a.attgenerated <> '' THEN ' generated ' || a.attgenerated::text ELSE '' END
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm') AND a.attnum > 0 AND NOT a.attisdropped
      UNION ALL
      SELECT 'constraint ' || c.conrelid::regclass::text || ' ' || c.conname || ' ' || pg_get_constraintdef(c.oid)
        FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
       WHERE n.nspname = 'public' AND c.conrelid <> 0
      UNION ALL
      SELECT 'index ' || indexdef FROM pg_indexes WHERE schemaname = 'public'
      UNION ALL
      SELECT 'trigger ' || pg_get_triggerdef(t.oid)
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND NOT t.tgisinternal
      UNION ALL
      SELECT 'function ' || pg_get_functiondef(p.oid)
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')
      UNION ALL
      SELECT 'enum ' || t.typname || ' ' || string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder)
        FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = 'public' GROUP BY t.typname
      UNION ALL
      SELECT 'sequence ' || sequencename || ' ' || data_type::text || ' ' || increment_by || ' ' || start_value
        FROM pg_sequences WHERE schemaname = 'public'
      UNION ALL
      SELECT 'view ' || viewname || ' ' || definition FROM pg_views WHERE schemaname = 'public'
      UNION ALL
      SELECT 'policy ' || tablename || ' ' || policyname || ' ' || cmd || ' ' || COALESCE(qual, '') || ' ' || COALESCE(with_check, '')
        FROM pg_policies WHERE schemaname = 'public'
    `)) as { line: string }[]
    return rows.map((r) => r.line).sort()
  } finally {
    await sql.close()
  }
}

export interface Scratch {
  adminUrl: string
  close(): Promise<void>
}

/** The Postgres image the dev stack pins, so the proof runs on what development does. */
function devPostgresImage(root: string): string {
  const compose = readFileSync(join(root, 'deploy', 'docker', 'docker-compose.dev.yml'), 'utf-8')
  const m = /^\s*image:\s*(postgres:\S+)/m.exec(compose)
  if (!m) throw new Error('deploy/docker/docker-compose.dev.yml pins no postgres image')
  return m[1]
}

function sh(cmd: string[]): string {
  const r = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(`${cmd.join(' ')}: ${r.stderr.toString().trim()}`)
  return r.stdout.toString().trim()
}

/** MIGRATION_ORDER_ADMIN_URL, or a throwaway container (fsync off: it is discarded). */
export async function scratchPostgres(root: string): Promise<Scratch> {
  const given = process.env.MIGRATION_ORDER_ADMIN_URL
  if (given) return { adminUrl: given, close: async () => {} }
  const name = `migration-order-${process.pid}-${Date.now()}`
  sh([
    'docker', 'run', '-d', '--rm', '--name', name,
    '-e', 'POSTGRES_USER=order', '-e', 'POSTGRES_PASSWORD=order', '-e', 'POSTGRES_DB=order',
    '-p', '127.0.0.1::5432', devPostgresImage(root),
    '-c', 'fsync=off', '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off',
  ])
  const close = async () => {
    Bun.spawnSync(['docker', 'rm', '-f', name], { stdout: 'ignore', stderr: 'ignore' })
  }
  try {
    const port = sh(['docker', 'port', name, '5432/tcp']).split('\n')[0].split(':').at(-1)
    const adminUrl = `postgres://order:order@127.0.0.1:${port}/order`
    for (let i = 0; ; i++) {
      // pg_isready over TCP: the entrypoint's first start listens on the socket only.
      const r = Bun.spawnSync(['docker', 'exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'order'], { stdout: 'ignore', stderr: 'ignore' })
      if (r.exitCode === 0) break
      if (i >= 60) throw new Error(`postgres container ${name} did not become ready`)
      await Bun.sleep(500)
    }
    return { adminUrl, close }
  } catch (err) {
    await close()
    throw err
  }
}

function withDatabase(adminUrl: string, db: string): string {
  const u = new URL(adminUrl)
  u.pathname = `/${db}`
  return u.toString()
}

/** Run the real runner over exactly `files` (taken from `sourceDir`) against `url`. */
function runRunner(root: string, url: string, sourceDir: string, files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'migration-order-'))
  try {
    for (const f of files) copyFileSync(join(sourceDir, f), join(dir, f))
    const r = Bun.spawnSync([process.execPath, '--no-env-file', join(root, 'scripts', 'run-migrations.ts')], {
      cwd: root,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', DATABASE_URL: url, LLAMENOS_MIGRATIONS_DIR: dir },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = `${r.stdout.toString()}${r.stderr.toString()}`
    if (r.exitCode !== 0) throw new Error(`run-migrations failed:\n${out.split('\n').slice(-15).join('\n')}`)
    return out
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export interface OrderReport {
  plans: UpgradePlan[]
  /** One line per order that disagreed with a fresh install. */
  mismatches: string[]
}

function describeDifference(fresh: string[], other: string[]): string {
  const f = new Set(fresh)
  const o = new Set(other)
  const onlyFresh = fresh.filter((l) => !o.has(l))
  const onlyOther = other.filter((l) => !f.has(l))
  const show = (ls: string[]) => ls.slice(0, 8).map((l) => `        ${l.replace(/\s+/g, ' ').slice(0, 160)}`).join('\n')
  return `      only on a fresh install:\n${show(onlyFresh) || '        (nothing)'}\n      only after the upgrade:\n${show(onlyOther) || '        (nothing)'}`
}

/**
 * Apply `final` fresh (twice), and every inverted upgrade plan, and compare.
 * `sourceDir` holds the files by name.
 */
export async function proveOrders(root: string, sourceDir: string, final: string[], plans: UpgradePlan[], adminUrl: string): Promise<OrderReport> {
  const inverted = plans.filter((p) => p.inversions.length > 0)
  const mismatches: string[] = []
  if (inverted.length === 0) return { plans, mismatches }

  const admin = new SQL({ url: adminUrl, max: 1 })
  const created: string[] = []
  const fresh = async (n: number) => {
    const db = `migration_order_${process.pid}_${n}`
    await admin.unsafe(`DROP DATABASE IF EXISTS ${db}`)
    await admin.unsafe(`CREATE DATABASE ${db}`)
    created.push(db)
    return withDatabase(adminUrl, db)
  }
  try {
    const freshUrl = await fresh(0)
    try {
      runRunner(root, freshUrl, sourceDir, final)
    } catch (err) {
      mismatches.push(`a fresh install of this tree fails:\n${err instanceof Error ? err.message : String(err)}`)
      return { plans, mismatches }
    }
    const freshPrint = await schemaFingerprint(freshUrl)
    const again = runRunner(root, freshUrl, sourceDir, final)
    if (!again.includes(`0 applied, 0 reconciled, ${final.length} already in the ledger`)) {
      mismatches.push(`a second run on the fresh install was not a no-op:\n${again.split('\n').slice(-4).join('\n')}`)
    }
    const againPrint = await schemaFingerprint(freshUrl)
    if (againPrint.join('\n') !== freshPrint.join('\n')) {
      mismatches.push(`a second run on the fresh install changed its schema:\n${describeDifference(freshPrint, againPrint)}`)
    }

    for (const [i, plan] of inverted.entries()) {
      const url = await fresh(i + 1)
      try {
        runRunner(root, url, sourceDir, plan.applied)
        runRunner(root, url, sourceDir, final)
      } catch (err) {
        mismatches.push(
          `upgrading from ${plan.from}, which applies ${plan.inversions.join(', ')} after the files it sorts before, ` +
            `fails:\n${err instanceof Error ? err.message : String(err)}`,
        )
        continue
      }
      const print = await schemaFingerprint(url)
      if (print.join('\n') !== freshPrint.join('\n')) {
        mismatches.push(
          `upgrading from ${plan.from} applies ${plan.inversions.join(', ')} after ${plan.applied.at(-1)}, and builds a ` +
            `different schema from a fresh install:\n${describeDifference(freshPrint, print)}`,
        )
      }
    }
  } finally {
    for (const db of created) await admin.unsafe(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => {})
    await admin.close()
  }
  return { plans, mismatches }
}

async function main() {
  const root = arg('--root') ?? process.cwd()
  const base = arg('--base') ?? 'origin/main'
  const migrationsDir = join(root, MIGRATIONS)
  const final = listMigrationFiles(migrationsDir)

  // The tips a deployment can be sitting on: the base, then each first-parent
  // commit up to (not including) HEAD — in a merge group, the entries ahead of
  // this one.
  const between = git(root, 'rev-list', '--first-parent', '--reverse', `${base}..HEAD`).split('\n').filter(Boolean)
  const tips = [git(root, 'rev-parse', base).trim(), ...between.slice(0, -1)].map((rev) => ({
    rev: rev.slice(0, 12),
    files: migrationsAt(root, rev),
  }))
  const plans = upgradePlans(tips, final)
  const inverted = plans.filter((p) => p.inversions.length > 0)
  if (inverted.length === 0) {
    console.log(
      `[migration-order] every upgrade from ${tips.map((t) => t.rev).join(', ')} applies in filename order; ` +
        'nothing to prove',
    )
    return
  }
  for (const p of inverted) {
    console.log(`[migration-order] upgrading from ${p.from} applies ${p.inversions.join(', ')} after ${p.applied.at(-1)}`)
  }

  const scratch = await scratchPostgres(root)
  let report: OrderReport
  try {
    report = await proveOrders(root, migrationsDir, final, plans, scratch.adminUrl)
  } finally {
    await scratch.close()
  }
  if (report.mismatches.length === 0) {
    console.log(`[migration-order] OK: ${inverted.length} upgrade order(s) build the same schema as a fresh install, which is idempotent`)
    return
  }
  console.error(`[migration-order] FAILED:\n`)
  for (const m of report.mismatches) console.error(`  ✗ ${m}\n`)
  console.error(
    '  Two migrations written on different branches do not commute. Rebase onto origin/main, delete THIS\n' +
      "  branch's migration and snapshot, and regenerate it on top so it sorts after the other:\n" +
      '    bun run db:generate --name <description>',
  )
  process.exit(1)
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[migration-order] could not run: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(2)
  })
}
