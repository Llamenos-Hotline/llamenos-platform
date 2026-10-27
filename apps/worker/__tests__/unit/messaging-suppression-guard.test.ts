/**
 * The outbound opt-out backstop (#2286): every adapter the factory hands out
 * refuses to send to a suppressed recipient, observably, and still is the
 * concrete adapter for the callers that need `instanceof`.
 */
import { describe, it, expect, vi } from 'vitest'
import { guardOutbound, SUPPRESSED_SEND_ERROR, type OutboundSuppression } from '@worker/messaging/suppression-guard'
import type { MessagingAdapter } from '@worker/messaging/adapter'

class FakeAdapter {
  readonly channelType = 'sms' as const
  #sent: string[] = []
  sendMessage = vi.fn(async (p: { recipientIdentifier: string }) => {
    this.#sent.push(p.recipientIdentifier)
    return { success: true, externalId: 'SM1' }
  })
  sendMediaMessage = vi.fn(async () => ({ success: true, externalId: 'MM1' }))
  sent(): string[] {
    return this.#sent
  }
  parseIncomingMessage = vi.fn()
  validateWebhook = vi.fn()
  getChannelStatus = vi.fn()
}

const SUPPRESSED = '+15550001111'
const suppression = (): OutboundSuppression & { blocksOutbound: ReturnType<typeof vi.fn> } => ({
  blocksOutbound: vi.fn(async (_channel: string, recipient: string) => recipient === SUPPRESSED),
})

describe('guardOutbound', () => {
  it('refuses a suppressed recipient: no provider call, a terminal suppressed result', async () => {
    const adapter = new FakeAdapter()
    const guard = suppression()
    const guarded = guardOutbound(adapter as unknown as MessagingAdapter, guard)

    const text = await guarded.sendMessage({ recipientIdentifier: SUPPRESSED, body: 'hi', conversationId: 'c' })
    const media = await guarded.sendMediaMessage({ recipientIdentifier: SUPPRESSED, body: 'hi', conversationId: 'c', mediaUrl: 'u', mediaType: 'image/png' })

    for (const result of [text, media]) {
      expect(result).toEqual({ success: false, error: SUPPRESSED_SEND_ERROR, suppressed: true })
    }
    expect(adapter.sendMessage).not.toHaveBeenCalled()
    expect(adapter.sendMediaMessage).not.toHaveBeenCalled()
    expect(guard.blocksOutbound).toHaveBeenCalledWith('sms', SUPPRESSED)
  })

  it('sends to anyone else through the adapter itself', async () => {
    const adapter = new FakeAdapter()
    const guarded = guardOutbound(adapter as unknown as MessagingAdapter, suppression())

    const result = await guarded.sendMessage({ recipientIdentifier: '+15550002222', body: 'hi', conversationId: 'c' })

    expect(result).toEqual({ success: true, externalId: 'SM1' })
    // Private state proves the call ran with the real adapter as `this`.
    expect(adapter.sent()).toEqual(['+15550002222'])
  })

  it('does not send when the suppression lookup fails', async () => {
    const adapter = new FakeAdapter()
    const guarded = guardOutbound(adapter as unknown as MessagingAdapter, {
      blocksOutbound: vi.fn().mockRejectedValue(new Error('db down')),
    })

    await expect(guarded.sendMessage({ recipientIdentifier: '+15550002222', body: 'hi', conversationId: 'c' })).rejects.toThrow('db down')
    expect(adapter.sendMessage).not.toHaveBeenCalled()
  })

  it('keeps the concrete adapter: instanceof and its own members still work', () => {
    const adapter = new FakeAdapter()
    const guarded = guardOutbound(adapter as unknown as MessagingAdapter, suppression())
    expect(guarded).toBeInstanceOf(FakeAdapter)
    expect(guarded.channelType).toBe('sms')
    expect((guarded as unknown as FakeAdapter).sent()).toEqual([])
  })
})
