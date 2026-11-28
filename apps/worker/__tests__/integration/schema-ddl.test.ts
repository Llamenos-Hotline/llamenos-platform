/**
 * The schema-derived fixture DDL (#3011) is faithful to the declaration, for EVERY table.
 *
 * `createSchemaTables` is what every integration fixture now trusts in place of
 * a hand-written copy, so it is held to the one property that makes that safe:
 * what it creates is what the schema declares — same tables, same columns — and
 * it is self-contained. Requesting every declared table at once also proves the
 * generated DDL applies cleanly for the whole schema, not just the dozen tables
 * the fixtures happen to ask for today.
 *
 * Requires postgres at DATABASE_URL. Own schema, dropped on teardown.
 */
import '../../db/pg-array-patch'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import postgres from 'postgres'
import { is } from 'drizzle-orm'
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core'
import * as schema from '../../db/schema'
import { requireDatabaseUrl } from '../helpers/database-url'
import { createSchemaTables, withForeignKeyClosure } from '../helpers/schema-ddl'

const TEST_SCHEMA = `test_schema_ddl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

const declared = Object.values(schema).filter((value) => is(value, PgTable)) as PgTable[]

let sql: ReturnType<typeof postgres>

beforeAll(async () => {
  sql = postgres(requireDatabaseUrl(), { max: 1 })
  await createSchemaTables(sql, TEST_SCHEMA, declared)
}, 120_000)

afterAll(async () => {
  await sql`DROP SCHEMA IF EXISTS ${sql(TEST_SCHEMA)} CASCADE`
  await sql.end()
})

describe('createSchemaTables over the whole schema', () => {
  it('finds the declared tables (not vacuous)', () => {
    expect(declared.length).toBeGreaterThan(50)
  })

  it('creates every declared table with exactly the declared columns', async () => {
    const rows = await sql<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = ${TEST_SCHEMA}
    `
    const created = new Map<string, Set<string>>()
    for (const row of rows) {
      const columns = created.get(row.table_name) ?? new Set<string>()
      columns.add(row.column_name)
      created.set(row.table_name, columns)
    }
    for (const table of declared) {
      const config = getTableConfig(table)
      expect([...(created.get(config.name) ?? [])].sort(), config.name).toEqual(
        config.columns.map((column) => column.name).sort(),
      )
    }
    expect(created.size).toBe(declared.length)
  })

  it('every foreign key points inside the fixture schema, never at the real public table', async () => {
    const outside = await sql<{ conname: string; target: string }[]>`
      SELECT c.conname, tn.nspname || '.' || t.relname AS target
      FROM pg_constraint c
      JOIN pg_class s ON s.oid = c.conrelid
      JOIN pg_namespace sn ON sn.oid = s.relnamespace
      JOIN pg_class t ON t.oid = c.confrelid
      JOIN pg_namespace tn ON tn.oid = t.relnamespace
      WHERE c.contype = 'f' AND sn.nspname = ${TEST_SCHEMA} AND tn.nspname <> ${TEST_SCHEMA}
    `
    expect(outside).toEqual([])
  })
})

describe('withForeignKeyClosure', () => {
  it('adds the tables a requested table references, once each', () => {
    const names = withForeignKeyClosure([schema.signalMessageQueue, schema.hubs]).map(
      (table) => getTableConfig(table).name,
    )
    expect(names).toContain('hubs')
    expect(names.filter((name) => name === 'hubs')).toHaveLength(1)
  })
})
