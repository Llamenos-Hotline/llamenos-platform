#!/usr/bin/env bun
/**
 * Apply Drizzle SQL migrations in order before the app starts.
 *
 * Runs from deploy/docker/docker-entrypoint.sh on EVERY container start, so
 * "apply each file at most once" is a data-integrity requirement, not a
 * nicety. The previous version had no ledger: it read every *.sql file in
 * drizzle/migrations/, sorted by filename, and executed all of them on every
 * boot, swallowing "already exists" / "does not exist" errors to survive the
 * replay.
 *
 * That replay destroyed live data. `0024_ep03_teams_tags.sql:50` is a bare
 * `ALTER TABLE "users" DROP COLUMN "team_id"` and `0026_add-team-id-to-users`
 * re-adds it. On the first boot the DROP failed harmlessly (no such column)
 * and 0026 created it; on every boot after that the column EXISTED, so the
 * DROP succeeded and every user's team_id was destroyed and re-added as NULL.
 * The same replay re-ran `0001`'s UPDATE over role permissions and `0049`'s
 * UPDATE that flags every contact as needing re-encryption.
 *
 * This runner therefore keeps a ledger (`llamenos_schema_migrations`) keyed by
 * filename, holds a Postgres advisory lock for the whole run so the two pods
 * Helm starts (deploy/helm/llamenos/values.yaml: replicas: 2) serialise, and
 * records a file only once all of its statements have succeeded. A file whose
 * contents changed after being recorded is a hard failure, never a silent
 * re-run.
 *
 * Shipped files under drizzle/migrations/ are never edited (CLAUDE.md) — with
 * a ledger, 0024 runs exactly once on a fresh database, before 0026, which is
 * the correct sequence and needs no change to either file.
 */
import { SQL } from 'bun'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  console.error('[migrate] DATABASE_URL is required')
  process.exit(1)
}

const migrationsDir = join(import.meta.dir, '..', 'drizzle', 'migrations')

/** Ledger of applied migrations. Keyed by filename, the same key used to sort. */
const LEDGER_TABLE = 'llamenos_schema_migrations'

/**
 * Advisory lock held for the whole run so concurrent boots serialise.
 * Session-scoped: Postgres releases it if a pod dies mid-migration, so a crash
 * cannot wedge the next deploy. The value is arbitrary but must never change.
 */
const ADVISORY_LOCK_KEY = 7_742_010_914_551

/**
 * A table that only exists once the schema has been built. Its presence
 * distinguishes "fresh database" from "already migrated by the old, ledgerless
 * runner" on the single run that introduces the ledger.
 */
const SCHEMA_SENTINEL_TABLE = 'users'

const files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort()

if (files.length === 0) {
  console.log('[migrate] No migration files found')
  process.exit(0)
}

/**
 * Make DDL statements idempotent by injecting IF NOT EXISTS / IF EXISTS guards.
 * Drizzle generates bare CREATE/DROP without these guards.
 */
function makeIdempotent(stmt: string): string {
  let s = stmt
  // CREATE TABLE → CREATE TABLE IF NOT EXISTS
  s = s.replace(
    /\bCREATE TABLE\b(?!\s+IF\s+NOT\s+EXISTS)/gi,
    'CREATE TABLE IF NOT EXISTS',
  )
  // CREATE INDEX → CREATE INDEX IF NOT EXISTS
  s = s.replace(
    /\bCREATE INDEX\b(?!\s+IF\s+NOT\s+EXISTS)/gi,
    'CREATE INDEX IF NOT EXISTS',
  )
  // CREATE UNIQUE INDEX → CREATE UNIQUE INDEX IF NOT EXISTS
  s = s.replace(
    /\bCREATE UNIQUE INDEX\b(?!\s+IF\s+NOT\s+EXISTS)/gi,
    'CREATE UNIQUE INDEX IF NOT EXISTS',
  )
  // DROP TABLE → DROP TABLE IF EXISTS
  s = s.replace(
    /\bDROP TABLE\b(?!\s+IF\s+EXISTS)/gi,
    'DROP TABLE IF EXISTS',
  )
  // DROP INDEX → DROP INDEX IF EXISTS
  s = s.replace(
    /\bDROP INDEX\b(?!\s+IF\s+EXISTS)/gi,
    'DROP INDEX IF EXISTS',
  )
  return s
}

