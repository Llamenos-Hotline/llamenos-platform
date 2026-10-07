import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  isValidPin,
  KeyLockedError,
  markUnlocked,
  isUnlocked,
  getPublicKeyHex,
  onLock,
  onUnlock,
  setLockDelay,
  getLockDelayMs,
  lock,
  wipeKey,
} from './key-manager'

describe('isValidPin', () => {
  it('rejects too short numeric PIN', () => {
    expect(isValidPin('1234567')).toBe(false)
  })

  it('accepts 8-digit numeric PIN', () => {
    expect(isValidPin('12345678')).toBe(true)
  })

  it('accepts longer numeric PIN', () => {
    expect(isValidPin('123456789012')).toBe(true)
  })

  it('accepts alphanumeric passphrase with letters', () => {
    expect(isValidPin('MyPass12')).toBe(true)
    expect(isValidPin('abcdefgh')).toBe(true)
  })

  it('rejects passphrase without letters', () => {
    expect(isValidPin('1234!@#$')).toBe(false)
    expect(isValidPin('!@#$%^&*')).toBe(false)
  })

  it('rejects empty string', () => {
    expect(isValidPin('')).toBe(false)
  })

  it('rejects 7-character passphrase', () => {
    expect(isValidPin('abcdefg')).toBe(false)
  })
})

describe('KeyLockedError', () => {
  it('has correct name and message', () => {
    const err = new KeyLockedError()
    expect(err.name).toBe('KeyLockedError')
    expect(err.message).toBe('Key is locked. Enter PIN to unlock.')
  })

  it('is instance of Error', () => {
    const err = new KeyLockedError()
    expect(err).toBeInstanceOf(Error)
  })
})

describe('lock/unlock state', () => {
  beforeEach(() => {
    lock()
  })

  it('starts locked', () => {
    expect(isUnlocked()).toBe(false)
    expect(getPublicKeyHex()).toBeNull()
  })

  it('markUnlocked sets state and pubkey', () => {
    markUnlocked('aabbccdd')
    expect(isUnlocked()).toBe(true)
    expect(getPublicKeyHex()).toBe('aabbccdd')
  })

  it('lock clears unlocked state but keeps pubkey', () => {
    markUnlocked('aabbccdd')
    expect(isUnlocked()).toBe(true)

    lock()
    expect(isUnlocked()).toBe(false)
    expect(getPublicKeyHex()).toBe('aabbccdd')
  })

  it('wipeKey locks and clears stored key', async () => {
    markUnlocked('aabbccdd')
    await expect(wipeKey()).rejects.toThrow('Vault wipe unavailable — Tauri required')
    expect(isUnlocked()).toBe(false)
  })
})

describe('callbacks', () => {
  beforeEach(() => {
    lock()
  })

  it('onLock fires when lock() is called', () => {
    const cb = vi.fn()
    const unsubscribe = onLock(cb)

    markUnlocked('pk1')
    lock()
    expect(cb).toHaveBeenCalledTimes(1)

    unsubscribe()
  })

  it('onUnlock fires when markUnlocked is called', () => {
    const cb = vi.fn()
    const unsubscribe = onUnlock(cb)

    markUnlocked('pk1')
    expect(cb).toHaveBeenCalledTimes(1)

    unsubscribe()
  })

  it('unsubscribe removes callback', () => {
    const lockCb = vi.fn()
    const unsub = onLock(lockCb)

    unsub()
    markUnlocked('pk1')
    lock()
    expect(lockCb).not.toHaveBeenCalled()
  })

  it('multiple callbacks all fire', () => {
    const cb1 = vi.fn()
    const cb2 = vi.fn()

    onLock(cb1)
    onLock(cb2)

    markUnlocked('pk1')
    lock()
    expect(cb1).toHaveBeenCalledTimes(1)
    expect(cb2).toHaveBeenCalledTimes(1)
  })
})

describe('lock delay', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('getLockDelayMs returns default when localStorage empty', () => {
    vi.mocked(localStorage.getItem).mockReturnValue(null)
    expect(getLockDelayMs()).toBe(30000)
  })

  it('getLockDelayMs returns stored value', () => {
    vi.mocked(localStorage.getItem).mockReturnValue('60000')
    expect(getLockDelayMs()).toBe(60000)
  })

  it('getLockDelayMs clamps values above max', () => {
    vi.mocked(localStorage.getItem).mockReturnValue('999999')
    expect(getLockDelayMs()).toBe(30000)
  })

  it('getLockDelayMs clamps negative values', () => {
    vi.mocked(localStorage.getItem).mockReturnValue('-1')
    expect(getLockDelayMs()).toBe(30000)
  })

  it('setLockDelay stores clamped value', () => {
    setLockDelay(45000)
    expect(localStorage.setItem).toHaveBeenCalledWith('llamenos-lock-delay', '45000')
  })

  it('setLockDelay clamps to max', () => {
    setLockDelay(999999)
    expect(localStorage.setItem).toHaveBeenCalledWith('llamenos-lock-delay', '600000')
  })

  it('setLockDelay clamps to min', () => {
    setLockDelay(-1)
    expect(localStorage.setItem).toHaveBeenCalledWith('llamenos-lock-delay', '0')
  })
})
