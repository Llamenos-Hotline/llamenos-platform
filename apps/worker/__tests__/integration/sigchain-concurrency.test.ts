/**
 * CryptoKeysService.appendSigchainLink concurrency — real PostgreSQL (#1146).
 *
 * The sigchain is an append-only, hash-chained, Ed25519-signed record of
 * which devices are authorised for a user. Before #1146, appendSigchainLink
 * read the chain head and inserted the next link with no advisory lock and
 * no unique constraint backing (user_pubkey, seq_no) — a plain index only.
 * Two concurrent appends could both read the same head, both pass the
 * seqNo/prevHash continuity check, and both insert: a forked chain, silently
 * accepted as valid by any reader.
 *
 * The fix is two-layered:
 *   1. appendSigchainLink now takes a transaction-scoped
 *      pg_advisory_xact_lock on the user's pubkey BEFORE reading the head
 *      (see sigchainLockKey in services/crypto-keys.ts) — the application
 *      serializes concurrent appends to the same chain.
 *   2. (user_pubkey, seq_no) is now a UNIQUE index (migration 0053) — the
 *      database refuses a fork even if a future code path forgets the lock.
 *
 * The contract asserted here: of N concurrent appends racing to extend the
 * SAME chain head, exactly one succeeds and every other one is rejected
 * with a 409 CryptoKeyError — never two successful inserts at the same
 * seqNo, and never a silent fork.
 *
 * Requires postgres at DATABASE_URL (default: local dev postgres). Each run
 * uses an isolated schema that is dropped on teardown. Ed25519 signing uses
 * the pure-TypeScript mock (see ../mocks/llamenos-crypto-ffi.ts) so this
 * test exercises REAL signature verification without the native crypto
 * library.
 */

// pg-array-patch must be imported before any schema is loaded.
import '../../db/pg-array-patch'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@llamenos/crypto/ffi', async () => await import('../mocks/llamenos-crypto-ffi'))

import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import type { Database } from '../../db'
import * as schema from '../../db/schema'
import { CryptoKeysService, CryptoKeyError, computeEntryHash } from '../../services/crypto-keys'
import { ed25519Sign, ed25519PubkeyFromSeed } from '../mocks/llamenos-crypto-ffi'
import { hexToBytes, bytesToHex } from '@shared/encoding'

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

