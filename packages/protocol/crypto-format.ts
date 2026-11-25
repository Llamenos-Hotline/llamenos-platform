/**
 * Crypto formats a sealed row can carry (#2964).
 *
 * Every table that stores ciphertext has a `crypto_format` column, NOT NULL,
 * so a later format migration (M2: content AAD bound to hub/type/doc, group
 * recipients — #2961, #2974) can select exactly the rows an older format wrote
 * instead of trial-decrypting them. Pilot data is format 1.
 *
 * Source of truth: `crypto-formats.json` beside this file. The Rust crate's
 * `crypto_format` module is pinned to it by a test, and each table's
 * `<table>_crypto_format_known` CHECK is generated from `CRYPTO_FORMATS_KNOWN`,
 * so adding a value here and running `bun run db:generate` widens every table.
 */
import formats from './crypto-formats.json'

/** A crypto format this build can read. */
export type CryptoFormat = (typeof formats.known)[number]

/** The format every writer in this build stamps on a sealed row. */
export const CRYPTO_FORMAT_CURRENT: CryptoFormat = formats.current

/** Every format a reader in this build accepts; anything else is refused. */
export const CRYPTO_FORMATS_KNOWN: readonly CryptoFormat[] = formats.known

/** True only for a format this build can read. Readers must not guess. */
export function isKnownCryptoFormat(value: unknown): value is CryptoFormat {
  return typeof value === 'number' && (CRYPTO_FORMATS_KNOWN as readonly number[]).includes(value)
}
