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
 * What counts as an admin is the same set the server seals its own records to
 * (`ADMIN_DECRYPTION_PUBKEY` plus every active super-admin device), the one set
 * a client can reliably be told about. The check is "at least one envelope is
 * addressed to a key an admin holds" — not "every admin", because clients wrap
 * to the key the server publishes and a device registered a moment later must
 * not turn a correct write into a 422.
 */
import type { Services } from '../services'
import { ServiceError } from '../services/settings'
import { adminHpkeRecipient, type AdminKeyEnv } from './hpke-recipient'
import { createLogger } from './logger'

const logger = createLogger('lib.admin-envelopes')

/** Anything that names the key an envelope was sealed to. */
type AddressedEnvelope = { pubkey: string }

/**
 * Refuse (422) an envelope set no admin can open.
 *
 * With NO resolvable admin recipient (no `ADMIN_DECRYPTION_PUBKEY`, no
 * super-admin device) there is nothing to check against, and the contract —
 * the same loud-but-stored one `CallsService.sealCallMetadata` and the inbound
 * message path follow — is to log an error an operator must see and persist the
 * record anyway: a hotline that refuses a volunteer's note or a crisis reply
 * because of a deployment gap loses more than it protects. Never silent.
 *
 * @param what names the record for the error log and the 422 message.
 */
export async function assertAdminCanRead(
  services: { identity: Pick<Services['identity'], 'listAdminEnvelopeRecipients'> },
  env: AdminKeyEnv,
  envelopes: readonly AddressedEnvelope[] | undefined,
  what: string,
  context: Record<string, unknown> = {},
): Promise<void> {
  const adminRecipients = await services.identity.listAdminEnvelopeRecipients(adminHpkeRecipient(env))

  if (adminRecipients.length === 0) {
    logger.error(
      `${what} stored WITHOUT any admin-readable envelope: no admin HPKE recipient resolvable ` +
      '(configure ADMIN_DECRYPTION_PUBKEY and/or register an admin device). ' +
      'No admin can read this record until its key is re-wrapped for one.',
      { ...context, envelopeCount: envelopes?.length ?? 0 },
    )
    return
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
