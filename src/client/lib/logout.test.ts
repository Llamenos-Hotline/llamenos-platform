import { describe, it, expect, vi, beforeEach } from 'vitest'

const wipeKey = vi.fn<() => Promise<void>>()
vi.mock('./key-manager', () => ({ wipeKey: () => wipeKey() }))

import { logoutAndRemoveKey } from './logout'

describe('logoutAndRemoveKey (#2110)', () => {
  beforeEach(() => {
    wipeKey.mockReset()
  })

  it('ends the session, then deletes the stored vault', async () => {
    const order: string[] = []
    wipeKey.mockImplementation(async () => { order.push('wipeKey') })
    const onFailed = vi.fn()

    await logoutAndRemoveKey(() => order.push('signOut'), onFailed)

    expect(order).toEqual(['signOut', 'wipeKey'])
    expect(onFailed).not.toHaveBeenCalled()
  })

  it('reports a failed removal instead of claiming success, and does not throw', async () => {
    wipeKey.mockRejectedValue(new Error('Failed to delete vault file'))
    const signOut = vi.fn()
    const onFailed = vi.fn()

    await expect(logoutAndRemoveKey(signOut, onFailed)).resolves.toBeUndefined()

    expect(signOut).toHaveBeenCalledTimes(1)
    expect(onFailed).toHaveBeenCalledTimes(1)
  })
})
