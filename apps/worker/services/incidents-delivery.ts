/**
 * IncidentDelivery (B-INCIDENTS, #2341) — the three channels an incident
 * announcement goes out on.
 *
 *  - Relay: `KIND_HUB_INCIDENT` with `{incidentId, state}` and nothing else.
 *    `publishEvent` fans out to EVERY member of the hub (lib/ws-events.ts →
 *    `publishToHub`), so anything richer would tell every volunteer of a
 *    crisis hotline what kind of attack it is under. A permission holder's
 *    client learns the detail by refetching `GET /hubs/:hubId/incidents`,
 *    which is filtered by permission.
 *  - Push: content-free. The wake payload carries the hub (multi-hub routing)
 *    and `type: 'incident'`; no category, no counts. The app renders
 *    `incident.push` ("There is activity on your hotline that needs a look.")
 *    locally and opens the incident view for detail.
 *  - Signal: the `hub_incident` alert (category + state, localized), through
 *    `UserNotificationsService.sendAlert`, whose preference gate and retries
 *    apply — only members who chose Signal as their alert channel get it.
 *
 * Push and Signal reach only the category's permission HOLDERS, resolved from
 * each member's roles in the hub; never a role name or id.
 */
import type { Env } from '../types'
import type { HubIncidentRow } from '../db/schema/incidents'
import {
  hubIncidentRelayEventSchema,
  type IncidentCategory,
  type IncidentState,
} from '@protocol/schemas/incidents'
import { KIND_HUB_INCIDENT } from '@shared/event-kinds'
import { permissionGranted, resolveHubPermissions } from '@shared/permissions'
import { publishEvent } from '../lib/ws-events'
import { createPushDispatcherFromService, type PushDispatcher } from '../lib/push-dispatch'
import type { IdentityService } from './identity'
import type { SettingsService } from './settings'
import type { ShiftsService } from './shifts'
import type { UserNotificationsService } from './user-notifications'
import type { IncidentNotifier } from './incidents'
import { INCIDENT_CATEGORIES } from './incidents-categories'
import { createLogger } from '../lib/logger'

const log = createLogger('services.incidents-delivery')

export interface IncidentHolder {
  pubkey: string
  uiLanguage: string
}

/**
 * Members of `hubId` whose roles IN THAT HUB grant `category`'s permission.
 *
 * Only people with a role assignment in the hub are interrupted. A platform
 * super-admin who is not a member can still READ the hub's incidents (their
 * global `*` reaches the GET, as it reaches every hub route), but is not paged
 * for every hub on the instance — reach is resolved from hub roles (spec §5.4).
 * Inactive accounts are skipped.
 */
export async function resolveIncidentHolders(
  identity: Pick<IdentityService, 'getUsers'>,
  settings: Pick<SettingsService, 'getRoles'>,
  hubId: string,
  category: IncidentCategory,
): Promise<IncidentHolder[]> {
  const permission = INCIDENT_CATEGORIES[category].permission
  const [{ users }, { roles }] = await Promise.all([identity.getUsers(hubId), settings.getRoles()])
  return users
    .filter((u) => u.active)
    .filter((u) => (u.hubRoles ?? []).some((assignment) => assignment.hubId === hubId))
    .filter((u) => permissionGranted(resolveHubPermissions(u.roles, u.hubRoles ?? [], roles, hubId), permission))
    .map((u) => ({ pubkey: u.pubkey, uiLanguage: u.uiLanguage || 'en' }))
}

export interface IncidentDeliveryDeps {
  env: Env
  identity: IdentityService
  settings: SettingsService
  shifts: ShiftsService
  userNotifications: Pick<UserNotificationsService, 'sendAlert'>
  /** Overridable for tests; defaults to the dispatcher every other push uses. */
  pushDispatcher?: PushDispatcher
}

export class IncidentDelivery implements IncidentNotifier {
  private readonly push: PushDispatcher

  constructor(private readonly deps: IncidentDeliveryDeps) {
    this.push = deps.pushDispatcher ?? createPushDispatcherFromService(deps.env, deps.identity, deps.shifts)
  }

  async relay(incident: HubIncidentRow, state: IncidentState): Promise<void> {
    // Parsed through the strict schema: a field added here by mistake throws
    // instead of reaching every member of the hub.
    const content = hubIncidentRelayEventSchema.parse({ incidentId: incident.id, state })
    publishEvent(this.deps.env, KIND_HUB_INCIDENT, content, incident.hubId)
  }

  async interrupt(incident: HubIncidentRow, state: IncidentState): Promise<void> {
    const category = incident.category as IncidentCategory
    const holders = await resolveIncidentHolders(this.deps.identity, this.deps.settings, incident.hubId, category)
    const wake = { hubId: incident.hubId, type: 'incident' as const }
    await Promise.allSettled(
      holders.map(async (holder) => {
        const results = await Promise.allSettled([
          this.push.sendToVolunteer(holder.pubkey, wake, { ...wake }),
          this.deps.userNotifications.sendAlert(
            holder.pubkey,
            { type: 'hub_incident', category, state },
            holder.uiLanguage,
          ),
        ])
        for (const r of results) {
          if (r.status === 'rejected') {
            log.error('Incident notification to a holder failed', {
              incidentId: incident.id,
              state,
              error: r.reason,
            })
          }
        }
      }),
    )
  }
}
