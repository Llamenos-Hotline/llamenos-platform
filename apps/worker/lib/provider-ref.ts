import { hkdf } from '@noble/hashes/hkdf.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { LABEL_PROVIDER_REF_KEY } from '@shared/crypto-labels'

/**
 * Provider identifiers in anything we log, audit or export (#2333).
 *
 * A telephony or messaging provider's identifier for a call, recording or message
 * (Twilio/SignalWire `CallSid`, `RecordingSid`, `MessageSid`; the Vonage, Plivo,
 * Telnyx and Bandwidth UUIDs) is the key to *their* CDR/MDR, which holds the
 * caller's number. Anyone holding our logs and able to reach the provider's records
 * — the provider, or whoever compels it — could re-identify callers from data we
 * do not store ourselves. So those identifiers never appear in a log line or an
 * audit row; a {@link providerRef} stands in for them.
 *
 * `providerRef(id) = "pr_" + hex(HMAC-SHA256(HKDF-SHA256(HMAC_SECRET, info = LABEL_PROVIDER_REF_KEY), id))[0..16]`
 * — the derivation shape of `messagingContactHash` (HKDF-derived key under a dedicated
 * label, then HMAC), computed with `@noble/hashes` like `ivr-media-url.ts` so the logger,
 * which imports this, never has to load the native crypto library. It is deterministic, so every line about one call carries the same
 * ref, and a holder of the key can compute it from an identifier they already have:
 *
 *   - an operator with a failed call's provider SID (from the provider console or a
 *     CDR) runs `bun run provider-ref <sid>` on the server and greps the logs for it;
 *   - someone holding only the logs, or only the provider's records, learns nothing,
 *     and cannot confirm a guess without HMAC_SECRET.
 *
 * Sixteen hex digits (64 bits) keeps the ref short enough to read and grep; the ref is
 * a correlation handle inside one deployment's logs, not a collision-free identifier.
 *
 * HMAC_SECRET (not a file-only key) is the root because the identifiers it hashes are
 * already stored in cleartext in the database: a database reader gains nothing from the
 * ref, and a log reader has no database. Rotating HMAC_SECRET changes every ref, so logs
 * written before a rotation can no longer be looked up by identifier.
 */

const REF_PREFIX = 'pr_'
const REF_HEX_LENGTH = 16

/** What a ref says when no usable HMAC_SECRET is configured: never the identifier, and visibly not a hash. */
export const UNKEYED_PROVIDER_REF = 'pr_unkeyed'

const HEX64 = /^[0-9a-f]{64}$/

/** The derived key, with the root it came from so a different secret is never answered from here. */
let cached: { root: string; key: Uint8Array } | null = null

function refKey(): Uint8Array | null {
  const root = typeof process !== 'undefined' ? process.env?.HMAC_SECRET?.trim() : undefined
  if (!root || !HEX64.test(root)) return null
  if (cached?.root === root) return cached.key
  const key = hkdf(sha256, hexToBytes(root), new Uint8Array(0), utf8ToBytes(LABEL_PROVIDER_REF_KEY), 32)
  cached = { root, key }
  return key
}

/**
 * The reference that stands in for a provider identifier in logs and audit rows.
 * Fails closed: with no usable HMAC_SECRET the result is {@link UNKEYED_PROVIDER_REF},
 * never the identifier.
 */
export function providerRef(providerId: string): string {
  const key = refKey()
  if (!key) return UNKEYED_PROVIDER_REF
  return REF_PREFIX + bytesToHex(hmac(sha256, key, utf8ToBytes(providerId))).slice(0, REF_HEX_LENGTH)
}

/**
 * Twilio/SignalWire resource SIDs: two capital letters naming the resource (CA call,
 * RE recording, SM/MM message, CF conference, …) and 32 hex digits. Distinctive enough
 * to find inside free text such as a provider's error body. The UUID-shaped identifiers
 * of the other providers cannot be found by shape — a hub id is a UUID too — so they are
 * dealt with by the field that carries them, not here.
 */
const TWILIO_SID_RE = /\b[A-Z]{2}[0-9a-f]{32}\b/g

/** `text` with every Twilio/SignalWire SID in it replaced by its {@link providerRef}. */
export function scrubProviderSids(text: string): string {
  return text.replace(TWILIO_SID_RE, (sid) => providerRef(sid))
}

/**
 * Keys whose value is a provider identifier. `callId` is here because a call's id IS the
 * provider's identifier for it (`active_calls.call_id` is the webhook's `CallSid`).
 * `messageId` is not: the messaging code uses it for its own queue ids.
 */
export const PROVIDER_ID_KEY_RE =
  /^(?:callId|callSid|parentCallSid|legSid|recordingSid|messageSid|callUuid|callControlId|providerCallId|providerMessageId)$/i

/** The key a provider-identifier field is logged under: `callSid` → `callSidRef`. */
export function providerRefKey(key: string): string {
  return `${key}Ref`
}

/**
 * `value` with every provider-identifier field and every SID-shaped string inside it
 * replaced by a ref — the form a persisted audit row or an exported payload may take.
 * Fields named by {@link PROVIDER_ID_KEY_RE} are renamed `<key>Ref`; other strings are
 * scrubbed for SIDs. Objects and arrays are walked; nothing is mutated.
 */
export function withProviderRefs<T>(value: T): T {
  return walk(value, 0) as T
}

const MAX_DEPTH = 6

function walk(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return scrubProviderSids(value)
  if (value === null || typeof value !== 'object' || value instanceof Date || depth > MAX_DEPTH) return value
  if (Array.isArray(value)) return value.map((v) => walk(v, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    if (PROVIDER_ID_KEY_RE.test(k) && typeof v === 'string') out[providerRefKey(k)] = providerRef(v)
    else out[k] = walk(v, depth + 1)
  }
  return out
}
