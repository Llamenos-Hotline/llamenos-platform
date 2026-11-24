/**
 * Serialises writers of a "DELETE all rows, INSERT the new list" replacement.
 */
import { sql } from 'drizzle-orm'
import type { Database } from '../db'

/**
 * Serialise the writers of a "DELETE all rows, INSERT the new list" replacement.
 * Under READ COMMITTED a second writer's DELETE blocks on the first's row locks,
 * then skips the rows the first deleted and cannot see the rows it inserted, so
 * re-inserting a row that is kept (same id) fails on the primary key — a 500 for
 * two concurrent template applications — and rows with new ids survive as a
 * union (#686). Holding a transaction-scoped advisory lock makes each
 * replacement see the previous one's committed state: last writer wins.
 */
export async function lockReplaceAll(tx: Pick<Database, 'execute'>, table: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${table}:replace`}))`)
}
