/**
 * Demo call simulation — drives the MockTelephonyAdapter through the REAL routing path.
 *
 * A real inbound call goes: webhook → ban check → shift / ring-group resolution →
 * `call:ring` to on-shift volunteers → answer → end → note. There is no provider here to
 * originate that webhook, so this injects the call at the same point the webhook flow does
 * (after provider parsing) and reuses the very same services: `records.checkBan`,
 * `startParallelRinging` (shift + fallback-group resolution, call record, `call:ring`,
 * VoIP push, adapter.ringVolunteers). Answer / hang-up / notes are then the ordinary
 * authenticated calls-and-notes endpoints the volunteer client already uses.
 */
import type { Env } from '../types'
import type { Services } from './index'
import { getHubTelephonyFromService } from '../lib/service-factories'
import { MockTelephonyAdapter, MOCK_CALL_SID_PREFIX } from '../telephony/mock'
import { startParallelRinging } from './ringing'
import { hashPhone } from '../lib/crypto'
import { publishEvent } from '../lib/ws-events'
import { KIND_CALL_UPDATE } from '@shared/event-kinds'
import { createLogger } from '../lib/logger'

const logger = createLogger('demo-call-simulation')

export type SimulateIncomingCallResult =
  | { ok: true; callId: string; callerLast4: string; volunteersNotified: number }
  | { ok: false; status: 403 | 409 | 422 | 500; code: 'banned' | 'mock-not-enabled' | 'no-volunteers' | 'ringing-failed' }

/** A fictional NANP-style 555 number — never routable, never a real subscriber. */
export function randomFictionalCallerNumber(): string {
  const digits = new Uint32Array(1)
  crypto.getRandomValues(digits)
  return `+1555${String(digits[0] % 10_000_000).padStart(7, '0')}`
}

export async function simulateIncomingCall(params: {
  env: Env
  services: Services
  hubId: string
  callerNumber: string
  origin: string
}): Promise<SimulateIncomingCallResult> {
  const { env, services, hubId, callerNumber, origin } = params

  // Only a hub that has selected the mock provider may be simulated against —
  // never inject fake calls into a hub wired to a real provider.
  const adapter = await getHubTelephonyFromService(env, services.settings, hubId)
  if (!(adapter instanceof MockTelephonyAdapter)) {
    return { ok: false, status: 409, code: 'mock-not-enabled' }
  }

  // Ban check — same hashed lookup the /incoming webhook performs.
  const banned = await services.records.checkBan(hashPhone(callerNumber, env.HMAC_SECRET), hubId)
  if (banned) return { ok: false, status: 403, code: 'banned' }

  const callId = `${MOCK_CALL_SID_PREFIX}${crypto.randomUUID()}`
  const result = await startParallelRinging(callId, callerNumber, origin, env, services, hubId)
  if (!result.ringing) {
    // The call record is created before ringing is attempted; a simulated caller never
    // leaves a voicemail, so close it out rather than leave a phantom ringing call.
    try {
      await services.calls.endCall(hubId, callId)
    } catch (err) {
      logger.warn('Could not close simulated call after ring failure', { callId, err })
    }
    const noOne = result.reason === 'no-volunteers' || result.reason === 'no-available-volunteers'
    return noOne
      ? { ok: false, status: 422, code: 'no-volunteers' }
      : { ok: false, status: 500, code: 'ringing-failed' }
  }
  return { ok: true, callId, callerLast4: callerNumber.slice(-4), volunteersNotified: result.volunteersNotified }
}

export type SimulateCallerHangupResult =
  | { ok: true; callId: string }
  | { ok: false; status: 404 | 409; code: 'call-not-found' | 'not-a-simulated-call' }

/**
 * The simulated caller hangs up. Mirrors the `/call-status` webhook's `completed` branch
 * (end the call record + publish `call:update`), but only for calls the mock minted.
 */
export async function simulateCallerHangup(params: {
  env: Env
  services: Services
  hubId: string
  callId: string
}): Promise<SimulateCallerHangupResult> {
  const { env, services, hubId, callId } = params
  if (!callId.startsWith(MOCK_CALL_SID_PREFIX)) {
    return { ok: false, status: 409, code: 'not-a-simulated-call' }
  }
  const call = await services.calls.getActiveCallById(hubId, callId)
  if (!call) return { ok: false, status: 404, code: 'call-not-found' }
  await services.calls.endCall(hubId, callId)
  publishEvent(env, KIND_CALL_UPDATE, { type: 'call:update', callId, status: 'completed' }, hubId)
  return { ok: true, callId }
}
