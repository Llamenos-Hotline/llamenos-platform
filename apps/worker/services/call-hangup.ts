/**
 * Provider-side hang-up for an active call.
 *
 * The active_calls row only mirrors the provider's call leg; ending the row does
 * not disconnect anyone. Every in-app disconnect (Hang up, Ban & hang up) goes
 * through here so the caller is dropped at the provider *before* the row is ended,
 * and the outcome reported to the volunteer is what actually happened.
 */
import type { Env } from '../types'
import type { Services } from './index'
import { getHubTelephonyFromService, getTelephonyFromService } from '../lib/service-factories'
import { createLogger } from '../lib/logger'

const logger = createLogger('call-hangup')

export type ProviderHangupOutcome =
  /** The provider confirmed the caller's leg is disconnected. */
  | 'disconnected'
  /** No telephony provider is configured for the call's hub — there is no provider leg to drop. */
  | 'no-provider'
  /** The provider refused or was unreachable — the caller may still be connected. */
  | 'failed'

/**
 * Disconnect the caller's leg (the call's `callId` is the caller's provider call SID).
 * Never throws: the outcome is the result.
 *
 * For a bridged call, dropping the caller leg also ends the bridge, so the
 * volunteer's leg is released by the provider as a consequence.
 */
export async function hangUpCallerLeg(
  env: Env,
  services: Services,
  call: { callId: string; hubId: string | null },
): Promise<ProviderHangupOutcome> {
  const hubId = call.hubId ?? ''
  let adapter
  try {
    adapter = hubId !== ''
      ? await getHubTelephonyFromService(env, services.settings, hubId)
      : await getTelephonyFromService(env, services.settings)
  } catch (err) {
    logger.error('Could not resolve telephony adapter for hang-up', err, { callId: call.callId, hubId })
    return 'failed'
  }

  if (!adapter) {
    logger.warn('No telephony provider configured — nothing to disconnect at the provider', { callId: call.callId, hubId })
    return 'no-provider'
  }

  try {
    await adapter.hangupCall(call.callId)
    return 'disconnected'
  } catch (err) {
    logger.error('Provider hang-up failed — caller may still be connected', err, { callId: call.callId, hubId })
    return 'failed'
  }
}
