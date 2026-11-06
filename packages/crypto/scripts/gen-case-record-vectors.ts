#!/usr/bin/env bun
/**
 * Record case records and case comments AS THE SERVER PERSISTED THEM, as a
 * cross-platform fixture (#2499).
 *
 *   bash packages/crypto/scripts/build-server.sh            # the real FFI library
 *   DATABASE_URL=postgres://…/postgres \
 *     bun packages/crypto/scripts/gen-case-record-vectors.ts
 *
 * Writes `packages/crypto/tests/fixtures/case-record-vectors.json`.
 *
 * Unlike a stored message, a case ciphertext is sealed by a client and only
 * stored by the server, so "what the server wrote" means what it persisted and
 * returns. This script therefore:
 *
 *  1. seals a summary, a fields payload and a comment through
 *     `packages/crypto/src/case_record.rs` (`caseSeal`, via `bun:ffi`) — the one
 *     implementation every client binding reaches — for two fixed reader keys;
 *  2. sends each through the request validator the routes use
 *     (`createRecordBodySchema` / `createInteractionBodySchema`) and the real
 *     `CasesService` into a throwaway PostgreSQL database migrated by
 *     `scripts/run-migrations.ts`;
 *  3. reads the record and the interaction back through `CasesService` and
 *     records THOSE bytes — never the in-memory values from step 1.
 *
 * Every platform opens the recorded bytes through its production reader. The
 * ciphertext is randomised per run (fresh content key, nonce, HPKE ephemeral),
 * so regenerating rewrites the bytes; consumers open whatever is recorded.
 *
 * DATABASE_URL must point at a server where this role may CREATE DATABASE; a
 * uniquely named database is created, migrated, used and dropped.
 */
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { SQL } from 'bun'
import { drizzle } from 'drizzle-orm/bun-sql'
import { x25519 } from '@noble/curves/ed25519.js'
import { caseOpen, caseSeal, type CasePurpose, type EncryptedCaseCiphertext } from '@llamenos/crypto/ffi'
import { createInteractionBodySchema } from '../../protocol/schemas/interactions'
import { createRecordBodySchema } from '../../protocol/schemas/records'
import { recipientEnvelopeSchema } from '../../protocol/schemas/common'
import { z } from 'zod'
import { LABEL_CASE_COMMENT, LABEL_CASE_FIELDS, LABEL_CASE_SUMMARY } from '../../shared/crypto-labels'
import { contentAadHex, keyWrapAadHex } from '../../shared/envelope-aad'
import { bytesToHex, hexToBytes } from '../../shared/encoding'
import * as schema from '../../../apps/worker/db/schema'
import type { Database } from '../../../apps/worker/db'
import { CasesService } from '../../../apps/worker/services/cases'
import { SettingsService } from '../../../apps/worker/services/settings'

const REPO_ROOT = resolve(import.meta.dir, '../../..')
const OUT = resolve(import.meta.dir, '../tests/fixtures/case-record-vectors.json')

const BASE_URL = process.env.DATABASE_URL
if (!BASE_URL) throw new Error('DATABASE_URL is required (a server where this role may CREATE DATABASE)')

/** Fixed X25519 secrets — the same published test keys as stored-record-vectors.json. */
const READERS = [
  { name: 'volunteer', x25519SecretHex: 'a1'.repeat(32) },
  { name: 'admin', x25519SecretHex: 'b2'.repeat(32) },
].map(r => ({ ...r, x25519PubkeyHex: bytesToHex(x25519.getPublicKey(hexToBytes(r.x25519SecretHex))) }))
const READER_PUBKEYS = READERS.map(r => r.x25519PubkeyHex)

const LABELS: Record<CasePurpose, string> = {
  summary: LABEL_CASE_SUMMARY,
  fields: LABEL_CASE_FIELDS,
  comment: LABEL_CASE_COMMENT,
}

const PLAINTEXT: Record<CasePurpose, string> = {
  summary: JSON.stringify({ title: 'Vivienda — desalojo', description: 'case-record vector', status: 'Open' }),
  fields: JSON.stringify({ housing_status: 'at risk', household_size: '3' }),
  comment: 'Llamó de nuevo; ¿necesita intérprete? — case-comment vector',
}

const persistedCiphertextSchema = z.object({
  encryptedContent: z.string().min(1),
  readerEnvelopes: z.array(recipientEnvelopeSchema).min(1),
})

const DB_NAME = `case_record_vectors_${Date.now()}`
function urlFor(db: string): string {
  const u = new URL(BASE_URL as string)
  u.pathname = `/${db}`
  return u.toString()
}

