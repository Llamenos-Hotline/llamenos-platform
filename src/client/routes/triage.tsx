import { createFileRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/lib/auth'
import { useToast } from '@/lib/toast'
import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  listTriageQueue,
  updateReportConversionStatus,
  listCmsReportTypes,
  getCaseManagementEnabled,
  type Report,
  type ReportTypeDefinition,
  type ConversionStatus,
} from '@/lib/api'
import { formatRelativeTime } from '@/lib/format'
import { TriageReportContent } from '@/components/cases/triage-report-content'
import { TriageCaseCreationPanel } from '@/components/cases/triage-case-creation-panel'
import { TriageLinkedCases } from '@/components/cases/triage-linked-cases'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import {
  Inbox, Loader2, Clock,
  ChevronLeft, ChevronRight,
} from 'lucide-react'
import { Button } from '@/components/ui/button'

export const Route = createFileRoute('/triage')({
  component: TriagePage,
})

const STATUS_TABS: Array<{ key: ConversionStatus | 'all'; labelKey: string; defaultLabel: string }> = [
  { key: 'pending', labelKey: 'triage.statusPending', defaultLabel: 'Pending' },
  { key: 'in_progress', labelKey: 'triage.statusInProgress', defaultLabel: 'In Progress' },
  { key: 'completed', labelKey: 'triage.statusCompleted', defaultLabel: 'Completed' },
]

