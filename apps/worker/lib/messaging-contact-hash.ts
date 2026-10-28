import { hkdfSha256, hmacSha256 } from '@llamenos/crypto/ffi'
import { hexToBytes, bytesToHex, utf8ToBytes } from '@shared/encoding'
import { HMAC_MESSAGING_CONTACT_PREFIX, LABEL_MESSAGING_CONTACT_HUB_KEY } from '@shared/crypto-labels'

/**
 * The scope of a webhook that carries no `?hub=` — the only path that is not
 * hub-scoped. Hub ids are UUIDs, so it cannot equal one.
 */
export const GLOBAL_MESSAGING_SCOPE = 'global'

/** Per-scope keys, derived once. Holds the root key it was derived from so a different key is never answered from here. */
const scopeKeys = new Map<string, { rootKey: string; key: Uint8Array }>()

function scopeKey(hubId: string | undefined, messagingHashKey: string): Uint8Array {
  const scope = hubId || GLOBAL_MESSAGING_SCOPE
  const cached = scopeKeys.get(scope)
  if (cached && cached.rootKey === messagingHashKey) return cached.key
  const key = hkdfSha256(
    hexToBytes(messagingHashKey),
    new Uint8Array(0),
    utf8ToBytes(`${LABEL_MESSAGING_CONTACT_HUB_KEY}:${scope}`),
    32,
  )
  scopeKeys.set(scope, { rootKey: messagingHashKey, key })
  return key
}

/**
 * The thread identity of a messaging contact:
 * HMAC(HKDF(MESSAGING_HASH_KEY, hubId), identifier).
 *
 * Deterministic, so a returning contact lands in the same thread; keyed per hub,
 * so the same contact in two hubs has two unrelated hashes and a hub's threads
 * cannot be linked to another's. MESSAGING_HASH_KEY is a file-only secret, never
 * in the database, `.env` or a config backup, so a database dump alone confirms
 * nothing about who a thread belongs to. It is a key of its own: only the blast
 * subscriber's identifier hash shares it, on purpose (STOP must find the row an
 * import made); no ban or audit hash of the same number can be compared with this one.
 *
 * `identifier` is the provider-level sender identity (`IncomingMessage.senderIdentifier`):
 * the same value the sealed reply address holds.
 */
export function messagingContactHash(
  identifier: string,
  hubId: string | undefined,
  messagingHashKey: string,
): string {
  return bytesToHex(
    hmacSha256(scopeKey(hubId, messagingHashKey), utf8ToBytes(`${HMAC_MESSAGING_CONTACT_PREFIX}${identifier}`)),
  )
}

/** Channels whose identifiers are phone numbers (Signal also carries a UUID, which is never phone-shaped). */
const PHONE_CHANNELS: ReadonlySet<string> = new Set(['sms', 'whatsapp', 'signal'])

/** Digits with an optional leading "+" — after formatting separators are removed. */
const PHONE_SHAPE = /^\+?\d{7,15}$/

/** The digits of a phone-shaped identifier on a phone channel, or null for anything else (UUIDs, Telegram ids, RCS ids). */
function phoneDigits(channel: string, identifier: string): string | null {
  if (!PHONE_CHANNELS.has(channel)) return null
  const stripped = identifier.replace(/^whatsapp:/, '').replace(/[\s().-]/g, '')
  return PHONE_SHAPE.test(stripped) ? stripped.replace(/^\+/, '') : null
}

/**
 * The one spelling a blast subscriber is filed under: `+digits` for a phone number
 * (an import's "+1 555-111-0000" and an inbound E.164 "From" are the same person),
 * the identifier untouched otherwise.
 */
export function canonicalSubscriberIdentifier(channel: string, identifier: string): string {
  const digits = phoneDigits(channel, identifier)
  return digits === null ? identifier : `+${digits}`
}

/**
 * What the opt-out path looks a sender up by. One person reaches us as more than
 * one identifier: Signal sends a UUID and, usually, the phone number; WhatsApp via
 * Meta sends bare digits where an admin imported "+digits". A subscriber is filed
 * under whichever shape the admin imported, so a STOP must be tried against every
 * shape the webhook carried — hashing only `senderIdentifier` leaves a person who
 * texted STOP still subscribed under the other shape.
 *
 * `identifierHash` is where a NEW subscriber is filed (the canonical form of the
 * sender); `lookupHashes` is every hash an existing row for this person may sit
 * under, `identifierHash` included. Same per-hub key as {@link messagingContactHash},
 * so nothing reversible or partial is stored.
 */
export function subscriberHashes(
  channel: string,
  identifiers: readonly string[],
  hubId: string | undefined,
  messagingHashKey: string,
): { identifierHash: string; lookupHashes: string[] } {
  const spellings = new Set<string>()
  for (const identifier of identifiers) {
    spellings.add(canonicalSubscriberIdentifier(channel, identifier))
    const digits = phoneDigits(channel, identifier)
    if (digits !== null) spellings.add(digits)
    spellings.add(identifier)
  }
  const hash = (identifier: string) => messagingContactHash(identifier, hubId, messagingHashKey)
  return {
    identifierHash: hash(canonicalSubscriberIdentifier(channel, identifiers[0])),
    lookupHashes: [...spellings].map(hash),
  }
}

/**
 * The key scope of the opt-out (suppression) record. Like {@link GLOBAL_MESSAGING_SCOPE}
 * it can never equal a hub id (hub ids are UUIDs), and it is distinct from "global",
 * so a suppression hash equals neither a hub's thread or subscriber hash nor the
 * thread hash of a `?hub=`-less webhook: a suppression row cannot be joined to any
 * conversation or subscriber by its hash.
 *
 * Suppression is deployment-wide, not per hub, because the sender identity is: the
 * messaging config (SMS number, WhatsApp business number, Signal account) is one row
 * for the whole deployment, and every hub's blasts and replies go out from it. A
 * person who texts STOP to that number has told the number to stop, whichever hub's
 * webhook URL happened to receive the message.
 */
export const SUPPRESSION_SCOPE = 'suppression'

/**
 * Every hash an opt-out for these identifiers is filed and found under: the keyed
 * hash of each identifier's canonical spelling ({@link canonicalSubscriberIdentifier}),
 * so a bare-digits WhatsApp sender, an imported "+1 (555) …" and an E.164 "From"
 * all land on one hash, and a Signal UUID lands on its own.
 *
 * The channel only decides whether an identifier is read as a phone number. The
 * resulting hash does not depend on it, so a STOP on one phone channel matches the
 * same number on another: the subscriber STOP already unsubscribes the whole row,
 * every channel included, and the suppression record holds the same line.
 */
export function suppressionHashes(
  channel: string,
  identifiers: readonly string[],
  messagingHashKey: string,
): string[] {
  const canonical = new Set(identifiers.map((identifier) => canonicalSubscriberIdentifier(channel, identifier)))
  return [...canonical].map((identifier) => messagingContactHash(identifier, SUPPRESSION_SCOPE, messagingHashKey))
}
