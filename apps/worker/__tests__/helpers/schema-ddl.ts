/**
 * Derive an integration fixture's tables from the Drizzle schema, never restate them (#3011).
 *
 * Fourteen integration test files used to hand-write `CREATE TABLE` DDL for tables
 * the app declares in apps/worker/db/schema/. Nothing checked that a hand-written
 * copy still matched the declaration, so adding a column to a real table (#2997:
 * `crypto_format`) broke seven fixtures at once, with an error that pointed at the
 * fixture rather than at the change that caused it.
 *
 * This builds the DDL from the SAME table objects the app queries through, using
 * drizzle-kit's own generator (the one `bun run db:generate` and the migration
 * drift check use). Columns, defaults, CHECK constraints, unique constraints,
 * indexes and foreign keys all come from the declaration, so a column added to
 * the schema reaches every fixture with no edit here.
 *
 * Foreign keys are followed: asking for `conversations` also creates `hubs`,
 * because a fixture that dropped the constraint would not be the schema the
 * server runs on. A test that needs a row in a referenced table inserts a real
 * one (see `insertTestHub`).
 *
 * Tables are created UNQUALIFIED, inside the schema named by `search_path`, so one
 * test schema holds one isolated copy.
 */
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core'
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api'
import type postgres from 'postgres'
import type { Database } from '../../db'
import * as schema from '../../db/schema'

/** `tables` plus every table reachable through a foreign key, each once. */
export function withForeignKeyClosure(tables: readonly PgTable[]): PgTable[] {
  const seen = new Map<string, PgTable>()
  const visit = (table: PgTable) => {
    const config = getTableConfig(table)
    if (seen.has(config.name)) return
    seen.set(config.name, table)
    for (const fk of config.foreignKeys) visit(fk.reference().foreignTable as PgTable)
  }
  for (const table of tables) visit(table)
  return [...seen.values()]
}

/** The ordered statements that create `tables` (and what they reference) as the schema declares them. */
export async function schemaStatements(tables: readonly PgTable[]): Promise<string[]> {
  const modules: Record<string, PgTable> = {}
  for (const table of withForeignKeyClosure(tables)) modules[getTableConfig(table).name] = table
  const statements = await generateMigration(generateDrizzleJson({}), generateDrizzleJson(modules))
  // drizzle-kit qualifies foreign-key targets as "public"."table". Left in, a
  // fixture's FK would bind to the real public.<table> of whatever database the
  // run is pointed at instead of the isolated copy created beside it.
  const created = statements.map((statement) => statement.replaceAll('"public".', ''))
  // A column default may draw on a sequence the schema does not declare (audit_log.seq
  // takes nextval('audit_log_seq_default_seq'), which its migration creates). The
  // sequence is named by the default itself, so it is read from there.
  const sequences = new Set(created.flatMap((statement) => [...statement.matchAll(/nextval\('([^']+)'/g)].map((match) => match[1] ?? '')))
  return [...[...sequences].filter(Boolean).map((name) => `CREATE SEQUENCE IF NOT EXISTS "${name}"`), ...created]
}

/**
 * Create `schemaName` and, inside it, the declared tables for `tables`.
 * `admin` is any connection; the statements run on one transaction pinned to
 * `schemaName` so the unqualified names land there.
 */
export async function createSchemaTables(
  admin: ReturnType<typeof postgres>,
  schemaName: string,
  tables: readonly PgTable[],
): Promise<void> {
  const statements = await schemaStatements(tables)
  await admin.unsafe(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`)
  await admin.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL search_path TO "${schemaName}"`)
    for (const statement of statements) await tx.unsafe(statement)
  })
}

/** Insert a real `hubs` row — the parent every hub-scoped table references. */
export async function insertTestHub(db: Database, id: string): Promise<void> {
  await db.insert(schema.hubs).values({ id, name: id, slug: id, createdBy: 'test-fixture' })
}
