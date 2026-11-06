/**
 * The one way to turn a user id into keys anything may encrypt to.
 *
 * A user is identified by `users.pubkey`, an **Ed25519** signing key. The keys
 * that can receive HPKE are `devices.x25519_pubkey`, one per registered device.
 * Nothing about the two representations distinguishes them — both are 64 hex
 * characters, and DHKEM(X25519) accepts any 32 bytes as a recipient — so
 * passing the user id where a recipient belongs produces a well-formed envelope
 * no secret key can open (#1283, #1466).
 *
 * `apps/worker/lib/hpke-recipient.ts` makes that substitution a compile error.
 * This module is the only supplier of the branded type for a *user*: every
 * write path that needs to seal to a volunteer or an admin user goes through
 * here, so "which key do we encrypt to" has exactly one answer.
 */
import { and, eq, isNotNull } from 'drizzle-orm'
import type { Database } from '../db'
import { devices } from '../db/schema'
import { hpkeRecipientPubkey, type HpkeRecipientPubkey } from './hpke-recipient'

/**
 * Every distinct X25519 key the user has registered, one per device.
 *
 * Returns `[]` when the user has no device carrying an X25519 key. That is a
 * real answer, not an error: the user cannot be addressed, and the caller must
 * say so rather than seal to something else or silently drop the reader. A
 * desktop that has not completed `ensureDeviceRegistered()`, or an Android
 * install with no push distributor, looks exactly like this.
 */
export async function getUserHpkeRecipients(
  db: Database,
  pubkey: string,
): Promise<HpkeRecipientPubkey[]> {
  const rows = await db
    .select({ x25519Pubkey: devices.x25519Pubkey })
    .from(devices)
    .where(and(eq(devices.pubkey, pubkey), isNotNull(devices.x25519Pubkey)))

  const seen = new Set<string>()
  const recipients: HpkeRecipientPubkey[] = []
  for (const row of rows) {
    const recipient = hpkeRecipientPubkey(row.x25519Pubkey)
    if (recipient && !seen.has(recipient)) {
      seen.add(recipient)
      recipients.push(recipient)
    }
  }
  return recipients
}

/**
 * The readers of one message: the hub's `admin` reader set (`readersFor`,
 * `lib/readers.ts`), plus every device the author or assignee has registered.
 *
 * Both server-sealing write paths (`handleIncoming` and
 * `POST /conversations/:id/messages`) build this list, and building it twice
 * is how the Ed25519 substitution came to exist at two sites (#1283, #1466).
 * Deduplicated, because a hub admin who is also the author would otherwise be
 * sealed to twice. Admin readers come first, in `readersFor` order.
 *
 * The admin set is the hub's own — the devices of the members who hold the
 * admin minimum in that hub, and its escrow key — never the instance-wide
 * `ADMIN_DECRYPTION_PUBKEY` (D1: the platform operator is not a reader of hub
 * content; #1034). Whether an EMPTY admin set may be written under is the
 * caller's decision, and the two callers decide differently: an inbound
 * message is refused (`handleIncoming`), an outbound reply is still sent.
 */
export function messageReaders(
  adminReaders: readonly HpkeRecipientPubkey[],
  userRecipients: readonly HpkeRecipientPubkey[],
): HpkeRecipientPubkey[] {
  const readers: HpkeRecipientPubkey[] = []
  for (const recipient of [...adminReaders, ...userRecipients]) {
    if (!readers.includes(recipient)) readers.push(recipient)
  }
  return readers
}
