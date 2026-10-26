import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createIdleLock, ACTIVITY_EVENTS } from './auto-lock'

const TIMEOUT = 5 * 60 * 1000

function setup() {
  const target = new EventTarget()
  const onIdle = vi.fn()
  const lock = createIdleLock({ timeoutMs: TIMEOUT, onIdle, target })
  const input = (type: (typeof ACTIVITY_EVENTS)[number] = 'keydown') => target.dispatchEvent(new Event(type))
  return { target, onIdle, lock, input }
}

describe('idle lock', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('locks after the timeout with no input', () => {
    const { lock, onIdle } = setup()
    lock.arm()
    vi.advanceTimersByTime(TIMEOUT - 1)
    expect(onIdle).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onIdle).toHaveBeenCalledTimes(1)
  })

  it('input resets the clock, so an actively used app never locks', () => {
    const { lock, onIdle, input } = setup()
    lock.arm()
    // Ten minutes of use, input every 4 minutes: never 5 idle minutes in a row.
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(4 * 60 * 1000)
      input()
    }
    expect(onIdle).not.toHaveBeenCalled()
    vi.advanceTimersByTime(TIMEOUT)
    expect(onIdle).toHaveBeenCalledTimes(1)
  })

  it.each(ACTIVITY_EVENTS)('treats %s as presence', type => {
    const { lock, onIdle, input } = setup()
    lock.arm()
    vi.advanceTimersByTime(TIMEOUT - 1)
    input(type)
    vi.advanceTimersByTime(TIMEOUT - 1)
    expect(onIdle).not.toHaveBeenCalled()
  })

  it('does not lock while busy on a call, however long it runs', () => {
    const { lock, onIdle } = setup()
    lock.arm()
    lock.setBusy(true)
    vi.advanceTimersByTime(60 * 60 * 1000)
    expect(onIdle).not.toHaveBeenCalled()
  })

  it('a call that was already running when the lock armed still blocks it', () => {
    const { lock, onIdle } = setup()
    lock.setBusy(true)
    lock.arm()
    vi.advanceTimersByTime(TIMEOUT * 2)
    expect(onIdle).not.toHaveBeenCalled()
  })

  it('starts a full timeout when the call ends, not an immediate lock', () => {
    const { lock, onIdle } = setup()
    lock.arm()
    lock.setBusy(true)
    vi.advanceTimersByTime(30 * 60 * 1000)
    lock.setBusy(false)
    vi.advanceTimersByTime(TIMEOUT - 1)
    expect(onIdle).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onIdle).toHaveBeenCalledTimes(1)
  })

  it('input while busy does not start a countdown', () => {
    const { lock, onIdle, input } = setup()
    lock.arm()
    lock.setBusy(true)
    input()
    vi.advanceTimersByTime(TIMEOUT * 2)
    expect(onIdle).not.toHaveBeenCalled()
  })

  it('does not count while disarmed and ignores input then', () => {
    const { lock, onIdle, input } = setup()
    lock.arm()
    lock.disarm()
    input()
    vi.advanceTimersByTime(TIMEOUT * 2)
    expect(onIdle).not.toHaveBeenCalled()
    // Ending a call while locked must not arm anything either.
    lock.setBusy(true)
    lock.setBusy(false)
    vi.advanceTimersByTime(TIMEOUT * 2)
    expect(onIdle).not.toHaveBeenCalled()
  })

  it('removes every input listener on disarm and does not stack them on re-arm', () => {
    const add = vi.fn()
    const remove = vi.fn()
    const lock = createIdleLock({ timeoutMs: TIMEOUT, onIdle: vi.fn(), target: { addEventListener: add, removeEventListener: remove } })
    lock.arm()
    lock.arm()
    expect(add).toHaveBeenCalledTimes(ACTIVITY_EVENTS.length)
    lock.disarm()
    expect(remove).toHaveBeenCalledTimes(ACTIVITY_EVENTS.length)
  })
})
