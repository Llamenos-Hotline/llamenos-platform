/**
 * Direct PostgreSQL query helpers for BDD step definitions (Epic 365).
 *
 * Bypasses the API to verify persisted state directly in the database.
 * Uses postgres.js (works in both Node.js/Playwright and Bun contexts).
 *
 * Column names use snake_case (matching PostgreSQL conventions).
 *
 * The connection is verified against the server under test on first use: these
 * helpers only mean anything if they query the SAME database the server writes
 * to. See assertSharedDatabase() below, and the rail in
 * tests/db-helpers-identity-rail.spec.ts.
 */
import postgres from 'postgres'
import { assertSameDatabase } from './db-identity'

/**
 * Resolve the test database URL.
 *
 * There is deliberately NO fallback. A default silently connected TestDB to the
 * shared dev database whenever DATABASE_URL was unset, while the server under
 * test could be pointed somewhere else entirely — both sides then "worked" and
 * asserted against different data. It was also redundant: scripts/dev-bun.sh
 * already exports DATABASE_URL with its own default, so the fallback never
 * helped local dev; it only fired when something had already gone wrong.
 */
function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error(
      '[db-helpers] DATABASE_URL is required.\n' +
        'TestDB bypasses the API to assert persisted state, so it MUST query the same\n' +
        'database the server under test writes to. There is no default on purpose: a\n' +
        'fallback would connect TestDB to the shared dev database while the server used\n' +
        'another, and every direct-DB assertion would then pass or fail for reasons\n' +
        'unrelated to the code under test.\n' +
        'Export DATABASE_URL pointing at the server\'s database and re-run\n' +
        '(scripts/dev-bun.sh exports one for local dev).',
    )
  }
  return url
}

// Lazy: the URL is read at FIRST USE, not at import. Creating the client at
// import time froze whatever DATABASE_URL happened to be set the moment any
// step file imported this module, so a harness that sets it later (e.g. a
// Playwright global setup) was silently ignored.
let client: postgres.Sql | null = null

function rawSql(): postgres.Sql {
  if (!client) {
    client = postgres(requireDatabaseUrl(), {
      connect_timeout: 10,
      onnotice: () => {},
    })
  }
  return client
}

let identityCheck: Promise<void> | null = null

/**
 * Verify — once, on first query — that TestDB and the server under test are
 * looking at the same PostgreSQL database.
 *
 * The comparison itself lives in `tests/db-identity.ts`, shared with
 * `scripts/check-db-identity.ts` so the runner can make the SAME assertion as
 * its own pipeline step before a single scenario runs. One implementation, two
 * callers: a second copy is how the invariant drifts.
 *
 * An unreachable server is a HARD failure, not a skip: a check that quietly
 * passes when its dependency is down is exactly the false signal this replaces.
 */
function assertSharedDatabase(): Promise<void> {
  identityCheck ??= assertSameDatabase(rawSql()).then(() => undefined)
  return identityCheck
}

/** The verified connection. Every query path goes through here. */
async function sql(): Promise<postgres.Sql> {
  await assertSharedDatabase()
  return rawSql()
}

