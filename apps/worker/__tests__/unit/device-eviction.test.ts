import { describe, it, expect } from 'vitest'
import {
  decideDeviceRegistration,
  selectLruDevice,
  MAX_DEVICES_PER_VOLUNTEER,
  type DeviceForEviction,
} from '../../lib/device-eviction'

function makeDevice(
  id: string,
  lastSeenAt: Date | null,
  pushToken: string = `token-${id}`,
): DeviceForEviction {
  return { id, lastSeenAt, pushToken }
}

// ---------------------------------------------------------------------------
// decideDeviceRegistration
// ---------------------------------------------------------------------------

describe('decideDeviceRegistration', () => {
  it('6 devices → evict the one with oldest lastSeenAt', () => {
    const oldest = new Date('2026-01-01T00:00:00Z')
    const newer = new Date('2026-05-01T00:00:00Z')
    const devices = [
      makeDevice('d1', oldest),
      makeDevice('d2', newer),
      makeDevice('d3', newer),
      makeDevice('d4', newer),
      makeDevice('d5', newer),
      makeDevice('d6', newer),
    ]
    const decision = decideDeviceRegistration(devices, 'new-token', 5)
    expect(decision.action).toBe('insert')
    if (decision.action === 'insert') {
      expect(decision.evictDeviceId).toBe('d1')
    }
  })

  it('existing device (same pushToken) → update, no eviction', () => {
    const devices = [
      makeDevice('d1', new Date(), 'existing-token'),
      makeDevice('d2', new Date()),
    ]
    const decision = decideDeviceRegistration(devices, 'existing-token')
    expect(decision.action).toBe('update_existing')
    if (decision.action === 'update_existing') {
      expect(decision.deviceId).toBe('d1')
    }
  })

  it('exactly 5 devices → new registration triggers eviction', () => {
    const devices = Array.from({ length: 5 }, (_, i) =>
      makeDevice(`d${i}`, new Date(`2026-0${i + 1}-01T00:00:00Z`)),
    )
    const decision = decideDeviceRegistration(devices, 'new-token')
    expect(decision.action).toBe('insert')
    if (decision.action === 'insert') {
      // d0 has the oldest date (2026-01-01)
      expect(decision.evictDeviceId).toBe('d0')
    }
  })

  it('< 5 devices → no eviction', () => {
    const devices = [
      makeDevice('d1', new Date()),
      makeDevice('d2', new Date()),
    ]
    const decision = decideDeviceRegistration(devices, 'new-token')
    expect(decision.action).toBe('insert')
    if (decision.action === 'insert') {
      expect(decision.evictDeviceId).toBeUndefined()
    }
  })

  it('empty device list → plain insert', () => {
    const decision = decideDeviceRegistration([], 'new-token')
    expect(decision.action).toBe('insert')
    if (decision.action === 'insert') {
      expect(decision.evictDeviceId).toBeUndefined()
    }
  })

  // #1548 groundwork: desktop registrations have no push token.
  describe('desktop registrations (null pushToken)', () => {
    it('matching X25519 key → update_existing', () => {
      const devices: DeviceForEviction[] = [
        { id: 'd1', lastSeenAt: new Date(), pushToken: null, x25519Pubkey: 'x-key-1' },
        makeDevice('d2', new Date()),
      ]
      const decision = decideDeviceRegistration(devices, null, 5, 'x-key-1')
      expect(decision).toEqual({ action: 'update_existing', deviceId: 'd1' })
    })

    it('null pushToken never matches another tokenless device → insert', () => {
      const devices: DeviceForEviction[] = [
        { id: 'd1', lastSeenAt: new Date(), pushToken: null, x25519Pubkey: 'x-key-1' },
      ]
      const decision = decideDeviceRegistration(devices, null, 5, 'x-key-2')
      expect(decision.action).toBe('insert')
      if (decision.action === 'insert') {
        expect(decision.evictDeviceId).toBeUndefined()
      }
    })

    it('no matchKey and null pushToken → insert, evicting LRU at capacity', () => {
      const devices = Array.from({ length: 5 }, (_, i) =>
        makeDevice(`d${i}`, new Date(`2026-0${i + 1}-01T00:00:00Z`)),
      )
      const decision = decideDeviceRegistration(devices, null)
      expect(decision.action).toBe('insert')
      if (decision.action === 'insert') {
        expect(decision.evictDeviceId).toBe('d0')
      }
    })

    it('X25519 match takes precedence over push-token match', () => {
      const devices: DeviceForEviction[] = [
        { id: 'd1', lastSeenAt: new Date(), pushToken: null, x25519Pubkey: 'x-key-1' },
        makeDevice('d2', new Date(), 'fresh-token'),
      ]
      const decision = decideDeviceRegistration(devices, 'fresh-token', 5, 'x-key-1')
      expect(decision).toEqual({ action: 'update_existing', deviceId: 'd1' })
    })
  })
})

// ---------------------------------------------------------------------------
// selectLruDevice
// ---------------------------------------------------------------------------

describe('selectLruDevice', () => {
  it('selects device with oldest lastSeenAt', () => {
    const devices = [
      makeDevice('d1', new Date('2026-03-01')),
      makeDevice('d2', new Date('2026-01-01')),
      makeDevice('d3', new Date('2026-05-01')),
    ]
    expect(selectLruDevice(devices)!.id).toBe('d2')
  })

  it('null lastSeenAt sorts before any date (evicted first)', () => {
    const devices = [
      makeDevice('d1', new Date('2026-01-01')),
      makeDevice('d2', null),
    ]
    // null → getTime() ?? 0 → 0, which is less than any real date
    expect(selectLruDevice(devices)!.id).toBe('d2')
  })

  it('multiple devices with same lastSeenAt → deterministic (first in sort-stable order)', () => {
    const sameTime = new Date('2026-05-02T12:00:00Z')
    const devices = [
      makeDevice('d1', sameTime),
      makeDevice('d2', sameTime),
      makeDevice('d3', sameTime),
    ]
    const result = selectLruDevice(devices)
    expect(result).not.toBeNull()
    // Sort is stable in V8, so first element stays first when equal
    expect(result!.id).toBe('d1')
  })

  it('returns null for empty list', () => {
    expect(selectLruDevice([])).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('MAX_DEVICES_PER_VOLUNTEER', () => {
  it('is 5', () => {
    expect(MAX_DEVICES_PER_VOLUNTEER).toBe(5)
  })
})
