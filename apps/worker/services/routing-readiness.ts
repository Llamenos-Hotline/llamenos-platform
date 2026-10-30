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
import { resolveRingableVolunteers } from './ringing'
import { EMPTY_CHECK_RESULT, type IncidentCheck, type IncidentCheckResult } from './incidents'

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

// ---------------------------------------------------------------------------
// "Would a call arriving right now ring anybody?"
// ---------------------------------------------------------------------------

/**
 * The live ring decision, as a value an operator can read.
 *
 * Before this, the decision was unmeasurable on a deployment: nothing exposed
 * what `resolveRingableVolunteers` would resolve to, and its only non-provider
 * caller was `POST /hubs/:id/simulated-telephony/simulate/incoming-call`, which
 * only a host with the dev surface enabled may serve. On a VM without it, five
 * ring-eligibility checks in the live suite skipped, so R1's "that volunteer
 * clocks in, receives a call" could only ever be verified on a test instance. A
 * suite that skips on the one configuration that ships is not coverage.
 *
 * It CALLS the resolver rather than restating it, for the same reason presence
 * does: a second copy of the eligibility rule drifts from the first. The counts
 * either side of it (`scheduledNow`, `clockedIn`) are plain reads of the two
 * inputs, not a re-derivation of the decision — they are what turns "nobody
 * would ring" into a diagnosis (rostered but nobody clocked in, versus nobody
 * rostered at all).
 *
 * Read-only: no provider call, no call record, no side effect of any kind.
 */
export interface HubRingDecision {
  hubId: string
  /** Would a call arriving right now ring anybody at all? */
  wouldRing: boolean
  /** How many phones/clients would ring. */
  volunteerCount: number
  /** True when those volunteers came from the hub's fallback group, not the schedule. */
  usingFallbackGroup: boolean
  /** Distinct volunteers the schedule puts on shift right now, before availability. */
  scheduledNow: number
  /** Volunteers currently clocked into this hub. */
  clockedIn: number
  /**
   * Pubkeys of the volunteers that would ring. Identity-bearing: the route
   * returns this only to a caller who may already see volunteer presence.
   */
  pubkeys: string[]
}

export async function currentRingDecision(
  services: Services,
  hubId: string,
): Promise<HubRingDecision> {
  const [ringable, scheduled, { activeShifts }] = await Promise.all([
    resolveRingableVolunteers(services, hubId),
    services.shifts.getCurrentVolunteers(hubId),
    services.activeShifts.listActiveByHub(hubId),
  ])

  const pubkeys = (ringable?.available ?? []).map(v => v.pubkey)

  return {
    hubId,
    wouldRing: pubkeys.length > 0,
    volunteerCount: pubkeys.length,
    usingFallbackGroup: ringable?.usedFallback ?? false,
    scheduledNow: new Set(scheduled).size,
    clockedIn: activeShifts.length,
    pubkeys,
  }
}

// ---------------------------------------------------------------------------
// The same questions, asked continuously: `routing` incidents (#2330)
// ---------------------------------------------------------------------------
//
// Both checks below are L1 detectors (spec §5.6): registered with
// `IncidentService.registerCheck` by the service registry and evaluated per
// hub by the `incident-checks` scheduler worker — never by the ringing path,
// so a ringing path that has stopped working is still reported. Each returns
// a LEVEL: `{count: 0, oldestAgeSeconds: null}` when healthy, and THROWS when
// it cannot answer (a failing check raises `worker_failing`, never a zero).
// Counts only — neither result names a volunteer, a caller or a call.

/** Look-back for `no_answers`. Matches the instance-level `InboundButNoAnswers` rule's window. */
export const ROUTING_NO_ANSWER_WINDOW_MS = 30 * 60_000

/**
 * Inbound calls with an outcome in the window before `no_answers` is raised
 * with none answered. Below it, a quiet line where one or two callers hung up
 * in the queue is ordinary; three unanswered in a row with not one pickup is a
 * hotline nobody is answering.
 */
export const ROUTING_NO_ANSWER_MIN_INBOUND = 3

