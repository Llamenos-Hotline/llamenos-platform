/**
 * A device is addressable only once its X25519 key is on record.
 *
 * `devices.x25519_pubkey` existed and `POST /devices/register` accepted it, but
 * `registerDeviceBodySchema` admitted only `platform: 'ios' | 'android'` and
 * required `pushToken` + `wakeKeyPublic` — so the Tauri desktop, which has no
 * push distributor, could not register at all and its column stayed NULL.
 * Nothing could then HPKE-wrap a message to a desktop user.
 *
 * These tests pin the three parts of the fix: the schema accepts an
 * identity-only desktop registration and still refuses an empty one; a
 * registration is keyed on the device's own signing key so repeat logins update
 * one row; and a user id never doubles as a recipient key.
 */
import { describe, it, expect } from 'vitest'
import { registerDeviceBodySchema } from '@protocol/schemas'
import { decideDeviceRegistration, MAX_DEVICES_PER_VOLUNTEER } from '../../lib/device-eviction'

const X25519 = 'a'.repeat(64)
const ED25519 = 'b'.repeat(64)

describe('registerDeviceBodySchema', () => {
  it('accepts a desktop registration carrying only its crypto keys', () => {
    const parsed = registerDeviceBodySchema.safeParse({
      platform: 'desktop',
      ed25519Pubkey: ED25519,
      x25519Pubkey: X25519,
      deviceName: 'Desktop (Linux)',
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.pushToken).toBeUndefined()
      expect(parsed.data.x25519Pubkey).toBe(X25519)
    }
  })

  it('still accepts the mobile push registration Android sends today', () => {
    const parsed = registerDeviceBodySchema.safeParse({
      platform: 'android',
      pushToken: 'https://ntfy.example.org/abc',
      wakeKeyPublic: X25519,
      ed25519Pubkey: ED25519,
      x25519Pubkey: X25519,
    })
    expect(parsed.success).toBe(true)
  })

  it('refuses a registration that registers neither push nor an identity', () => {
    const parsed = registerDeviceBodySchema.safeParse({
      platform: 'desktop',
      deviceName: 'Desktop (Linux)',
    })
    expect(parsed.success).toBe(false)
  })

  it('refuses a push token with no wake key', () => {
    const parsed = registerDeviceBodySchema.safeParse({
      platform: 'android',
      pushToken: 'https://ntfy.example.org/abc',
      x25519Pubkey: X25519,
    })
    expect(parsed.success).toBe(false)
  })

  it('refuses a malformed X25519 key rather than storing an unusable recipient', () => {
    const parsed = registerDeviceBodySchema.safeParse({
      platform: 'desktop',
      ed25519Pubkey: ED25519,
      x25519Pubkey: 'not-hex',
    })
    expect(parsed.success).toBe(false)
  })
})

describe('decideDeviceRegistration keys on the device identity', () => {
  const existing = [
    { id: 'dev-1', lastSeenAt: new Date('2026-01-01'), pushToken: 'tok-1', ed25519Pubkey: ED25519 },
  ]

  it('updates the row with the same ed25519Pubkey even with no push token at all', () => {
    const decision = decideDeviceRegistration(existing, { ed25519Pubkey: ED25519 })
    expect(decision).toEqual({ action: 'update_existing', deviceId: 'dev-1' })
  })

  it('updates the row with the same ed25519Pubkey after the push endpoint rotated', () => {
    const decision = decideDeviceRegistration(existing, {
      ed25519Pubkey: ED25519,
      pushToken: 'tok-rotated',
    })
    expect(decision).toEqual({ action: 'update_existing', deviceId: 'dev-1' })
  })

  it('still falls back to the push token when no signing key is supplied', () => {
    const decision = decideDeviceRegistration(existing, { pushToken: 'tok-1' })
    expect(decision).toEqual({ action: 'update_existing', deviceId: 'dev-1' })
  })

  it('inserts a genuinely different device', () => {
    const decision = decideDeviceRegistration(existing, { ed25519Pubkey: 'c'.repeat(64) })
    expect(decision.action).toBe('insert')
  })

  it('does not evict another real device when the desktop re-registers at capacity', () => {
    const atCapacity = Array.from({ length: MAX_DEVICES_PER_VOLUNTEER }, (_, i) => ({
      id: `dev-${i}`,
      lastSeenAt: new Date(2026, 0, i + 1),
      pushToken: `tok-${i}`,
      ed25519Pubkey: i === 4 ? ED25519 : `${i}`.repeat(64),
    }))
    const decision = decideDeviceRegistration(atCapacity, { ed25519Pubkey: ED25519 })
    expect(decision).toEqual({ action: 'update_existing', deviceId: 'dev-4' })
  })
})
