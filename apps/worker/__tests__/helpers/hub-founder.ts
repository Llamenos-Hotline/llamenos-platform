import { devices, users } from '../../db/schema'
import type { Database } from '../../db'

const randomHex32 = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('')

/**
 * Insert a user to found a test hub with.
 *
 * `SettingsService.createHub` creates a hub together with its first admin and
 * refuses to create one otherwise (#2126), so fixtures that only need "a hub"
 * need a founder to hand it.
 *
 * The founder has a registered device key, as every real founder does: the
 * setup wizard refuses to found a hub for an admin without one, and the desktop
 * registers its device on unlock. That key is what makes the founder the hub's
 * admin READER (#1034) — a hub without one refuses inbound messages, since no
 * admin could read them. A test about a hub with no admin reader builds that
 * state itself.
 */
export async function insertHubFounder(db: Database): Promise<{ pubkey: string; roleIds: string[] }> {
  const pubkey = randomHex32()
  await db.insert(users).values({ pubkey, displayName: 'Hub founder' })
  await db.insert(devices).values({ pubkey, platform: 'desktop', x25519Pubkey: randomHex32() })
  return { pubkey, roleIds: ['role-hub-admin'] }
}
