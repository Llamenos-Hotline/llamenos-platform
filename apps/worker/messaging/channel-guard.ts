/**
 * Enforcing a hub's channel switches at the webhook (#2384).
 *
 * `hub_settings.channels` is the hub's own answer to "do we take this channel?"
 * (`PUT /hubs/:hubId/onboard/channels`). Before this, nothing that received a
 * webhook read it, so a hub that had turned SMS, WhatsApp, Signal or voice off
 * still accepted and processed everything the provider sent: an operator who
 * flipped the switch believed they had stopped the channel and had not.
 *
 * A refusal is not silent. Whoever tried to reach the line — a caller, a person
 * texting — did not get through, so every refusal is signalled into the hub's
 * `channel-disabled` incident (rule V). It is `record` severity, not `notify`:
 * the switch doing what it was set to do is expected behaviour, not an
 * emergency, but a crisis line must not discard contacts invisibly. The signal
 * carries the channel as its kind and a count — never the sender, the called
 * number or the provider's message/call id (the wire shape has nowhere to put
 * one).
 */
import type { HubChannelType } from '@protocol/schemas/provider-setup'
import type { Services } from '../services'
import { createLogger } from '../lib/logger'

const logger = createLogger('channel-guard')

/**
 * Refuse an inbound contact on a channel the hub has switched off.
 *
 * Returns true when the contact must be refused, after recording it. A webhook
 * that names no hub (`hubId` undefined) is deployment-wide traffic with no hub
 * switches to consult, and is never refused here.
 *
 * Never throws, and fails OPEN: if the switch cannot be read the contact is
 * processed. A database blip must not turn a crisis line's inbound traffic
 * away, and the failure is logged. Failing to record the refusal never changes
 * the refusal.
 */
export async function refuseIfChannelDisabled(
  services: Pick<Services, 'settings' | 'incidents'>,
  hubId: string | undefined,
  channel: Exclude<HubChannelType, 'email'>,
): Promise<boolean> {
  if (!hubId) return false

  let enabled: boolean
  try {
    enabled = await services.settings.isHubChannelEnabled(hubId, channel)
  } catch (err) {
    logger.error('Could not read the hub channel switch — processing the contact', {
      hubId,
      channel,
      error: err instanceof Error ? err.message : String(err),
    })
    return false
  }
  if (enabled) return false

  logger.warn('Refused an inbound contact: the hub has this channel switched off', { hubId, channel })
  try {
    await services.incidents.signal(hubId, 'channel-disabled', channel)
  } catch (err) {
    logger.error('Could not record a channel-disabled incident', {
      hubId,
      channel,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  return true
}
