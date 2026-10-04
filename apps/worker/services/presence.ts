/**
 * Hub presence — who a call arriving right now would actually reach.
 *
 * This used to be `CallsService.getPresence`, with the `ShiftsService` it needed
 * as an OPTIONAL constructor argument and the whole on-shift lookup behind
 * `if (this.shiftsService)`. `createServices` passed `new CallsService(db)`, so
 * on every deployment the branch was dead and `/calls/presence` answered
 * `{ activeCalls: 0, availableVolunteers: 0, users: [] }` — nobody is ever on
 * shift — while `/shifts/active` listed the volunteer who had just clocked in.
 * The unit suite was green because it constructed the service WITH a stub, and
 * one of its cases pinned the degraded answer as correct ("works without shifts
 * service"). The dependency is not optional any more because it is no longer a
 * dependency: presence is composed here, where the whole service registry is in
 * hand, and there is no argument left to forget.
 *
 * ## Presence is derived from the ringing rule, not a second copy of it
 *
 * `resolveRingableVolunteers` (services/ringing.ts) is the one definition of
 * "who may be rung", shared by the ringing path and the answer route. Presence
 * CALLS it rather than re-deriving "on shift" from the schedule, so the two can
 * never drift: whatever the ring rule becomes — the schedule alone, or
 * `scheduled ∩ clocked_in` (#1469, #1142) — presence reports exactly that set,
 * with no change here. A presence view that listed people the hotline would not
 * ring would be worse than an empty one: it tells an operator the shift is
 * covered when no phone will light up.
 *
 * Three consequences worth stating, because they are deliberate:
 *
 *  - **`available` means "a call would ring this person now"** — active, not on
 *    break, not already on a live call in ANY hub, and a member of this hub.
 *    Every filter comes from the ring resolver.
 *  - **When nobody is on shift, the hub's fallback group is the ring target**,
 *    so it is who presence reports. That is who a caller reaches.
 *  - **`on-call` is per hub.** A volunteer answering a call in another hub is
 *    excluded entirely here (one phone, one pair of ears) rather than shown as
 *    available, which is what the old code did.
 */
import type { Services } from '../services'
import { resolveRingableVolunteers } from './ringing'

export interface HubPresence {
  /** Calls currently live in this hub (ringing or in progress). */
  activeCalls: number
  /** How many people a call arriving now would ring. */
  availableVolunteers: number
  users: Array<{ pubkey: string; status: 'available' | 'on-call' }>
}

export async function getHubPresence(services: Services, hubId: string): Promise<HubPresence> {
  // getActiveCalls also reaps rows past their staleness TTL, so this is the
  // same view of "live" the dashboard's call list gets.
  const active = await services.calls.getActiveCalls(hubId)

  const onCall = new Set(
    active
      .filter(c => c.answeredBy && c.status === 'in-progress')
      .map(c => c.answeredBy as string),
  )

  // Null means this hub has no roster at all — no shift and no fallback group.
  // Nobody would be rung, which is what presence then reports (and what
  // routing-readiness.ts warns an operator about before a caller finds out).
  const ringable = await resolveRingableVolunteers(services, hubId)

  // The resolver already excludes anyone on a live call in any hub; filtering
  // again only guarantees a pubkey cannot appear twice in `users`.
  const available = (ringable?.available ?? [])
    .map(v => v.pubkey)
    .filter(pubkey => !onCall.has(pubkey))

  return {
    activeCalls: active.length,
    availableVolunteers: available.length,
    users: [
      ...available.map(pubkey => ({ pubkey, status: 'available' as const })),
      ...[...onCall].map(pubkey => ({ pubkey, status: 'on-call' as const })),
    ],
  }
}
