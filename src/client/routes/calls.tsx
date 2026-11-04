import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/lib/auth'
import { useEffect, useState, useCallback, useMemo } from 'react'
import { getCallHistory, listUsers, type CallRecord, type User } from '@/lib/api'
import { useToast } from '@/lib/toast'
import { decryptCallRecord } from '@/lib/platform'
import * as keyManager from '@/lib/key-manager'
import { PhoneIncoming, ChevronLeft, ChevronRight, Clock, Mic, Search, X, StickyNote, Voicemail, PhoneMissed, Disc } from 'lucide-react'
import { Link } from '@tanstack/react-router'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { RecordingPlayer } from '@/components/recording-player'

/** Status filter applied to the call history list. Empty string means "All". */
type CallStatusFilter = '' | 'completed' | 'unanswered'

const STATUS_FILTERS: ReadonlyArray<{ value: CallStatusFilter; testId: string; labelKey: 'common.all' | 'callHistory.filterCompleted' | 'callHistory.filterUnanswered' }> = [
  { value: '', testId: 'call-filter-all', labelKey: 'common.all' },
  { value: 'completed', testId: 'call-filter-completed', labelKey: 'callHistory.filterCompleted' },
  { value: 'unanswered', testId: 'call-filter-unanswered', labelKey: 'callHistory.filterUnanswered' },
]

function parseStatusFilter(value: unknown): CallStatusFilter {
  return value === 'completed' || value === 'unanswered' ? value : ''
}

type CallsSearch = {
  page: number
  q: string
  dateFrom: string
  dateTo: string
  status: CallStatusFilter
}

export const Route = createFileRoute('/calls')({
  validateSearch: (search: Record<string, unknown>): CallsSearch => ({
    page: Number(search?.page ?? 1),
    q: (search?.q as string) || '',
    dateFrom: (search?.dateFrom as string) || '',
    dateTo: (search?.dateTo as string) || '',
    status: parseStatusFilter(search?.status),
  }),
  component: CallHistoryPage,
})

