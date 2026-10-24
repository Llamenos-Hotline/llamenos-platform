import { users } from '../../db/schema'
import type { Database } from '../../db'

/**
 * Insert a user to found a test hub with.
 *
 * `SettingsService.createHub` creates a hub together with its first admin and
 * refuses to create one otherwise (#2126), so fixtures that only need "a hub"
 * need a founder to hand it.
 */
export async function insertHubFounder(db: Database): Promise<{ pubkey: string; roleIds: string[] }> {
  const pubkey = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('')
  await db.insert(users).values({ pubkey, displayName: 'Hub founder' })
  return { pubkey, roleIds: ['role-hub-admin'] }
}
