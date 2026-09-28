/**
 * Ed25519 signing keys whose private halves are public.
 *
 * This repository once committed signing seeds for the five demo accounts.
 * The seeds are gone from the tree but remain in git history, so anyone can
 * sign as these keys. A deployment that ran a demo reset before they were
 * removed still holds users under them, one of them a super-admin. No request
 * signed by, and no session belonging to, one of these keys is ever accepted.
 */
const REVOKED_SIGNING_PUBKEYS: ReadonlySet<string> = new Set([
  '0d786358b24f0a6eb7905b69649d8789df776144051a28da4f17e08bc716e7c8',
  '0daa88b11e127320b8bb320482258eac40b5192431a9cb0b40155b62515462d6',
  '627db7f2e7c832781e481fc43bcda730fc13022392b996a8f0a6ff99aa71d728',
  '2e2b68150166352733bc256cd023a9ca24be61f39388f0515096b009cf310a96',
  '4e5a92f65d0961fbc9927336a47964bf53a958eb8d08932c9b4378328c604a59',
])

export function isRevokedSigningKey(pubkey: string): boolean {
  return REVOKED_SIGNING_PUBKEYS.has(pubkey.toLowerCase())
}

/** For the rail that proves the published seeds never re-enter the tree. */
export function revokedSigningKeys(): ReadonlySet<string> {
  return REVOKED_SIGNING_PUBKEYS
}
