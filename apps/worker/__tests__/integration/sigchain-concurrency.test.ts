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
 *
 * Also covered: IdentityService.revokeDevice, which appends its
 * device_remove link inside a larger transaction, must take the SAME
 * per-user advisory lock before appending — otherwise a revoke racing a
 * public sigchain append loses the (user_pubkey, seq_no) unique-index race
 * as an unhandled 500 instead of a serialized 409.
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
import { IdentityService } from '../../services/identity'
import { ServiceError } from '../../services/settings'
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
    pubkey TEXT PRIMARY KEY,
    hub_roles JSONB NOT NULL DEFAULT '[]'
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

  -- IdentityService.revokeDevice touches these in the same transaction as
  -- its sigchain append, so the revoke-vs-append race test needs them.
  CREATE TABLE ${TEST_SCHEMA}.devices (
    id               TEXT PRIMARY KEY,
    pubkey           TEXT NOT NULL REFERENCES ${TEST_SCHEMA}.users(pubkey) ON DELETE CASCADE,
    platform         TEXT NOT NULL,
    push_token       TEXT,
    voip_token       TEXT,
    wake_key_public  TEXT,
    ed25519_pubkey   TEXT,
    x25519_pubkey    TEXT,
    registered_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at     TIMESTAMPTZ,
    device_name      TEXT,
    device_model     TEXT,
    os_version       TEXT,
    app_version      TEXT,
    last_ip_hash     TEXT
  );

  CREATE TABLE ${TEST_SCHEMA}.sessions (
    id          TEXT NOT NULL,
    token       TEXT PRIMARY KEY,
    pubkey      TEXT NOT NULL REFERENCES ${TEST_SCHEMA}.users(pubkey) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ NOT NULL,
    device_info JSONB
  );

  CREATE TABLE ${TEST_SCHEMA}.security_events (
    id          TEXT PRIMARY KEY,
    user_pubkey TEXT REFERENCES ${TEST_SCHEMA}.users(pubkey) ON DELETE SET NULL,
    event_type  TEXT NOT NULL,
    device_id   TEXT,
    metadata    JSONB NOT NULL DEFAULT '{}',
    ip_hash     TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
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
let db: Database
let service: CryptoKeysService
let identity: IdentityService

// The sigchain owner's Ed25519 identity key — appendSigchainLink verifies
// `signature` against this pubkey (hex), exactly as production does.
const identitySeed = crypto.getRandomValues(new Uint8Array(32))
const USER_PUBKEY = bytesToHex(ed25519PubkeyFromSeed(identitySeed))

interface LinkInput {
  seqNo: number
  linkType: string
  payload: unknown
  signature: string
  /** null for genesis (seqNo 1); '' accepted as a legacy alias. */
  prevHash: string | null
  hash: string
  signerDeviceId: string
  signerPubkey: string
  timestamp: string
}

/** Build a correctly-signed link extending `prevHash` at `seqNo`. */
function buildLink(
  seqNo: number,
  prevHash: string | null,
  payload: unknown,
  meta: { signerDeviceId?: string; signerPubkey?: string; timestamp?: string } = {},
): LinkInput {
  const signerDeviceId = meta.signerDeviceId ?? 'dev-1'
  const signerPubkey = meta.signerPubkey ?? 'aa'.repeat(32)
  const timestamp = meta.timestamp ?? '2026-01-01T00:00:00Z'
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
  db = drizzle({ client: testSql, schema }) as unknown as Database
  service = new CryptoKeysService(db)
  identity = new IdentityService(db)

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
    // Genesis is seqNo 1 with prevHash null (#1537 crate-verifier contract).
    const genesis = buildLink(1, null, { type: 'user_init', deviceId: 'dev-1' })
    const genesisLink = await service.appendSigchainLink(USER_PUBKEY, genesis)

    const CONCURRENCY = 8
    // Every writer independently computes the next link from the SAME
    // observed head (seqNo=2, prevHash=genesis.hash) — exactly what two
    // devices racing to add themselves would do.
    const attempts = Array.from({ length: CONCURRENCY }, (_, i) =>
      buildLink(2, genesisLink.hash, { type: 'device_add', deviceId: `new-device-${i}` }),
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
    expect(persisted[0].seqNo).toBe(1)
    expect(persisted[0].prevHash).toBeNull()
    expect(persisted[1].seqNo).toBe(2)
    expect(persisted[1].prevHash).toBe(genesisLink.hash)

    // No two rows ever share (user_pubkey, seq_no) — the DB-level backstop
    // (migration 0053) holds regardless of application-level locking.
    const seqNos = persisted.map((l) => l.seqNo)
    expect(new Set(seqNos).size).toBe(seqNos.length)
  })

  it('serializes concurrent appends into a single valid chain across many rounds', async () => {
    let head = await service.appendSigchainLink(USER_PUBKEY, buildLink(1, null, { type: 'user_init' }))

    for (let round = 0; round < 5; round++) {
      const nextSeqNo = round + 2
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
    // The chain is contiguous and unforked: seqNo 1..6, each prevHash
    // matching the previous link's hash (null for genesis).
    for (let i = 0; i < persisted.length; i++) {
      expect(persisted[i].seqNo).toBe(i + 1)
      expect(persisted[i].prevHash).toBe(i === 0 ? null : persisted[i - 1].hash)
    }
  })
})

