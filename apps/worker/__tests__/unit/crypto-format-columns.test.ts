/**
 * Every sealed-row table carries `crypto_format` (#2964).
 *
 * A later crypto format migration selects the rows an older format wrote by
 * this column. A new table that stores ciphertext without it would be
 * invisible to that migration, so this guard fails as soon as one is declared.
 */
import { is } from 'drizzle-orm'
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import * as schema from '@worker/db/schema'
import { CRYPTO_FORMAT_CURRENT, CRYPTO_FORMATS_KNOWN, isKnownCryptoFormat } from '@protocol/crypto-format'

/** A column name that holds ciphertext or an HPKE wrap. */
const SEALED_COLUMN = /(^|_)(encrypted|envelopes?|ciphertext|sealed|wrapped)(_|$)|^(enc|ct)$/

/**
 * Tables that hold ciphertext but whose rows are deliberately out of scope,
 * each with the reason. Keep this list short and argued.
 */
const EXEMPT: Record<string, string> = {
  users: '`encrypted_secret_key` is a retired column the service always writes as an empty string',
  provision_rooms: 'ephemeral device-linking rooms, expired within minutes; nothing outlives a session',
  envelope_revocation_jobs: '`total_envelopes`/`processed_envelopes` are counters, not ciphertext',
}

const tables: PgTable[] = Object.values(schema as Record<string, unknown>).filter((v): v is PgTable => is(v, PgTable))

describe('crypto_format on sealed-row tables (#2964)', () => {
  it('finds the schema tables (guards against a vacuous pass)', () => {
    expect(tables.length).toBeGreaterThan(50)
  })

  const sealed = tables
    .map((t) => getTableConfig(t))
    .filter((cfg) => cfg.columns.some((c) => SEALED_COLUMN.test(c.name)))

  it('detects the known sealed tables', () => {
    const names = sealed.map((c) => c.name)
    for (const expected of ['notes', 'case_records', 'messages', 'hub_keys', 'call_records', 'files']) {
      expect(names).toContain(expected)
    }
  })

  for (const cfg of sealed) {
    if (cfg.name in EXEMPT) continue
    it(`${cfg.name} has crypto_format NOT NULL DEFAULT current, and its CHECK`, () => {
      const col = cfg.columns.find((c) => c.name === 'crypto_format')
      expect(col, `${cfg.name} stores ciphertext but has no crypto_format column`).toBeDefined()
      expect(col?.notNull).toBe(true)
      expect(col?.default).toBe(CRYPTO_FORMAT_CURRENT)
      expect(cfg.checks.map((c) => c.name)).toContain(`${cfg.name}_crypto_format_known`)
    })
  }

  it('every exemption still names a sealed table', () => {
    const names = new Set(sealed.map((c) => c.name))
    for (const exempt of Object.keys(EXEMPT)) expect(names.has(exempt), exempt).toBe(true)
  })

  it('readers accept only the known formats', () => {
    expect(CRYPTO_FORMATS_KNOWN).toContain(CRYPTO_FORMAT_CURRENT)
    for (const f of CRYPTO_FORMATS_KNOWN) expect(isKnownCryptoFormat(f)).toBe(true)
    for (const f of [0, 2, '1', null, undefined, 1.5]) expect(isKnownCryptoFormat(f)).toBe(false)
  })
})
