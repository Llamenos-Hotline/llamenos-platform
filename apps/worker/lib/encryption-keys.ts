/**
 * Server-side resolution of a user's HPKE recipient keys.
 *
 * A user is identified to the server by their **Ed25519** signing/auth pubkey:
 * that is what `lib/auth.ts` verifies request signatures against, what
 * `users.pubkey` stores, and what `conversations.assignedTo` holds. It is NOT
 * an HPKE recipient key. A device's signing and encryption seeds are separate
 * values — independently random for a generated device
 * (`packages/crypto/src/device_keys.rs::generate_device_keys`), HKDF-derived for
 * an imported one (`apps/desktop/src/crypto.rs::device_import_and_load`) — so
 * the 32 bytes of an Ed25519 public key are never the matching X25519 one.
 *
 * Handing those bytes to `hpkeSeal` does not fail — DHKEM(X25519) will happily
 * treat any 32 bytes as a public key — it silently produces an envelope for
 * which no secret key exists. That is #1021: every message sealed to a
 * volunteer's auth key is unreadable by the volunteer, by an admin, and by the
 * server.
 *
 * The X25519 encryption key a user actually holds lives on their devices:
 * `devices.x25519Pubkey`, published by the client at device registration. A
 * user may have several devices, so a reader resolves to zero or more
 * recipient keys and each one needs its own envelope (multi-device).
 */
import { and, inArray, isNotNull, ne } from 'drizzle-orm'
import type { Database } from '../db'
import { devices } from '../db/schema'

/** 32-byte X25519 public key, lowercase hex. */
const X25519_HEX = /^[0-9a-f]{64}$/i

/**
 * Map each given user (Ed25519 auth) pubkey to the X25519 encryption pubkeys
 * of their registered devices.
 *
 * Users with no registered device key are absent from the map rather than
 * mapped to an empty array — callers must decide explicitly what to do about a
 * reader the server cannot seal to, and the one thing they must never do is
 * fall back to the auth key.
 */
export async function resolveEncryptionPubkeys(
  db: Database,
  userPubkeys: string[],
): Promise<Map<string, string[]>> {
  const wanted = [...new Set(userPubkeys.filter(Boolean))]
  const byUser = new Map<string, string[]>()
  if (wanted.length === 0) return byUser

  const rows = await db
    .select({ pubkey: devices.pubkey, x25519Pubkey: devices.x25519Pubkey })
    .from(devices)
    .where(
      and(
        inArray(devices.pubkey, wanted),
        isNotNull(devices.x25519Pubkey),
        ne(devices.x25519Pubkey, ''),
      ),
    )

  for (const row of rows) {
    const key = row.x25519Pubkey?.trim().toLowerCase()
    // A malformed stored key would be sealed to just as silently as an Ed25519
    // one. Drop it here rather than mint another unopenable envelope.
    if (!key || !X25519_HEX.test(key)) continue
    const existing = byUser.get(row.pubkey)
    if (existing) {
      if (!existing.includes(key)) existing.push(key)
    } else {
      byUser.set(row.pubkey, [key])
    }
  }

  return byUser
}

/**
 * Resolve the recipient keys for a single user. Returns `[]` when the user has
 * no device encryption key on file.
 */
export async function resolveEncryptionPubkeysFor(
  db: Database,
  userPubkey: string,
): Promise<string[]> {
  const map = await resolveEncryptionPubkeys(db, [userPubkey])
  return map.get(userPubkey) ?? []
}

/**
 * Build the reader list for a server-sealed record: the admin's X25519
 * recipient key plus every device encryption key of the given users.
 *
 * `adminDecryptionPubkey` is `ADMIN_DECRYPTION_PUBKEY`, which `validateConfig`
 * refuses to boot without whenever an admin identity is configured — there is
 * deliberately no fallback to `ADMIN_PUBKEY` (#1283).
 */
export async function buildReaderPubkeys(
  db: Database,
  adminDecryptionPubkey: string | undefined,
  userPubkeys: string[],
): Promise<string[]> {
  const readers: string[] = []
  const admin = adminDecryptionPubkey?.trim().toLowerCase()
  if (admin && X25519_HEX.test(admin)) readers.push(admin)

  const resolved = await resolveEncryptionPubkeys(db, userPubkeys)
  for (const pubkey of userPubkeys) {
    for (const key of resolved.get(pubkey) ?? []) {
      if (!readers.includes(key)) readers.push(key)
    }
  }

  return readers
}
