import { describe, expect, it } from 'vitest'
import { ed25519 } from '@noble/curves/ed25519.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@shared/encoding'
import { WS_PROTOCOL_VERSION } from '@protocol/schemas/ws-messages'
import {
  DEVICE_WIPE_CLOCK_SKEW_MS,
  DEVICE_WIPE_MAX_AGE_MS,
  verifyDeviceWipe,
  type DeviceWipeVerificationContext,
} from './device-wipe'

const serverSecret = ed25519.utils.randomSecretKey()
const serverPubkey = bytesToHex(ed25519.getPublicKey(serverSecret))
const devicePubkey = bytesToHex(ed25519.getPublicKey(ed25519.utils.randomSecretKey()))
const NOW = 1_760_000_000_000

const ctx: DeviceWipeVerificationContext = {
  devicePubkey,
  serverPubkey,
  nowMs: NOW,
  verify: async (messageHex, sigHex, pubkeyHex) =>
    ed25519.verify(hexToBytes(sigHex), hexToBytes(messageHex), hexToBytes(pubkeyHex)),
}

function frame(ts: number, extra: Record<string, unknown> = {}) {
  const message = `${WS_PROTOCOL_VERSION}:device:wipe:${devicePubkey}:${ts}`
  return { type: 'device:wipe', ...extra, ts, sig: bytesToHex(ed25519.sign(utf8ToBytes(message), serverSecret)) }
}

describe('verifyDeviceWipe', () => {
  it('accepts a wipe exactly at the max age and at the skew limit', async () => {
    expect(await verifyDeviceWipe(frame(NOW - DEVICE_WIPE_MAX_AGE_MS), ctx)).not.toBeNull()
    expect(await verifyDeviceWipe(frame(NOW + DEVICE_WIPE_CLOCK_SKEW_MS), ctx)).not.toBeNull()
  })

  it('refuses one millisecond past either bound', async () => {
    expect(await verifyDeviceWipe(frame(NOW - DEVICE_WIPE_MAX_AGE_MS - 1), ctx)).toBeNull()
    expect(await verifyDeviceWipe(frame(NOW + DEVICE_WIPE_CLOCK_SKEW_MS + 1), ctx)).toBeNull()
  })

  it('passes a known reason through and maps an unknown one to admin-erasure', async () => {
    expect(await verifyDeviceWipe(frame(NOW, { reason: 'device-revocation' }), ctx)).toEqual({ reason: 'device-revocation' })
    expect(await verifyDeviceWipe(frame(NOW, { reason: 'something-new' }), ctx)).toEqual({ reason: 'admin-erasure' })
    expect(await verifyDeviceWipe(frame(NOW), ctx)).toEqual({ reason: 'admin-erasure' })
  })

  it('fails closed without a server key, without an identity, or when the verifier throws', async () => {
    expect(await verifyDeviceWipe(frame(NOW), { ...ctx, serverPubkey: '' })).toBeNull()
    expect(await verifyDeviceWipe(frame(NOW), { ...ctx, devicePubkey: '' })).toBeNull()
    expect(await verifyDeviceWipe(frame(NOW), { ...ctx, verify: async () => { throw new Error('ipc') } })).toBeNull()
  })

  it('refuses a frame that is not a wipe frame', async () => {
    expect(await verifyDeviceWipe({ ...frame(NOW), type: 'event' }, ctx)).toBeNull()
    expect(await verifyDeviceWipe(null, ctx)).toBeNull()
  })
})
