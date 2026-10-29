/**
 * How a Drizzle migration directory is read: which files are migrations, in
 * what order they run, and how one file is cut into the statements that are
 * executed one at a time.
 *
 * Shared by `scripts/run-migrations.ts` (which ships inside the image and
 * applies the files) and `scripts/check-migration-safety.ts` (which judges
 * them in CI), so the unit the lint judges is exactly the unit the runner
 * executes. A lint that split files its own way could pass a statement the
 * runner then runs differently.
 */
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
