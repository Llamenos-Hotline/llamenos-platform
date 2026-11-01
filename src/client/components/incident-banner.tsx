import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import type { IncidentCategory } from '@protocol/schemas/incidents'
import type { HubIncident } from '@/lib/api/incidents'
import { useConfig } from '@/lib/config'
import { formatTimestamp } from '@/lib/format'
import { useHubIncidents } from '@/lib/incidents'

const CATEGORY_LABEL_KEY: Record<IncidentCategory, string> = {
  spam: 'incident.category.spam',
  'provider-media': 'incident.category.providerMedia',
  'erasure-deadline': 'incident.category.erasureDeadline',
  'ban-expiry': 'incident.category.banExpiry',
  'channel-disabled': 'incident.category.channelDisabled',
  routing: 'incident.category.routing',
  'provider-auth': 'incident.category.providerAuth',
}

function categoryLabelKey(category: string): string {
  // The category is extensible: a value this build does not know (a category
  // appended after it shipped) is still an incident, shown under the generic title.
  return (CATEGORY_LABEL_KEY as Record<string, string | undefined>)[category] ?? 'incident.title'
}

/**
 * The persistent incident banner (B-INCIDENTS-CLIENTS, operator rule V).
 *
 * Mounted in the authenticated shell, outside the routed page, so it survives
 * navigation; it has no dismiss control and disappears only when the server
 * stops listing the incident. It shows exactly what the permission-filtered
 * GET returned for each member hub — a member who may see nothing sees nothing.
 * An incident in a hub other than the active one is labelled with that hub;
 * nothing here switches the active hub.
 */
export function IncidentBanner() {
  const { t } = useTranslation()
  const incidents = useHubIncidents()
  const { hubs, currentHubId } = useConfig()

  if (incidents.length === 0) return null

  // Incidents in the hub being browsed first, then oldest first.
  const ordered = [...incidents].sort((a, b) =>
    Number(b.hubId === currentHubId) - Number(a.hubId === currentHubId) || a.openedAt.localeCompare(b.openedAt),
  )

  const hubLabel = (incident: HubIncident): string | null => {
    if (incident.hubId === currentHubId) return null
    const name = hubs.find((hub) => hub.id === incident.hubId)?.name
    return name ? t('incident.inHub', { hub: name }) : t('incident.otherHub')
  }

  return (
    <section
      role="status"
      aria-label={t('incident.title')}
      data-testid="incident-banner"
      className="border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-sm"
    >
      <ul className="space-y-1">
        {ordered.map((incident) => {
          const otherHub = hubLabel(incident)
          return (
            <li
              key={incident.id}
              data-testid="incident-banner-row"
              data-hub-id={incident.hubId}
              className="flex flex-wrap items-center gap-x-2 gap-y-0.5"
            >
              <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
              <span className="font-semibold">{t(categoryLabelKey(incident.category))}</span>
              <span className="text-destructive">{t('incident.opened')}</span>
              <span className="text-muted-foreground">
                {t('incident.ongoing', { count: incident.totalCount, time: formatTimestamp(incident.openedAt) })}
              </span>
              {otherHub && (
                <span data-testid="incident-banner-hub" className="rounded bg-background/60 px-1.5 py-0.5 text-xs font-medium">
                  {otherHub}
                </span>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
