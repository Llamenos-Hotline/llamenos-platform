/**
 * Drizzle ORM database connection.
 * Uses Bun's native SQL driver via drizzle-orm/bun-sql, behind the pool gate
 * (./pool-gate.ts): no root-pool operation can be issued from inside an open
 * transaction, and an operation that cannot get a connection fails loudly
 * instead of hanging (#1208, #1264).
 */
import './pg-array-patch' // Must be first — patches PgArray before schema loads
import { drizzle, type BunSQLDatabase } from 'drizzle-orm/bun-sql'
import { SQL } from 'bun'
import * as schema from './schema'
import { createLogger } from '../lib/logger'
import { PoolGate, gateClient, type GatedClient, type PoolExhaustedError, type PoolReentryError } from './pool-gate'

export { PoolExhaustedError, PoolReentryError, outsideTransaction } from './pool-gate'

const logger = createLogger('db')

export type Database = BunSQLDatabase<typeof schema>

export interface DatabaseOptions {
  /** Names the pool in exhaustion and re-entry errors. */
  name: string
  /** Pooled connections (PG_POOL_SIZE). */
  max: number
  /** Idle seconds before a pooled connection is closed; 0 keeps it for the pool lifetime. */
  idleTimeout: number
  /** How long an operation may wait for a free connection before it fails (PG_POOL_ACQUIRE_TIMEOUT_MS). */
  acquireTimeoutMs: number
}

let db: Database | null = null

function positiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`)
  }
  return value
}

/**
 * Pool settings for the server's database, from the environment. Each variable
 * is a literal environment read so scripts/check-consumed-env.py sees it.
 */
export function databaseOptionsFromEnv(): DatabaseOptions {
  // PG_IDLE_TIMEOUT=0 disables idle timeouts (connections live for the pool lifetime).
  // Default is 0 so development and test runs don't crash when the pool goes quiet
  // between parallel test batches. Production deployments can set PG_IDLE_TIMEOUT
  // (e.g., 300) to reclaim connections during low-traffic windows.
  const idleTimeoutRaw = process.env.PG_IDLE_TIMEOUT
  return {
    name: 'main',
    max: positiveInt('PG_POOL_SIZE', process.env.PG_POOL_SIZE, 10),
    idleTimeout: idleTimeoutRaw !== undefined ? parseInt(idleTimeoutRaw, 10) : 0,
    acquireTimeoutMs: positiveInt('PG_POOL_ACQUIRE_TIMEOUT_MS', process.env.PG_POOL_ACQUIRE_TIMEOUT_MS, 10_000),
  }
}

/**
 * Open a gated database on its own pool. The server uses {@link createDatabase};
 * this is the constructor behind it, for anything that needs a pool of its own
 * size (a test reproducing exhaustion, a one-off tool).
 */
export function openDatabase(databaseUrl: string, opts: DatabaseOptions): Database {
  const client = new SQL({
    url: databaseUrl,
    max: opts.max,
    idleTimeout: opts.idleTimeout,
    connectionTimeout: 30,
  })
  const gate = new PoolGate({
    name: opts.name,
    max: opts.max,
    acquireTimeoutMs: opts.acquireTimeoutMs,
    onExhausted: (err: PoolExhaustedError) => {
      logger.error('PostgreSQL pool exhausted', err, {
        pool: err.pool,
        waitedMs: err.waitedMs,
        waiting: err.waiting,
        holders: err.holders,
      })
    },
    onReentry: (err: PoolReentryError) => {
      logger.error('Root-pool query refused inside an open transaction', err, { pool: opts.name })
    },
  })
  // drizzle types its client as Bun's full SQL; the gated client implements the
  // part drizzle's bun-sql session calls (unsafe, begin, close) and nothing that
  // could bypass the gate.
  return drizzle({ client: gateClient(client, gate) as GatedClient & SQL, schema })
}

/**
 * Create the Drizzle database instance.
 * Called once at server startup.
 */
export function createDatabase(databaseUrl: string): Database {
  if (db) return db
  db = openDatabase(databaseUrl, databaseOptionsFromEnv())
  return db
}

/**
 * Get the active database instance.
 * Throws if not initialized.
 */
export function getDb(): Database {
  if (!db) throw new Error('Database not initialized — call createDatabase() first')
  return db
}

/** Close a database's pool. */
export async function closeDatabase(database: Database): Promise<void> {
  await (database as Database & { $client: GatedClient }).$client.close()
}

/**
 * Close the database connection.
 */
export async function closeDb(): Promise<void> {
  if (db) {
    await closeDatabase(db)
    db = null
    logger.info('Connection closed')
  }
}

// Re-export schema for convenience
export { schema }