/** Identifiers come from our own shipped migrations; refuse anything exotic. */
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Would running this chunk during the catch-up pass destroy rows that are
 * there right now?
 *
 * Asked of the LIVE DATABASE rather than guessed from the SQL text, because
 * the text alone cannot tell the two cases apart:
 *
 *   - `0024` drops `users.team_id`, which `0026` re-adds and which then holds
 *     real assignments. Re-running that drop is what destroyed team_id on
 *     every restart. It must be skipped.
 *   - `0031` drops `bans.phone_plain`, and `0015` drops `nostr_event_outbox`.
 *     Both were already gone, but the catch-up pass re-runs the earlier
 *     `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN` that first introduced them,
 *     so they come back EMPTY. Skipping those drops leaves a caught-up
 *     database permanently out of step with a freshly migrated one.
 *
 * "Does this object currently hold any data?" separates them exactly, and is
 * the property actually being protected. UPDATE / DELETE / TRUNCATE cannot be
 * evaluated this way and are always skipped.
 *
 * Deliberately not treated as destructive at all: DROP CONSTRAINT, DROP INDEX,
 * DROP DEFAULT and DROP NOT NULL — they reshape a table without deleting row
 * data, and later migrations depend on them having run.
 */
async function catchUpWouldDestroyData(sql: SQL, chunk: string): Promise<boolean> {
  const s = chunk.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim()

  // Unevaluable and rerun-unsafe: 0001 rewrites role permissions, 0049 flags
  // contacts. Their effect is already in the database.
  if (/\bTRUNCATE\b/i.test(s) || /\bDELETE\s+FROM\b/i.test(s) || /^\s*UPDATE\s+/i.test(s)) {
    return true
  }

  for (const m of s.matchAll(
    /ALTER\s+TABLE\s+"?([A-Za-z0-9_]+)"?\s+DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?"?([A-Za-z0-9_]+)"?/gi,
  )) {
    const [, table, column] = m
    if (!SAFE_IDENT.test(table) || !SAFE_IDENT.test(column)) return true
    const [row] = (await sql.unsafe(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
       ) AS present`,
      [table, column],
    )) as { present: boolean }[]
    if (!row.present) continue
    const [{ has_data }] = (await sql.unsafe(
      `SELECT EXISTS (SELECT 1 FROM "${table}" WHERE "${column}" IS NOT NULL) AS has_data`,
    )) as { has_data: boolean }[]
    if (has_data) return true
  }

  for (const m of s.matchAll(/\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?"?([A-Za-z0-9_]+)"?/gi)) {
    const [, table] = m
    if (!SAFE_IDENT.test(table)) return true
    const [row] = (await sql.unsafe(
      `SELECT to_regclass('public.' || quote_ident($1)) IS NOT NULL AS present`,
      [table],
    )) as { present: boolean }[]
    if (!row.present) continue
    const [{ has_data }] = (await sql.unsafe(
      `SELECT EXISTS (SELECT 1 FROM "${table}") AS has_data`,
    )) as { has_data: boolean }[]
    if (has_data) return true
  }

  return false
}

/**
 * Should this error be tolerated as "this statement's effect is already in
 * place"?
 *
 * Two different questions, depending on which is the source of truth:
 *
 *  - Applying a file for the first time (`lenient: false`): the FILES are the
 *    source of truth and any surprise is real. Tolerance is paired with the
 *    statement shape that can legitimately produce it, so a "does not exist"
 *    from a CREATE, INSERT or UPDATE is a hard failure. That closes the hole
 *    the ledger alone does not: under the old blanket message match, a
 *    genuinely failed CREATE TABLE made every later statement against that
 *    table report "relation ... does not exist", each was logged as skipped,
 *    and the run exited 0 onto a half-applied schema.
 *
 *  - Reconciling an already-migrated database (`lenient: true`): the SCHEMA is
 *    the source of truth. These files ran once already, and old DDL routinely
 *    references objects that later migrations removed — 0000 indexes
 *    `bans.phone`, which 0008 drops — so "does not exist" here is expected,
 *    not a defect. Failing hard would refuse to boot every database that
 *    predates the ledger.
 */
function isAlreadyApplied(
  stmt: string,
  msg: string,
  code: unknown,
  lenient: boolean,
): boolean {
  const s = stmt.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim()
  const isDrop = /\bDROP\s+(COLUMN|CONSTRAINT|INDEX|TABLE|TYPE|SEQUENCE|VIEW)\b/i.test(s)
  const isAdd = /\b(CREATE|ADD\s+(COLUMN|CONSTRAINT|PRIMARY\s+KEY))\b/i.test(s)
  const isInsert = /^\s*INSERT\s+INTO\b/i.test(s)

  // foreign_key_violation on ADD CONSTRAINT: re-adding an old FK after a later
  // migration re-pointed it fails because existing rows reference the new
  // table. The correct constraint is installed by that later migration.
  if (/\bADD\s+CONSTRAINT\b/i.test(s) && code === '23503') return true

  if (lenient) {
    return (
      msg.includes('already exists') ||
      msg.includes('does not exist') ||
      msg.includes('duplicate key') ||
      msg.includes('duplicate column') ||
      msg.includes('multiple primary keys')
    )
  }

  // The object a DROP targets is already gone.
  if (isDrop && msg.includes('does not exist')) return true
  // The object a CREATE/ADD would introduce is already there.
  if (isAdd && (msg.includes('already exists') || msg.includes('duplicate column'))) return true
  if (isAdd && msg.includes('multiple primary keys')) return true
  if (isInsert && msg.includes('duplicate key')) return true

  return false
}

/**
 * Note a table the catch-up pass resurrected and then failed to rename away.
 *
 * `0001` renames `volunteers` to `users`. During catch-up the earlier
 * `CREATE TABLE IF NOT EXISTS "volunteers"` in `0000` runs again and recreates
 * that table EMPTY, because the rename already happened on the original pass.
 * The rename then fails ("users already exists"), leaving a stray empty
 * `volunteers` alongside the real `users` — permanent drift from what a fresh
 * migration produces.
 *
 * Only recorded here, never dropped here: at this point the replay has also
 * re-created the stale foreign keys that `0009` and `0010` remove later in the
 * same pass, so an immediate DROP fails on the dependency. Cleanup runs once
 * the whole pass is done (`cleanUpResurrectedTables`), which needs no CASCADE.
 */
function noteResurrectedRenameSource(
  stmt: string,
  msg: string,
  into: Map<string, string>,
): void {
  if (!msg.includes('already exists')) return
  const m = /ALTER\s+TABLE\s+"?([A-Za-z0-9_]+)"?\s+RENAME\s+TO\s+"?([A-Za-z0-9_]+)"?/i.exec(
    stmt.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' '),
  )
  if (!m) return
  const [, source, target] = m
  if (!SAFE_IDENT.test(source) || !SAFE_IDENT.test(target)) return
  into.set(source, target)
}

/**
 * Drop the tables noted above, once the catch-up pass has finished.
 *
 * Dropped only when the rename target exists and the source is still EMPTY, so
 * this can never discard data: rows in the source mean the rename genuinely
 * has not happened and the earlier failure was something else. Drift that
 * cannot be cleaned is reported, never fatal — a stray empty table is not a
 * reason to refuse to boot.
 */
async function cleanUpResurrectedTables(
  sql: SQL,
  candidates: Map<string, string>,
): Promise<void> {
  for (const [source, target] of candidates) {
    const [{ ok }] = (await sql.unsafe(
      `SELECT to_regclass('public.' || quote_ident($1)) IS NOT NULL
          AND to_regclass('public.' || quote_ident($2)) IS NOT NULL AS ok`,
      [source, target],
    )) as { ok: boolean }[]
    if (!ok) continue

    const [{ has_data }] = (await sql.unsafe(
      `SELECT EXISTS (SELECT 1 FROM "${source}") AS has_data`,
    )) as { has_data: boolean }[]
    if (has_data) {
      console.warn(
        `[migrate] "${source}" still holds rows but "${target}" also exists — ` +
          'leaving both in place for an operator to reconcile.',
      )
      continue
    }

    try {
      await sql.unsafe(`DROP TABLE "${source}"`)
      console.log(
        `[migrate] dropped empty "${source}" recreated by the catch-up replay ` +
          `(already renamed to "${target}")`,
      )
    } catch (err) {
      console.warn(
        `[migrate] could not drop the empty leftover "${source}": ` +
          `${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
}

function checksumOf(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex')
}

const sql = new SQL({ url: databaseUrl, max: 1, connectionTimeout: 30 })

let lockHeld = false
try {
  // ── Serialise concurrent boots ────────────────────────────────────────────
  // Blocks until the other pod's run finishes. Taken before the ledger table
  // is created so two pods cannot race on creating it either.
  console.log('[migrate] Acquiring advisory lock...')
  await sql.unsafe(`SELECT pg_advisory_lock(${ADVISORY_LOCK_KEY})`)
  lockHeld = true
  console.log('[migrate] Advisory lock acquired')

  const [{ ledger_exists: ledgerExisted, schema_exists: schemaExisted }] = (await sql.unsafe(
    `SELECT to_regclass('public.${LEDGER_TABLE}') IS NOT NULL AS ledger_exists,
            to_regclass('public.${SCHEMA_SENTINEL_TABLE}') IS NOT NULL AS schema_exists`,
  )) as { ledger_exists: boolean; schema_exists: boolean }[]

  // `applied_at IS NULL` marks a row RESERVED for the catch-up pass. Reserving
  // up front, rather than re-deciding "is this a catch-up?" on every boot, is
  // what makes a half-finished catch-up safe to resume: the reservation is in
  // the database, so a crashed run resumes in catch-up mode instead of
  // downgrading to a strict replay that would then destroy the very data the
  // catch-up exists to protect.
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
      filename    text PRIMARY KEY,
      checksum    text,
      applied_at  timestamptz,
      mode        text NOT NULL,
      skipped_sql jsonb NOT NULL DEFAULT '[]'::jsonb
    )
  `)

  if (!ledgerExisted && schemaExisted) {
    // This database has a schema but no ledger, so the old ledgerless runner
    // built it and has already executed every file at least once.
    for (const file of files) {
      await sql.unsafe(
        `INSERT INTO ${LEDGER_TABLE} (filename, mode) VALUES ($1, 'catch-up')
         ON CONFLICT (filename) DO NOTHING`,
        [file],
      )
    }
    console.log('[migrate] ───────────────────────────────────────────────────────')
    console.log('[migrate] CATCH-UP RUN — this is NOT normal operation.')
    console.log('[migrate] This database has a schema but no migration ledger, so')
    console.log('[migrate] it was built by the old runner that replayed every file')
    console.log('[migrate] on every boot. All files are being reconciled once and')
    console.log('[migrate] recorded. Statements that destroy row data are SKIPPED')
    console.log('[migrate] and logged below: they already took effect when the file')
    console.log('[migrate] was first applied, and re-running them is precisely what')
    console.log('[migrate] destroyed users.team_id on every restart.')
    console.log('[migrate] ───────────────────────────────────────────────────────')
  } else if (!ledgerExisted) {
    console.log('[migrate] Fresh database — applying every migration in order')
  }

  const ledger = new Map(
    ((await sql.unsafe(
      `SELECT filename, checksum, applied_at FROM ${LEDGER_TABLE}`,
    )) as { filename: string; checksum: string | null; applied_at: Date | null }[]).map(
      (r) => [r.filename, r] as const,
    ),
  )

  let applied = 0
  let reconciled = 0
  let alreadyDone = 0
  /** Tables the catch-up replay recreated, to be cleaned up after the pass. */
  const resurrected = new Map<string, string>()

  for (const file of files) {
    const content = readFileSync(join(migrationsDir, file), 'utf-8')
    const checksum = checksumOf(content)

    const row = ledger.get(file)
    if (row?.applied_at != null) {
      if (row.checksum !== checksum) {
        // Never silently re-run and never silently ignore: a shipped migration
        // changed after it was applied, so the database and the repo disagree
        // about what this file did.
        throw new Error(
          `${file} was applied with checksum ${row.checksum} but now hashes to ${checksum}. ` +
            'Shipped migrations are immutable — revert the edit and add a new migration ' +
            'file instead. Refusing to start.',
        )
      }
      alreadyDone++
      continue
    }

    // A reserved-but-unapplied row means this file is part of the catch-up
    // reconciliation; anything with no row at all is a genuinely new migration
    // and is applied strictly, even on a database that was caught up earlier.
    const catchUp = row !== undefined

    const statements = content
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)

    const skippedSql: string[] = []

    for (const raw of statements) {
      if (catchUp && (await catchUpWouldDestroyData(sql, raw))) {
        const preview = raw.replace(/\s+/g, ' ').slice(0, 120)
        console.log(`[migrate] ${file}: SKIPPED (would destroy live data): ${preview}`)
        skippedSql.push(raw)
        continue
      }

      const stmt = makeIdempotent(raw)
      try {
        await sql.unsafe(stmt)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        const code =
          (err as Record<string, unknown>)?.errno ?? (err as Record<string, unknown>)?.code
        if (isAlreadyApplied(stmt, msg, code, catchUp)) {
          console.log(`[migrate] ${file}: already in place (${msg.slice(0, 80)})`)
          if (catchUp) noteResurrectedRenameSource(stmt, msg, resurrected)
        } else {
          console.error(`[migrate] ${file}: FAILED — ${msg}`)
          console.error(`[migrate]   statement: ${stmt.replace(/\s+/g, ' ').slice(0, 200)}`)
          throw err
        }
      }
    }

    // Marked applied only now: every statement in the file has succeeded (or
    // was a deliberate catch-up skip). A crash mid-file leaves applied_at NULL
    // and the file is retried — in the same mode — on the next boot.
    await sql.unsafe(
      `INSERT INTO ${LEDGER_TABLE} (filename, checksum, applied_at, mode, skipped_sql)
       VALUES ($1, $2, now(), $3, $4::jsonb)
       ON CONFLICT (filename) DO UPDATE
         SET checksum = EXCLUDED.checksum,
             applied_at = EXCLUDED.applied_at,
             skipped_sql = EXCLUDED.skipped_sql`,
      // The array goes to Bun's SQL driver as-is. JSON.stringify-ing it first
      // stores the JSON *string* `"[]"` rather than the array `[]` — the same
      // double-serialisation trap that `bun-jsonb` exists to avoid.
      [file, checksum, catchUp ? 'catch-up' : 'fresh', skippedSql],
    )
    if (catchUp) reconciled++
    else applied++
    console.log(`[migrate] ${file}: ${catchUp ? 'reconciled' : 'applied'}`)
  }

  if (resurrected.size > 0) await cleanUpResurrectedTables(sql, resurrected)

  console.log(
    `[migrate] Done — ${applied} applied, ${reconciled} reconciled, ` +
      `${alreadyDone} already in the ledger, ${files.length} total`,
  )
  if (reconciled > 0) {
    console.log(
      '[migrate] Catch-up complete. Later boots skip every file above; the ' +
        `destructive statements that were skipped are stored in ${LEDGER_TABLE}.skipped_sql.`,
    )
  }
} finally {
  if (lockHeld) {
    await sql.unsafe(`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`).catch(() => {})
  }
  await sql.close()
}
