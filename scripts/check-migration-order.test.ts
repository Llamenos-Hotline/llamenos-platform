/**
 * Rails for scripts/check-migration-order.ts: two migrations written on two
 * branches, with no knowledge of each other, applied in either merge order
 * (#2391).
 *
 *   bun test scripts/check-migration-order.test.ts
 *
 * Real Postgres, through the real runner (scripts/run-migrations.ts).
 * MIGRATION_ORDER_ADMIN_URL names one; without it a throwaway container is
 * started, exactly as the CLI does in CI.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { proveOrders, scratchPostgres, upgradePlans, type Scratch } from './check-migration-order'
import { prefixOf, TIMESTAMP_PREFIX } from './lib/migration-graph'
import { listMigrationFiles } from './lib/migration-statements'

const ROOT = join(import.meta.dir, '..')
const REAL = join(ROOT, 'drizzle', 'migrations')

describe('upgradePlans', () => {
  test('a tip whose files all sort first upgrades in filename order', () => {
    const [p] = upgradePlans([{ rev: 'base', files: ['0001_a.sql'] }], ['0001_a.sql', '20261030110000_x.sql'])
    expect(p.then).toEqual(['20261030110000_x.sql'])
    expect(p.inversions).toEqual([])
  })

  test('a tip holding a later-named file inverts the earlier one', () => {
    const [p] = upgradePlans(
      [{ rev: 'b-landed', files: ['0001_a.sql', '20261030120000_b.sql'] }],
      ['0001_a.sql', '20261030110000_a.sql', '20261030120000_b.sql'],
    )
    expect(p.applied).toEqual(['0001_a.sql', '20261030120000_b.sql'])
    expect(p.inversions).toEqual(['20261030110000_a.sql'])
  })

  test('files the final tree no longer has are not "applied" (they cannot be: migrations are immutable)', () => {
    const [p] = upgradePlans([{ rev: 'x', files: ['0001_a.sql', '0002_gone.sql'] }], ['0001_a.sql'])
    expect(p.applied).toEqual(['0001_a.sql'])
  })
})

describe('proveOrders, in Postgres', () => {
  let scratch: Scratch
  const dirs: string[] = []

  beforeAll(async () => {
    scratch = await scratchPostgres(ROOT)
  }, 120_000)

  afterAll(async () => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
    await scratch?.close()
  }, 120_000)

  /**
   * This repo's numbered migrations plus `extra`, in a scratch directory. The
   * copy stops at the cutover: A and B below are named as if generated then,
   * so a timestamped migration main has landed since would sort after them
   * and turn "main" into a deployment they invert against.
   */
  function tree(extra: Record<string, string>, withReal = true): { dir: string; files: string[] } {
    const dir = mkdtempSync(join(tmpdir(), 'migration-order-test-'))
    dirs.push(dir)
    if (withReal) {
      cpSync(REAL, dir, { recursive: true, filter: (src) => !TIMESTAMP_PREFIX.test(prefixOf(basename(src)) ?? '') })
    }
    for (const [name, sql] of Object.entries(extra)) writeFileSync(join(dir, name), sql)
    return { dir, files: listMigrationFiles(dir) }
  }

  // Branch A and branch B each forked from main and added a migration. A was
  // written first, so it sorts first; either may land first.
  const A = '20261030110000_branch_a_audit_tags.sql'
  const B = '20261030120000_branch_b_shift_notes.sql'
  const independent = {
    [A]: 'CREATE TABLE "branch_a_tags" ("id" text PRIMARY KEY NOT NULL, "label" text NOT NULL);\n--> statement-breakpoint\nALTER TABLE "users" ADD COLUMN "branch_a_flag" boolean DEFAULT false NOT NULL;',
    [B]: 'CREATE TABLE "branch_b_notes" ("id" text PRIMARY KEY NOT NULL);\n--> statement-breakpoint\nALTER TABLE "users" ADD COLUMN "branch_b_note" text;\n--> statement-breakpoint\nCREATE INDEX "users_branch_b_note_idx" ON "users" ("branch_b_note");',
  }

  test('two independent migrations build the same schema in either merge order, and twice over', async () => {
    const { dir, files } = tree(independent)
    const main = files.filter((f) => f !== A && f !== B)
    const plans = upgradePlans(
      [
        { rev: 'main', files: main },
        { rev: 'A-landed-first', files: [...main, A] },
        { rev: 'B-landed-first', files: [...main, B] },
      ],
      files,
    )
    // Only B-first inverts: A then runs after B on that deployment.
    expect(plans.map((p) => p.inversions)).toEqual([[], [], [A]])
    const report = await proveOrders(ROOT, dir, files, plans, scratch.adminUrl)
    expect(report.mismatches).toEqual([])
  }, 120_000)

  test('BREAK IT: two migrations that do not commute are caught, naming the order', async () => {
    const { dir, files } = tree(
      {
        '0000_base.sql': 'CREATE TABLE "users" ("id" text PRIMARY KEY NOT NULL);',
        [A]: `CREATE OR REPLACE FUNCTION branch_probe() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;`,
        [B]: `CREATE OR REPLACE FUNCTION branch_probe() RETURNS int LANGUAGE sql AS $$ SELECT 2 $$;`,
      },
      false,
    )
    const plans = upgradePlans([{ rev: 'B-landed-first', files: ['0000_base.sql', B] }], files)
    const report = await proveOrders(ROOT, dir, files, plans, scratch.adminUrl)
    expect(report.mismatches).toHaveLength(1)
    expect(report.mismatches[0]).toContain(`upgrading from B-landed-first applies ${A} after ${B}`)
    expect(report.mismatches[0]).toContain('SELECT 2')
  }, 120_000)

  test('BREAK IT: an upgrade order that cannot even run is reported, not thrown', async () => {
    const { dir, files } = tree(
      {
        '0000_base.sql': 'CREATE TABLE "users" ("id" text PRIMARY KEY NOT NULL);',
        // A drops what B, landed first, now depends on.
        [A]: 'ALTER TABLE "users" DROP COLUMN "id";',
        [B]: 'CREATE VIEW "user_ids" AS SELECT "id" FROM "users";',
      },
      false,
    )
    const plans = upgradePlans([{ rev: 'B-landed-first', files: ['0000_base.sql', B] }], files)
    const report = await proveOrders(ROOT, dir, files, plans, scratch.adminUrl)
    expect(report.mismatches.join('\n')).toContain('fails')
  }, 120_000)
})
