import { request, hubPath } from './client'
import type { HubIncident, HubIncidentListResponse } from '@protocol/schemas/incidents'

export type { HubIncident }

/**
 * The open incidents in `hubId` that the caller is responsible for (B-INCIDENTS).
 *
 * The server filters by the caller's permissions IN THAT HUB, so a member
 * holding no category permission gets an empty list. The client renders exactly
 * what comes back and never decides reach itself. Hub-scoped explicitly (never
 * the active hub): an incident in any member hub must surface (multi-hub axiom).
 */
export async function listOpenIncidents(hubId: string) {
  return request<HubIncidentListResponse>(hubPath(hubId, '/incidents?open=true'))
}