/**
 * Can this hub receive a call at all? Only an active hub with a number is
 * routed to (`SettingsService.getHubByPhone`); a hub without one — mid-setup,
 * or messaging-only — expects no calls, so neither check has anything to say.
 */
async function hubTakesCalls(services: Pick<Services, 'settings'>, hubId: string): Promise<boolean> {
  const { hub } = await services.settings.getHub(hubId)
  return hub.status === 'active' && !!hub.phoneNumber
}

/**
 * `routing/nobody_would_ring`: a call arriving now, during a period the hub
 * expects coverage, would ring nobody.
 *
 * The answer comes from `currentRingDecision`, i.e. from the real resolver —
 * never a restatement of the eligibility rule. "Expects coverage" comes from
 * the hub's own schedule and fallback group:
 *
 *  - a shift names somebody right now — the schedule promises an answer now;
 *  - the fallback group names somebody — it exists to answer whenever the
 *    schedule does not, so it promises an answer at every hour;
 *  - NOTHING names anybody — no shift on any day and an empty fallback group.
 *    The hub cannot ring at any hour, so this is a standing incident that
 *    stays open until an admin rosters somebody, not a one-off.
 *
 * What it deliberately does NOT raise: a hub whose only shift is 09:00–17:00,
 * with no fallback group, at 03:00. That is the schedule working as written
 * (see `HubRoutingReadiness.canEverRing`).
 *
 * Volunteers all being on other calls also reads as "nobody would ring": a
 * caller arriving then is not answered either, and the ringing path already
 * treats it as an emergency (`reportUnroutableCall`, no-available-volunteers).
 */
export async function nobodyWouldRingCount(services: Services, hubId: string): Promise<IncidentCheckResult> {
  if (!(await hubTakesCalls(services, hubId))) return EMPTY_CHECK_RESULT
  const decision = await currentRingDecision(services, hubId)
  if (decision.wouldRing) return EMPTY_CHECK_RESULT

  const readiness = await hubRoutingReadiness(services, hubId)
  const expectsCoverage =
    !readiness.canEverRing || readiness.fallbackVolunteers > 0 || decision.scheduledNow > 0
  return expectsCoverage ? { count: 1, oldestAgeSeconds: null } : EMPTY_CHECK_RESULT
}

/**
 * `routing/no_answers`: in the last {@link ROUTING_NO_ANSWER_WINDOW_MS}, at
 * least {@link ROUTING_NO_ANSWER_MIN_INBOUND} inbound calls reached an outcome
 * and none was answered.
 *
 * The source is the hub's own call records — `active_calls.answered_at` for a
 * call still in progress, `call_records.status = 'completed'` for a finished
 * one (`CallsService.answerOutcomesSince`) — not Prometheus, whose counters
 * carry no hub and vanish with the process. The count is the unanswered calls;
 * the age is how long ago the oldest of them started.
 */
export async function noAnswersCount(
  services: Pick<Services, 'settings' | 'calls'>,
  hubId: string,
  now: Date,
): Promise<IncidentCheckResult> {
  if (!(await hubTakesCalls(services, hubId))) return EMPTY_CHECK_RESULT
  const since = new Date(now.getTime() - ROUTING_NO_ANSWER_WINDOW_MS)
  const outcomes = await services.calls.answerOutcomesSince(hubId, since)
  if (outcomes.answered > 0 || outcomes.inbound < ROUTING_NO_ANSWER_MIN_INBOUND) return EMPTY_CHECK_RESULT
  const oldestAgeSeconds = outcomes.oldestUnansweredAt
    ? Math.max(0, Math.floor((now.getTime() - outcomes.oldestUnansweredAt.getTime()) / 1000))
    : null
  return { count: outcomes.inbound, oldestAgeSeconds }
}

/** The two `routing` L1 checks, as registered by the service registry. */
export function routingIncidentChecks(services: Services): IncidentCheck[] {
  return [
    {
      category: 'routing',
      kind: 'nobody_would_ring',
      name: 'routing-nobody-would-ring',
      check: (hubId) => nobodyWouldRingCount(services, hubId),
    },
    {
      category: 'routing',
      kind: 'no_answers',
      name: 'routing-no-answers',
      check: (hubId, now) => noAnswersCount(services, hubId, now),
    },
  ]
}
