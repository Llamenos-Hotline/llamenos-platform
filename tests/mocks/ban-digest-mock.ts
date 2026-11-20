/**
 * The client half of the ban digest (#2759), mirrored from `packages/crypto/src/ban_digest.rs`
 * for builds that never load the crate: the Playwright IPC mock (`ban_digest_blind` /
 * `ban_digest_finalize`) and the backend BDD steps, which act as a client of the real server.
 *
 * Both sides implement RFC 9497 OPRF (ristretto255-SHA512, mode 0x00) and are pinned to its
 * test vectors — the crate in its own tests, this one (@noble/curves) against the real server
 * library in `apps/worker/__tests__/integration-bun/ban-digest.test.ts` — so a digest computed
 * here is the digest the server matches an inbound call against.
 */
import { ristretto255_oprf } from '@noble/curves/ed25519.js'
import { HMAC_BAN_PREFIX } from '@shared/crypto-labels'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'

const E164 = /^\+\d{7,15}$/

/** The OPRF input for a typed number: refused unless E.164, never normalised (as the crate). */
function typedBanInput(phone: string): Uint8Array {
  if (!E164.test(phone)) throw new Error('phone number must be E.164 (+ followed by 7-15 digits)')
  return new TextEncoder().encode(`${HMAC_BAN_PREFIX}${phone}`)
}

export interface BanDigestBlind {
  blindHex: string
  blindedElementHex: string
}

export function banDigestBlind(phone: string): BanDigestBlind {
  const { blind, blinded } = ristretto255_oprf.oprf.blind(typedBanInput(phone))
  return { blindHex: bytesToHex(blind), blindedElementHex: bytesToHex(blinded) }
}

export function banDigestFinalize(phone: string, blindHex: string, evaluatedElementHex: string): string {
  return bytesToHex(
    ristretto255_oprf.oprf.finalize(typedBanInput(phone), hexToBytes(blindHex), hexToBytes(evaluatedElementHex)),
  )
}
