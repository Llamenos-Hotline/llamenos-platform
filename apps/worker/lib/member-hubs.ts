/**
 * Which hubs a user belongs to, for the two places that must agree: relay
 * subscription (`routes/ws.ts`, via `src/server/index.ts`) and relay-event key
 * distribution (`GET /api/auth/me`). A user is handed an event key exactly for
 * the hubs whose frames they may subscribe to (#2999).
 */
import type { Hub } from '@protocol/schemas/hubs'

/** The ids of the active hubs `user` holds a hub role in. */
export function activeMemberHubIds(
  user: { hubRoles?: ReadonlyArray<{ hubId: string }> | null },
  hubs: ReadonlyArray<Pick<Hub, 'id' | 'status'>>,
): string[] {
  const member = new Set((user.hubRoles ?? []).map(hr => hr.hubId))
  return hubs.filter(h => h.status === 'active' && member.has(h.id)).map(h => h.id)
}
