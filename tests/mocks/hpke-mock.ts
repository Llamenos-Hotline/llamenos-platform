/**
 * The HPKE envelope primitive the Tauri IPC mock serves to the desktop webview
 * under Playwright (tauri-core.ts), shared with the Node-side seeding helpers
 * (tests/crypto-helpers.ts).
 *
 * It is the REAL suite — RFC 9180 DHKEM(X25519, HKDF-SHA256) + HKDF-SHA256 +
 * AES-256-GCM, the same one `packages/crypto/src/hpke_envelope.rs` uses.
 *
 * It used to be a bespoke construction: X25519 ECDH, then
 * `hkdf(sha256, shared, salt=∅, info="hpke-v3:<label>", 44)` split into a key
 * and a nonce. Self-consistent, and interoperable with nothing. Its own
 * docstring recorded the consequence — "the desktop client under Playwright
 * cannot open envelopes made with the real RFC 9180 suite" — which meant no
 * desktop test could ever exercise reading what the *server* writes. The
 * server/desktop AAD disagreement that made every message render as
 * `[Encrypted]` was invisible to this suite for exactly that reason: the
 * harness could not have noticed, because it never spoke the wire format.
 *
 * Envelopes are `{enc, ct}`, lowercase hex (spec D1, D2). The label is the HPKE
 * `info`; the shape table below maps each shape to its label and AAD exactly as
 * `packages/crypto/src/shape.rs` does. Because a copy can drift, the table is
 * pinned: `apps/worker/__tests__/unit/v2-vectors-mock.test.ts` opens every
 * positive vector in `packages/crypto/tests/fixtures/v2/` through this module and
 * asserts every negative is refused — the crate generated those bytes.
 *
 * The REAL RFC 9180 path (apps/desktop/src/crypto.rs → packages/crypto) is
 * covered separately, against the actual Tauri binary, by
 * tests/desktop/specs/crypto.wdio.ts (run via `bun run test:desktop:wdio`,
 * driven by tauri-driver/WebKitWebDriver — see tests/desktop/wdio.conf.ts).
 * That suite is not yet wired into any CI workflow (#1126) — only run it
 * locally until that lands. Nothing a Playwright test asserts against this
 * mock constitutes evidence about the real HPKE implementation; it only
 * proves the mocked webview build is internally consistent.
 *
 * Pure module: no `window`, no Tauri imports, safe to load from Node.
 */
import { CipherSuite, KemId, KdfId, AeadId } from 'hpke-js'
import { gcm } from '@noble/ciphers/aes.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import * as L from '@shared/crypto-labels'
import type { Shape } from '@shared/crypto-shapes'

/** Matches `packages/crypto/src/hpke_envelope.rs`: X25519-HKDF-SHA256-AES256GCM. */
const suite = new CipherSuite({
  kem: KemId.DhkemX25519HkdfSha256,
  kdf: KdfId.HkdfSha256,
  aead: AeadId.Aes256Gcm,
})

/** hpke-js takes ArrayBuffers; a Uint8Array view may be a slice of a larger one. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length)
  copy.set(bytes)
  return copy.buffer
}

// ── HPKE (RFC 9180, X25519-HKDF-SHA256-AES256GCM) ──────────────────

/** The one HPKE envelope: `{enc, ct}`, lowercase hex. */
export interface MockHpkeEnvelope {
  enc: string
  ct: string
}

const LOWER_HEX = /^(?:[0-9a-f]{2})*$/

function strictHex(field: string, hex: string, exactBytes?: number): Uint8Array {
  if (!LOWER_HEX.test(hex) || (exactBytes !== undefined && hex.length !== 2 * exactBytes)) {
    throw new Error(`invalid_format: ${field} must be lowercase hex${exactBytes ? ` of ${exactBytes} bytes` : ''}`)
  }
  return hexToBytes(hex)
}

/** Seal under a raw label and AAD — the primitive the crate-module mocks build on. */
export async function hpkeSealMock(
  plaintext: Uint8Array,
  recipientPubkeyHex: string,
  label: string,
  aad: Uint8Array,
): Promise<MockHpkeEnvelope> {
  const recipientPublicKey = await suite.importKey(
    'raw',
    toArrayBuffer(strictHex('recipient public key', recipientPubkeyHex, 32)),
    true,
  )
  const { enc, ct } = await suite.seal(
    { recipientPublicKey, info: new TextEncoder().encode(label) },
    plaintext,
    aad,
  )
  return { enc: bytesToHex(new Uint8Array(enc)), ct: bytesToHex(new Uint8Array(ct)) }
}

