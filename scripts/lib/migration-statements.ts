/**
 * How a Drizzle migration directory is read: which files are migrations, in
 * what order they run, and how one file is cut into the statements that are
 * executed one at a time.
 *
 * Shared by `scripts/run-migrations.ts` (which ships inside the image and
 * applies the files) and `scripts/check-migration-safety.ts` (which judges
 * them in CI and again before a deploy), so the unit the lint judges is
 * exactly the unit the runner executes. A lint that split files its own way could pass a statement the
 * runner then runs differently.
 */
import { createHash } from 'node:crypto'
import { readdirSync } from 'node:fs'

/** The marker drizzle-kit writes between statements of one migration file. */
export const STATEMENT_BREAKPOINT = '--> statement-breakpoint'

/** Every migration file in `dir`, in application order (plain filename sort). */
export function listMigrationFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
}

/**
 * The statements of one migration file, in order. A "statement" is a chunk
 * between breakpoints: the runner sends each chunk to Postgres as one
 * `sql.unsafe` call, so a chunk may itself hold several `;`-separated SQL
 * statements (hand-written migrations often do).
 */
export function splitMigrationStatements(content: string): string[] {
  return content
    .split(STATEMENT_BREAKPOINT)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * The runner's ledger of applied files, keyed by filename. Read by the
 * pre-deploy check (`check-migration-safety.ts --target`) to learn which
 * files a deploy will apply, so both agree on the table by construction.
 */
export const LEDGER_TABLE = 'llamenos_schema_migrations'

/** The checksum the ledger records for a file: SHA-256 of its UTF-8 text. */
export function migrationChecksum(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex')
}
