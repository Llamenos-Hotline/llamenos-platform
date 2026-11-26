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
import { inArray } from 'drizzle-orm'
import type { Database } from '../db'
import { deviceKeyClaims } from '../db/schema'

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
 */
export async function claimDeviceKeys(
  tx: Tx,
  userPubkey: string,
  keys: readonly DeviceKeyClaim[],
): Promise<void> {
  if (keys.length === 0) return
  const unique = [...new Map(keys.map(k => [k.key.toLowerCase(), { key: k.key.toLowerCase(), kind: k.kind }])).values()]
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