function TriagePage() {
  const { t } = useTranslation()
  const { hasPermission } = useAuth()
  const { toast } = useToast()

  // Data state
  const [reports, setReports] = useState<Report[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [reportTypes, setReportTypes] = useState<ReportTypeDefinition[]>([])
  const [cmsEnabled, setCmsEnabled] = useState<boolean | null>(null)

  // UI state
  // The open report is held as its own state rather than looked up in `reports`
  // on every render. Acting on a report changes its conversionStatus, so the
  // next queue refresh legitimately drops it from the filtered page the admin is
  // looking at — and a derived lookup turned that into the whole detail pane
  // (report content, case panel, linked cases) disappearing mid-task. Only an
  // explicit selection change clears it.
  const [selectedReport, setSelectedReport] = useState<Report | null>(null)
  const selectedId = selectedReport?.id ?? null
  const [statusTab, setStatusTab] = useState<ConversionStatus | 'all'>('pending')
  const [page, setPage] = useState(1)
  const [linkedCasesRefreshKey, setLinkedCasesRefreshKey] = useState(0)
  const pageSize = 50

  const reportTypeMap = useMemo(
    () => new Map(reportTypes.map(rt => [rt.id, rt])),
    [reportTypes],
  )

  const selectedReportType = selectedReport?.metadata.reportTypeId
    ? reportTypeMap.get(selectedReport.metadata.reportTypeId)
    : undefined

  // Permission gate
  const canAccess = hasPermission('reports:read-all') && hasPermission('cases:create')

  // Load CMS status + report types
  useEffect(() => {
    getCaseManagementEnabled()
      .then(({ enabled }) => setCmsEnabled(enabled))
      .catch(() => setCmsEnabled(false))

    listCmsReportTypes()
      .then(({ reportTypes: types }) => setReportTypes(types.filter(rt => !rt.isArchived)))
      .catch(() => {})
  }, [])

  // Fetch triage queue
  const fetchReports = useCallback(() => {
    setLoading(true)
    const params: { conversionStatus?: ConversionStatus; page?: number; limit?: number } = {
      page,
      limit: pageSize,
    }
    if (statusTab !== 'all') {
      params.conversionStatus = statusTab
    }

    listTriageQueue(params)
      .then(({ conversations, total: t }) => {
        setReports(conversations)
        setTotal(t)
        // Refresh the open report from the new page when it is still listed;
        // keep the copy we have when it is not (it just left this status tab).
        setSelectedReport(prev =>
          prev ? conversations.find(r => r.id === prev.id) ?? prev : prev)
      })
      .catch(() => toast(t('triage.loadError', { defaultValue: 'Failed to load triage queue' }), 'error'))
      .finally(() => setLoading(false))
  }, [statusTab, page, toast, t])

  useEffect(() => { fetchReports() }, [fetchReports])

  // Poll
  useEffect(() => {
    const interval = setInterval(fetchReports, 30_000)
    return () => clearInterval(interval)
  }, [fetchReports])

  const handleSelectReport = useCallback((reportId: string) => {
    setSelectedReport(reports.find(r => r.id === reportId) ?? null)
  }, [reports])

  const handleStatusChange = useCallback(async (reportId: string, newStatus: ConversionStatus) => {
    try {
      await updateReportConversionStatus(reportId, newStatus)
      setReports(prev =>
        prev.map(r => r.id === reportId
          ? { ...r, metadata: { ...r.metadata, conversionStatus: newStatus } }
          : r),
      )
      setSelectedReport(prev => prev?.id === reportId
        ? { ...prev, metadata: { ...prev.metadata, conversionStatus: newStatus } }
        : prev)
      toast(t('triage.statusUpdated', { defaultValue: 'Status updated' }))
    } catch {
      toast(t('triage.statusUpdateError', { defaultValue: 'Failed to update status' }), 'error')
    }
  }, [toast, t])

  const handleCaseCreated = useCallback(async (_recordId: string) => {
    // Bump linked cases refresh and update conversion status. The status write
    // is awaited before the queue is refetched: fired in parallel, whichever
    // request the server happened to serve first decided whether the refreshed
    // queue still listed the report, so the left-hand list showed a stale
    // status about half the time.
    setLinkedCasesRefreshKey(k => k + 1)
    if (selectedId) {
      await handleStatusChange(selectedId, 'in_progress')
    }
    fetchReports()
  }, [selectedId, handleStatusChange, fetchReports])

  const totalPages = Math.ceil(total / pageSize)

  // Not authorized
  if (!canAccess) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Inbox className="h-6 w-6 text-primary" />
          <h1 data-testid="page-title" className="text-xl font-bold sm:text-2xl">
            {t('triage.title', { defaultValue: 'Triage' })}
          </h1>
        </div>
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <Inbox className="mb-3 h-10 w-10 text-muted-foreground/40" />
            <p className="font-medium">{t('triage.noAccess', { defaultValue: 'You do not have access to the triage queue.' })}</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  // CMS not enabled
  if (cmsEnabled === false) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Inbox className="h-6 w-6 text-primary" />
          <h1 data-testid="page-title" className="text-xl font-bold sm:text-2xl">
            {t('triage.title', { defaultValue: 'Triage' })}
          </h1>
        </div>
        <Card data-testid="cms-not-enabled">
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <Inbox className="mb-3 h-10 w-10 text-muted-foreground/40" />
            <p className="font-medium">{t('cases.notEnabled', { defaultValue: 'Case management is not enabled' })}</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  // Loading CMS status
  if (cmsEnabled === null) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Inbox className="h-6 w-6 text-primary" />
          <h1 data-testid="page-title" className="text-xl font-bold sm:text-2xl">
            {t('triage.title', { defaultValue: 'Triage' })}
          </h1>
        </div>
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    )
  }

  return (
    <div data-testid="triage-queue" className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Inbox className="h-6 w-6 text-primary" />
        <h1 data-testid="page-title" className="text-xl font-bold sm:text-2xl">
          {t('triage.title', { defaultValue: 'Triage' })}
        </h1>
        <Badge variant="secondary">{total}</Badge>
      </div>

      {/* Status tabs */}
      <div className="flex gap-1">
        {STATUS_TABS.map(tab => (
          <button
            key={tab.key}
            type="button"
            data-testid={`triage-status-tab-${tab.key}`}
            onClick={() => { setStatusTab(tab.key); setPage(1); setSelectedReport(null) }}
            className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
              statusTab === tab.key
                ? 'bg-primary text-primary-foreground font-medium'
                : 'bg-muted text-muted-foreground hover:bg-muted/80'
            }`}
          >
            {t(tab.labelKey, { defaultValue: tab.defaultLabel })}
          </button>
        ))}
      </div>

      {/* Three-zone layout */}
      <div className="flex h-[calc(100vh-14rem)] gap-4">
        {/* Left: Report list sidebar */}
        <div className="w-80 shrink-0 overflow-y-auto rounded-lg border border-border bg-card">
          <div className="sticky top-0 z-10 border-b border-border bg-card p-3">
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <Inbox className="h-4 w-4" />
              {t('triage.reports', { defaultValue: 'Reports' })}
              <Badge variant="secondary" className="text-[10px]">{total}</Badge>
            </h2>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : reports.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <Inbox className="mb-2 h-8 w-8 text-muted-foreground/40" />
              <p className="text-sm">{t('triage.noReports', { defaultValue: 'No reports in triage queue' })}</p>
            </div>
          ) : (
            <>
              <div className="p-2 space-y-1.5">
                {reports.map(report => (
                  <TriageReportCard
                    key={report.id}
                    report={report}
                    reportType={report.metadata.reportTypeId ? reportTypeMap.get(report.metadata.reportTypeId) : undefined}
                    isSelected={selectedId === report.id}
                    onSelect={handleSelectReport}
                  />
                ))}
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="sticky bottom-0 border-t border-border bg-card px-3 py-2 flex items-center justify-between text-xs text-muted-foreground">
                  <span>
                    {t('cases.pageInfo', {
                      defaultValue: 'Page {{page}} of {{total}}',
                      page,
                      total: totalPages,
                    })}
                  </span>
                  <div className="flex gap-1">
                    <Button variant="ghost" size="icon-sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
                      <ChevronLeft className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon-sm" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>
                      <ChevronRight className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Right: Split content area */}
        <div className="flex flex-1 flex-col gap-4 overflow-hidden">
          {selectedReport ? (
            <>
              {/* Top right: Report content + Case creation side-by-side */}
              <div className="flex flex-1 gap-4 overflow-hidden">
                {/* Report content */}
                <div className="flex-1 overflow-y-auto rounded-lg border border-border bg-card p-4">
                  <TriageReportContent
                    report={selectedReport}
                    reportType={selectedReportType}
                  />
                </div>

                {/* Case creation panel */}
                <div className="w-80 shrink-0 overflow-y-auto">
                  <TriageCaseCreationPanel
                    reportId={selectedReport.id}
                    onCaseCreated={handleCaseCreated}
                  />

                  {/* Conversion status actions */}
                  <div className="mt-3 space-y-1.5">
                    {selectedReport.metadata.conversionStatus !== 'in_progress' && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full"
                        data-testid="triage-mark-in-progress"
                        onClick={() => handleStatusChange(selectedReport.id, 'in_progress')}
                      >
                        {t('triage.markInProgress', { defaultValue: 'Mark In Progress' })}
                      </Button>
                    )}
                    {selectedReport.metadata.conversionStatus !== 'completed' && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full"
                        data-testid="triage-mark-completed"
                        onClick={() => handleStatusChange(selectedReport.id, 'completed')}
                      >
                        {t('triage.markCompleted', { defaultValue: 'Mark Completed' })}
                      </Button>
                    )}
                  </div>
                </div>
              </div>

              {/* Bottom right: Linked cases */}
              <div className="h-48 shrink-0 overflow-y-auto rounded-lg border border-border bg-card p-4">
                <TriageLinkedCases
                  reportId={selectedReport.id}
                  refreshKey={linkedCasesRefreshKey}
                />
              </div>
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center text-muted-foreground rounded-lg border border-border bg-card">
              <Inbox className="h-10 w-10 mb-3" />
              <p>{t('triage.selectReport', { defaultValue: 'Select a report to begin triage' })}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// --- Report list card ---

function TriageReportCard({
  report,
  reportType,
  isSelected,
  onSelect,
}: {
  report: Report
  reportType: ReportTypeDefinition | undefined
  isSelected: boolean
  onSelect: (id: string) => void
}) {
  const { t } = useTranslation()
  const conversionStatus = report.metadata.conversionStatus as ConversionStatus | undefined
  const statusColors: Record<string, string> = {
    pending: '#eab308',
    in_progress: '#3b82f6',
    completed: '#22c55e',
  }

  return (
    <button
      type="button"
      data-testid="triage-report-card"
      onClick={() => onSelect(report.id)}
      className={`w-full rounded-lg border px-3 py-2.5 text-left transition-colors ${
        isSelected
          ? 'border-primary bg-primary/5 ring-1 ring-primary/20'
          : 'border-border bg-card hover:bg-accent/50'
      }`}
    >
      <div className="flex items-center gap-2">
        {conversionStatus && (
          <span
            className="inline-block h-2.5 w-2.5 rounded-full shrink-0"
            style={{ backgroundColor: statusColors[conversionStatus] ?? '#6b7280' }}
          />
        )}
        <span className="truncate text-sm font-medium text-foreground flex-1">
          {report.metadata.reportTitle || report.id.slice(0, 8)}
        </span>
        <span className="flex items-center gap-1 text-xs text-muted-foreground shrink-0">
          <Clock className="h-3 w-3" />
          {formatRelativeTime(report.createdAt, t)}
        </span>
      </div>

      <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
        {reportType && (
          <Badge
            variant="secondary"
            className="text-[10px] gap-1"
            style={{
              borderColor: reportType.color ?? undefined,
              color: reportType.color ?? undefined,
            }}
          >
            {reportType.label}
          </Badge>
        )}
        {conversionStatus && (
          <Badge
            variant="secondary"
            className="text-[10px]"
            style={{
              borderColor: statusColors[conversionStatus],
              color: statusColors[conversionStatus],
            }}
          >
            {conversionStatus.replace('_', ' ')}
          </Badge>
        )}
        {report.metadata.reportCategory && (
          <Badge variant="outline" className="text-[10px]">
            {report.metadata.reportCategory}
          </Badge>
        )}
      </div>
    </button>
  )
}