const TEST_SCHEMA = `test_sigchain_concurrency_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

// Mirrors apps/worker/db/schema/sigchain.ts sigchainLinks, post-#1146
// (UNIQUE, not plain, index on (user_pubkey, seq_no)). `users` is a minimal
// FK target — appendSigchainLink never reads/writes it.
const DDL = `
  CREATE TABLE ${TEST_SCHEMA}.users (
    pubkey TEXT PRIMARY KEY
  );

  CREATE TABLE ${TEST_SCHEMA}.sigchain_links (
    id                 TEXT PRIMARY KEY,
    user_pubkey        TEXT NOT NULL REFERENCES ${TEST_SCHEMA}.users(pubkey) ON DELETE CASCADE,
    seq_no             INTEGER NOT NULL,
    link_type          TEXT NOT NULL,
    payload            JSONB NOT NULL,
    signature          TEXT NOT NULL,
    prev_hash          TEXT NOT NULL DEFAULT '',
    hash               TEXT NOT NULL,
    signer_device_id   TEXT NOT NULL DEFAULT '',
    signer_pubkey      TEXT NOT NULL DEFAULT '',
    "timestamp"        TEXT NOT NULL DEFAULT '',
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE UNIQUE INDEX sigchain_links_user_seq_idx
    ON ${TEST_SCHEMA}.sigchain_links (user_pubkey, seq_no);
`

const JSONB_TYPE = {
  to: 3802,
  from: [3802],
  serialize: (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v)),
  parse: (v: string) => {
    try {
      return JSON.parse(v)
    } catch {
      return v
    }
  },
}

let adminSql: ReturnType<typeof postgres>
let testSql: ReturnType<typeof postgres>
let service: CryptoKeysService

// The sigchain owner's Ed25519 identity key — appendSigchainLink verifies
// `signature` against this pubkey (hex), exactly as production does.
const identitySeed = crypto.getRandomValues(new Uint8Array(32))
const USER_PUBKEY = bytesToHex(ed25519PubkeyFromSeed(identitySeed))

interface LinkInput {
  seqNo: number
  linkType: string
  payload: unknown
  signature: string
  prevHash: string
  hash: string
  signerDeviceId: string
  signerPubkey: string
  timestamp: string
}

/** Build a correctly-signed link extending `prevHash` at `seqNo`. */
function buildLink(seqNo: number, prevHash: string, payload: unknown): LinkInput {
  const signerDeviceId = 'dev-1'
  const signerPubkey = 'aa'.repeat(32)
  const timestamp = '2026-01-01T00:00:00Z'
  const hash = computeEntryHash(
    seqNo,
    prevHash === '' ? null : prevHash,
    timestamp,
    signerDeviceId,
    signerPubkey,
    payload,
  )
  const signature = bytesToHex(ed25519Sign(identitySeed, hexToBytes(hash)))
  return { seqNo, linkType: 'device_add', payload, signature, prevHash, hash, signerDeviceId, signerPubkey, timestamp }
}

beforeAll(async () => {
  adminSql = postgres(DATABASE_URL, { max: 1 })
  await adminSql`CREATE SCHEMA IF NOT EXISTS ${adminSql(TEST_SCHEMA)}`
  await adminSql.unsafe(DDL)

  // A multi-connection pool is required: the race only exists when the
  // concurrent transactions run on distinct connections.
  testSql = postgres(DATABASE_URL, {
    max: 10,
    connection: { search_path: TEST_SCHEMA },
    types: { jsonb: JSONB_TYPE },
  })
  const db = drizzle({ client: testSql, schema }) as unknown as Database
  service = new CryptoKeysService(db)

  await testSql`INSERT INTO users (pubkey) VALUES (${USER_PUBKEY})`
})

afterAll(async () => {
  await adminSql`DROP SCHEMA IF EXISTS ${adminSql(TEST_SCHEMA)} CASCADE`
  await adminSql.end()
  await testSql.end()
})

beforeEach(async () => {
  await testSql`TRUNCATE TABLE sigchain_links`
})

describe('CryptoKeysService.appendSigchainLink under concurrent writers (#1146)', () => {
  it('lets exactly one of N concurrent appends at the same seqNo succeed; the rest get a 409', async () => {
    const genesis = buildLink(0, '', { type: 'user_init', deviceId: 'dev-1' })
    const genesisLink = await service.appendSigchainLink(USER_PUBKEY, genesis)

    const CONCURRENCY = 8
    // Every writer independently computes the next link from the SAME
    // observed head (seqNo=1, prevHash=genesis.hash) — exactly what two
    // devices racing to add themselves would do.
    const attempts = Array.from({ length: CONCURRENCY }, (_, i) =>
      buildLink(1, genesisLink.hash, { type: 'device_add', deviceId: `new-device-${i}` }),
    )

    const results = await Promise.allSettled(
      attempts.map((link) => service.appendSigchainLink(USER_PUBKEY, link)),
    )

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')

    // Exactly one writer wins the race.
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(CONCURRENCY - 1)

    // Every loser is rejected as a hash-chain continuity conflict, not some
    // other failure mode (e.g. an unhandled unique-constraint DB error
    // leaking past appendSigchainLink).
    for (const r of rejected) {
      if (r.status !== 'rejected') continue
      expect(r.reason).toBeInstanceOf(CryptoKeyError)
      expect((r.reason as CryptoKeyError).status).toBe(409)
    }

    // The persisted chain is exactly genesis + the one winner — never both,
    // never neither.
    const persisted = await service.getSigchain(USER_PUBKEY)
    expect(persisted).toHaveLength(2)
    expect(persisted[0].seqNo).toBe(0)
    expect(persisted[1].seqNo).toBe(1)
    expect(persisted[1].prevHash).toBe(genesisLink.hash)

    // No two rows ever share (user_pubkey, seq_no) — the DB-level backstop
    // (migration 0053) holds regardless of application-level locking.
    const seqNos = persisted.map((l) => l.seqNo)
    expect(new Set(seqNos).size).toBe(seqNos.length)
  })

  it('serializes concurrent appends into a single valid chain across many rounds', async () => {
    let head = await service.appendSigchainLink(USER_PUBKEY, buildLink(0, '', { type: 'user_init' }))

    for (let round = 0; round < 5; round++) {
      const nextSeqNo = round + 1
      const attempts = Array.from({ length: 4 }, (_, i) =>
        buildLink(nextSeqNo, head.hash, { type: 'device_add', deviceId: `round-${round}-writer-${i}` }),
      )
      const results = await Promise.allSettled(
        attempts.map((link) => service.appendSigchainLink(USER_PUBKEY, link)),
      )
      const winner = results.find((r) => r.status === 'fulfilled')
      expect(winner).toBeDefined()
      head = (winner as PromiseFulfilledResult<Awaited<ReturnType<typeof service.appendSigchainLink>>>).value
      expect(head.seqNo).toBe(nextSeqNo)
    }

    const persisted = await service.getSigchain(USER_PUBKEY)
    expect(persisted).toHaveLength(6) // genesis + 5 rounds
    // The chain is contiguous and unforked: seqNo 0..5, each prevHash
    // matching the previous link's hash.
    for (let i = 0; i < persisted.length; i++) {
      expect(persisted[i].seqNo).toBe(i)
      expect(persisted[i].prevHash).toBe(i === 0 ? '' : persisted[i - 1].hash)
    }
  })
})
