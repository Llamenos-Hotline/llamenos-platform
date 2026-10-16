/**
 * The desktop registers its X25519 *public* key, and nothing else.
 *
 * The private key lives in Rust `CryptoState` and must never enter the webview,
 * so the only thing this module may read is what `get_device_pubkeys` returns:
 * a deviceId and two public keys. These tests assert the request body carries
 * exactly that, that it says `platform: 'desktop'` and no push token, and that
 * a locked vault registers nothing rather than posting a half-built body.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ensureDeviceRegistered, resetDeviceRegistrationCache } from './device-registration'

const request = vi.hoisted(() => vi.fn())
const getDevicePubkeys = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api', () => ({ request }))
vi.mock('@/lib/platform', () => ({ getDevicePubkeys }))

const DEVICE_STATE = {
  deviceId: 'device-1',
  signingPubkeyHex: 'b'.repeat(64),
  encryptionPubkeyHex: 'a'.repeat(64),
}

function lastBody(): Record<string, unknown> {
  const [, options] = request.mock.calls[request.mock.calls.length - 1]
  return JSON.parse((options as { body: string }).body)
}

describe('ensureDeviceRegistered', () => {
  beforeEach(() => {
    request.mockReset()
    getDevicePubkeys.mockReset()
    resetDeviceRegistrationCache()
    request.mockResolvedValue(undefined)
  })

  it('posts the device X25519 public key to /devices/register', async () => {
    getDevicePubkeys.mockResolvedValue(DEVICE_STATE)

    await expect(ensureDeviceRegistered()).resolves.toBe(true)

    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0][0]).toBe('/devices/register')
    expect(request.mock.calls[0][1]).toMatchObject({ method: 'POST' })
    expect(lastBody()).toMatchObject({
      platform: 'desktop',
      ed25519Pubkey: DEVICE_STATE.signingPubkeyHex,
      x25519Pubkey: DEVICE_STATE.encryptionPubkeyHex,
    })
  })

  it('sends no push token — the desktop has no push distributor', async () => {
    getDevicePubkeys.mockResolvedValue(DEVICE_STATE)
    await ensureDeviceRegistered()
    const body = lastBody()
    expect(body).not.toHaveProperty('pushToken')
    expect(body).not.toHaveProperty('wakeKeyPublic')
  })

  it('never sends a secret: the body carries only public key material', async () => {
    getDevicePubkeys.mockResolvedValue(DEVICE_STATE)
    await ensureDeviceRegistered()
    const body = lastBody()
    const keyish = Object.keys(body).filter((k) => /secret|private|seed|pin/i.test(k))
    expect(keyish).toEqual([])
    // Only the two public keys are 64-hex values.
    const hexValues = Object.values(body).filter((v) => typeof v === 'string' && /^[0-9a-f]{64}$/i.test(v))
    expect(new Set(hexValues)).toEqual(
      new Set([DEVICE_STATE.signingPubkeyHex, DEVICE_STATE.encryptionPubkeyHex]),
    )
  })

  it('registers nothing while the vault is locked', async () => {
    getDevicePubkeys.mockResolvedValue(null)
    await expect(ensureDeviceRegistered()).resolves.toBe(false)
    expect(request).not.toHaveBeenCalled()
  })

  it('does not re-post an unchanged registration', async () => {
    getDevicePubkeys.mockResolvedValue(DEVICE_STATE)
    await ensureDeviceRegistered()
    await ensureDeviceRegistered()
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('registers again when the device keys change', async () => {
    getDevicePubkeys.mockResolvedValue(DEVICE_STATE)
    await ensureDeviceRegistered()
    getDevicePubkeys.mockResolvedValue({ ...DEVICE_STATE, encryptionPubkeyHex: 'c'.repeat(64) })
    await ensureDeviceRegistered()
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('sends one POST when two callers race (StrictMode double-invoke)', async () => {
    getDevicePubkeys.mockResolvedValue(DEVICE_STATE)
    const [a, b] = await Promise.all([ensureDeviceRegistered(), ensureDeviceRegistered()])
    expect([a, b]).toEqual([true, true])
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('propagates a failure instead of swallowing it', async () => {
    getDevicePubkeys.mockResolvedValue(DEVICE_STATE)
    request.mockRejectedValue(new Error('429 rate limited'))
    await expect(ensureDeviceRegistered()).rejects.toThrow('429 rate limited')
  })

  it('retries after a failure — a failed registration is not cached as done', async () => {
    getDevicePubkeys.mockResolvedValue(DEVICE_STATE)
    request.mockRejectedValueOnce(new Error('offline'))
    await expect(ensureDeviceRegistered()).rejects.toThrow('offline')
    request.mockResolvedValue(undefined)
    await expect(ensureDeviceRegistered()).resolves.toBe(true)
    expect(request).toHaveBeenCalledTimes(2)
  })
})
