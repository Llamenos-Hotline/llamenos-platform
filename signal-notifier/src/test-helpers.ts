import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from './db/schema'

/**
 * This suite runs under `bunx vitest run` (see package.json) — NOT
 * `bun --bun vitest run`. signal-notifier is not a root workspace member, so
 * it has no node_modules of its own and resolves every dependency upward.
 * Under the bun runtime, vite's CJS interop handed `import { z } from 'zod'`
 * back as undefined, and routes.ts died at `z.object` during collection; the
 * same files collect and pass under node. The whole package's tests ran in no
 * workflow until #1641, so nothing reported it.
 *
 * The database named by TEST_DATABASE_URL (default `llamenos_test` on the dev
 * instance) must already exist — these helpers create a SCHEMA per suite, not
 * a database. Locally:
 *   docker exec llamenos-dev-postgres-1 psql -U llamenos -d llamenos \
 *     -c 'CREATE DATABASE llamenos_test'
 */
const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://llamenos:dev@localhost:5432/llamenos_test'

/**
 * Create an isolated test schema for each test suite to avoid parallel conflicts.
 */
export async function createTestDb(suiteName: string) {
  const schemaName = `test_${suiteName}_${Date.now()}`
  const sql = postgres(TEST_DB_URL, { max: 3 })

  await sql`CREATE SCHEMA ${sql(schemaName)}`
  await sql`SET search_path TO ${sql(schemaName)}`
  await sql`
    CREATE TABLE signal_identifiers (
      hash TEXT PRIMARY KEY,
      ciphertext TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('phone', 'username')),
      created_at BIGINT NOT NULL
    )
  `
  await sql`
    CREATE TABLE signal_audit_log (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      action TEXT NOT NULL,
      identifier_hash TEXT,
      success TEXT NOT NULL CHECK (success IN ('true', 'false')),
      error_message TEXT,
      metadata TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `

  // Reconnect with search_path set
  await sql.end()
  const connSql = postgres(`${TEST_DB_URL}?search_path=${schemaName}`, { max: 3 })
  const db = drizzle(connSql, { schema })

  return {
    sql: connSql,
    db,
    async cleanup() {
      await connSql`DROP SCHEMA ${connSql(schemaName)} CASCADE`
      await connSql.end()
    },
    async truncateAll() {
      await connSql`TRUNCATE signal_identifiers`
      await connSql`TRUNCATE signal_audit_log`
    },
  }
}