const admin = new SQL({ url: BASE_URL })
await admin.unsafe(`CREATE DATABASE ${DB_NAME}`)
let client: SQL | undefined
try {
  const migrate = spawnSync('bun', ['--no-env-file', 'scripts/run-migrations.ts'], {
    cwd: REPO_ROOT,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: urlFor(DB_NAME) },
    encoding: 'utf-8',
    timeout: 300_000,
  })
  if (migrate.status !== 0) throw new Error(`migrations failed:\n${migrate.stdout}\n${migrate.stderr}`)

  client = new SQL({ url: urlFor(DB_NAME), max: 2 })
  const db = drizzle({ client, schema }) as unknown as Database
  const cases = new CasesService(db)
  const settings = new SettingsService(db)

  const hubId = crypto.randomUUID()
  const author = READER_PUBKEYS[0]
  await db.insert(schema.hubs).values({ id: hubId, name: 'Vectors', slug: `vectors-${Date.now()}`, createdBy: author })
  const entityType = await settings.createEntityType({
    hubId,
    name: 'vector_case',
    label: 'Vector Case',
    labelPlural: 'Vector Cases',
    category: 'case',
    statuses: [{ value: 'open', label: 'Open', order: 1 }],
    defaultStatus: 'open',
    closedStatuses: [],
    fields: [],
  })

  const sealed = {
    summary: caseSeal('summary', PLAINTEXT.summary, READER_PUBKEYS),
    fields: caseSeal('fields', PLAINTEXT.fields, READER_PUBKEYS),
    comment: caseSeal('comment', PLAINTEXT.comment, READER_PUBKEYS),
  }

  // The route path: validator, then the service.
  const recordBody = createRecordBodySchema.parse({
    entityTypeId: entityType.id,
    statusHash: 'open',
    assignedTo: [author],
    encryptedSummary: sealed.summary.encryptedContent,
    summaryEnvelopes: sealed.summary.readerEnvelopes,
    encryptedFields: sealed.fields.encryptedContent,
    fieldEnvelopes: sealed.fields.readerEnvelopes,
  })
  const created = await cases.create({ ...recordBody, hubId, createdBy: author })
  const interactionBody = createInteractionBodySchema.parse({
    interactionType: 'comment',
    interactionTypeHash: 'comment',
    encryptedContent: sealed.comment.encryptedContent,
    contentEnvelopes: sealed.comment.readerEnvelopes,
  })
  const createdInteraction = await cases.createInteraction(created.id, author, interactionBody)

  // What the server persisted, read back the way the routes read it.
  const stored = await cases.get(created.id)
  const { interactions } = await cases.listInteractions({ caseId: created.id, page: 1, limit: 10 })
  const storedComment = interactions.find(i => i.id === createdInteraction.id)
  if (!storedComment?.encryptedContent || !storedComment.contentEnvelopes) {
    throw new Error('the server did not return the comment it stored')
  }
  if (!stored.encryptedFields || !stored.fieldEnvelopes) throw new Error('the server did not return the fields it stored')

  // The persisted columns are untyped JSON on the way out; parse them with the
  // wire schema the clients parse them with, so the fixture is what a client gets.
  const asStored = (encryptedContent: unknown, readerEnvelopes: unknown): EncryptedCaseCiphertext =>
    persistedCiphertextSchema.parse({ encryptedContent, readerEnvelopes })
  const persisted: Record<CasePurpose, EncryptedCaseCiphertext> = {
    summary: asStored(stored.encryptedSummary, stored.summaryEnvelopes),
    fields: asStored(stored.encryptedFields, stored.fieldEnvelopes),
    comment: asStored(storedComment.encryptedContent, storedComment.contentEnvelopes),
  }

  // Refuse to record a vector a reader cannot open, through the same library.
  for (const purpose of Object.keys(persisted) as CasePurpose[]) {
    for (const reader of READERS) {
      const opened = caseOpen(purpose, hexToBytes(reader.x25519SecretHex), persisted[purpose])
      if (opened !== PLAINTEXT[purpose]) throw new Error(`${reader.name} could not open the persisted ${purpose}`)
    }
  }

  const fixture = {
    description:
      'Case records and case comments exactly as the server PERSISTED them (PROTOCOL.md §2.11): ' +
      'sealed by packages/crypto/src/case_record.rs, sent through the routes\' request validators ' +
      'and CasesService into PostgreSQL, and read back. Each purpose has its own label and the ' +
      'canonical AAD on both layers (content: UTF-8(label); key wrap: UTF-8(label + ":key-wrap")); ' +
      'envelopes are addressed to the reader\'s X25519 key, all hex. Every platform must open these ' +
      'bytes through its production reader, and the stored-message format (LABEL_MESSAGE, no AAD) ' +
      'must not. Regenerate with packages/crypto/scripts/gen-case-record-vectors.ts — never edit by hand.',
    generator:
      'packages/crypto/src/case_record.rs via bun:ffi → createRecordBodySchema / createInteractionBodySchema → ' +
      'CasesService.create / createInteraction → CasesService.get / listInteractions',
    readers: READERS,
    records: (['summary', 'fields', 'comment'] as const).map(purpose => ({
      name: `case-${purpose}`,
      purpose,
      label: LABELS[purpose],
      aadHex: { content: contentAadHex(LABELS[purpose]), keyWrap: keyWrapAadHex(LABELS[purpose]) },
      plaintext: PLAINTEXT[purpose],
      encryptedContent: persisted[purpose].encryptedContent,
      readerEnvelopes: persisted[purpose].readerEnvelopes,
    })),
  }

  writeFileSync(OUT, JSON.stringify(fixture, null, 2) + '\n')
  console.log(`wrote ${OUT}`)
} finally {
  await client?.close()
  await admin.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`)
  await admin.close()
}
