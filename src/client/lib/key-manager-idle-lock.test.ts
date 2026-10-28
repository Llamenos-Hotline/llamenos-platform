/**
 * The idle lock as key-manager wires it: real `document` input, real lock().
 *
 * Playwright cannot prove any of this — `autoLockDisabled` is forced under
 * PLAYWRIGHT_TEST, so an e2e run passes whatever the lock does. These tests drive
 * the real module under fake timers instead.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./platform', () => ({
  lockCrypto: vi.fn(async () => {}),
  wipeVaultFile: vi.fn(async () => {}),
  decryptWithPin: vi.fn(async () => null),
  deviceImportAndLoad: vi.fn(),
  restoreBackupAndLoad: vi.fn(),
  persistAndUnlockDeviceKeys: vi.fn(),
  isValidSeedHex: vi.fn(() => true),
  hasStoredKey: vi.fn(async () => true),
}))

import { markUnlocked, isUnlocked, lock, setOnCall, wipeKey } from './key-manager'
import { getCallNoteDraft, setCallNoteDraft, clearCallNoteDrafts } from './call-note-drafts'

const FIVE_MIN = 5 * 60 * 1000

describe('key-manager idle auto-lock', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setOnCall(false)
    lock()
  })
  afterEach(() => {
    lock()
    vi.useRealTimers()
  })

  it('locks after five idle minutes', () => {
    markUnlocked('pk')
    vi.advanceTimersByTime(FIVE_MIN)
    expect(isUnlocked()).toBe(false)
  })

  it('input in the window keeps it unlocked', () => {
    markUnlocked('pk')
    vi.advanceTimersByTime(FIVE_MIN - 1000)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    vi.advanceTimersByTime(FIVE_MIN - 1000)
    expect(isUnlocked()).toBe(true)
    vi.advanceTimersByTime(1000)
    expect(isUnlocked()).toBe(false)
  })

  it('does not lock during an answered call, then locks a full timeout after it ends', () => {
    markUnlocked('pk')
    setOnCall(true)
    vi.advanceTimersByTime(30 * 60 * 1000)
    expect(isUnlocked()).toBe(true)
    setOnCall(false)
    vi.advanceTimersByTime(FIVE_MIN - 1)
    expect(isUnlocked()).toBe(true)
    vi.advanceTimersByTime(1)
    expect(isUnlocked()).toBe(false)
  })

  it('a call that began before the unlock still blocks the lock', () => {
    setOnCall(true)
    markUnlocked('pk')
    vi.advanceTimersByTime(FIVE_MIN * 3)
    expect(isUnlocked()).toBe(true)
  })

  it('leaves the tab-hide lock alone: hiding the window during a call still locks', () => {
    markUnlocked('pk')
    setOnCall(true)
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    document.dispatchEvent(new Event('visibilitychange'))
    vi.advanceTimersByTime(30_000)
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    expect(isUnlocked()).toBe(false)
  })
})

describe('in-call note draft', () => {
  beforeEach(() => {
    clearCallNoteDrafts()
    localStorage.clear()
    sessionStorage.clear()
  })

  it('survives a lock and is restored by call id', () => {
    markUnlocked('pk')
    setCallNoteDraft('CA-1', 'caller mentioned the bridge')
    lock()
    markUnlocked('pk')
    expect(getCallNoteDraft('CA-1')).toBe('caller mentioned the bridge')
    expect(getCallNoteDraft('CA-2')).toBe('')
  })

  it('is cleared by a wipe (panic wipe and remote wipe both go through wipeKey)', async () => {
    setCallNoteDraft('CA-1', 'secret')
    await wipeKey()
    expect(getCallNoteDraft('CA-1')).toBe('')
  })

  it('is never written to web storage', () => {
    setCallNoteDraft('CA-1', 'secret note text')
    const dump = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage })
    expect(dump).not.toContain('secret note text')
  })
})
