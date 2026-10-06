import { describe, it, expect, vi } from 'vitest'
import { drainSignalQueue } from '../../lib/signal-queue-drain-worker'
import type { SignalMessageQueue } from '../../messaging/signal/queue'
import type { MessagingAdapter, SendResult } from '../../messaging/adapter'

interface FakeRow {
  id: string
  hubId: string
  conversationId: string
  recipientIdentifier: string
  body: string
  mediaUrl: string | null
  mediaType: string | null
  retryCount: number
  status: 'pending' | 'processing' | 'sent' | 'failed' | 'dead'
  lastError: string | null
}

/**
 * In-memory stand-in for SignalMessageQueue, replicating just the state
 * machine drainSignalQueue depends on (claim -> markSent/markFailed, with
 * markFailed's own retry-count-driven dead-letter transition) without a
 * real Postgres connection — mirrors how routes/signal.ts's own tests mock
 * the whole class (signal-route.test.ts).
 */
function createFakeQueue(maxRetries: number) {
  const rows = new Map<string, FakeRow>()

  function seedPending(row: Omit<FakeRow, 'status' | 'lastError'>) {
    rows.set(row.id, { ...row, status: 'pending', lastError: null })
  }

  const queue = {
    claimBatch: vi.fn(async (batchSize: number) => {
      const claimed: FakeRow[] = []
      for (const row of rows.values()) {
        if (row.status !== 'pending') continue
        row.status = 'processing'
        claimed.push(row)
        if (claimed.length >= batchSize) break
      }
      return claimed.map(({ id, hubId, conversationId, recipientIdentifier, body, mediaUrl, mediaType, retryCount }) => ({
        id,
        hubId,
        conversationId,
        recipientIdentifier,
        body,
        mediaUrl,
        mediaType,
        retryCount,
      }))
    }),
    markSent: vi.fn(async (id: string, externalId?: string) => {
      const row = rows.get(id)!
      row.status = 'sent'
      void externalId
    }),
    markFailed: vi.fn(async (id: string, error: string, currentRetryCount: number) => {
      const row = rows.get(id)!
      const nextRetryCount = currentRetryCount + 1
      row.retryCount = nextRetryCount
      row.lastError = error
      row.status = nextRetryCount >= maxRetries ? 'dead' : 'pending'
    }),
    isRateLimited: vi.fn(async () => false),
  }

  return { queue, rows, seedPending }
}

function fakeAdapter(sendMessage: () => Promise<SendResult>): MessagingAdapter {
  return {
    channelType: 'signal',
    sendMessage,
    sendMediaMessage: vi.fn(async () => ({ success: true })),
    getChannelStatus: vi.fn(async () => ({ connected: true })),
  } as unknown as MessagingAdapter
}

