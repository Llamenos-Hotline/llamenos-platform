/**
 * Construction-time proof that a service was handed a real Drizzle database.
 *
 * `Database` is a structural type, so a cast (`{} as Database`, a `vi.fn()`
 * mock, a half-built stand-in) satisfies it while holding none of the query
 * builder. The first symptom is then a `TypeError: this.db.select is not a
 * function` thrown from deep inside whatever request happened to touch the
 * service first. Services whose first use is on a path that must not fail
 * (an opt-out being recorded, #2447) call this from their constructor so the
 * misconfiguration fails where it is made, naming what was missing.
 *
 * Type-only import: this module must stay loadable outside Bun (vitest/Node),
 * and `../db` pulls in `bun:sql`.
 */
import type { Database } from '../db'

const QUERY_BUILDERS = ['select', 'insert', 'update', 'delete'] as const

export function assertDatabase(db: Database | null | undefined, owner: string): Database {
  if (db === null || db === undefined) {
    throw new Error(`${owner} requires a Drizzle database, but received ${db === null ? 'null' : 'undefined'}`)
  }
  const missing = QUERY_BUILDERS.filter(
    (method) => typeof (db as unknown as Record<string, unknown>)[method] !== 'function',
  )
  if (missing.length > 0) {
    throw new Error(
      `${owner} requires a Drizzle database, but the value it was given has no ${missing.map((m) => `${m}()`).join(', ')} ` +
        `(received ${Object.prototype.toString.call(db)} with keys [${Object.keys(db).join(', ')}])`,
    )
  }
  return db
}
