/**
 * The outbound opt-out backstop.
 *
 * Every adapter the messaging factory hands out (`getMessagingAdapterFromService`)
 * is wrapped here, so every send — conversation replies, blasts, the Signal retry
 * queue, case-contact notifications — asks the suppression record first. A bug in
 * any upstream path (an import that resurrected a row, a stale queue entry, a
 * caller that never looked) still cannot message someone who sent STOP.
 *
 * A refused send is a failed `SendResult` with `suppressed: true` and
 * {@link SUPPRESSED_SEND_ERROR}, never a silent no-op: the record counts it, and
 * the caller marks its delivery or queue row terminally.
 */
import type { MessagingAdapter, SendMessageParams, SendMediaParams, SendResult } from './adapter'
import type { MessagingChannelType } from '@shared/types'

/** The error a suppressed send reports — what a delivery, queue row or message shows as its reason. */
export const SUPPRESSED_SEND_ERROR = 'recipient-suppressed: the recipient opted out (STOP)'

/** What the backstop needs: whether a send to this recipient is refused (and, if so, record the refusal). */
export interface OutboundSuppression {
  blocksOutbound(channel: MessagingChannelType, recipientIdentifier: string): Promise<boolean>
}

const SUPPRESSED: SendResult = { success: false, error: SUPPRESSED_SEND_ERROR, suppressed: true }

/**
 * The adapter with its two send methods gated on the suppression record. A Proxy
 * rather than a wrapper object, so `instanceof SignalAdapter` / `TelegramAdapter`
 * still hold for the callers that need the concrete adapter; every other member
 * is the adapter's own, bound to it. A failed suppression lookup throws — the
 * send does not happen.
 */
export function guardOutbound(adapter: MessagingAdapter, suppression: OutboundSuppression): MessagingAdapter {
  const sendMessage = async (params: SendMessageParams): Promise<SendResult> =>
    (await suppression.blocksOutbound(adapter.channelType, params.recipientIdentifier))
      ? SUPPRESSED
      : adapter.sendMessage(params)
  const sendMediaMessage = async (params: SendMediaParams): Promise<SendResult> =>
    (await suppression.blocksOutbound(adapter.channelType, params.recipientIdentifier))
      ? SUPPRESSED
      : adapter.sendMediaMessage(params)

  return new Proxy(adapter, {
    get(target, prop) {
      if (prop === 'sendMessage') return sendMessage
      if (prop === 'sendMediaMessage') return sendMediaMessage
      const value: unknown = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
