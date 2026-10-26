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
