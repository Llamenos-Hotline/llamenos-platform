import { useQueries, useQueryClient } from '@tanstack/react-query'
import { KIND_HUB_INCIDENT } from '@shared/event-kinds'
import { listOpenIncidents, type HubIncident } from './api/incidents'
import { useAuth } from './auth'
import { useMemberHubIds } from './member-hubs'
import { useRelaySubscriptions } from './relay/hooks'

const INCIDENT_KINDS = [KIND_HUB_INCIDENT]

/**
 * Keyed by the signed-in user as well as the hub: the query cache outlives a logout, and
 * what one user may see of a hub's incidents is not what the next user may see.
 */
export const incidentsQueryKey = (publicKey: string | null, hubId: string) =>
  ['hub-incidents', publicKey, hubId] as const

/**
 * Every open incident the user is responsible for, across EVERY hub they are a
 * member of (B-INCIDENTS-CLIENTS, operator rule V).
 *
 * - Source of truth is the permission-filtered `GET /hubs/:hubId/incidents`,
 *   one per member hub. What the server returns is rendered; a member it
 *   returns nothing to sees nothing.
 * - `KIND_HUB_INCIDENT` is a doorbell: it re-reads THAT hub's list, once. Its
 *   payload (`{incidentId, state}`) is never rendered or merged in.
 * - Multi-hub axiom: subscribed and fetched for all member hubs, whichever hub
 *   is active. Nothing here reads or changes the active hub.
 */
export function useHubIncidents(): HubIncident[] {
  const memberHubIds = useMemberHubIds()
  const { publicKey } = useAuth()
  const queryClient = useQueryClient()

  const results = useQueries({
    queries: memberHubIds.map((hubId) => ({
      queryKey: incidentsQueryKey(publicKey, hubId),
      queryFn: async () => (await listOpenIncidents(hubId)).incidents,
      enabled: publicKey !== null,
      // Every mount of the banner (a new session) reads afresh; the doorbell does the rest.
      staleTime: 0,
    })),
  })

  useRelaySubscriptions(memberHubIds, INCIDENT_KINDS, (_kind, _doorbell, hubId) => {
    void queryClient.invalidateQueries({ queryKey: incidentsQueryKey(publicKey, hubId), exact: true })
  })

  return results.flatMap((result) => result.data ?? [])
}
