/**
 * Pure functions extracted from IdentityService.registerDevice for unit testing.
 * Device LRU eviction selection — no DB dependencies.
 */

/** Maximum devices per user before LRU eviction kicks in */
export const MAX_DEVICES_PER_VOLUNTEER = 5

export interface DeviceForEviction {
  id: string
  lastSeenAt: Date | null
  pushToken: string | null
  /** The device's own Ed25519 signing key — its stable identity. */
  ed25519Pubkey?: string | null
}

/** What a registration claims to identify itself by. */
export interface RegistrationIdentity {
  /** The device's Ed25519 signing key, when the client holds one. */
  ed25519Pubkey?: string | null
  /** The push endpoint, when the client has a push distributor configured. */
  pushToken?: string | null
}

export type RegistrationDecision =
  | { action: 'update_existing'; deviceId: string }
  | { action: 'insert'; evictDeviceId?: string }

/**
 * Decide whether a device registration should update an existing device
 * or insert a new one (possibly evicting the LRU device).
 *
 * Matching is by the device's Ed25519 signing key first and its push token
 * second. The signing key is the device's identity: it survives a push
 * endpoint rotation, and it is the only handle a client without push (the
 * Tauri desktop) has. Matching on the push token alone meant a rotated ntfy
 * endpoint registered a *second* row for the same physical device, and after
 * five rotations the LRU eviction below started deleting other real devices'
 * HPKE keys.
 *
 * - If a device with the same ed25519Pubkey exists: update it
 * - Else if a device with the same pushToken exists: update it
 * - Else if at capacity (>= maxDevices): evict the device with oldest lastSeenAt
 * - Otherwise: plain insert
 */
export function decideDeviceRegistration(
  existingDevices: DeviceForEviction[],
  identity: RegistrationIdentity,
  maxDevices: number = MAX_DEVICES_PER_VOLUNTEER,
): RegistrationDecision {
  const byIdentity = identity.ed25519Pubkey
    ? existingDevices.find((d) => d.ed25519Pubkey === identity.ed25519Pubkey)
    : undefined
  if (byIdentity) {
    return { action: 'update_existing', deviceId: byIdentity.id }
  }

  // Fall back to the push endpoint for clients that register no signing key.
  const existing = identity.pushToken
    ? existingDevices.find((d) => d.pushToken === identity.pushToken)
    : undefined
  if (existing) {
    return { action: 'update_existing', deviceId: existing.id }
  }

  // Check if at capacity
  if (existingDevices.length >= maxDevices) {
    const sorted = [...existingDevices].sort((a, b) => {
      const aTime = a.lastSeenAt?.getTime() ?? 0
      const bTime = b.lastSeenAt?.getTime() ?? 0
      return aTime - bTime
    })
    return { action: 'insert', evictDeviceId: sorted[0].id }
  }

  return { action: 'insert' }
}

/**
 * Select which device to evict using LRU (Least Recently Used) strategy.
 * Returns the device with the oldest lastSeenAt, or null lastSeenAt first.
 * Returns null if the list is empty.
 */
export function selectLruDevice(devices: DeviceForEviction[]): DeviceForEviction | null {
  if (devices.length === 0) return null

  return [...devices].sort((a, b) => {
    const aTime = a.lastSeenAt?.getTime() ?? 0
    const bTime = b.lastSeenAt?.getTime() ?? 0
    return aTime - bTime
  })[0]
}
