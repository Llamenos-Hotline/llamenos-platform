/**
 * Device key claims (#2496; spec 2026-11-25-v2-device-linking-and-recovery §6,
 * L5): a device public key belongs to ONE user, across all users.
 *
 * Every write that names a device key — a sigchain link (services/crypto-keys.ts)
 * or a device registration (services/identity.ts registerDevice) — claims it in
 * `device_key_claims` inside its own transaction. A key another user already
 * holds refuses the write. No native FFI here, so identity.ts can import it
 * statically.
 */
import { asc, eq, inArray } from 'drizzle-orm'
import type { Database } from '../db'
import { deviceKeyClaims, sigchainLinks, users } from '../db/schema'

type Tx = Parameters<Database['transaction']>[0] extends (tx: infer T, ...rest: never[]) => unknown ? T : never

/** A device public key a link or registration names, and what kind it is. */
export interface DeviceKeyClaim {
  key: string
  kind: 'signing' | 'encryption'
}

/** A write named a device key another user already holds. */
export class DeviceKeyReusedError extends Error {
  readonly status = 409 as const
  constructor() {
    // Names neither the other user nor the key: a refusal must not tell the
    // caller whose key it tried to register (user identity protection).
    super('device key is already registered to another user (#2496)')
    this.name = 'DeviceKeyReusedError'
  }
}

const HEX_KEY = /^[0-9a-f]+$/i

/**
 * Every device key a sigchain link names: its signer and the payload's
 * `devicePubkey` (signing), `deviceEncryptionPubkey` (X25519) and
 * `encryptionPubkey` (X-Wing). Mirrors the keys packages/crypto
 * `verify_sigchain` records in `namedKeys`, so the server's uniqueness and the
 * clients' cross-chain refusal cover the same keys.
 */
export function deviceKeysNamedBy(link: { signerPubkey?: string; payload: unknown }): DeviceKeyClaim[] {
  const payload = (link.payload ?? {}) as Record<string, unknown>
  const named: DeviceKeyClaim[] = []
  const add = (value: unknown, kind: DeviceKeyClaim['kind']) => {
    if (typeof value === 'string' && value !== '' && HEX_KEY.test(value)) named.push({ key: value.toLowerCase(), kind })
  }
  add(link.signerPubkey, 'signing')
  add(payload.devicePubkey, 'signing')
  add(payload.deviceEncryptionPubkey, 'encryption')
  add(payload.encryptionPubkey, 'encryption')
  return named
}

/**
 * Claim `keys` for `userPubkey`, inside the caller's transaction. A key already
 * claimed by ANOTHER user throws `DeviceKeyReusedError` and the caller's
 * transaction rolls back. Re-claiming a key the same user already holds is a
 * no-op. Claims are permanent (see `deviceKeyClaims`).
 *
 * Another user's identity key (`users.pubkey`) is refused too, even before that
 * user's first device has claimed it: a user row exists from invite or admin
 * creation on, so a member who has seen it could otherwise claim it first and
 * lock its owner out of their own genesis.
 */
export async function claimDeviceKeys(
  tx: Tx,
  userPubkey: string,
  keys: readonly DeviceKeyClaim[],
): Promise<void> {
  if (keys.length === 0) return
  const unique = [...new Map(keys.map(k => [k.key.toLowerCase(), { key: k.key.toLowerCase(), kind: k.kind }])).values()]
  const identities = await tx
    .select({ pubkey: users.pubkey })
    .from(users)
    .where(inArray(users.pubkey, unique.map(k => k.key)))
  if (identities.some(u => u.pubkey !== userPubkey)) throw new DeviceKeyReusedError()
  await tx
    .insert(deviceKeyClaims)
    .values(unique.map(k => ({ key: k.key, userPubkey, kind: k.kind })))
    .onConflictDoNothing({ target: deviceKeyClaims.key })
  const held = await tx
    .select({ userPubkey: deviceKeyClaims.userPubkey })
    .from(deviceKeyClaims)
    .where(inArray(deviceKeyClaims.key, unique.map(k => k.key)))
  if (held.some(h => h.userPubkey !== userPubkey)) throw new DeviceKeyReusedError()
}

/**
 * The devices a user's sigchain currently authorises, as Ed25519 key → the
 * X25519 key the chain names for it (genesis / device_add
 * `deviceEncryptionPubkey`), or `null` for a user with no chain yet. Mirrors the
 * device-set walk of packages/crypto `verify_sigchain` (device_remove removes by
 * key). Used to bind a device registration to the chain (#2496): once a user
 * has a chain, a registration may name only a device the chain authorises, with
 * the X25519 key the chain gives it.
 */
export async function chainDeviceEncryptionKeys(
  tx: Tx,
  userPubkey: string,
): Promise<Map<string, string | undefined> | null> {
  const rows = await tx
    .select({ linkType: sigchainLinks.linkType, payload: sigchainLinks.payload })
    .from(sigchainLinks)
    .where(eq(sigchainLinks.userPubkey, userPubkey))
    .orderBy(asc(sigchainLinks.seqNo))
  if (rows.length === 0) return null
  const devices = new Map<string, string | undefined>()
  for (const row of rows) {
    const p = (row.payload ?? {}) as { devicePubkey?: unknown; deviceEncryptionPubkey?: unknown }
    const device = typeof p.devicePubkey === 'string' ? p.devicePubkey.toLowerCase() : undefined
    const x25519 = typeof p.deviceEncryptionPubkey === 'string' ? p.deviceEncryptionPubkey.toLowerCase() : undefined
    if (!device) continue
    if (row.linkType === 'genesis' || row.linkType === 'device_add' || row.linkType === 'recovery-device-add') {
      devices.set(device, x25519)
    } else if (row.linkType === 'device_remove') {
      devices.delete(device)
    }
  }
  return devices
}

/** A registration names a device or key its user's sigchain does not authorise. */
export class DeviceNotInChainError extends Error {
  readonly status = 409 as const
  constructor(detail: string) {
    super(`device registration does not match the user's sigchain (#2496): ${detail}`)
    this.name = 'DeviceNotInChainError'
  }
}
