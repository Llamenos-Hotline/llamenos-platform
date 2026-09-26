import type { Env } from '../types'
import type { Services } from '../services'
import { getTelephonyFromService, getHubTelephonyFromService } from '../lib/service-factories'
import { dispatchVoipPushFromService } from '../lib/voip-push'
import { publishEvent } from '../lib/ws-events'
import { KIND_CALL_RING } from '@shared/event-kinds'
import { createLogger } from '../lib/logger'
import { withRetry, isRetryableError } from '../lib/retry'
import { getCircuitBreaker } from '../lib/circuit-breaker'
import { incCounter } from '../routes/metrics'
import { hashPhone } from '../lib/crypto'
import { resolveHubPermissions } from '@shared/permissions'

const logger = createLogger('ringing')

/**
 * Outcome of a ringing attempt. `ringing: false` means nobody could be rung — the call
 * record still exists (created before ringing is attempted) and ends as `unanswered`,
 * with `hasVoicemail` set if the caller leaves a message.
 */
export interface ParallelRingingResult {
  ringing: boolean
  /** Why nothing rang (only set when `ringing` is false). */
  reason?: 'no-volunteers' | 'no-available-volunteers' | 'error'
  /** Number of available on-shift volunteers notified (relay / VoIP push / phone). */
  volunteersNotified: number
}

/**
 * A caller is in the queue and nobody can be rung. That is an operational emergency
 * (they will hear hold music, then leave a voicemail nobody knows to expect), not an
 * info-level event: log at error level and bump a counter operators can alert on.
 */
function reportUnroutableCall(
  callSid: string,
  hubId: string,
  reason: 'no-volunteers' | 'no-available-volunteers',
  detail: string,
): void {
  logger.error(`${detail} — caller will get no answer`, { callSid, hubId, reason })
  incCounter('llamenos_calls_unroutable_total', { reason })
}