describe('IdentityService.revokeDevice racing a concurrent sigchain append (#1146)', () => {
  // The race window (two transactions reading the same head before either
  // commits) is tiny, so the race is run over several rounds on a growing
  // chain — with revokeDevice's advisory lock in place every round passes
  // deterministically (the lock serializes the racers and the loser
  // re-reads the new head under READ COMMITTED, getting a clean 409). If
  // the lock were dropped again, rounds where the transactions genuinely
  // overlap would surface the raw unique-constraint error (code 23505) the
  // reviewer flagged instead of a 409.
  it('serializes revoke + appends: exactly one racer wins; losers get a 409, never a 500', async () => {
    await service.appendSigchainLink(
      USER_PUBKEY,
      buildLink(1, null, { type: 'user_init', deviceId: 'dev-1' }),
    )

    const ROUNDS = 10
    for (let round = 0; round < ROUNDS; round++) {
      const head = await service.getSigchain(USER_PUBKEY)
      const nextSeqNo = head.length + 1
      const prevHash = head[head.length - 1].hash

      const deviceId = `device-to-revoke-${round}`
      const devicePubkey = 'bb'.repeat(32)
      await testSql`
        INSERT INTO devices (id, pubkey, platform, ed25519_pubkey)
        VALUES (${deviceId}, ${USER_PUBKEY}, 'ios', ${devicePubkey})
      `

      // The device_remove link the client signed for revokeDevice. The
      // payload must match exactly what revokeDevice assembles (deviceId,
      // devicePubkey, platform) and the signer metadata must be the empty
      // defaults appendValidatedSigchainLink applies on this path.
      const removeLink = buildLink(
        nextSeqNo,
        prevHash,
        { deviceId, devicePubkey, platform: 'ios' },
        { signerDeviceId: '', signerPubkey: '', timestamp: '' },
      )
      // Two competing appends — other devices racing to join at the same
      // seqNo — so each round has three concurrent writers at the head.
      const addLinks = [0, 1].map((i) =>
        buildLink(nextSeqNo, prevHash, { type: 'device_add', deviceId: `dev-r${round}-${i}` }),
      )

      const [revokeResult, ...appendResults] = await Promise.allSettled([
        identity.revokeDevice(USER_PUBKEY, deviceId, {
          signature: removeLink.signature,
          sigchainHash: removeLink.hash,
          sigchainSeqNo: removeLink.seqNo,
          sigchainPrevHash: removeLink.prevHash ?? undefined,
        }),
        ...addLinks.map((link) => service.appendSigchainLink(USER_PUBKEY, link)),
      ])

      // Exactly one racer wins.
      const outcomes = [revokeResult, ...appendResults]
      expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1)

      // Every loser is rejected with the documented serialized-conflict
      // status (409) — as a CryptoKeyError from the append path (translated
      // by the app's error handler) or a ServiceError from the revoke path
      // (where identity.ts translates CryptoKeyError itself). Critically it
      // is NOT a raw unique-constraint Postgres error (code 23505) leaking
      // past as a 500.
      for (const r of outcomes) {
        if (r.status !== 'rejected') continue
        expect(r.reason).toSatisfy(
          (e: unknown) => e instanceof CryptoKeyError || e instanceof ServiceError,
        )
        const status =
          r.reason instanceof CryptoKeyError
            ? r.reason.status
            : (r.reason as ServiceError).status
        expect(status).toBe(409)
        expect((r.reason as { code?: string }).code).not.toBe('23505')
      }

      // The persisted chain gained exactly one link — no fork.
      const persisted = await service.getSigchain(USER_PUBKEY)
      expect(persisted).toHaveLength(head.length + 1)
      expect(persisted[persisted.length - 1].seqNo).toBe(nextSeqNo)
      expect(persisted[persisted.length - 1].prevHash).toBe(prevHash)

      // The winner's side effect landed; the losers' did not.
      const [deviceRow] = await testSql`SELECT id FROM devices WHERE id = ${deviceId}`
      if (revokeResult.status === 'fulfilled') {
        expect(deviceRow).toBeUndefined()
        expect(revokeResult.value).toEqual({ hubIds: [], pukRotationNeeded: true })
        expect(persisted[persisted.length - 1].linkType).toBe('device_remove')
        expect(persisted[persisted.length - 1].payload).toEqual({
          deviceId,
          devicePubkey,
          platform: 'ios',
        })
      } else {
        expect(deviceRow).toBeDefined()
        expect(persisted[persisted.length - 1].linkType).toBe('device_add')
      }
    }
  })
})
