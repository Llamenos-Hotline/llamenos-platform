import { and, inArray, isNotNull } from 'drizzle-orm'
import type { Database } from '../db'
import { devices, users } from '../db/schema'

/**
 * Resolve the readers of a server-sealed envelope to HPKE recipient keys.
 *
 * A user's pubkey is their Ed25519 auth key and is never an X25519 recipient:
 * sealing to it produces an envelope no device can open (#1021). So any reader
 * that is a registered user is expanded to the X25519 key-agreement keys their
 * devices registered — one recipient per device — and a user with none gets no
 * envelope rather than an unopenable one. Every other key (a configured
 * `ADMIN_DECRYPTION_PUBKEY`) is already an X25519 recipient and passes through.
 *
 * Callers may pass `ADMIN_DECRYPTION_PUBKEY || ADMIN_PUBKEY` as-is: the
 * fallback is an auth key, and resolves to the admin's devices here.
 */
export async function resolveHpkeRecipients(
  db: Database,
  readers: ReadonlyArray<string | null | undefined>,
): Promise<string[]> {
  const keys = [...new Set(readers.filter((k): k is string => !!k))]
  if (keys.length === 0) return []

  const identities = new Set(
    (await db.select({ pubkey: users.pubkey }).from(users).where(inArray(users.pubkey, keys)))
      .map(r => r.pubkey),
  )
  const deviceKeys = identities.size === 0
    ? []
    : await db
      .selectDistinct({ x25519Pubkey: devices.x25519Pubkey })
      .from(devices)
      .where(and(inArray(devices.pubkey, [...identities]), isNotNull(devices.x25519Pubkey)))

  return [...new Set([
    ...keys.filter(k => !identities.has(k)),
    ...deviceKeys.flatMap(r => (r.x25519Pubkey ? [r.x25519Pubkey] : [])),
  ])]
}
