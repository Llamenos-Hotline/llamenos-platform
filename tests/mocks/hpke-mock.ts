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
 * The label still becomes the HPKE `info` (the Albrecht defense) and the
 * labelId is still checked against the expected label before any key material
 * is touched, so the mock enforces what the Rust implementation enforces.
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
import { hexToBytes } from '@noble/hashes/utils.js'

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

// ── HPKE (RFC 9180, X25519-HKDF-SHA256-AES256GCM) ──────────────────

export async function hpkeSealMock(
  plaintext: Uint8Array,
  recipientPubkeyHex: string,
  label: string,
  aad: Uint8Array,
): Promise<{ v: number; labelId: number; enc: string; ct: string }> {
  const labelId = labelToId(label)
  const recipientPublicKey = await suite.importKey(
    'raw',
    toArrayBuffer(hexToBytes(recipientPubkeyHex)),
    true,
  )

  const { enc, ct } = await suite.seal(
    { recipientPublicKey, info: new TextEncoder().encode(label) },
    plaintext,
    aad,
  )

  return {
    v: 3,
    labelId,
    enc: base64urlEncode(new Uint8Array(enc)),
    ct: base64urlEncode(new Uint8Array(ct)),
  }
}

export async function hpkeOpenMock(
  envelope: { v: number; labelId: number; enc: string; ct: string },
  recipientSecretHex: string,
  expectedLabel: string,
  aad: Uint8Array,
): Promise<Uint8Array> {
  if (envelope.v !== 3) throw new Error(`Unsupported HPKE version: ${envelope.v}`)
  const expectedId = labelToId(expectedLabel)
  if (envelope.labelId !== expectedId) {
    throw new Error(`Label mismatch: expected ${expectedId}, got ${envelope.labelId}`)
  }

  const recipientKey = await suite.importKey(
    'raw',
    toArrayBuffer(hexToBytes(recipientSecretHex)),
    false,
  )

  const plaintext = await suite.open(
    {
      recipientKey,
      enc: toArrayBuffer(base64urlDecode(envelope.enc)),
      info: new TextEncoder().encode(expectedLabel),
    },
    toArrayBuffer(base64urlDecode(envelope.ct)),
    aad,
  )

  return new Uint8Array(plaintext)
}

