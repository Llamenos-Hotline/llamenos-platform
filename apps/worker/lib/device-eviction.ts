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
  /** Phase 6 key-agreement pubkey — the desktop registration identity key (#1548) */
  x25519Pubkey?: string | null
}

export type RegistrationDecision =
  | { action: 'update_existing'; deviceId: string }
  | { action: 'insert'; evictDeviceId?: string }

/**
 * Decide whether a device registration should update an existing device
 * or insert a new one (possibly evicting the LRU device).
 *
 * - If a device with the same pushToken already exists: update it
 * - If matchX25519Key is given (desktop registrations have no push token) and a
 *   device with that X25519 pubkey exists: update it
 * - If at capacity (>= maxDevices): evict the device with oldest lastSeenAt
 * - Otherwise: plain insert
 *
 * A null pushToken never matches — tokenless (desktop) rows would otherwise
 * all collapse onto each other.
 */
export function decideDeviceRegistration(
  existingDevices: DeviceForEviction[],
  pushToken: string | null,
  maxDevices: number = MAX_DEVICES_PER_VOLUNTEER,
  matchX25519Key?: string | null,
): RegistrationDecision {
  // Desktop re-registration is identified by its X25519 key, not a push token.
  if (matchX25519Key) {
    const keyMatch = existingDevices.find((d) => d.x25519Pubkey === matchX25519Key)
    if (keyMatch) {
      return { action: 'update_existing', deviceId: keyMatch.id }
    }
  }

  // Check for existing device with same pushToken (mobile only — desktop has none)
  if (pushToken !== null) {
    const existing = existingDevices.find((d) => d.pushToken === pushToken)
    if (existing) {
      return { action: 'update_existing', deviceId: existing.id }
    }
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
