import { createFileRoute, Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/lib/auth'
import { useEffect, useState, useMemo, useCallback } from 'react'
import { listAuditLog, listPlatformAuditLog, listUsers, NoActiveHubError, type AuditLogEntry, type User } from '@/lib/api'
import { useToast } from '@/lib/toast'
import { ScrollText, ChevronLeft, ChevronRight, Search } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

export const Route = createFileRoute('/audit')({
  component: () => <AuditPage />,
})

const EVENT_CATEGORIES = [
  { value: 'all', labelKey: 'auditLog.allEvents' },
  { value: 'authentication', labelKey: 'auditLog.categoryAuth' },
  { value: 'volunteers', labelKey: 'auditLog.categoryVolunteers' },
  { value: 'calls', labelKey: 'auditLog.categoryCalls' },
  { value: 'settings', labelKey: 'auditLog.categorySettings' },
  { value: 'shifts', labelKey: 'auditLog.categoryShifts' },
  { value: 'notes', labelKey: 'auditLog.categoryNotes' },
] as const

function getEventCategoryColor(action: string): string {
  const authEvents = ['login', 'logout', 'sessionCreated', 'sessionExpired', 'passkeyRegistered', 'deviceLinked', 'volunteerOnBreak', 'volunteerAvailable']
  const volEvents = ['userAdded', 'userRemoved', 'rolesChanged', 'userDeactivated', 'inviteCreated', 'inviteRevoked']
  const callEvents = ['callAnswered', 'callEnded', 'callMissed', 'numberBanned', 'voicemailReceived']
  const settingsEvents = ['transcriptionToggled', 'customFieldsUpdated', 'spamMitigationToggled', 'callSettingsUpdated', 'ivrLanguagesUpdated', 'webauthnSettingsUpdated', 'telephonyProviderChanged', 'messagingConfigUpdated', 'setupStateUpdated']
  const shiftEvents = ['shiftCreated', 'shiftUpdated', 'shiftDeleted']

  if (authEvents.includes(action)) return 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300'
  if (volEvents.includes(action)) return 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300'
  if (callEvents.includes(action)) return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
  if (settingsEvents.includes(action)) return 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300'
  if (shiftEvents.includes(action)) return 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-300'
  return 'bg-secondary text-secondary-foreground'
}

/**
 * `hub` is the active hub's chain. `platform` is the deployment-level chain, which
 * has its own route and permission (`system:view-audit`) — no hub's entries (#2395).
 */
export function AuditPage({ scope = 'hub' }: { scope?: 'hub' | 'platform' }) {
  const { t } = useTranslation()
  const { isAdmin } = useAuth()
  const [entries, setEntries] = useState<AuditLogEntry[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [users, setUsers] = useState<User[]>([])
  const [searchText, setSearchText] = useState('')
  const [eventType, setEventType] = useState('all')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const limit = 50

  const { toast } = useToast()

  useEffect(() => {
    listUsers().then(r => setUsers(r.users)).catch(() => toast(t('common.error'), 'error'))
  }, [t, toast])

  const fetchEntries = useCallback(() => {
    setLoading(true)
    const list = scope === 'platform' ? listPlatformAuditLog : listAuditLog
    list({
      page,
      limit,
      eventType: eventType !== 'all' ? eventType : undefined,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
      search: searchText || undefined,
    })
      .then(r => { setEntries(r.entries); setTotal(r.total) })
      // No hub to browse is an empty chain, not a failure to load one (#2405).
      .catch(err => { if (!(err instanceof NoActiveHubError)) toast(t('common.error'), 'error') })
      .finally(() => setLoading(false))
  }, [scope, page, eventType, dateFrom, dateTo, searchText, t, toast])

  useEffect(() => {
    fetchEntries()
  }, [fetchEntries])

  // Reset to page 1 when filters change
  useEffect(() => {
    setPage(1)
  }, [eventType, dateFrom, dateTo, searchText])

  const nameMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const u of users) {
      map.set(u.pubkey, u.name)
    }
    return map
  }, [users])

  if (!isAdmin) {
    return <div className="text-muted-foreground">{t('common.accessDenied')}</div>
  }

  const totalPages = Math.ceil(total / limit)

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <ScrollText className="h-6 w-6 text-primary" />
        <h1 data-testid="page-title" className="text-xl font-bold sm:text-2xl">{t(scope === 'platform' ? 'adminNav.items.platformAudit' : 'auditLog.title')}</h1>
      </div>

      {/* Filter bar */}
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 py-3">
          <div className="flex-1 min-w-[180px]">
            <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('common.search', { defaultValue: 'Search' })}</label>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                data-testid="audit-search"
                value={searchText}
                onChange={e => setSearchText(e.target.value)}
                placeholder={t('auditLog.searchPlaceholder', { defaultValue: 'Search actor or event...' })}
                className="h-8 pl-8 text-sm"
              />
            </div>
          </div>
          <div className="min-w-[150px]">
            <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('auditLog.eventType', { defaultValue: 'Event Type' })}</label>
            <Select value={eventType} onValueChange={setEventType}>
              <SelectTrigger data-testid="audit-event-filter" className="h-8 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EVENT_CATEGORIES.map(cat => (
                  <SelectItem key={cat.value} value={cat.value} data-testid={`audit-event-filter-option-${cat.value}`}>
                    {t(cat.labelKey, { defaultValue: cat.value === 'all' ? 'All Events' : cat.value.charAt(0).toUpperCase() + cat.value.slice(1) })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('callHistory.from', { defaultValue: 'From' })}</label>
            <Input
              type="date"
              value={dateFrom}
              onChange={e => setDateFrom(e.target.value)}
              className="h-8 text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('callHistory.to', { defaultValue: 'To' })}</label>
            <Input
              type="date"
              value={dateTo}
              onChange={e => setDateTo(e.target.value)}
              className="h-8 text-sm"
            />
          </div>
          {(searchText || eventType !== 'all' || dateFrom || dateTo) && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8"
              onClick={() => { setSearchText(''); setEventType('all'); setDateFrom(''); setDateTo('') }}
            >
              {t('common.clear', { defaultValue: 'Clear' })}
            </Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="divide-y divide-border">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4 px-6 py-3">
                  <div className="h-4 w-32 animate-pulse rounded bg-muted" />
                  <div className="h-5 w-24 animate-pulse rounded-full bg-muted" />
                  <div className="h-4 w-20 animate-pulse rounded bg-muted" />
                  <div className="h-4 w-40 animate-pulse rounded bg-muted" />
                </div>
              ))}
            </div>
          ) : entries.length === 0 ? (
            <div data-testid="empty-state" className="py-8 text-center text-muted-foreground">
              <ScrollText className="mx-auto mb-2 h-8 w-8 opacity-40" />
              {t('auditLog.noEntries')}
            </div>
          ) : (
            <div className="divide-y divide-border">
              {entries.map(entry => (
                <div key={entry.id} data-testid="audit-entry" className="flex flex-wrap items-center gap-4 px-4 py-3 sm:px-6">
                  <span className="w-full text-xs text-muted-foreground whitespace-nowrap sm:w-36 sm:shrink-0">
                    {new Date(entry.createdAt).toLocaleString()}
                  </span>
                  <Badge variant="secondary" className={getEventCategoryColor(entry.action)}>
                    {t(`auditLog.events.${entry.action}`, { defaultValue: entry.action })}
                  </Badge>
                  <ActorDisplay pubkey={entry.actorPubkey} nameMap={nameMap} />
                  <AuditDetails entry={entry} />
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page === 1}
          >
            <ChevronLeft className="h-4 w-4" />
            {t('common.back')}
          </Button>
          <span className="text-sm text-muted-foreground">{page} / {totalPages}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
          >
            {t('common.next')}
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  )
}

function ActorDisplay({ pubkey, nameMap }: { pubkey: string; nameMap: Map<string, string> }) {
  const name = nameMap.get(pubkey)

  if (pubkey === 'system') {
    return <code className="text-xs text-muted-foreground">system</code>
  }

  if (name) {
    return (
      <Link
        to="/users/$pubkey"
        params={{ pubkey }}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
      >
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 text-[10px] font-medium text-primary">
          {name.charAt(0).toUpperCase()}
        </span>
        {name}
      </Link>
    )
  }

  return <code className="text-xs text-muted-foreground">{pubkey.slice(0, 12)}...</code>
}

function AuditDetails({ entry }: { entry: AuditLogEntry }) {
  const { t } = useTranslation()
  const details = entry.details || {}

  const callerLast4 = details.callerLast4 as string | undefined
  const duration = details.duration as number | undefined

  const isCallEvent = entry.action === 'callAnswered' || entry.action === 'callEnded' || entry.action === 'callMissed'
  const isVoicemail = entry.action === 'voicemailReceived'

  if (isCallEvent) {
    return (
      <span className="flex flex-1 items-center gap-2 truncate text-xs text-muted-foreground">
        {callerLast4 && (
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
            ***{callerLast4}
          </code>
        )}
        {duration !== undefined && entry.action === 'callEnded' && (
          <span>{Math.floor(duration / 60)}:{String(duration % 60).padStart(2, '0')}</span>
        )}
      </span>
    )
  }

  if (isVoicemail) {
    return (
      <span className="flex-1 text-xs text-muted-foreground">
        {t('callHistory.hasVoicemail')}
      </span>
    )
  }

  return <span className="flex-1 text-xs text-muted-foreground">—</span>
}
