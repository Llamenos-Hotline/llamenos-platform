/**
 * Shared decrypt-path helpers for the hub-shred integration suites.
 *
 * Tasks 4-7 of docs/superpowers/plans/2026-10-04-hub-deletion-crypto-shred.md
 * all need to prove readability with REAL crypto — a mocked unwrap cannot
 * tell "envelope destroyed" from "envelope returned garbage". Written once
 * here so a second copy cannot assert the wrong thing in a second place.
 *
 * Requires postgres at DATABASE_URL. Each consumer gets its own database,
 * created with the real migrations and dropped on teardown.
 */

// pg-array-patch must be imported before any schema is loaded.
import '../../db/pg-array-patch'

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { expect } from 'vitest'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import { x25519 } from '@noble/curves/ed25519.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@shared/encoding'
import { hpkeOpen, symmetricDecrypt } from '@llamenos/crypto/ffi'
import { LABEL_MESSAGE } from '@shared/crypto-labels'
import type { Database } from '../../db'
import * as schema from '../../db/schema'
import { encryptMessageForStorage } from '../../lib/crypto'
import { SettingsService } from '../../services/settings'
import { IdentityService } from '../../services/identity'
import { AuditService } from '../../services/audit'
import { ErasureService } from '../../services/erasure'
import { HubShredService } from '../../services/hub-shred'
import { notes } from '../../db/schema'

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

function urlFor(name: string): string {
  const url = new URL(DATABASE_URL)
  url.pathname = `/${name}`
  return url.toString()
}

/** A real X25519 keypair — the same primitive the Rust DHKEM uses. */
export function reader(): { secret: Uint8Array; pubkey: string } {
  const secret = new Uint8Array(32)
  crypto.getRandomValues(secret)
  return { secret, pubkey: bytesToHex(x25519.getPublicKey(secret)) }
}

/**
 * The real decrypt path: unwrap the content key out of an HPKE envelope.
 * `env` is the { enc, ct } pair stored in an envelope column; `label` is the
 * crypto context label the seal used (defaults to the message label).
 */
export function openEnvelope(
  secret: Uint8Array,
  env: { enc: string; ct: string },
  label: string = LABEL_MESSAGE,
): Uint8Array {
  const envelope = new Uint8Array(hexToBytes(env.enc).length + hexToBytes(env.ct).length)
  envelope.set(hexToBytes(env.enc), 0)
  envelope.set(hexToBytes(env.ct), hexToBytes(env.enc).length)
  return hpkeOpen(secret, envelope, utf8ToBytes(label), utf8ToBytes(`${label}:key-wrap`))
}

/** Unwrap AND open, returning the plaintext. Throws if either step fails. */
export function readSealed(
  secret: Uint8Array,
  env: { enc: string; ct: string },
  encryptedContent: string,
  label: string = LABEL_MESSAGE,
): string {
  const key = openEnvelope(secret, env, label)
  return new TextDecoder().decode(
    symmetricDecrypt(key, hexToBytes(encryptedContent), utf8ToBytes(label)),
  )
}

/**
 * Seed a note whose author and an admin can both genuinely decrypt it.
 * The plaintext is distinctive so tests can prove byte-level recovery.
 */
export async function seedReadableNote(
  db: Database,
  hubId: string,
  author: ReturnType<typeof reader> = reader(),
  plaintext = 'caller disclosed an address',
): Promise<{
  note: typeof notes.$inferSelect
  author: ReturnType<typeof reader>
  admin: ReturnType<typeof reader>
  plaintext: string
}> {
  const admin = reader()
  const sealed = encryptMessageForStorage(plaintext, [author.pubkey, admin.pubkey])
  const [note] = await db
    .insert(schema.notes)
    .values({
      hubId,
      authorPubkey: author.pubkey,
      encryptedContent: sealed.encryptedContent,
      authorEnvelope: sealed.readerEnvelopes[0],
      adminEnvelopes: [sealed.readerEnvelopes[1]],
    })
    .returning()
  return { note: note!, author, admin, plaintext }
}

