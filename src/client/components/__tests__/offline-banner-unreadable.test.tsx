/**
 * #2948: a persisted offline queue that cannot be opened is reported to the user
 * and recoverable — not a console line. The queue under test is the real one;
 * only its seal is a stand-in whose `open` fails like a GCM tag mismatch.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { OfflineQueue, offlineQueueStorageKey, type OfflineQueueSealer } from '@/lib/offline-queue'

const state = vi.hoisted(() => ({ queue: null as unknown as import('@/lib/offline-queue').OfflineQueue }))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('@/lib/api', () => ({ getAuthHeadersForReplay: async () => ({}) }))
vi.mock('@/lib/offline-queue', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/offline-queue')>()
  return { ...actual, get offlineQueue() { return state.queue } }
})

import { OfflineBanner } from '../offline-banner'

const OWNER = 'owner-pubkey'

function sealer(): OfflineQueueSealer & { failOpen: boolean } {
  return {
    failOpen: false,
    async seal(json) { return `sealed:${btoa(json)}` },
    async open(sealed) {
      if (this.failOpen) throw new Error('aes/gcm: invalid ghash tag')
      return atob(sealed.slice('sealed:'.length))
    },
  }
}

afterEach(() => {
  cleanup()
  state.queue?.destroy()
  localStorage.clear()
})

describe('OfflineBanner when the persisted queue cannot be opened', () => {
  it('says so, and discarding recovers the queue', async () => {
    const seal = sealer()
    const writer = new OfflineQueue({ sealer: seal, identity: () => OWNER })
    await writer.enqueue('/notes', 'POST', '{}')
    writer.destroy()

    seal.failOpen = true
    state.queue = new OfflineQueue({ sealer: seal, identity: () => OWNER })
    render(<OfflineBanner />)
    expect(screen.queryByTestId('offline-queue-unreadable')).toBeNull()

    await act(async () => { await state.queue.hydrate().catch(() => {}) })
    expect(await screen.findByTestId('offline-queue-unreadable')).toBeTruthy()
    expect(localStorage.getItem(offlineQueueStorageKey(OWNER))).not.toBeNull()

    seal.failOpen = false
    fireEvent.click(screen.getByTestId('offline-queue-discard'))
    await waitFor(() => expect(screen.queryByTestId('offline-queue-unreadable')).toBeNull())
    expect(localStorage.getItem(offlineQueueStorageKey(OWNER))).toBeNull()
    await state.queue.enqueue('/messages', 'POST', '{}')
    expect(state.queue.pendingCount).toBe(1)
  })
})
