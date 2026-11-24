/**
 * The `crypto_format` column every sealed-row table carries (#2964).
 *
 * A row records which crypto format wrote its ciphertext, so a later format
 * migration (#2961, #2974) selects the rows to re-encrypt by value instead of
 * trial decryption. The column is NOT NULL and defaults to the one format this
 * build writes; the `<table>_crypto_format_known` CHECK admits only the formats
 * in `packages/protocol/crypto-formats.json`.
 *
 * Adding a format: append it to `known` in that file and run
 * `bun run db:generate` — every table's CHECK is rebuilt from the list, so the
 * migration widens all of them at once. When writers move to the new format,
 * move `current`, and from then on a writer that means a specific format must
 * say so rather than inherit the default.
 *
 * Imported by relative path, not `@protocol/*`: drizzle-kit loads the schema
 * files without the app's path aliases.
 */
import { type SQL, sql } from 'drizzle-orm'
import { type AnyPgColumn, check, smallint } from 'drizzle-orm/pg-core'
import { CRYPTO_FORMAT_CURRENT, CRYPTO_FORMATS_KNOWN } from '../../../packages/protocol/crypto-format'

/** `crypto_format smallint NOT NULL DEFAULT <current>`. */
export function cryptoFormatColumn() {
  return smallint('crypto_format').notNull().default(CRYPTO_FORMAT_CURRENT)
}

/** The SQL list of known formats, e.g. `1` or `1, 2`. */
function knownList(): SQL {
  return sql.raw(CRYPTO_FORMATS_KNOWN.map((f) => String(Math.trunc(f))).join(', '))
}

/** `CHECK (crypto_format IN (<known>))`, named `<table>_crypto_format_known`. */
export function cryptoFormatCheck(table: string, column: AnyPgColumn) {
  return check(`${table}_crypto_format_known`, sql`${column} IN (${knownList()})`)
}