/** Re-read a note and unwrap its author envelope, proving it is still readable. */
export async function expectNoteReadable(
  db: Database,
  noteId: string,
  secret: Uint8Array,
  expectedPlaintext: string,
): Promise<void> {
  const [row] = await db.select().from(schema.notes).where(eq(schema.notes.id, noteId))
  const key = openEnvelope(secret, row!.authorEnvelope as { enc: string; ct: string })
  const plain = new TextDecoder().decode(
    symmetricDecrypt(key, hexToBytes(row!.encryptedContent), utf8ToBytes(LABEL_MESSAGE)),
  )
  expect(plain).toBe(expectedPlaintext)
}

export interface FreshHubDb {
  db: Database
  raw: ReturnType<typeof postgres>
  settings: SettingsService
  identity: IdentityService
  audit: AuditService
  erasure: ErasureService
  shred: HubShredService
  /** Attach a blob store after construction, before use. */
  useBlobStorage(blob: { delete(key: string): Promise<void> }): void
  setup(): Promise<void>
  teardown(): Promise<void>
}

/**
 * beforeAll/afterAll pair: own database, real migrations, dropped on teardown.
 * Caller wires `beforeAll(fresh.setup, 180_000)` / `afterAll(fresh.teardown, 60_000)`.
 */
export function freshHubDb(name: string): FreshHubDb {
  const DB_NAME = `${name}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  let sql: ReturnType<typeof postgres> | undefined
  let blobStorage: { delete(key: string): Promise<void> } | undefined

  const dbRef: FreshHubDb = {
    db: undefined as unknown as Database,
    raw: undefined as unknown as ReturnType<typeof postgres>,
    settings: undefined as unknown as SettingsService,
    identity: undefined as unknown as IdentityService,
    audit: undefined as unknown as AuditService,
    erasure: undefined as unknown as ErasureService,
    shred: undefined as unknown as HubShredService,
    useBlobStorage(blob) {
      blobStorage = blob
    },
    async setup() {
      const admin = postgres(DATABASE_URL, { max: 1 })
      try {
        await admin.unsafe(`CREATE DATABASE ${DB_NAME}`)
      } finally {
        await admin.end()
      }

      const migrate = spawnSync('bun', ['--no-env-file', 'scripts/run-migrations.ts'], {
        cwd: REPO_ROOT,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: urlFor(DB_NAME) },
        encoding: 'utf-8',
        timeout: 120_000,
      })
      if (migrate.status !== 0) {
        throw new Error(`migrations failed:\n${migrate.stdout}\n${migrate.stderr}`)
      }

      sql = postgres(urlFor(DB_NAME), { max: 4 })
      const db = drizzle(sql, { schema }) as unknown as Database
      // drizzle-orm/postgres-js replaces serializers['3802'] (jsonb) with a
      // transparent pass-through in construct(), assuming the column type
      // already serialized the value. The bun-jsonb customType has no toDriver
      // (correct for Bun SQL, which serializes natively), so raw objects would
      // reach postgres.js's byte encoder and throw. Re-register a JSON
      // serializer AFTER drizzle() so the same schema works on this driver.
      // Strings pass through untouched, so this is a no-op for values already
      // serialized by a toDriver (e.g. the test-jsonb vitest alias).
      const serializers = (sql as unknown as { options: { serializers: Record<string, (v: unknown) => unknown> } }).options.serializers
      serializers['3802'] = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v))
      const settings = new SettingsService(db)
      const identity = new IdentityService(db)
      const audit = new AuditService(db)
      const erasure = new ErasureService(db, identity, {
        deleteEnvelopeMirrors: (fileIds) =>
          new HubShredService(db, blobStorage).deleteBlobEnvelopeMirrors(fileIds),
      })
      dbRef.db = db
      dbRef.raw = sql
      dbRef.settings = settings
      dbRef.identity = identity
      dbRef.audit = audit
      dbRef.erasure = erasure
    },
    async teardown() {
      await sql?.end()
      const admin = postgres(DATABASE_URL, { max: 1 })
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`)
      } finally {
        await admin.end()
      }
    },
  }
  // `shred` resolves the blob store at access time so a test can attach a fake
  // store after setup; the service is stateless, so a fresh instance per use
  // is equivalent.
  Object.defineProperty(dbRef, 'shred', {
    enumerable: true,
    get: () => new HubShredService(dbRef.db, blobStorage),
  })
  return dbRef
}
