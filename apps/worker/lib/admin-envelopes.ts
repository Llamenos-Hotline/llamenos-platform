/**
 * Server-side guard for client-sealed envelope sets.
 *
 * Notes and outbound messages are encrypted on the client, so the server can
 * never wrap the content key for anyone itself: the envelope list it is handed
 * IS the complete reader set, forever. A write whose set names no admin stores a
 * record no admin can ever open, and nothing can repair it afterwards — the
 * content key was never wrapped for anyone else. "Admins can always read, for
 * accountability" therefore has to be enforced at the write boundary, not
 * trusted to the client (#2113).
 *
 * Who an admin reader is, is decided in ONE place: the hub's `admin` reader set
 * (`lib/readers.ts` `readersFor`, PROTOCOL §2.4.2) — the registered device keys
 * of every member holding the admin minimum IN the record's hub (the very set
 * the hub last-admin invariant refuses to let shrink to nothing, #2126/#2190),
 * plus the hub's own optional escrow key. Super-admins are zero-knowledge and
 * never readers (D1).
 *
 * The instance-wide `ADMIN_DECRYPTION_PUBKEY` is NOT in that set. It is still
 * ACCEPTED here, as a separately named transitional recipient, because every
 * shipped client seals to it and to nothing else: refusing it today would
 * refuse every note on every platform. It is deleted from this guard once the
 * clients seal to `GET /api/hubs/:hubId/readers?purpose=admin`.
 *
 * The check is "at least one envelope is addressed to one of them" — not
 * "every admin", because clients wrap to the keys the server publishes and a
 * device registered a moment later must not turn a correct write into a 422.
 */
import type { Services } from '../services'
import { ServiceError } from '../services/settings'
import { transitionalInstanceRecipient, type AdminKeyEnv } from './hpke-recipient'
import { createLogger } from './logger'

const logger = createLogger('lib.admin-envelopes')

/** Anything that names the key an envelope was sealed to. */
type AddressedEnvelope = { pubkey: string }

/**
 * Refuse an envelope set no admin can open.
 *
 * 422 when the set names no admin key. 503 when there is no admin key to
 * check against at all — an empty `admin` reader set (no admin of the hub with
 * a registered device and no hub escrow key) and no transitional instance key.
 * This used to log and store (#2125), on the theory
 * that a hotline refusing a note over a deployment gap loses more than it
 * protects. That no longer holds: the last-admin invariant guarantees the hub
 * has an admin, so an empty recipient set is a misconfiguration (an admin who
 * never registered a device, on a hub with no escrow key), and storing a note
 * under it creates exactly the record the invariant
 * exists to prevent. The shipped clients already refuse to seal without an admin
 * key, so only a modified or stale client reaches this branch; the 503 and the
 * error log tell the operator to fix the deployment.
 *
 * @param hubId the record's hub; undefined for a record with no hub, which has
 *   no reader set, so only the transitional instance key is accepted.
 * @param what names the record for the error log and the response message.
 */
export async function assertAdminCanRead(
  services: { identity: Pick<Services['identity'], 'listAdminEnvelopeRecipients'> },
  env: AdminKeyEnv,
  hubId: string | undefined,
  envelopes: readonly AddressedEnvelope[] | undefined,
  what: string,
  context: Record<string, unknown> = {},
): Promise<void> {
  const adminRecipients = await services.identity.listAdminEnvelopeRecipients(transitionalInstanceRecipient(env), hubId)

  if (adminRecipients.length === 0) {
    logger.error(
      `${what} REFUSED: no admin HPKE recipient is resolvable, so no admin could ever read it ` +
      '(register a device for a hub admin, or set the hub escrow key).',
      { ...context, hubId, envelopeCount: envelopes?.length ?? 0 },
    )
    throw new ServiceError(
      503,
      `${what} cannot be accepted: this hub has no admin able to read it. A hub admin must register a device or set the hub escrow key`,
    )
  }

  if (!envelopes || envelopes.length === 0) {
    throw new ServiceError(
      422,
      `${what} must carry at least one admin envelope: a record no admin can read breaks admin accountability`,
    )
  }

  const admins = new Set(adminRecipients.map(key => key.toLowerCase()))
  if (!envelopes.some(envelope => admins.has(envelope.pubkey.toLowerCase()))) {
    throw new ServiceError(
      422,
      `${what} must include an envelope addressed to an admin recipient key; none of its envelopes can be opened by an admin`,
    )
  }
}
