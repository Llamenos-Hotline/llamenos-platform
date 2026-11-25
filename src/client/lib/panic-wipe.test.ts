import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { initPanicWipe, performPanicWipe, _resetPanicWipeState } from './panic-wipe'
import * as keyManager from './key-manager'

vi.mock('./platform', async importOriginal => ({
  ...(await importOriginal<typeof import('./platform')>()),
  lockCrypto: vi.fn(async () => {}),
  decryptWithPin: vi.fn(async () => null),
  clearStoredKey: vi.fn(async () => {}),
  wipeVaultFile: vi.fn(async () => {}),
}))

describe('initPanicWipe', () => {
  let cleanup: (() => void) | null = null

  beforeEach(() => {
    vi.useFakeTimers()
    _resetPanicWipeState()
  })

  afterEach(() => {
    cleanup?.()
    cleanup = null
    _resetPanicWipeState()
    vi.useRealTimers()
  })

  it('triggers wipe on 3 Escape presses within 1s', () => {
    const wipeSpy = vi.fn()
    cleanup = initPanicWipe(wipeSpy)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

    expect(wipeSpy).toHaveBeenCalledTimes(1)
  })

  it('does not trigger on 2 Escape presses', () => {
    const wipeSpy = vi.fn()
    cleanup = initPanicWipe(wipeSpy)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

    expect(wipeSpy).not.toHaveBeenCalled()
  })

  it('does not trigger on non-Escape keys', () => {
    const wipeSpy = vi.fn()
    cleanup = initPanicWipe(wipeSpy)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))

    expect(wipeSpy).not.toHaveBeenCalled()
  })

  it('resets counter on non-Escape key between escapes', () => {
    const wipeSpy = vi.fn()
    cleanup = initPanicWipe(wipeSpy)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

    expect(wipeSpy).not.toHaveBeenCalled()
  })

  it('ignores escapes outside 1s window', () => {
    const wipeSpy = vi.fn()
    cleanup = initPanicWipe(wipeSpy)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    vi.advanceTimersByTime(501)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    vi.advanceTimersByTime(501)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

    expect(wipeSpy).not.toHaveBeenCalled()
  })

  it('triggers on rapid 4+ escapes', () => {
    const wipeSpy = vi.fn()
    cleanup = initPanicWipe(wipeSpy)

    for (let i = 0; i < 4; i++) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    }

    expect(wipeSpy).toHaveBeenCalledTimes(1)
  })

  it('resets after triggering', () => {
    const wipeSpy = vi.fn()
    cleanup = initPanicWipe(wipeSpy)

    for (let i = 0; i < 3; i++) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    }
    expect(wipeSpy).toHaveBeenCalledTimes(1)

    wipeSpy.mockClear()
    for (let i = 0; i < 3; i++) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    }
    expect(wipeSpy).toHaveBeenCalledTimes(1)
  })

  it('removes listener on cleanup', () => {
    const wipeSpy = vi.fn()
    cleanup = initPanicWipe(wipeSpy)
    cleanup()

    for (let i = 0; i < 3; i++) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    }
    expect(wipeSpy).not.toHaveBeenCalled()
  })
})

describe('performPanicWipe', () => {
  beforeEach(() => {
    localStorage.setItem('test-key', 'test-value')
    sessionStorage.setItem('session-key', 'session-value')
    vi.spyOn(keyManager, 'wipeKey').mockImplementation(() => Promise.resolve())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('calls wipe callback', () => {
    const cb = vi.fn()
    initPanicWipe(cb)
    performPanicWipe()
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('calls keyManager.wipeKey', () => {
    performPanicWipe()
    expect(keyManager.wipeKey).toHaveBeenCalled()
  })

  it('continues even if wipeKey throws', () => {
    vi.spyOn(keyManager, 'wipeKey').mockImplementation(() => {
      throw new Error('already wiped')
    })

    expect(() => performPanicWipe()).not.toThrow()
  })

  it('clears localStorage', () => {
    performPanicWipe()
    expect(localStorage.getItem('test-key')).toBeNull()
  })

  it('clears sessionStorage', () => {
    performPanicWipe()
    expect(sessionStorage.getItem('session-key')).toBeNull()
  })

  it('continues even if storage throws', () => {
    vi.spyOn(Storage.prototype, 'clear').mockImplementation(() => {
      throw new Error('storage blocked')
    })

    expect(() => performPanicWipe()).not.toThrow()
  })

  it('schedules redirect after flash duration', async () => {
    const hrefSpy = vi.spyOn(window.location, 'href', 'set').mockImplementation(() => {})

    performPanicWipe()
    expect(hrefSpy).not.toHaveBeenCalled()

    // Wait long enough for FLASH_DURATION_MS (200) + async dynamic imports to settle
    await new Promise(r => setTimeout(r, 500))
    expect(hrefSpy).toHaveBeenCalledWith('/login')

    hrefSpy.mockRestore()
  })
})