describe('drainSignalQueue', () => {
  it('returns 0 and does not resolve an adapter when the queue is empty', async () => {
    const { queue } = createFakeQueue(5)
    const resolveSignalAdapter = vi.fn(async () => fakeAdapter(async () => ({ success: true })))

    const claimed = await drainSignalQueue({ queue: queue as unknown as SignalMessageQueue, resolveSignalAdapter })

    expect(claimed).toBe(0)
    expect(resolveSignalAdapter).not.toHaveBeenCalled()
  })

  it('marks a successfully delivered message as sent', async () => {
    const { queue, rows, seedPending } = createFakeQueue(5)
    seedPending({
      id: 'm1', hubId: 'hub-1', conversationId: 'conv-1',
      recipientIdentifier: '+15550001', body: 'hi', mediaUrl: null, mediaType: null, retryCount: 0,
    })
    const adapter = fakeAdapter(async () => ({ success: true, externalId: 'ext-1' }))

    await drainSignalQueue({ queue: queue as unknown as SignalMessageQueue, resolveSignalAdapter: async () => adapter })

    expect(rows.get('m1')!.status).toBe('sent')
    expect(queue.markSent).toHaveBeenCalledWith('m1', 'ext-1')
  })

  it('puts every claimed message back on the retry clock when no adapter is configured, without burning a real send', async () => {
    const { queue, rows, seedPending } = createFakeQueue(5)
    seedPending({
      id: 'm1', hubId: 'hub-1', conversationId: 'conv-1',
      recipientIdentifier: '+15550001', body: 'hi', mediaUrl: null, mediaType: null, retryCount: 0,
    })

    await drainSignalQueue({ queue: queue as unknown as SignalMessageQueue, resolveSignalAdapter: async () => null })

    expect(rows.get('m1')!.status).toBe('pending')
    expect(rows.get('m1')!.retryCount).toBe(1)
  })

  /**
   * This is the issue's own acceptance criterion: "A drain loop calls
   * claimBatch() on a schedule, with the dead-letter transition the admin
   * UI already expects; a test asserts a pending row is retried and
   * eventually dead-lettered."
   */
  it('retries a transiently-failing message across multiple drain passes, then dead-letters it once retries are exhausted', async () => {
    const maxRetries = 3
    const { queue, rows, seedPending } = createFakeQueue(maxRetries)
    seedPending({
      id: 'm1', hubId: 'hub-1', conversationId: 'conv-1',
      recipientIdentifier: '+15550001', body: 'hi', mediaUrl: null, mediaType: null, retryCount: 0,
    })
    const adapter = fakeAdapter(async () => ({ success: false, error: 'bridge unreachable' }))
    const resolveSignalAdapter = async () => adapter

    // Pass 1: still pending, retried once.
    await drainSignalQueue({ queue: queue as unknown as SignalMessageQueue, resolveSignalAdapter })
    expect(rows.get('m1')!.status).toBe('pending')
    expect(rows.get('m1')!.retryCount).toBe(1)

    // Pass 2: still pending, retried twice.
    await drainSignalQueue({ queue: queue as unknown as SignalMessageQueue, resolveSignalAdapter })
    expect(rows.get('m1')!.status).toBe('pending')
    expect(rows.get('m1')!.retryCount).toBe(2)

    // Pass 3: retries exhausted — dead-lettered, exactly where the admin
    // dead-letter UI (routes/signal.ts) looks.
    await drainSignalQueue({ queue: queue as unknown as SignalMessageQueue, resolveSignalAdapter })
    expect(rows.get('m1')!.status).toBe('dead')
    expect(rows.get('m1')!.retryCount).toBe(maxRetries)
    expect(rows.get('m1')!.lastError).toBe('bridge unreachable')
  })

  it('dead-letters a message that throws instead of returning a result', async () => {
    const { queue, rows, seedPending } = createFakeQueue(1)
    seedPending({
      id: 'm1', hubId: 'hub-1', conversationId: 'conv-1',
      recipientIdentifier: '+15550001', body: 'hi', mediaUrl: null, mediaType: null, retryCount: 0,
    })
    const adapter = fakeAdapter(async () => { throw new Error('network error') })

    await drainSignalQueue({ queue: queue as unknown as SignalMessageQueue, resolveSignalAdapter: async () => adapter })

    expect(rows.get('m1')!.status).toBe('dead')
    expect(rows.get('m1')!.lastError).toBe('network error')
  })

  it('skips sending and reschedules when the recipient is rate limited', async () => {
    const { queue, rows, seedPending } = createFakeQueue(5)
    seedPending({
      id: 'm1', hubId: 'hub-1', conversationId: 'conv-1',
      recipientIdentifier: '+15550001', body: 'hi', mediaUrl: null, mediaType: null, retryCount: 0,
    })
    queue.isRateLimited.mockResolvedValueOnce(true)
    const sendMessage = vi.fn(async () => ({ success: true }) as SendResult)
    const adapter = fakeAdapter(sendMessage)

    await drainSignalQueue({ queue: queue as unknown as SignalMessageQueue, resolveSignalAdapter: async () => adapter })

    expect(sendMessage).not.toHaveBeenCalled()
    expect(rows.get('m1')!.status).toBe('pending')
  })

  it('sends media messages via sendMediaMessage when mediaUrl is present', async () => {
    const { queue, rows, seedPending } = createFakeQueue(5)
    seedPending({
      id: 'm1', hubId: 'hub-1', conversationId: 'conv-1',
      recipientIdentifier: '+15550001', body: 'hi', mediaUrl: 'https://example.test/img.jpg', mediaType: 'image/jpeg', retryCount: 0,
    })
    const sendMediaMessage = vi.fn(async () => ({ success: true, externalId: 'ext-2' }))
    const adapter = {
      channelType: 'signal',
      sendMessage: vi.fn(async () => ({ success: true })),
      sendMediaMessage,
      getChannelStatus: vi.fn(async () => ({ connected: true })),
    } as unknown as MessagingAdapter

    await drainSignalQueue({ queue: queue as unknown as SignalMessageQueue, resolveSignalAdapter: async () => adapter })

    expect(sendMediaMessage).toHaveBeenCalledWith(expect.objectContaining({
      mediaUrl: 'https://example.test/img.jpg',
      mediaType: 'image/jpeg',
    }))
    expect(rows.get('m1')!.status).toBe('sent')
    expect(queue.markSent).toHaveBeenCalledWith('m1', 'ext-2')
  })
})
