import { useQueries, useQueryClient } from '@tanstack/react-query'
import { KIND_HUB_INCIDENT } from '@shared/event-kinds'
import { listOpenIncidents, type HubIncident } from './api/incidents'
import { useMemberHubIds } from './member-hubs'
import { useRelaySubscriptions } from './relay/hooks'

const INCIDENT_KINDS = [KIND_HUB_INCIDENT]

export const incidentsQueryKey = (hubId: string) => ['hub-incidents', hubId] as const

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
  const queryClient = useQueryClient()

  const results = useQueries({
    queries: memberHubIds.map((hubId) => ({
      queryKey: incidentsQueryKey(hubId),
      queryFn: async () => (await listOpenIncidents(hubId)).incidents,
    })),
  })

  useRelaySubscriptions(memberHubIds, INCIDENT_KINDS, (_kind, _doorbell, hubId) => {
    void queryClient.invalidateQueries({ queryKey: incidentsQueryKey(hubId), exact: true })
  })

  return results.flatMap((result) => result.data ?? [])
}
