import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { formatRelativeTime } from '@/lib/format'
import { StatusPill } from '@/components/cases/status-pill'
import { SchemaForm, type SchemaFieldValues } from '@/components/cases/schema-form'
import { CaseTimeline } from '@/components/cases/case-timeline'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  ArrowLeft, Clock, FileText, AlertTriangle, Link2, Loader2,
  ClipboardList,
} from 'lucide-react'
import type {
  CaseRecord, EntityTypeDefinition, EventReportLink,
} from '@/lib/api'
import {
  listEventLinkedReports,
  linkReportToEvent,
  listChildRecords,
  updateRecord,
  listRecords,
} from '@/lib/api'
import { useToast } from '@/lib/toast'
import { useRecordFieldRecipients } from '@/lib/record-recipients'

type DetailTab = 'details' | 'timeline' | 'cases' | 'reports'

interface CaseDetailProps {
  record: CaseRecord
  entityType: EntityTypeDefinition
  onStatusChange: (id: string, newStatus: string) => void
  onBack: () => void
}

export function CaseDetail({ record, entityType, onStatusChange, onBack }: CaseDetailProps) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<DetailTab>('details')
  const [fieldValues] = useState<SchemaFieldValues>({})

  // Who may read this record's working content — the server decides. This was
  // `[]`, which left every timeline comment readable only by its author and
  // the platform admin, never by the volunteers assigned to the case.
  const fieldRecipients = useRecordFieldRecipients(record.id)

  const isEvent = entityType.category === 'event'

  const severityDef = record.severityHash
    ? entityType.severities?.find(s => s.value === record.severityHash)
    : undefined

  const tabs: Array<{ key: DetailTab; label: string; icon: typeof FileText }> = [
    { key: 'details', label: t('cases.tabDetails', { defaultValue: 'Details' }), icon: FileText },
    { key: 'timeline', label: t('cases.tabTimeline', { defaultValue: 'Timeline' }), icon: Clock },
    ...(isEvent ? [
      { key: 'cases' as const, label: t('events.tabCases', { defaultValue: 'Cases' }), icon: ClipboardList },
      { key: 'reports' as const, label: t('events.tabReports', { defaultValue: 'Reports' }), icon: FileText },
    ] : []),
  ]

  return (
    <>
      <div data-testid="case-detail-header" className="border-b border-border px-4 py-3">
        <div className="flex items-center gap-2 mb-2">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onBack}
            className="md:hidden shrink-0"
            data-testid="case-back-btn"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-mono text-sm font-bold text-foreground">
                {record.caseNumber || record.id.slice(0, 8)}
              </span>
              <StatusPill
                currentStatus={record.statusHash}
                statuses={entityType.statuses}
                onStatusChange={(s) => onStatusChange(record.id, s)}
              />
              {severityDef && (
                <Badge
                  variant="secondary"
                  className="gap-1 text-xs"
                  style={{
                    borderColor: severityDef.color ?? '#6b7280',
                    color: severityDef.color ?? '#6b7280',
                    backgroundColor: `${severityDef.color ?? '#6b7280'}15`,
                  }}
                >
                  <AlertTriangle className="h-3 w-3" />
                  {severityDef.label}
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {t('cases.createdAt', {
                defaultValue: 'Created {{time}}',
                time: formatRelativeTime(record.createdAt, t),
              })}
            </p>
          </div>
        </div>

        <div data-testid="case-tabs" className="flex gap-0.5 -mb-3 mt-1">
          {tabs.map(tab => (
            <button
              key={tab.key}
              type="button"
              data-testid={`case-tab-${tab.key}`}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-1.5 rounded-t-md px-3 py-2 text-xs font-medium transition-colors ${
                activeTab === tab.key
                  ? 'bg-card border border-b-0 border-border text-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent/30'
              }`}
            >
              <tab.icon className="h-3.5 w-3.5" />
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {activeTab === 'details' && (
          <div data-testid="case-details-tab">
            {entityType.fields.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <FileText className="h-8 w-8 mb-2 text-muted-foreground/40" />
                <p className="text-sm">{t('cases.noFields', { defaultValue: 'No custom fields defined.' })}</p>
              </div>
            ) : (
              <SchemaForm
                entityType={entityType}
                values={fieldValues}
                onChange={() => {}}
                readOnly
                showAccessIndicators
              />
            )}
          </div>
        )}
        {activeTab === 'timeline' && (
          <CaseTimeline
            recordId={record.id}
            volunteerNames={{}}
            readerPubkeys={fieldRecipients}
            statusLabels={Object.fromEntries(
              entityType.statuses.map(s => [s.value, { label: s.label, color: s.color ?? '#6b7280' }]),
            )}
          />
        )}
        {activeTab === 'cases' && isEvent && (
          <EventLinkedCasesTab eventId={record.id} />
        )}
        {activeTab === 'reports' && isEvent && (
          <EventLinkedReportsTab eventId={record.id} />
        )}
      </div>
    </>
  )
}

// --- Event Linked Cases Tab ---

function EventLinkedCasesTab({ eventId }: { eventId: string }) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [linkedCases, setLinkedCases] = useState<CaseRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [showLinkDialog, setShowLinkDialog] = useState(false)

  // Record-based events link cases via record parent/child — the /events API
  // operates on the separate events table, which record-based events never enter.
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await listChildRecords(eventId)
      setLinkedCases(res.records)
    } catch {
      toast(t('common.error'), 'error')
    } finally {
      setLoading(false)
    }
  }, [eventId, t, toast])

  useEffect(() => { load() }, [load])

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">
          {t('events.tabCases', { defaultValue: 'Cases' })}
        </h3>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          data-testid="event-link-case-btn"
          onClick={() => setShowLinkDialog(true)}
        >
          <Link2 className="h-3.5 w-3.5" />
          {t('events.linkCase', { defaultValue: 'Link Case' })}
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : linkedCases.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
          <ClipboardList className="h-8 w-8 mb-2 opacity-40" />
          <p className="text-sm">{t('events.noLinkedCases', { defaultValue: 'No cases linked to this event.' })}</p>
        </div>
      ) : (
        <div data-testid="event-linked-cases-list" className="space-y-2">
          {linkedCases.map(rec => (
            <Card key={rec.id} data-testid="event-linked-case-card">
              <CardContent className="flex items-center gap-3 py-3">
                <ClipboardList className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium font-mono">{rec.caseNumber || rec.id.slice(0, 8)}</p>
                  <p className="text-xs text-muted-foreground">
                    {t('cases.createdAt', {
                      defaultValue: 'Created {{time}}',
                      time: new Date(rec.createdAt).toLocaleDateString(),
                    })}
                  </p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {showLinkDialog && (
        <LinkCaseDialog
          eventId={eventId}
          open={showLinkDialog}
          onOpenChange={setShowLinkDialog}
          onLinked={() => { setShowLinkDialog(false); load() }}
        />
      )}
    </div>
  )
}

// --- Event Linked Reports Tab ---

function EventLinkedReportsTab({ eventId }: { eventId: string }) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [links, setLinks] = useState<EventReportLink[]>([])
  const [loading, setLoading] = useState(true)
  const [showLinkDialog, setShowLinkDialog] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await listEventLinkedReports(eventId)
      setLinks(res.links)
    } catch {
      toast(t('common.error'), 'error')
    } finally {
      setLoading(false)
    }
  }, [eventId, t, toast])

  useEffect(() => { load() }, [load])

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">
          {t('events.tabReports', { defaultValue: 'Reports' })}
        </h3>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          data-testid="event-link-report-btn"
          onClick={() => setShowLinkDialog(true)}
        >
          <Link2 className="h-3.5 w-3.5" />
          {t('events.linkReport', { defaultValue: 'Link Report' })}
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : links.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
          <FileText className="h-8 w-8 mb-2 opacity-40" />
          <p className="text-sm">{t('events.noLinkedReports', { defaultValue: 'No reports linked to this event.' })}</p>
        </div>
      ) : (
        <div data-testid="event-linked-reports-list" className="space-y-2">
          {links.map(link => (
            <Card key={link.reportId} data-testid="event-linked-report-item">
              <CardContent className="flex items-center gap-3 py-3">
                <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium font-mono">{link.reportId.slice(0, 8)}</p>
                  <p className="text-xs text-muted-foreground">
                    {t('cases.createdAt', {
                      defaultValue: 'Created {{time}}',
                      time: new Date(link.linkedAt).toLocaleDateString(),
                    })}
                  </p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {showLinkDialog && (
        <LinkReportDialog
          eventId={eventId}
          open={showLinkDialog}
          onOpenChange={setShowLinkDialog}
          onLinked={() => { setShowLinkDialog(false); load() }}
        />
      )}
    </div>
  )
}

// --- Link Case Dialog ---

function LinkCaseDialog({ eventId, open, onOpenChange, onLinked }: {
  eventId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onLinked: () => void
}) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [search, setSearch] = useState('')
  const [results, setResults] = useState<CaseRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [linking, setLinking] = useState(false)

  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(async () => {
      setLoading(true)
      try {
        const res = await listRecords({ limit: 20 })
        if (!cancelled) setResults(res.records)
      } catch {
        // ignore
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, 300)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [search])

  async function handleSelect(recordId: string) {
    setLinking(true)
    try {
      await updateRecord(recordId, { parentRecordId: eventId })
      toast(t('common.saved', { defaultValue: 'Saved' }), 'success')
      onLinked()
    } catch {
      toast(t('common.error'), 'error')
    } finally {
      setLinking(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('events.linkCaseTitle', { defaultValue: 'Link Case to Event' })}</DialogTitle>
          <DialogDescription>
            {t('events.searchCases', { defaultValue: 'Search cases...' })}
          </DialogDescription>
        </DialogHeader>
        <Input
          data-testid="event-link-case-search"
          placeholder={t('events.searchCases', { defaultValue: 'Search cases...' })}
          value={search}
          onChange={e => setSearch(e.target.value)}
          autoFocus
        />
        <div className="max-h-60 overflow-y-auto space-y-1">
          {loading ? (
            <div className="flex justify-center py-4">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : results.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              {t('common.noResults', { defaultValue: 'No results' })}
            </p>
          ) : (
            results.map(rec => (
              <button
                key={rec.id}
                type="button"
                data-testid="event-link-case-result"
                disabled={linking}
                onClick={() => handleSelect(rec.id)}
                className="w-full flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-accent transition-colors"
              >
                <ClipboardList className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="font-mono">{rec.caseNumber || rec.id.slice(0, 8)}</span>
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

// --- Link Report Dialog ---

function LinkReportDialog({ eventId, open, onOpenChange, onLinked }: {
  eventId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onLinked: () => void
}) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [search, setSearch] = useState('')
  const [results, setResults] = useState<Array<{ id: string; reportTitle?: string }>>([])
  const [loading, setLoading] = useState(false)
  const [linking, setLinking] = useState(false)

  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(async () => {
      setLoading(true)
      try {
        const { listReports } = await import('@/lib/api')
        const res = await listReports()
        if (!cancelled) setResults(res.conversations.map(r => ({
          id: r.id,
          reportTitle: r.metadata?.reportTitle,
        })))
      } catch {
        // ignore
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, 300)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [search])

  async function handleSelect(reportId: string) {
    setLinking(true)
    try {
      await linkReportToEvent(eventId, reportId)
      toast(t('common.saved', { defaultValue: 'Saved' }), 'success')
      onLinked()
    } catch {
      toast(t('common.error'), 'error')
    } finally {
      setLinking(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('events.linkReportTitle', { defaultValue: 'Link Report to Event' })}</DialogTitle>
          <DialogDescription>
            {t('events.searchReports', { defaultValue: 'Search reports...' })}
          </DialogDescription>
        </DialogHeader>
        <Input
          data-testid="event-link-report-search"
          placeholder={t('events.searchReports', { defaultValue: 'Search reports...' })}
          value={search}
          onChange={e => setSearch(e.target.value)}
          autoFocus
        />
        <div className="max-h-60 overflow-y-auto space-y-1">
          {loading ? (
            <div className="flex justify-center py-4">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : results.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              {t('common.noResults', { defaultValue: 'No results' })}
            </p>
          ) : (
            results.map(report => (
              <button
                key={report.id}
                type="button"
                data-testid="event-link-report-result"
                disabled={linking}
                onClick={() => handleSelect(report.id)}
                className="w-full flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-accent transition-colors"
              >
                <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                <span>{report.reportTitle || report.id.slice(0, 8)}</span>
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
