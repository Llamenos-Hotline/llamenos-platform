/**
 * Mock HPKE envelope primitive (X25519 + HKDF-SHA256 + AES-256-GCM) shared by
 * the Tauri IPC mock (tauri-core.ts — what the desktop webview calls under
 * Playwright) and the Node-side seeding helpers (tests/crypto-helpers.ts).
 *
 * The desktop client under Playwright cannot open envelopes made with the
 * real RFC 9180 suite: `hpke_open_key_from_state` is served by this mock, so
 * anything a test seeds through the API for the UI to decrypt must be sealed
 * with the SAME primitive. Keeping one implementation here — imported by both
 * sides — is what stops the two from drifting apart (issue #796).
 *
 * Pure module: no `window`, no Tauri imports, safe to load from Node.
 */
import { x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { gcm } from '@noble/ciphers/aes.js'
import { randomBytes, utf8ToBytes, hexToBytes } from '@noble/hashes/utils.js'

export function base64urlEncode(bytes: Uint8Array): string {
  const b64 = btoa(String.fromCharCode(...bytes))
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function base64urlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - (str.length % 4)) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, c => c.charCodeAt(0))
}

// ── Label registry (matches Rust labels.rs) ─────────────────────────

// Labels must match packages/protocol/crypto-labels.json exactly.
// Index order matches LABEL_REGISTRY in packages/crypto/src/labels.rs.
export const LABEL_MAP: Record<string, number> = {
  'llamenos:note-key': 0,
  'llamenos:file-key': 1,
  'llamenos:file-metadata': 2,
  'llamenos:hub-key-wrap': 3,
  'llamenos:transcription': 4,
  'llamenos:message': 5,
  'llamenos:call-meta': 6,
  'llamenos:shift-schedule': 7,
  'llamenos:puk:sign:v1': 41,
  'llamenos:puk:dh:v1': 42,
  'llamenos:puk:secretbox:v1': 43,
  'llamenos:puk:wrap:device:v1': 44,
  'llamenos:device-auth:v1': 46,
  'llamenos:sframe-call-secret:v1': 50,
  'llamenos:sframe-base-key:v1': 51,
  'llamenos:mls-provision:v1': 52,
  'llamenos:recovery-group:share-wrap:v1': 60,
  'llamenos:recovery-group:puk-seed-wrap:v1': 61,
  'llamenos:recovery-group:share-contribute:v1': 62,
  'llamenos:recovery-group:liveness-proof:v1': 63,
  'llamenos:sas-derive:v1': 80,
}

export function labelToId(label: string): number {
  const id = LABEL_MAP[label]
  if (id === undefined) throw new Error(`Unknown label: ${label}`)
  return id
}

// ── HPKE mock (X25519 + HKDF-SHA256 + AES-256-GCM) ─────────────────

/** Wire shape of packages/crypto `HpkeEnvelope` (serde camelCase). */
export interface MockHpkeEnvelope {
  v: number
  labelId: number
  enc: string
  ct: string
}

export function hpkeSealMock(
  plaintext: Uint8Array,
  recipientPubkeyHex: string,
  label: string,
  aad: Uint8Array,
): MockHpkeEnvelope {
  const labelId = labelToId(label)

  // Generate ephemeral X25519 keypair
  const ephSeed = randomBytes(32)
  const ephPub = x25519.getPublicKey(ephSeed)
  const recipientPub = hexToBytes(recipientPubkeyHex)

  // ECDH shared secret
  const sharedSecret = x25519.getSharedSecret(ephSeed, recipientPub)

  // HKDF extract + expand
  const info = utf8ToBytes(`hpke-v3:${label}`)
  const derived = hkdf(sha256, sharedSecret, new Uint8Array(0), info, 44)

  const aesKey = derived.slice(0, 32)
  const nonce = derived.slice(32, 44)

  // AES-256-GCM encrypt with AAD
  const cipher = gcm(aesKey, nonce, aad)
  const ct = cipher.encrypt(plaintext)

  return {
    v: 3,
    labelId,
    enc: base64urlEncode(ephPub),
    ct: base64urlEncode(ct),
  }
}

export function hpkeOpenMock(
  envelope: MockHpkeEnvelope,
  recipientSecretHex: string,
  expectedLabel: string,
  aad: Uint8Array,
): Uint8Array {
  if (envelope.v !== 3) throw new Error(`Unsupported HPKE version: ${envelope.v}`)
  const expectedId = labelToId(expectedLabel)
  if (envelope.labelId !== expectedId) {
    throw new Error(`Label mismatch: expected ${expectedId}, got ${envelope.labelId}`)
  }

  const ephPub = base64urlDecode(envelope.enc)
  const ct = base64urlDecode(envelope.ct)
  const recipientSecret = hexToBytes(recipientSecretHex)

  // ECDH shared secret
  const sharedSecret = x25519.getSharedSecret(recipientSecret, ephPub)

  // HKDF extract + expand
  const info = utf8ToBytes(`hpke-v3:${expectedLabel}`)
  const derived = hkdf(sha256, sharedSecret, new Uint8Array(0), info, 44)

  const aesKey = derived.slice(0, 32)
  const nonce = derived.slice(32, 44)

  // AES-256-GCM decrypt with AAD
  const cipher = gcm(aesKey, nonce, aad)
  return cipher.decrypt(ct)
}