/** Open under a raw label and AAD. Any AEAD failure is `decryption_failed`. */
export async function hpkeOpenMock(
  envelope: MockHpkeEnvelope,
  recipientSecretHex: string,
  label: string,
  aad: Uint8Array,
): Promise<Uint8Array> {
  const enc = strictHex('enc', envelope.enc, 32)
  const ct = strictHex('ct', envelope.ct)
  if (ct.length < 16) throw new Error('invalid_format: ct shorter than the tag')
  const recipientKey = await suite.importKey('raw', toArrayBuffer(hexToBytes(recipientSecretHex)), false)
  try {
    const plaintext = await suite.open(
      { recipientKey, enc: toArrayBuffer(enc), info: new TextEncoder().encode(label) },
      toArrayBuffer(ct),
      aad,
    )
    return new Uint8Array(plaintext)
  } catch {
    throw new Error('decryption_failed: HPKE open failed')
  }
}

// ── Shapes (a mirror of packages/crypto/src/shape.rs, pinned by the v2 vectors) ──

const keyWrap = (label: string) => utf8ToBytes(`${label}:key-wrap`)
const noAad = () => new Uint8Array(0)

interface ShapeSpec {
  label: string
  arity: number
  key: boolean
  wrapAad: (fields: readonly string[]) => Uint8Array
  contentAad: Uint8Array | null
}

const SHAPE_TABLE: Record<Shape, ShapeSpec> = {
  'note-key': { label: L.LABEL_NOTE_KEY, arity: 0, key: true, wrapAad: () => keyWrap(L.LABEL_NOTE_KEY), contentAad: utf8ToBytes(L.LABEL_NOTE_KEY) },
  'file-key': { label: L.LABEL_FILE_KEY, arity: 0, key: true, wrapAad: () => keyWrap(L.LABEL_FILE_KEY), contentAad: utf8ToBytes(L.LABEL_FILE_KEY) },
  'file-metadata-key': { label: L.LABEL_FILE_METADATA, arity: 0, key: true, wrapAad: () => keyWrap(L.LABEL_FILE_METADATA), contentAad: utf8ToBytes(L.LABEL_FILE_METADATA) },
  'contact-profile-key': { label: L.LABEL_CONTACT_PROFILE, arity: 0, key: true, wrapAad: () => keyWrap(L.LABEL_CONTACT_PROFILE), contentAad: utf8ToBytes(L.LABEL_CONTACT_PROFILE) },
  'contact-id-key': { label: L.LABEL_CONTACT_ID, arity: 0, key: true, wrapAad: () => keyWrap(L.LABEL_CONTACT_ID), contentAad: utf8ToBytes(L.LABEL_CONTACT_ID) },
  'hub-key': { label: L.LABEL_HUB_KEY_WRAP, arity: 0, key: true, wrapAad: () => keyWrap(L.LABEL_HUB_KEY_WRAP), contentAad: null },
  'firehose-window-key': { label: L.LABEL_FIREHOSE_BUFFER_ENCRYPT, arity: 0, key: true, wrapAad: () => keyWrap(L.LABEL_FIREHOSE_BUFFER_ENCRYPT), contentAad: utf8ToBytes(L.LABEL_FIREHOSE_BUFFER_ENCRYPT) },
  'message-key': { label: L.LABEL_MESSAGE, arity: 0, key: true, wrapAad: noAad, contentAad: new Uint8Array(0) },
  'call-meta-key': { label: L.LABEL_CALL_META, arity: 0, key: true, wrapAad: noAad, contentAad: new Uint8Array(0) },
  'puk-seed': { label: L.LABEL_PUK_WRAP_TO_DEVICE, arity: 1, key: true, wrapAad: f => utf8ToBytes(`${L.LABEL_PUK_WRAP_TO_DEVICE}:${f[0]}`), contentAad: null },
  'audit-user-key': { label: L.LABEL_AUDIT_USER_KEY_WRAP, arity: 1, key: true, wrapAad: f => utf8ToBytes(`${L.LABEL_AUDIT_USER_KEY_WRAP}:${f[0]}`), contentAad: null },
  'push-wake': { label: L.LABEL_PUSH_WAKE, arity: 0, key: false, wrapAad: () => utf8ToBytes(`${L.LABEL_PUSH_WAKE}:push`), contentAad: null },
  'push-full': { label: L.LABEL_PUSH_FULL, arity: 0, key: false, wrapAad: () => utf8ToBytes(`${L.LABEL_PUSH_FULL}:push`), contentAad: null },
  'platform-role-name': { label: L.LABEL_PLATFORM_ROLE_NAME_ENCRYPT, arity: 1, key: false, wrapAad: f => utf8ToBytes(`${f[0]}:name`), contentAad: null },
  'platform-role-description': { label: L.LABEL_PLATFORM_ROLE_DESC_ENCRYPT, arity: 1, key: false, wrapAad: f => utf8ToBytes(`${f[0]}:description`), contentAad: null },
  'recovery-group-share': { label: L.LABEL_RECOVERY_GROUP_SHARE_WRAP, arity: 0, key: false, wrapAad: noAad, contentAad: null },
  'recovery-share-contribution': { label: L.LABEL_RECOVERY_SHARE_CONTRIBUTE, arity: 2, key: false, wrapAad: f => utf8ToBytes(`${f[0]}:${f[1]}`), contentAad: null },
  'recovery-puk-seed': { label: L.LABEL_RECOVERY_PUK_SEED_WRAP, arity: 0, key: true, wrapAad: noAad, contentAad: null },
}