/** Validate a SQL identifier (table/column name) to prevent injection. */
function validateIdentifier(name: string): void {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid SQL identifier: ${name}`)
  }
}

export class TestDB {
  /**
   * Get a raw row by id from any table.
   * Returns null if no row found.
   */
  static async getRow(table: string, id: string): Promise<Record<string, unknown> | null> {
    validateIdentifier(table)
    const rows = await (await sql()).unsafe(
      `SELECT * FROM ${table} WHERE id = $1 LIMIT 1`,
      [id],
    )
    return rows.length > 0 ? (rows[0] as Record<string, unknown>) : null
  }

  /**
   * Check if a JSONB column value is a proper object (not double-serialized string).
   *
   * Uses PostgreSQL's `jsonb_typeof()` to detect the actual storage type.
   * Double-serialization stores `"{"key":"val"}"` as a JSON string instead of
   * a JSON object — this helper detects that.
   */
  static async assertJsonbField(
    table: string,
    idColumn: string,
    id: string,
    jsonbColumn: string,
  ): Promise<{
    value: unknown
    pgType: string
    isDoubleStringified: boolean
  }> {
    for (const name of [table, idColumn, jsonbColumn]) {
      validateIdentifier(name)
    }

    const rows = await (await sql()).unsafe(
      `SELECT jsonb_typeof(${jsonbColumn}) as pg_type, ${jsonbColumn} as val FROM ${table} WHERE ${idColumn} = $1 LIMIT 1`,
      [id],
    )

    if (rows.length === 0) {
      throw new Error(`No row found in ${table} where ${idColumn} = '${id}'`)
    }

    const row = rows[0] as unknown as { pg_type: string; val: unknown }
    const pgType = row.pg_type
    const value = row.val

    // Double-stringified check: if pgType is 'string' and the string parses as
    // an object/array, the value was double-serialized
    let isDoubleStringified = false
    if (pgType === 'string' && typeof value === 'string') {
      try {
        const parsed = JSON.parse(value)
        if (typeof parsed === 'object' && parsed !== null) {
          isDoubleStringified = true
        }
      } catch {
        // Not parseable — it's a genuine string value
      }
    }

    return { value, pgType, isDoubleStringified }
  }

  /**
   * Get conversation metadata directly from DB.
   */
  static async getConversationMetadata(id: string): Promise<unknown> {
    const rows = await (await sql())`SELECT * FROM conversations WHERE id = ${id} LIMIT 1`
    return rows.length > 0 ? rows[0] : null
  }

  /**
   * Verify the SHA-256 hash chain in the audit_log table.
   *
   * NOTE: The server computes `createdAt` via `new Date().toISOString()` but the
   * DB column uses `defaultNow()`, so there may be timestamp drift. This helper
   * verifies chain links (previousEntryHash matches prior entryHash) but may
   * not be able to recompute hashes exactly due to this mismatch.
   */
  static async verifyAuditChain(hubId?: string, limit?: number): Promise<{
    valid: boolean
    entries: number
    brokenAt?: number
  }> {
    // Filter by hub_id to verify a single chain in isolation.
    // Different hubs have independent chains; verifying across hubs would
    // interleave entries from separate chains and always fail.
    let rows
    if (hubId) {
      rows = limit !== undefined
        ? await (await sql())`
            SELECT id, action, actor_pubkey, details, previous_entry_hash, entry_hash,
                   to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at
            FROM audit_log WHERE hub_id = ${hubId} ORDER BY created_at ASC LIMIT ${limit}`
        : await (await sql())`
            SELECT id, action, actor_pubkey, details, previous_entry_hash, entry_hash,
                   to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at
            FROM audit_log WHERE hub_id = ${hubId} ORDER BY created_at ASC`
    } else {
      rows = limit !== undefined
        ? await (await sql())`
            SELECT id, action, actor_pubkey, details, previous_entry_hash, entry_hash,
                   to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at
            FROM audit_log WHERE hub_id IS NULL ORDER BY created_at ASC LIMIT ${limit}`
        : await (await sql())`
            SELECT id, action, actor_pubkey, details, previous_entry_hash, entry_hash,
                   to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at
            FROM audit_log WHERE hub_id IS NULL ORDER BY created_at ASC`
    }

    if (rows.length === 0) {
      return { valid: true, entries: 0 }
    }

    const { computeAuditEntryHash } = await import('./integrity-helpers')

    let previousHash: string | null = null

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] as {
        id: string
        action: string
        actor_pubkey: string
        details: Record<string, unknown> | null
        previous_entry_hash: string | null
        entry_hash: string
        created_at: string
      }

      // Check chain link
      if (row.previous_entry_hash !== previousHash) {
        return { valid: false, entries: rows.length, brokenAt: i }
      }

      // Recompute hash and verify
      const computed = computeAuditEntryHash({
        id: row.id,
        action: row.action,
        actorPubkey: row.actor_pubkey,
        createdAt: row.created_at,
        details: row.details ?? {},
        previousEntryHash: row.previous_entry_hash,
      })

      if (computed !== row.entry_hash) {
        return { valid: false, entries: rows.length, brokenAt: i }
      }

      previousHash = row.entry_hash
    }

    return { valid: true, entries: rows.length }
  }

  /**
   * Update a single column on a row identified by id.
   */
  static async updateColumn(table: string, id: string, column: string, value: postgres.Serializable): Promise<void> {
    validateIdentifier(table)
    validateIdentifier(column)
    await (await sql()).unsafe(
      `UPDATE ${table} SET ${column} = $1 WHERE id = $2`,
      [value, id],
    )
  }

  /**
   * Delete the instance-wide telephony provider config (the `provider_configs` row with
   * no hub). There is no API that removes one, so the @global-setting scenarios that
   * create it reset it here: every hub without its own provider falls back to this
   * config, so a leaked one would change which provider every other call scenario
   * reaches.
   */
  static async deleteGlobalProviderConfigs(): Promise<void> {
    await (await sql()).unsafe('DELETE FROM provider_configs WHERE hub_id IS NULL')
  }

  /** Close the database connection pool. */
  static async close(): Promise<void> {
    // Deliberately does NOT go through sql(): closing a connection that was
    // never opened must not trigger the identity check (and must not fail).
    if (!client) return
    const open = client
    client = null
    identityCheck = null
    await open.end()
  }
}
