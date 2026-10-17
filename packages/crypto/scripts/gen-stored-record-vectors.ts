#!/usr/bin/env bun
/**
 * Record the server's stored-record output as a cross-platform fixture.
 *
 *   bash packages/crypto/scripts/build-server.sh   # the real FFI library
 *   bun packages/crypto/scripts/gen-stored-record-vectors.ts
 *
 * Writes `packages/crypto/tests/fixtures/stored-record-vectors.json`.
 *
 * The bytes in that file are produced by the server's own writers —
 * `encryptMessageForStorage` and `encryptCallRecordForStorage` in
 * `apps/worker/lib/crypto.ts`, running on the real Rust library through
 * `bun:ffi` — not by a re-statement of the format. That is the point: every
 * reader (Rust, desktop, iOS, Android) opens these exact bytes through its own
 * production code path, so a reader that binds a different AAD than the server
 * does fails against the fixture instead of agreeing with a copy of itself.
 *
 * The reader keys are fixed test keys so a consumer can open the record
 * without any key exchange. The ciphertext is randomised per run (fresh content
 * key, nonce and HPKE ephemeral), so regenerating rewrites the record bytes;
 * every consumer opens whatever bytes are recorded, never a re-run.
 */
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { x25519 } from '@noble/curves/ed25519.js'
import { hpkeOpen, symmetricDecrypt } from '@llamenos/crypto/ffi'
import { encryptCallRecordForStorage, encryptMessageForStorage } from '../../../apps/worker/lib/crypto'
import { LABEL_CALL_META, LABEL_MESSAGE } from '../../shared/crypto-labels'
import { bytesToHex, hexToBytes, utf8ToBytes } from '../../shared/encoding'
import type { RecipientEnvelope } from '../../shared/types'

const OUT = resolve(import.meta.dir, '../tests/fixtures/stored-record-vectors.json')

/** Fixed X25519 secrets. Test keys only — they guard nothing. */
const READERS = [
  { name: 'volunteer', x25519SecretHex: 'a1'.repeat(32) },
  { name: 'admin', x25519SecretHex: 'b2'.repeat(32) },
].map(r => ({ ...r, x25519PubkeyHex: bytesToHex(x25519.getPublicKey(hexToBytes(r.x25519SecretHex))) }))

const NO_AAD = new Uint8Array(0)

/** The server's own reader: what the firehose agent does with a stored message. */
function serverOpen(encryptedContent: string, env: RecipientEnvelope, secretHex: string, label: string): string {
  const sealed = new Uint8Array([...hexToBytes(env.enc), ...hexToBytes(env.ct)])
  const key = hpkeOpen(hexToBytes(secretHex), sealed, utf8ToBytes(label), NO_AAD)
  return new TextDecoder().decode(symmetricDecrypt(key, hexToBytes(encryptedContent), NO_AAD))
}

const messagePlaintext = 'caller: are you there? necesito ayuda — stored-record vector'
const message = encryptMessageForStorage(messagePlaintext, READERS.map(r => r.x25519PubkeyHex), LABEL_MESSAGE)

const callMetaPlaintext = JSON.stringify({ answeredBy: null, callerNumber: '+15555550142' })
const callMeta = encryptCallRecordForStorage(JSON.parse(callMetaPlaintext), READERS.map(r => r.x25519PubkeyHex))

// Refuse to record a vector the server itself cannot read back.
for (const [i, reader] of READERS.entries()) {
  if (serverOpen(message.encryptedContent, message.readerEnvelopes[i], reader.x25519SecretHex, LABEL_MESSAGE) !== messagePlaintext) {
    throw new Error(`server could not reopen its own message for ${reader.name}`)
  }
  if (serverOpen(callMeta.encryptedContent, callMeta.adminEnvelopes[i], reader.x25519SecretHex, LABEL_CALL_META) !== callMetaPlaintext) {
    throw new Error(`server could not reopen its own call metadata for ${reader.name}`)
  }
}

const fixture = {
  description:
    'Stored records exactly as the server writes them (PROTOCOL.md §2.4, §2.5): NO AAD on the ' +
    'AES-256-GCM content layer and NO AAD on the HPKE key wrap; the label is bound as the HPKE ' +
    'info only. Every platform must open these bytes through its production reader, and must ' +
    'fail to open them under the canonical label / label:key-wrap AAD. Regenerate with ' +
    'packages/crypto/scripts/gen-stored-record-vectors.ts — never edit by hand.',
  generator: 'apps/worker/lib/crypto.ts encryptMessageForStorage / encryptCallRecordForStorage via bun:ffi',
  aadHex: { content: '', keyWrap: '' },
  readers: READERS,
  records: [
    {
      name: 'conversation-message',
      label: LABEL_MESSAGE,
      plaintext: messagePlaintext,
      encryptedContent: message.encryptedContent,
      readerEnvelopes: message.readerEnvelopes,
    },
    {
      name: 'call-metadata',
      label: LABEL_CALL_META,
      plaintext: callMetaPlaintext,
      encryptedContent: callMeta.encryptedContent,
      readerEnvelopes: callMeta.adminEnvelopes,
    },
  ],
}

writeFileSync(OUT, JSON.stringify(fixture, null, 2) + '\n')
console.log(`wrote ${OUT}`)