function wrapAadOf(shape: Shape, fields: readonly string[]): Uint8Array {
  const spec = SHAPE_TABLE[shape]
  if (fields.length !== spec.arity || fields.some(f => f === '' || f.includes(':'))) {
    throw new Error(`invalid_input: ${shape} binds ${spec.arity} AAD field(s)`)
  }
  return spec.wrapAad(fields)
}

export async function shapeSealMock(
  shape: Shape,
  recipientPubkeyHex: string,
  fields: readonly string[],
  plaintext: Uint8Array,
): Promise<MockHpkeEnvelope> {
  const spec = SHAPE_TABLE[shape]
  if (spec.key && plaintext.length !== 32) throw new Error(`invalid_input: ${shape} seals a 32-byte key`)
  return hpkeSealMock(plaintext, recipientPubkeyHex, spec.label, wrapAadOf(shape, fields))
}

export async function shapeOpenMock(
  shape: Shape,
  recipientSecretHex: string,
  fields: readonly string[],
  envelope: MockHpkeEnvelope,
): Promise<Uint8Array> {
  const spec = SHAPE_TABLE[shape]
  const aad = wrapAadOf(shape, fields)
  if (spec.key) strictHex('ct', envelope.ct, 48)
  return hpkeOpenMock(envelope, recipientSecretHex, spec.label, aad)
}

/** The content AAD of `shape`, hex — what the desktop's `shape_content_aad` returns. */
export function shapeContentAadHexMock(shape: Shape): string {
  const aad = SHAPE_TABLE[shape].contentAad
  if (!aad) throw new Error(`invalid_input: ${shape} has no content layer`)
  return bytesToHex(aad)
}

// ── Relay events (a mirror of packages/crypto/src/events.rs, pinned by the v2 vectors) ──

function lp(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(2 + bytes.length)
  new DataView(out.buffer).setUint16(0, bytes.length, false)
  out.set(bytes, 2)
  return out
}

function u32be(n: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, n, false)
  return out
}

function u64be(n: number): Uint8Array {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, BigInt(n), false)
  return out
}

const HUB_ID_PROFILE = /^(?:[0-9a-z][0-9a-z-]{0,63}|(?:[0-9a-f]{2}){1,64})$/

function eventAad(hubId: string, kind: number, epoch: number): Uint8Array {
  if (!HUB_ID_PROFILE.test(hubId)) throw new Error('invalid_id: hub id is outside the identifier profile')
  return concatBytes(lp(utf8ToBytes(L.LABEL_HUB_EVENT_EPOCH)), lp(utf8ToBytes(hubId)), u32be(kind), u64be(epoch))
}

/** The relay-event key of `hubId` for `epoch`, derived from the server secret. */
export function serverEventKeyMock(serverSecret: Uint8Array, hubId: string, epoch: number): Uint8Array {
  const info = concatBytes(lp(utf8ToBytes(L.LABEL_SERVER_EVENT_ENCRYPTION_KEY_INFO)), lp(utf8ToBytes(hubId)), u64be(epoch))
  return hkdf(sha256, serverSecret, utf8ToBytes(L.LABEL_SERVER_EVENT_ENCRYPTION_KEY), info, 32)
}

/** Open one relay frame with its key — `events::open_server_event`. */
export function openServerEventMock(key: Uint8Array, hubId: string, kind: number, epoch: number, payloadHex: string): string {
  const aad = eventAad(hubId, kind, epoch)
  const packed = strictHex('payload', payloadHex)
  if (packed.length < 12 + 16 + 512) throw new Error('invalid_format: payload shorter than one padded bucket')
  let padded: Uint8Array
  try {
    padded = gcm(key, packed.subarray(0, 12), aad).decrypt(packed.subarray(12))
  } catch {
    throw new Error('decryption_failed: event open failed')
  }
  const len = new DataView(padded.buffer, padded.byteOffset).getUint32(0, true)
  if (len + 4 > padded.length) throw new Error('invalid_format: padding length exceeds the buffer')
  return new TextDecoder('utf-8', { fatal: true }).decode(padded.subarray(4, 4 + len))
}
