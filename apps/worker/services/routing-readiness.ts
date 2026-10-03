/**
 * Can this hub ring anybody, ever?
 *
 * Out of the box a hub has no shift and no fallback group, so an incoming call
 * rings nobody. That state is CORRECT — being rostered is the admin's consent
 * and nobody is enrolled into receiving crisis calls implicitly — but it is
 * indistinguishable from a healthy deployment: `/health/ready` passes, the setup
 * wizard reports complete, and the first real caller hears hold music and then
 * voicemail. `reportUnroutableCall` (services/ringing.ts) does log and count it,
 * but only once somebody is already on the line.
 *
 * This is the same question asked at boot, when it can still be acted on.
 * It is a WARNING, never a readiness failure: an un-provisioned hub must not
 * make an orchestrator kill the container, and an operator mid-setup is not
 * broken. It never names a volunteer — counts only.
 */
import type { Services } from '../services'
import { createLogger } from '../lib/logger'

const logger = createLogger('routing-readiness')

export interface HubRoutingReadiness {
  hubId: string
  /** Distinct volunteers named by at least one shift, on any day. */
  rosteredVolunteers: number
  /** Volunteers in the hub's fallback group (rung when nobody is on shift). */
  fallbackVolunteers: number
  /**
   * False when neither a shift nor the fallback group names anybody: no call to
   * this hub can ever ring, at any hour, until an admin provisions one.
   *
   * Deliberately NOT a question about right now. A hub with a 09:00–17:00 shift
   * rings nobody at 03:00 and that is the schedule working as intended; a hub
   * with no roster at all is a deployment that cannot do its job.
   */
  canEverRing: boolean
}

export async function hubRoutingReadiness(
  services: Services,
  hubId: string,
): Promise<HubRoutingReadiness> {
  const [{ shifts }, fallback] = await Promise.all([
    services.shifts.list(hubId),
    services.settings.getFallbackGroup(hubId),
  ])

  const rostered = new Set<string>()
  for (const shift of shifts) {
    for (const pubkey of shift.userPubkeys) rostered.add(pubkey)
  }

  return {
    hubId,
    rosteredVolunteers: rostered.size,
    fallbackVolunteers: fallback.userPubkeys.length,
    canEverRing: rostered.size > 0 || fallback.userPubkeys.length > 0,
  }
}

/**
 * Check every active hub at boot and log the ones a caller could not reach.
 *
 * Called from src/server/index.ts alongside the plaintext-contact warning it is
 * modelled on. Never throws: a hotline must still boot if this check cannot run.
 */
export async function warnOnUnroutableHubs(services: Services): Promise<HubRoutingReadiness[]> {
  let unroutable: HubRoutingReadiness[] = []
  try {
    const { hubs } = await services.settings.getHubs()
    const active = hubs.filter(h => h.status === 'active')
    const readiness = await Promise.all(active.map(h => hubRoutingReadiness(services, h.id)))
    unroutable = readiness.filter(r => !r.canEverRing)

    for (const hub of unroutable) {
      logger.error(
        'This hub can ring nobody: it has no shift naming a volunteer and an empty fallback group. '
        + 'An incoming call will reach voicemail. Add a shift (Admin → Shifts) or a fallback group '
        + '(Admin → Shifts → Fallback group) before publishing the number.',
        { hubId: hub.hubId },
      )
    }
  } catch (err) {
    logger.warn('Could not check whether every hub can route a call', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
  return unroutable
}
