import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  startBlastWorker,
  stopBlastWorker,
  type BlastDeliveryWorkerDeps,
  type BlastProgressCallback,
  type BlastStatusCallback,
} from '@worker/lib/blast-delivery-worker'

describe('BlastDeliveryWorker', () => {
  let deps: BlastDeliveryWorkerDeps
  let onProgress: BlastProgressCallback
  let onStatusChange: BlastStatusCallback

  beforeEach(() => {
    vi.useFakeTimers()
    onProgress = vi.fn() as unknown as BlastProgressCallback
    onStatusChange = vi.fn() as unknown as BlastStatusCallback

    deps = {
      blastsService: {
        getSendingBlasts: vi.fn().mockResolvedValue([]),
        getBlast: vi.fn().mockResolvedValue({ status: 'sending', content: { text: 'Hello' }, defaultLanguage: 'en' }),
        getBlastSettings: vi.fn().mockResolvedValue({ rateLimitPerSecond: 10, optOutFooter: '\nReply STOP to unsubscribe' }),
        drainDeliveryBatch: vi.fn().mockResolvedValue([]),
        syncBlastStats: vi.fn().mockResolvedValue({ stats: { totalRecipients: 0, sent: 0, delivered: 0, failed: 0, optedOut: 0 }, completed: false }),
        isSubscriberActive: vi.fn().mockResolvedValue(true),
        getSubscriberById: vi.fn().mockResolvedValue({ id: 'sub-1', language: 'en' }),
        markDeliverySent: vi.fn(),
        markDeliveryFailed: vi.fn(),
        markDeliveryOptedOut: vi.fn(),
      } as unknown as BlastDeliveryWorkerDeps['blastsService'],
      settingsService: {
        getMessagingConfig: vi.fn().mockResolvedValue({ smsContentMode: 'notification-only' }),
      } as unknown as BlastDeliveryWorkerDeps['settingsService'],
      resolveAdapter: vi.fn().mockResolvedValue({
        sendMessage: vi.fn().mockResolvedValue({ success: true, externalId: 'ext-1' }),
        sendMediaMessage: vi.fn().mockResolvedValue({ success: true, externalId: 'ext-2' }),
      }),
      resolveIdentifier: vi.fn().mockResolvedValue('+15551234567'),
      onProgress,
      onStatusChange,
    }
  })

  afterEach(() => {
    stopBlastWorker()
    vi.useRealTimers()
  })

  it('starts and stops without error', () => {
    startBlastWorker(deps)
    stopBlastWorker()
  })

  it('does not start twice if already running', () => {
    startBlastWorker(deps)
    // Second call should be a no-op (no error, no duplicate timer)
    startBlastWorker(deps)
    stopBlastWorker()
  })

  it('polls for sending blasts after initial delay', async () => {
    const getSendingBlasts = deps.blastsService.getSendingBlasts as ReturnType<typeof vi.fn>
    getSendingBlasts.mockResolvedValue([])

    startBlastWorker(deps)

    // Initial delay is 5s
    await vi.advanceTimersByTimeAsync(5000)

    expect(getSendingBlasts).toHaveBeenCalledOnce()
  })

  it('processes a delivery batch and marks sent', async () => {
    const getSendingBlasts = deps.blastsService.getSendingBlasts as ReturnType<typeof vi.fn>
    getSendingBlasts.mockResolvedValue([{ id: 'blast-1', hubId: 'hub-1' }])

    const drainBatch = deps.blastsService.drainDeliveryBatch as ReturnType<typeof vi.fn>
    drainBatch.mockResolvedValueOnce([
      { id: 'del-1', subscriberId: 'sub-1', channel: 'sms', attempts: 0 },
    ])

    const markSent = deps.blastsService.markDeliverySent as ReturnType<typeof vi.fn>
    const syncStats = deps.blastsService.syncBlastStats as ReturnType<typeof vi.fn>
    syncStats.mockResolvedValue({
      stats: { totalRecipients: 1, sent: 1, delivered: 0, failed: 0, optedOut: 0 },
      completed: false,
    })

    startBlastWorker(deps)
    await vi.advanceTimersByTimeAsync(5000)

    expect(markSent).toHaveBeenCalledWith('del-1', 'ext-1')
    expect(syncStats).toHaveBeenCalledWith('blast-1')
  })

  it('skips opted-out subscribers mid-flight', async () => {
    const getSendingBlasts = deps.blastsService.getSendingBlasts as ReturnType<typeof vi.fn>
    getSendingBlasts.mockResolvedValue([{ id: 'blast-2', hubId: 'hub-1' }])

    const drainBatch = deps.blastsService.drainDeliveryBatch as ReturnType<typeof vi.fn>
    drainBatch.mockResolvedValueOnce([
      { id: 'del-2', subscriberId: 'sub-opted-out', channel: 'sms', attempts: 0 },
    ])

    const isActive = deps.blastsService.isSubscriberActive as ReturnType<typeof vi.fn>
    isActive.mockResolvedValue(false)

    const markOptedOut = deps.blastsService.markDeliveryOptedOut as ReturnType<typeof vi.fn>

    startBlastWorker(deps)
    await vi.advanceTimersByTimeAsync(5000)

    expect(markOptedOut).toHaveBeenCalledWith('del-2')
    // Should NOT have tried to send
    expect(deps.resolveAdapter).not.toHaveBeenCalled()
  })

  it('marks delivery failed when adapter is not available', async () => {
    const getSendingBlasts = deps.blastsService.getSendingBlasts as ReturnType<typeof vi.fn>
    getSendingBlasts.mockResolvedValue([{ id: 'blast-3', hubId: 'hub-1' }])

    const drainBatch = deps.blastsService.drainDeliveryBatch as ReturnType<typeof vi.fn>
    drainBatch.mockResolvedValueOnce([
      { id: 'del-3', subscriberId: 'sub-3', channel: 'telegram', attempts: 0 },
    ])

    const resolveAdapter = deps.resolveAdapter as ReturnType<typeof vi.fn>
    resolveAdapter.mockResolvedValue(null) // no adapter available

    const markFailed = deps.blastsService.markDeliveryFailed as ReturnType<typeof vi.fn>

    startBlastWorker(deps)
    await vi.advanceTimersByTimeAsync(5000)

    expect(markFailed).toHaveBeenCalledWith('del-3', expect.stringContaining('No adapter'), 0)
  })

  it('marks delivery failed when identifier cannot be resolved', async () => {
    const getSendingBlasts = deps.blastsService.getSendingBlasts as ReturnType<typeof vi.fn>
    getSendingBlasts.mockResolvedValue([{ id: 'blast-4', hubId: 'hub-1' }])

    const drainBatch = deps.blastsService.drainDeliveryBatch as ReturnType<typeof vi.fn>
    drainBatch.mockResolvedValueOnce([
      { id: 'del-4', subscriberId: 'sub-unknown', channel: 'sms', attempts: 0 },
    ])

    const resolveIdentifier = deps.resolveIdentifier as ReturnType<typeof vi.fn>
    resolveIdentifier.mockResolvedValue(null) // can't decrypt

    const markFailed = deps.blastsService.markDeliveryFailed as ReturnType<typeof vi.fn>

    startBlastWorker(deps)
    await vi.advanceTimersByTimeAsync(5000)

    expect(markFailed).toHaveBeenCalledWith('del-4', expect.stringContaining('resolve subscriber'), 0)
  })

  it('marks delivery failed when adapter throws', async () => {
    const getSendingBlasts = deps.blastsService.getSendingBlasts as ReturnType<typeof vi.fn>
    getSendingBlasts.mockResolvedValue([{ id: 'blast-5', hubId: 'hub-1' }])

    const drainBatch = deps.blastsService.drainDeliveryBatch as ReturnType<typeof vi.fn>
    drainBatch.mockResolvedValueOnce([
      { id: 'del-5', subscriberId: 'sub-5', channel: 'sms', attempts: 1 },
    ])

    const adapter = {
      sendMessage: vi.fn().mockRejectedValue(new Error('Connection refused')),
      sendMediaMessage: vi.fn(),
    }
    ;(deps.resolveAdapter as ReturnType<typeof vi.fn>).mockResolvedValue(adapter)

    const markFailed = deps.blastsService.markDeliveryFailed as ReturnType<typeof vi.fn>

    startBlastWorker(deps)
    await vi.advanceTimersByTimeAsync(5000)

    expect(markFailed).toHaveBeenCalledWith('del-5', 'Connection refused', 1)
  })

  it('marks delivery failed when adapter returns success:false', async () => {
    const getSendingBlasts = deps.blastsService.getSendingBlasts as ReturnType<typeof vi.fn>
    getSendingBlasts.mockResolvedValue([{ id: 'blast-6', hubId: 'hub-1' }])

    const drainBatch = deps.blastsService.drainDeliveryBatch as ReturnType<typeof vi.fn>
    drainBatch.mockResolvedValueOnce([
      { id: 'del-6', subscriberId: 'sub-6', channel: 'sms', attempts: 0 },
    ])

    const adapter = {
      sendMessage: vi.fn().mockResolvedValue({ success: false, error: 'Number blocked' }),
      sendMediaMessage: vi.fn(),
    }
    ;(deps.resolveAdapter as ReturnType<typeof vi.fn>).mockResolvedValue(adapter)

    const markFailed = deps.blastsService.markDeliveryFailed as ReturnType<typeof vi.fn>

    startBlastWorker(deps)
    await vi.advanceTimersByTimeAsync(5000)

    expect(markFailed).toHaveBeenCalledWith('del-6', 'Number blocked', 0)
  })

  it('stops processing when blast is cancelled mid-batch', async () => {
    const getSendingBlasts = deps.blastsService.getSendingBlasts as ReturnType<typeof vi.fn>
    getSendingBlasts.mockResolvedValue([{ id: 'blast-cancel', hubId: 'hub-1' }])

    const getBlast = deps.blastsService.getBlast as ReturnType<typeof vi.fn>
    // Call sequence: 1=pollForWork status check, 2=processBlastBatch content,
    // 3=first delivery check (sending), 4=second delivery check (cancelled)
    getBlast
      .mockResolvedValueOnce({ status: 'sending', content: { text: 'Test' }, defaultLanguage: 'en' }) // pollForWork
      .mockResolvedValueOnce({ status: 'sending', content: { text: 'Test' }, defaultLanguage: 'en' }) // processBlastBatch content
      .mockResolvedValueOnce({ status: 'sending', content: { text: 'Test' }, defaultLanguage: 'en' }) // 1st delivery check
      .mockResolvedValueOnce({ status: 'cancelled', content: { text: 'Test' }, defaultLanguage: 'en' }) // 2nd delivery check

    const drainBatch = deps.blastsService.drainDeliveryBatch as ReturnType<typeof vi.fn>
    drainBatch.mockResolvedValueOnce([
      { id: 'del-c1', subscriberId: 'sub-1', channel: 'sms', attempts: 0 },
      { id: 'del-c2', subscriberId: 'sub-2', channel: 'sms', attempts: 0 },
    ])

    startBlastWorker(deps)
    await vi.advanceTimersByTimeAsync(5000)

    // First delivery should succeed, second should be skipped due to cancellation
    const markSent = deps.blastsService.markDeliverySent as ReturnType<typeof vi.fn>
    expect(markSent).toHaveBeenCalledTimes(1)
    expect(markSent).toHaveBeenCalledWith('del-c1', 'ext-1')
  })

  it('fires onStatusChange when blast completes', async () => {
    const getSendingBlasts = deps.blastsService.getSendingBlasts as ReturnType<typeof vi.fn>
    getSendingBlasts.mockResolvedValue([{ id: 'blast-done', hubId: 'hub-1' }])

    const drainBatch = deps.blastsService.drainDeliveryBatch as ReturnType<typeof vi.fn>
    drainBatch.mockResolvedValueOnce([]) // empty batch = check completion

    const syncStats = deps.blastsService.syncBlastStats as ReturnType<typeof vi.fn>
    syncStats.mockResolvedValue({
      stats: { totalRecipients: 10, sent: 10, delivered: 0, failed: 0, optedOut: 0 },
      completed: true,
    })

    startBlastWorker(deps)
    await vi.advanceTimersByTimeAsync(5000)

    expect(onStatusChange).toHaveBeenCalledWith('blast-done', 'hub-1', 'sent')
  })

  it('uses notification-only body for SMS when configured', async () => {
    const getSendingBlasts = deps.blastsService.getSendingBlasts as ReturnType<typeof vi.fn>
    getSendingBlasts.mockResolvedValue([{ id: 'blast-sms', hubId: 'hub-1' }])

    const getBlast = deps.blastsService.getBlast as ReturnType<typeof vi.fn>
    getBlast.mockResolvedValue({
      status: 'sending',
      content: { text: 'Full content here', smsText: 'SMS specific text' },
      defaultLanguage: 'en',
    })

    const drainBatch = deps.blastsService.drainDeliveryBatch as ReturnType<typeof vi.fn>
    drainBatch.mockResolvedValueOnce([
      { id: 'del-sms', subscriberId: 'sub-sms', channel: 'sms', attempts: 0 },
    ])

    const adapter = {
      sendMessage: vi.fn().mockResolvedValue({ success: true, externalId: 'ext-sms' }),
    }
    ;(deps.resolveAdapter as ReturnType<typeof vi.fn>).mockResolvedValue(adapter)

    startBlastWorker(deps)
    await vi.advanceTimersByTimeAsync(5000)

    // In notification-only mode, the body should be the notification message, not the content
    const sentBody = adapter.sendMessage.mock.calls[0]?.[0]?.body
    expect(sentBody).toContain('You have a new secure message')
    expect(sentBody).toContain('Reply STOP to unsubscribe') // opt-out footer
  })

  it('sends media messages when blast has mediaUrl', async () => {
    const getSendingBlasts = deps.blastsService.getSendingBlasts as ReturnType<typeof vi.fn>
    getSendingBlasts.mockResolvedValue([{ id: 'blast-media', hubId: 'hub-1' }])

    const getBlast = deps.blastsService.getBlast as ReturnType<typeof vi.fn>
    getBlast.mockResolvedValue({
      status: 'sending',
      content: { text: 'Check this photo', mediaUrl: 'https://example.com/img.jpg', mediaType: 'image/jpeg' },
      defaultLanguage: 'en',
    })

    const drainBatch = deps.blastsService.drainDeliveryBatch as ReturnType<typeof vi.fn>
    drainBatch.mockResolvedValueOnce([
      { id: 'del-media', subscriberId: 'sub-media', channel: 'whatsapp', attempts: 0 },
    ])

    const adapter = {
      sendMessage: vi.fn(),
      sendMediaMessage: vi.fn().mockResolvedValue({ success: true, externalId: 'ext-media' }),
    }
    ;(deps.resolveAdapter as ReturnType<typeof vi.fn>).mockResolvedValue(adapter)

    startBlastWorker(deps)
    await vi.advanceTimersByTimeAsync(5000)

    // Should use sendMediaMessage, not sendMessage
    expect(adapter.sendMediaMessage).toHaveBeenCalledOnce()
    expect(adapter.sendMessage).not.toHaveBeenCalled()
    expect(adapter.sendMediaMessage.mock.calls[0][0].mediaUrl).toBe('https://example.com/img.jpg')
  })
})