export async function startParallelRinging(
  callSid: string,
  callerNumber: string,
  origin: string,
  env: Env,
  services: Services,
  hubId: string,
): Promise<ParallelRingingResult> {
  try {
    // Register the incoming call FIRST — before anyone is looked up or rung. A caller who
    // reaches the queue has a call record whether or not a volunteer can be found: if
    // nobody is reachable they hear hold music, time out into voicemail, and the
    // voicemail/hangup handlers need a record to attach to (#1043).
    // Store the HMAC hash, not the raw number.
    const callerNumberHash = hashPhone(callerNumber, env.HMAC_SECRET)
    await services.calls.addCall(hubId, {
      callId: callSid,
      callerNumber: callerNumberHash,
      callerLast4: callerNumber.slice(-4),
      status: 'ringing',
    })

    // Get on-shift volunteers
    let onShiftPubkeys = await services.shifts.getCurrentVolunteers(hubId)
    let usedFallback = false

    // If no one is on shift, use the hub's fallback group
    if (onShiftPubkeys.length === 0) {
      const fallback = await services.settings.getFallbackGroup(hubId)
      onShiftPubkeys = fallback.userPubkeys
      usedFallback = true
    }

    logger.info('Parallel ringing started', { callSid, onShiftCount: onShiftPubkeys.length })

    if (onShiftPubkeys.length === 0) {
      reportUnroutableCall(callSid, hubId, 'no-volunteers', 'No volunteers on shift and the fallback group is empty')
      return { ringing: false, reason: 'no-volunteers', volunteersNotified: 0 }
    }

    // Get user details (including call preference)
    const { users: allUsers } = await services.identity.getUsers()

    // Hub access: only ring people who could actually answer this hub's call.
    // Same rule `hubContext` applies to the answer route — any effective permission in
    // the hub (global role or hub-scoped role). Without this a stale shift entry or a
    // fallback group naming a user from another hub would push "a caller is waiting"
    // to someone with no business in this hub. Global-scope calls (hubId '') have no hub.
    const { roles: allRoles } = hubId !== '' ? await services.settings.getRoles() : { roles: [] }
    const hasHubAccess = (v: (typeof allUsers)[number]) =>
      hubId === '' || resolveHubPermissions(v.roles ?? [], v.hubRoles ?? [], allRoles, hubId).length > 0

    // Availability rules: a volunteer must be active, on break-free, and a member of the hub.
    const pickAvailable = (pubkeys: string[]) =>
      allUsers.filter(v => pubkeys.includes(v.pubkey) && v.active && !v.onBreak && hasHubAccess(v))

    // All available on-shift users (for Nostr relay notification)
    let available = pickAvailable(onShiftPubkeys)

    // Everyone on shift is unavailable (inactive / on break) — try the fallback
    // group with the same availability rules before giving up. The fallback is
    // meant for exactly this case, not only for an empty roster.
    if (available.length === 0 && !usedFallback) {
      const fallback = await services.settings.getFallbackGroup(hubId)
      available = pickAvailable(fallback.userPubkeys)
      logger.info('On-shift volunteers unavailable — tried fallback group', {
        callSid,
        fallbackCount: fallback.userPubkeys.length,
        fallbackAvailable: available.length,
      })
    }

    // Only ring phones for volunteers with phone or both preference (and who have a phone number)
    const toRingPhone = available
      .filter(v => {
        const pref = v.callPreference ?? 'phone'
        return (pref === 'phone' || pref === 'both') && v.phone
      })
      .map(v => ({ pubkey: v.pubkey, phone: v.phone }))

    // Browser/VoIP volunteers get notified via Nostr relay and VoIP push
    const browserVoip = available.filter(v => {
      const pref = v.callPreference ?? 'phone'
      return pref === 'browser' || pref === 'both'
    })

    if (available.length === 0) {
      reportUnroutableCall(callSid, hubId, 'no-available-volunteers', 'Every volunteer on shift or in the fallback group is inactive, on break, or not a member of the hub')
      return { ringing: false, reason: 'no-available-volunteers', volunteersNotified: 0 }
    }

    logger.info('Ringing volunteers', { callSid, total: available.length, phone: toRingPhone.length, browserVoip: browserVoip.length })

    const callerLast4 = callerNumber.slice(-4)
    if (hubId !== '') {
      // Publish the ring to the hub that owns the call. Every member of that hub
      // whose relay socket subscribes to it rings — including members whose
      // active hub in the UI is a different one (multi-hub routing axiom).
      publishEvent(env, KIND_CALL_RING, { type: 'call:ring', callId: callSid }, hubId)

      // Dispatch VoIP push notifications to mobile volunteers with registered VoIP tokens.
      dispatchVoipPushFromService(
        browserVoip.map(v => v.pubkey),
        callSid,
        callerLast4,
        hubId,
        env,
        services.identity,
      ).catch(err => {
        // VoIP push is best-effort — Nostr relay is the primary notification path
        logger.error('VoIP push dispatch failed', err)
      })
    } else {
      // A call whose dialled number maps to no hub has no member set to ring over
      // the relay or VoIP push. Never fall back to an instance-wide channel: that
      // would expose the ring to every user of every hub.
      logger.error('Call resolved to no hub — relay and VoIP clients cannot be rung', { callSid })
    }

    // Ring phone volunteers via telephony adapter (skip if no one needs phone ringing)
    if (toRingPhone.length > 0) {
      const adapter = hubId !== ''
        ? await getHubTelephonyFromService(env, services.settings, hubId)
        : await getTelephonyFromService(env, services.settings)
      if (!adapter) return { ringing: true, volunteersNotified: available.length }

      // CRIT-W2: Generate opaque single-use call tokens per volunteer.
      // Tokens are embedded in callback URLs instead of raw pubkeys.
      // Filter out any volunteers with missing pubkeys — creating tokens
      // with empty pubkeys would break callback resolution.
      const ringableVolunteers = toRingPhone.filter(vol => vol.pubkey)
      const volunteersWithTokens = await Promise.all(
        ringableVolunteers.map(async (vol) => {
          const callToken = await services.calls.createCallToken({
            callSid,
            volunteerPubkey: vol.pubkey,
            hubId,
          })
          return { phone: vol.phone as string, callToken }
        }),
      )

      if (volunteersWithTokens.length === 0) return { ringing: true, volunteersNotified: available.length }

      const breaker = getCircuitBreaker({
        name: 'telephony:ringVolunteers',
        failureThreshold: 5,
        resetTimeoutMs: 30_000,
      })

      await breaker.execute(() =>
        withRetry(
          () => adapter.ringVolunteers({
            callSid,
            callerNumber,
            volunteers: volunteersWithTokens,
            callbackUrl: origin,
            hubId,
          }),
          {
            maxAttempts: 3,
            baseDelayMs: 500,
            maxDelayMs: 3000,
            isRetryable: isRetryableError,
            onRetry: (attempt, error) => {
              logger.warn(`ringVolunteers retry ${attempt} for callSid=${callSid}`, { error })
              incCounter('llamenos_retry_attempts_total', { service: 'telephony', operation: 'ringVolunteers' })
            },
          },
        )
      )
    }
    return { ringing: true, volunteersNotified: available.length }
  } catch (err) {
    logger.error('startParallelRinging failed', err)
    return { ringing: false, reason: 'error', volunteersNotified: 0 }
  }
}