function CallHistoryPage() {
  const { t } = useTranslation()
  const { isAdmin, hasDeviceKey, publicKey } = useAuth()
  const { toast } = useToast()
  const navigate = useNavigate({ from: '/calls' })
  const { page, q, dateFrom, dateTo, status } = Route.useSearch()
  const [calls, setCalls] = useState<CallRecord[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [users, setUsers] = useState<User[]>([])
  // Local input state (synced to URL on submit)
  const [searchInput, setSearchInput] = useState(q)
  const [dateFromInput, setDateFromInput] = useState(dateFrom)
  const [dateToInput, setDateToInput] = useState(dateTo)
  const limit = 50

  const fetchCalls = useCallback(() => {
    setLoading(true)
    getCallHistory({
      page,
      limit,
      search: q || undefined,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
      status: status || undefined,
    })
      .then(r => { setCalls(r.calls); setTotal(r.total) })
      .catch(() => toast(t('common.error'), 'error'))
      .finally(() => setLoading(false))
  }, [page, q, dateFrom, dateTo, status])

  useEffect(() => {
    fetchCalls()
  }, [fetchCalls])

  // Decrypt encrypted call records client-side (Epic 77)
  // Uses functional state update to avoid stale closure over calls
  useEffect(() => {
    if (!hasDeviceKey || !publicKey || calls.length === 0) return
    if (!keyManager.isUnlocked()) return
    // Only run if there are undecrypted records
    const hasUndecrypted = calls.some(c => c.answeredBy === undefined && c.encryptedContent && c.adminEnvelopes?.length)
    if (!hasUndecrypted) return

    let cancelled = false
    ;(async () => {
      const decrypted = await Promise.all(calls.map(async call => {
        if (call.answeredBy !== undefined) return call
        if (!call.encryptedContent || !call.adminEnvelopes?.length) return call
        const meta = await decryptCallRecord(call.encryptedContent, call.adminEnvelopes)
        if (meta) return { ...call, answeredBy: meta.answeredBy, callerNumber: meta.callerNumber }
        return call
      }))
      if (!cancelled) setCalls(decrypted)
    })()
    return () => { cancelled = true }
  }, [calls, hasDeviceKey, publicKey])

  useEffect(() => {
    listUsers().then(r => setUsers(r.users)).catch(() => toast(t('common.error'), 'error'))
  }, [t, toast])

  const nameMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const u of users) map.set(u.pubkey, u.name)
    return map
  }, [users])

  function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    navigate({
      search: { page: 1, q: searchInput, dateFrom: dateFromInput, dateTo: dateToInput, status },
    })
  }

  function clearFilters() {
    setSearchInput('')
    setDateFromInput('')
    setDateToInput('')
    navigate({ search: { page: 1, q: '', dateFrom: '', dateTo: '', status: '' } })
  }

  function setStatusFilter(next: CallStatusFilter) {
    navigate({ search: (prev) => ({ ...prev, page: 1, status: next }) })
  }

  function setPage(newPage: number) {
    navigate({ search: (prev) => ({ ...prev, page: newPage }) })
  }

  const hasFilters = q || dateFrom || dateTo || status

  if (!isAdmin) {
    return <div className="text-muted-foreground">{t('common.accessDenied')}</div>
  }

  const totalPages = Math.ceil(total / limit)
  // The status filter is sent to the API; rows are also matched here so the list stays
  // correct against a server that does not filter by status yet.
  const visibleCalls = status ? calls.filter(c => c.status === status) : calls

  function formatDuration(seconds: number) {
    const m = Math.floor(seconds / 60)
    const s = seconds % 60
    return `${m}:${String(s).padStart(2, '0')}`
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <PhoneIncoming className="h-6 w-6 text-primary" />
        <h1 data-testid="page-title" className="text-xl font-bold sm:text-2xl">{t('callHistory.title')}</h1>
      </div>

      {/* Search and filter bar */}
      <Card>
        <CardContent className="py-3">
          <form onSubmit={handleSearch} className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex-1">
              <label className="mb-1 block text-xs text-muted-foreground">{t('common.search')}</label>
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  data-testid="call-search"
                  value={searchInput}
                  onChange={e => setSearchInput(e.target.value)}
                  placeholder={t('callHistory.searchPlaceholder')}
                  className="pl-9"
                />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">{t('callHistory.from')}</label>
              <Input
                data-testid="call-date-from"
                type="date"
                value={dateFromInput}
                onChange={e => setDateFromInput(e.target.value)}
                className="w-full sm:w-36"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">{t('callHistory.to')}</label>
              <Input
                data-testid="call-date-to"
                type="date"
                value={dateToInput}
                onChange={e => setDateToInput(e.target.value)}
                className="w-full sm:w-36"
              />
            </div>
            <div className="flex gap-2">
              <Button data-testid="call-search-btn" type="submit" size="sm" aria-label={t('a11y.searchButton')}>
                <Search className="h-4 w-4" />
              </Button>
              {hasFilters && (
                <Button data-testid="call-clear-filters" type="button" variant="ghost" size="sm" onClick={clearFilters} aria-label={t('a11y.clearFilters')}>
                  <X className="h-4 w-4" />
                </Button>
              )}
            </div>
          </form>
        </CardContent>
      </Card>

      <div data-testid="call-status-filters" role="group" className="flex flex-wrap gap-2">
        {STATUS_FILTERS.map(f => (
          <Button
            key={f.testId}
            data-testid={f.testId}
            type="button"
            size="sm"
            variant={status === f.value ? 'default' : 'outline'}
            aria-pressed={status === f.value}
            onClick={() => setStatusFilter(f.value)}
          >
            {t(f.labelKey)}
          </Button>
        ))}
      </div>

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="divide-y divide-border">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4 px-6 py-3">
                  <div className="h-4 w-28 animate-pulse rounded bg-muted" />
                  <div className="h-4 w-20 animate-pulse rounded bg-muted" />
                  <div className="h-4 w-16 animate-pulse rounded bg-muted" />
                  <div className="ml-auto h-4 w-24 animate-pulse rounded bg-muted" />
                </div>
              ))}
            </div>
          ) : visibleCalls.length === 0 ? (
            <div data-testid="empty-state" className="py-8 text-center text-muted-foreground">
              <PhoneIncoming className="mx-auto mb-2 h-8 w-8 opacity-40" />
              {hasFilters ? t('callHistory.noResults') : t('callHistory.noCalls')}
            </div>
          ) : (
            <div data-testid="call-list" className="divide-y divide-border">
              {visibleCalls.map(call => (
                <div key={call.id} data-testid="call-row" data-call-status={call.status} className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
                  <div className="min-w-0 flex-1 sm:flex-none sm:w-48">
                    {call.status === 'unanswered' ? (
                      <div className="flex items-center gap-1.5">
                        <PhoneMissed className="h-3.5 w-3.5 shrink-0 text-destructive" />
                        <span className="text-sm font-medium text-destructive">{t('callHistory.unanswered')}</span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        <PhoneIncoming className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="text-sm font-medium">
                          {call.answeredBy ? (nameMap.get(call.answeredBy) || t('users.title')) : '-'}
                        </span>
                      </div>
                    )}
                  </div>
                  {call.duration !== undefined && (
                    <Badge variant="outline" className="gap-1">
                      <Clock className="h-3 w-3" />
                      {formatDuration(call.duration)}
                    </Badge>
                  )}
                  <div className="flex items-center gap-1.5">
                    {call.hasVoicemail && (
                      <Link to="/notes" search={{ page: 1, callId: call.id, search: '' }}>
                        <Badge variant="secondary" className="gap-1 cursor-pointer hover:bg-muted">
                          <Voicemail className="h-3 w-3" />
                        </Badge>
                      </Link>
                    )}
                    {call.hasTranscription && (
                      <Link to="/notes" search={{ page: 1, callId: call.id, search: '' }}>
                        <Badge variant="secondary" className="gap-1 cursor-pointer hover:bg-muted">
                          <Mic className="h-3 w-3" />
                        </Badge>
                      </Link>
                    )}
                    {call.hasRecording && (
                      <Badge variant="secondary" className="gap-1" data-testid="recording-badge">
                        <Disc className="h-3 w-3" />
                        {t('recording.title')}
                      </Badge>
                    )}
                  </div>
                  {call.hasRecording && (
                    <RecordingPlayer callId={call.id} />
                  )}
                  <span className="flex-1 text-right text-xs text-muted-foreground">
                    {new Date(call.startedAt).toLocaleString()}
                  </span>
                  <Link
                    data-testid="call-notes-link"
                    to="/notes"
                    search={{ page: 1, callId: call.id, search: '' }}
                    className="text-xs text-primary hover:underline flex items-center gap-1"
                  >
                    <StickyNote className="h-3 w-3" />
                    {t('notes.viewNotes')}
                  </Link>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage(Math.max(1, page - 1))}
            disabled={page === 1}
          >
            <ChevronLeft className="h-4 w-4" />
            {t('common.back')}
          </Button>
          <span className="text-sm text-muted-foreground">{page} / {totalPages}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage(Math.min(totalPages, page + 1))}
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
