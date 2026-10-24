#!/usr/bin/env bun
/**
 * Record the server's relay-event output as a cross-platform fixture.
 *
 *   bash packages/crypto/scripts/build-server.sh   # the real FFI library
 *   bun packages/crypto/scripts/gen-server-event-vectors.ts
 *
 * Writes `packages/crypto/tests/fixtures/server-event-vectors.json`.
 *
 * Every relay frame's `payload` is produced by `encryptEventContent` in
 * `apps/worker/lib/ws-events.ts` — the function `publishEvent` calls — and the
 * event keys are the ones `GET /api/auth/me` hands a client
 * (`deriveServerEventKey`, current and previous epoch). A client reader that
 * binds a different AAD, skips the epoch, or leaves the bucket padding in place
 * fails against these bytes instead of agreeing with a copy of itself: that is
 * how Android came to decrypt nothing at all (#2117) while a Rust test that
 * sealed its own fixture stayed green.
 *
 * The server secret is a fixed test value. The ciphertext is randomised per run
 * (fresh nonce, random padding), so regenerating rewrites the payload bytes;
 * every consumer opens whatever bytes are recorded, never a re-run.
 */
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { bytesToHex } from '../../shared/encoding'
import { LABEL_HUB_EVENT, LABEL_HUB_EVENT_EPOCH } from '../../shared/crypto-labels'
import { decryptHubEvent, deriveServerEventKey } from '../../../apps/worker/lib/hub-event-crypto'
import { encryptEventContent } from '../../../apps/worker/lib/ws-events'

const OUT = resolve(import.meta.dir, '../tests/fixtures/server-event-vectors.json')

/** A fixed test secret — guards nothing. */
const SERVER_SECRET = '5e'.repeat(32)

/** A real UTC-day epoch; only the relationship between current and previous matters. */
const CURRENT_EPOCH = 20750
const PREVIOUS_EPOCH = CURRENT_EPOCH - 1

const keyCurrent = deriveServerEventKey(SERVER_SECRET, undefined, CURRENT_EPOCH)
const keyPrevious = deriveServerEventKey(SERVER_SECRET, undefined, PREVIOUS_EPOCH)

const events: { name: string; epoch: number; content: Record<string, unknown> }[] = [
  { name: 'call-ring', epoch: CURRENT_EPOCH, content: { type: 'call:ring', callId: 'a3e54ff4-1f2b-4c33-9b1c-6f0d2f6f8a11' } },
  { name: 'message-new-previous-epoch', epoch: PREVIOUS_EPOCH, content: { type: 'message:new', conversationId: 'c0ffee00-0000-4000-8000-000000000001' } },
  // Longer than the 512-byte bucket, so the server pads it to 1024 and the reader must strip the padding.
  { name: 'padded-to-next-bucket', epoch: CURRENT_EPOCH, content: { type: 'call:update', callId: 'b'.repeat(36), status: 'in-progress', note: 'x'.repeat(600) } },
]

const frames = events.map(e => {
  const payload = encryptEventContent(e.content, SERVER_SECRET, e.epoch)
  // Refuse to record a frame the server's own reader cannot reopen.
  const key = e.epoch === CURRENT_EPOCH ? keyCurrent : keyPrevious
  if (JSON.stringify(decryptHubEvent(payload, key, e.epoch)) !== JSON.stringify(e.content)) {
    throw new Error(`server could not reopen its own ${e.name} frame`)
  }
  return { name: e.name, epoch: e.epoch, plaintext: JSON.stringify(e.content), payload }
})

const fixture = {
  description:
    'Relay event payloads exactly as the server publishes them (apps/worker/lib/ws-events.ts ' +
    'encryptEventContent): AES-256-GCM under the epoch key, AAD = "<LABEL_HUB_EVENT_EPOCH>:<epoch>", ' +
    'plaintext = [4-byte LE length][json][random padding] padded to a power-of-two bucket (min 512). ' +
    'Every platform must open these bytes through its production reader given the frame\'s epoch, ' +
    'and must not open them under the epoch-less LABEL_HUB_EVENT AAD. Regenerate with ' +
    'packages/crypto/scripts/gen-server-event-vectors.ts — never edit by hand.',
  generator: 'apps/worker/lib/ws-events.ts encryptEventContent via bun:ffi',
  aad: { epochLabel: LABEL_HUB_EVENT_EPOCH, epochless: LABEL_HUB_EVENT },
  // What GET /api/auth/me returns as serverEventKeyHex / serverEventKeyPrevHex.
  serverEventKeyHex: bytesToHex(keyCurrent),
  serverEventKeyPrevHex: bytesToHex(keyPrevious),
  currentEpoch: CURRENT_EPOCH,
  frames,
}

writeFileSync(OUT, JSON.stringify(fixture, null, 2) + '\n')
console.log(`wrote ${OUT}`)
