import { createFileRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/lib/auth'
import { useToast } from '@/lib/toast'
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  listRecords,
  updateRecord,
  listEntityTypes,
  listRecordContacts,
  listChildRecords,
  getRecord,
  assignRecord as apiAssignRecord,
  unassignRecord as apiUnassignRecord,
  getCaseManagementEnabled,
  getAutoAssignmentStatus,
  setAutoAssignment,
  type CaseRecord,
  type EntityTypeDefinition,
  type RecordContact,
  type EnumOption,
} from '@/lib/api'
import { formatRelativeTime } from '@/lib/format'
import { StatusPill } from '@/components/cases/status-pill'
import { SchemaForm, type SchemaFieldValues } from '@/components/cases/schema-form'
import { CreateRecordDialog } from '@/components/cases/create-record-dialog'
import { CaseTimeline } from '@/components/cases/case-timeline'
import { EvidenceTab } from '@/components/cases/evidence-tab'
import { AssignmentDialog } from '@/components/cases/assignment-dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  FolderOpen, Plus, Loader2, Clock, ArrowLeft, UserPlus, UserMinus,
  Users, FileText, MessageSquare, Link2, AlertTriangle, ToggleRight,
  ChevronLeft, ChevronRight, GitMerge, Globe, CalendarDays, Table2,
} from 'lucide-react'
import { HelpTooltip } from '@/components/ui/help-tooltip'
import { decryptMessage, encryptMessage } from '@/lib/platform'
import { useRecordFieldRecipients } from '@/lib/record-recipients'
import * as keyManager from '@/lib/key-manager'
import { EntityMergeDialog } from '@/components/entity-merge-dialog'
import { EntityCalendarView } from '@/components/entity-calendar-view'
import { EntityTimelineView } from '@/components/entity-timeline-view'
import { listEntitiesCrossHub } from '@/lib/api'

export const Route = createFileRoute('/cases')({
  component: CasesPage,
})

function CasesPage() {
  const { t } = useTranslation()
  const { hasDeviceKey, publicKey, isAdmin, hasPermission, adminDecryptionPubkey } = useAuth()
  const { toast } = useToast()

  // --- Data state ---
  const [records, setRecords] = useState<CaseRecord[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [entityTypes, setEntityTypes] = useState<EntityTypeDefinition[]>([])
  const [cmsEnabled, setCmsEnabled] = useState<boolean | null>(null)

  // --- UI state ---
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [showAssignDialog, setShowAssignDialog] = useState(false)
  const [assignDialogRecordId, setAssignDialogRecordId] = useState<string | null>(null)
  const [entityTypeFilter, setEntityTypeFilter] = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [page, setPage] = useState(1)
  const pageSize = 50
  const [autoAssign, setAutoAssign] = useState(false)
  const [autoAssignLoading, setAutoAssignLoading] = useState(false)

  // --- EP06-A4: merge, cross-hub, display type ---
  const [showMergeDialog, setShowMergeDialog] = useState(false)
  const [mergeSourceRecord, setMergeSourceRecord] = useState<CaseRecord | null>(null)
  const [crossHub, setCrossHub] = useState(false)
  const [displayType, setDisplayType] = useState<'table' | 'calendar' | 'timeline'>('table')

  const entityTypeMap = useMemo(
    () => new Map(entityTypes.map(et => [et.id, et])),
    [entityTypes],
  )

  const selectedRecord = records.find(r => r.id === selectedId)
  const selectedEntityType = selectedRecord
    ? entityTypeMap.get(selectedRecord.entityTypeId)
    : undefined

  // --- Load entity types + CMS status + auto-assignment ---
  useEffect(() => {
    getCaseManagementEnabled()
      .then(({ enabled }) => setCmsEnabled(enabled))
      .catch(() => setCmsEnabled(false))

    listEntityTypes()
      .then(({ entityTypes: types }) => setEntityTypes(types.filter(et => !et.isArchived)))
      .catch(() => {})

    getAutoAssignmentStatus()
      .then(({ enabled }) => setAutoAssign(enabled))
      .catch(() => {})
  }, [])

  // --- Fetch records ---
  const fetchRecords = useCallback(() => {
    setLoading(true)
    const params: {
      entityTypeId?: string
      statusHash?: string
      page?: number
      limit?: number
    } = { page, limit: pageSize }

    if (entityTypeFilter !== 'all') params.entityTypeId = entityTypeFilter
    if (statusFilter !== 'all') params.statusHash = statusFilter

    const fetch = crossHub
      ? listEntitiesCrossHub({ ...params, crossHub: true }).then(({ records: recs, total: tot }) => ({ records: recs as CaseRecord[], total: tot }))
      : listRecords(params)

    fetch
      .then(({ records: recs, total: tot }) => {
        setRecords(recs)
        setTotal(tot)
      })
      .catch(() => toast(t('cases.loadError', { defaultValue: 'Failed to load cases' }), 'error'))
      .finally(() => setLoading(false))
  }, [entityTypeFilter, statusFilter, page, crossHub, toast, t])

  useEffect(() => { fetchRecords() }, [fetchRecords])

  // Poll records
  useEffect(() => {
    const interval = setInterval(fetchRecords, 30_000)
    return () => clearInterval(interval)
  }, [fetchRecords])

  const handleRecordCreated = useCallback((recordId: string) => {
    fetchRecords()
    setSelectedId(recordId)
  }, [fetchRecords])

  const handleStatusChange = useCallback(async (recordId: string, newStatusValue: string) => {
    try {
      await updateRecord(recordId, { statusHash: newStatusValue })
      setRecords(prev =>
        prev.map(r => r.id === recordId ? { ...r, statusHash: newStatusValue, updatedAt: new Date().toISOString() } : r),
      )
      toast(t('cases.statusUpdated', { defaultValue: 'Status updated' }))
    } catch {
      toast(t('cases.statusUpdateError', { defaultValue: 'Failed to update status' }), 'error')
    }
  }, [toast, t])

  const handleAssignToMe = useCallback(async (recordId: string) => {
    if (!publicKey) return
    try {
      await apiAssignRecord(recordId, [publicKey])
      setRecords(prev =>
        prev.map(r => {
          if (r.id !== recordId) return r
          const assignedTo = r.assignedTo.includes(publicKey) ? r.assignedTo : [...r.assignedTo, publicKey]
          return { ...r, assignedTo, updatedAt: new Date().toISOString() }
        }),
      )
      toast(t('cases.assignedToYou', { defaultValue: 'Assigned to you' }))
    } catch {
      toast(t('cases.assignError', { defaultValue: 'Failed to assign' }), 'error')
    }
  }, [publicKey, toast, t])

  const handleUnassign = useCallback(async (recordId: string) => {
    // Find the record to determine who to unassign
    const record = records.find(r => r.id === recordId)
    if (!record) return
    // Prefer unassigning the current user; if not assigned, unassign the first assignee (admin action)
    const target = (publicKey && record.assignedTo.includes(publicKey))
      ? publicKey
      : record.assignedTo[0]
    if (!target) return
    try {
      await apiUnassignRecord(recordId, target)
      setRecords(prev =>
        prev.map(r => {
          if (r.id !== recordId) return r
          return { ...r, assignedTo: r.assignedTo.filter(pk => pk !== target), updatedAt: new Date().toISOString() }
        }),
      )
      toast(t('cases.unassigned', { defaultValue: 'Unassigned' }))
    } catch {
      toast(t('cases.unassignError', { defaultValue: 'Failed to unassign' }), 'error')
    }
  }, [publicKey, records, toast, t])

  const handleToggleAutoAssign = useCallback(async () => {
    setAutoAssignLoading(true)
    const newVal = !autoAssign
    try {
      await setAutoAssignment(newVal)
      setAutoAssign(newVal)
      toast(
        newVal
          ? t('cases.autoAssignEnabled', { defaultValue: 'Auto-assignment enabled' })
          : t('cases.autoAssignDisabled', { defaultValue: 'Auto-assignment disabled' }),
      )
    } catch {
      toast(t('cases.autoAssignError', { defaultValue: 'Failed to toggle auto-assignment' }), 'error')
    } finally {
      setAutoAssignLoading(false)
    }
  }, [autoAssign, toast, t])

  // Filter statuses come from all entity types combined, deduped
  const allStatuses = useMemo(() => {
    const map = new Map<string, EnumOption>()
    for (const et of entityTypes) {
      for (const s of et.statuses) {
        if (!map.has(s.value)) map.set(s.value, s)
      }
    }
    return Array.from(map.values())
  }, [entityTypes])

  const totalPages = Math.ceil(total / pageSize)
  const showEmptyState = !loading && records.length === 0 && entityTypeFilter === 'all' && statusFilter === 'all'

  // CMS not enabled
  if (cmsEnabled === false) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <FolderOpen className="h-6 w-6 text-primary" />
          <h1 data-testid="page-title" className="text-xl font-bold sm:text-2xl">
            {t('cases.title', { defaultValue: 'Cases' })}
          </h1>
        </div>
        <Card data-testid="cms-not-enabled">
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <FolderOpen className="mb-3 h-10 w-10 text-muted-foreground/40" />
            <p className="font-medium">{t('cases.notEnabled', { defaultValue: 'Case management is not enabled' })}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {isAdmin
                ? t('cases.enableHint', { defaultValue: 'Enable case management and apply a template in Hub Settings > Case Management.' })
                : t('cases.enableHintVolunteer', { defaultValue: 'An admin needs to enable case management for this hub.' })}
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  // Still loading CMS status
  if (cmsEnabled === null) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <FolderOpen className="h-6 w-6 text-primary" />
          <h1 data-testid="page-title" className="text-xl font-bold sm:text-2xl">
            {t('cases.title', { defaultValue: 'Cases' })}
          </h1>
        </div>
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <FolderOpen className="h-6 w-6 text-primary" />
          <h1 data-testid="page-title" className="text-xl font-bold sm:text-2xl">
            {t('cases.title', { defaultValue: 'Cases' })}
          </h1>
          <HelpTooltip helpKey="cmsToggle" side="bottom" />
        </div>
        <div className="flex items-center gap-2">
          {/* Auto-assignment toggle */}
          {isAdmin && (
            <button
              type="button"
              data-testid="auto-assignment-toggle"
              onClick={handleToggleAutoAssign}
              disabled={autoAssignLoading}
              className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                autoAssign
                  ? 'border-primary/30 bg-primary/10 text-primary'
                  : 'border-border bg-muted text-muted-foreground hover:text-foreground'
              }`}
            >
              <ToggleRight className="h-3.5 w-3.5" />
              {autoAssign
                ? t('cases.autoAssignOn', { defaultValue: 'Auto-assign on' })
                : t('cases.autoAssignOff', { defaultValue: 'Auto-assign' })}
            </button>
          )}
          {autoAssign && (
            <span data-testid="auto-assignment-indicator" className="text-xs text-primary font-medium flex items-center gap-1">
              <ToggleRight className="h-3 w-3" />
              {t('cases.autoAssignActive', { defaultValue: 'Auto-assign active' })}
            </span>
          )}
          {/* Cross-hub toggle */}
          {hasPermission('cases:read-cross-hub') && (
            <button
              type="button"
              data-testid="cross-hub-toggle"
              onClick={() => { setCrossHub(!crossHub); setPage(1) }}
              className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                crossHub
                  ? 'border-primary/30 bg-primary/10 text-primary'
                  : 'border-border bg-muted text-muted-foreground hover:text-foreground'
              }`}
            >
              <Globe className="h-3.5 w-3.5" />
              {t('cms.crossHub', { defaultValue: 'All Hubs' })}
            </button>
          )}
          {/* Display type picker */}
          <div className="flex items-center rounded-md border border-border overflow-hidden">
            {(['table', 'calendar', 'timeline'] as const).map((dt) => (
              <button
                key={dt}
                type="button"
                data-testid={`display-type-${dt}`}
                onClick={() => setDisplayType(dt)}
                className={`px-2 py-1.5 text-xs transition-colors ${
                  displayType === dt
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground hover:bg-muted/80'
                }`}
              >
                {dt === 'table' && <Table2 className="h-3.5 w-3.5" />}
                {dt === 'calendar' && <CalendarDays className="h-3.5 w-3.5" />}
                {dt === 'timeline' && <Clock className="h-3.5 w-3.5" />}
              </button>
            ))}
          </div>
          {hasPermission('cases:create') && (
            <Button size="sm" data-testid="case-new-btn" onClick={() => setShowCreateDialog(true)}>
              <Plus className="h-3.5 w-3.5" />
              {t('cases.new', { defaultValue: 'New Case' })}
            </Button>
          )}
        </div>
      </div>

      {/* Entity type tabs */}
      {entityTypes.length > 1 && (
        <div data-testid="case-type-tabs" className="flex flex-wrap gap-1">
          <button
            type="button"
            data-testid="case-tab-all"
            onClick={() => { setEntityTypeFilter('all'); setPage(1) }}
            className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
              entityTypeFilter === 'all'
                ? 'bg-primary text-primary-foreground font-medium'
                : 'bg-muted text-muted-foreground hover:bg-muted/80'
            }`}
          >
            {t('cases.allTypes', { defaultValue: 'All' })}
          </button>
          {entityTypes.map(et => (
            <button
              key={et.id}
              type="button"
              data-testid={`case-tab-${et.name}`}
              onClick={() => { setEntityTypeFilter(et.id); setPage(1) }}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors ${
                entityTypeFilter === et.id
                  ? 'bg-primary text-primary-foreground font-medium'
                  : 'bg-muted text-muted-foreground hover:bg-muted/80'
              }`}
            >
              {et.color && (
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: et.color }}
                />
              )}
              {et.label}
            </button>
          ))}
        </div>
      )}

      {showEmptyState ? (
        <Card data-testid="empty-state">
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <FolderOpen className="mb-3 h-10 w-10 text-muted-foreground/40" />
            <p className="text-muted-foreground">{t('cases.noCases', { defaultValue: 'No cases yet' })}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {entityTypes.length === 0
                ? t('cases.applyTemplateHint', { defaultValue: 'Apply a case management template to get started.' })
                : t('cases.noCasesHint', { defaultValue: 'Cases will appear here as your team creates them.' })}
            </p>
            {hasPermission('cases:create') && entityTypes.length > 0 && (
              <Button
                size="sm"
                className="mt-4"
                data-testid="case-empty-create-btn"
                onClick={() => setShowCreateDialog(true)}
              >
                <Plus className="h-3.5 w-3.5" />
                {t('cases.new', { defaultValue: 'New Case' })}
              </Button>
            )}
          </CardContent>
        </Card>
      ) : displayType === 'calendar' ? (
        <div data-testid="entity-calendar-view" className="rounded-lg border border-border bg-card overflow-y-auto max-h-[calc(100vh-14rem)]">
          <EntityCalendarView records={records} onSelectRecord={setSelectedId} />
        </div>
      ) : displayType === 'timeline' ? (
        <div data-testid="entity-timeline-view" className="rounded-lg border border-border bg-card overflow-y-auto max-h-[calc(100vh-14rem)]">
          <EntityTimelineView records={records} onSelectRecord={setSelectedId} />
        </div>
      ) : (
        <div className="flex h-[calc(100vh-14rem)] gap-4">
          {/* Cases list sidebar */}
          <div data-testid="case-list" className="w-80 shrink-0 overflow-y-auto rounded-lg border border-border bg-card">
            {/* Filters */}
            <div className="sticky top-0 z-10 border-b border-border bg-card p-3 space-y-2">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold flex items-center gap-2">
                  <FolderOpen className="h-4 w-4" />
                  {t('cases.title', { defaultValue: 'Cases' })}
                  <Badge variant="secondary" className="text-[10px]">{total}</Badge>
                </h2>
              </div>
              <div data-testid="case-filter-area" className="flex gap-2">
                <Select value={statusFilter} onValueChange={v => { setStatusFilter(v); setPage(1) }}>
                  <SelectTrigger size="sm" className="flex-1" data-testid="case-status-filter">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t('cases.allStatuses', { defaultValue: 'All statuses' })}</SelectItem>
                    {allStatuses.map(s => (
                      <SelectItem key={s.value} value={s.value}>
                        <span className="flex items-center gap-1.5">
                          <span
                            className="inline-block h-2 w-2 rounded-full"
                            style={{ backgroundColor: s.color ?? '#6b7280' }}
                          />
                          {s.label}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {loading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : records.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <FolderOpen className="mb-2 h-8 w-8 text-muted-foreground/40" />
                <p className="text-sm">{t('cases.noResults', { defaultValue: 'No matching cases' })}</p>
              </div>
            ) : (
              <>
                <div className="p-2 space-y-1.5">
                  {records.map(record => (
                    <RecordCard
                      key={record.id}
                      record={record}
                      entityType={entityTypeMap.get(record.entityTypeId)}
                      isSelected={selectedId === record.id}
                      onSelect={setSelectedId}
                      hasDeviceKey={hasDeviceKey}
                    />
                  ))}
                </div>

                {/* Pagination */}
                {totalPages > 1 && (
                  <div data-testid="case-pagination" className="sticky bottom-0 border-t border-border bg-card px-3 py-2 flex items-center justify-between text-xs text-muted-foreground">
                    <span>
                      {t('cases.pageInfo', {
                        defaultValue: 'Page {{page}} of {{total}}',
                        page,
                        total: totalPages,
                      })}
                    </span>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={page <= 1}
                        onClick={() => setPage(p => p - 1)}
                        data-testid="case-page-prev"
                      >
                        <ChevronLeft className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={page >= totalPages}
                        onClick={() => setPage(p => p + 1)}
                        data-testid="case-page-next"
                      >
                        <ChevronRight className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Record detail */}
          <div data-testid="case-detail" className="flex flex-1 flex-col rounded-lg border border-border bg-card overflow-hidden">
            {selectedRecord && selectedEntityType ? (
              <RecordDetail
                record={selectedRecord}
                entityType={selectedEntityType}
                hasPermission={hasPermission}
                publicKey={publicKey}
                hasDeviceKey={hasDeviceKey}
                adminDecryptionPubkey={adminDecryptionPubkey}
                onStatusChange={handleStatusChange}
                onAssignToMe={handleAssignToMe}
                onUnassign={handleUnassign}
                onOpenAssignDialog={(id) => { setAssignDialogRecordId(id); setShowAssignDialog(true) }}
                onMergeClick={(rec) => { setMergeSourceRecord(rec); setShowMergeDialog(true) }}
                onBack={() => setSelectedId(null)}
              />
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center text-muted-foreground">
                <FolderOpen className="h-10 w-10 mb-3" />
                <p>{t('cases.selectCase', { defaultValue: 'Select a case to view details' })}</p>
              </div>
            )}
          </div>
        </div>
      )}

      <CreateRecordDialog
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
        onCreated={handleRecordCreated}
        defaultEntityTypeId={entityTypeFilter !== 'all' ? entityTypeFilter : undefined}
      />

      {mergeSourceRecord && (
        <EntityMergeDialog
          open={showMergeDialog}
          onOpenChange={setShowMergeDialog}
          primaryRecord={mergeSourceRecord}
          onMerged={() => { setMergeSourceRecord(null); fetchRecords() }}
        />
      )}

      {assignDialogRecordId && (
        <AssignmentDialog
          open={showAssignDialog}
          onOpenChange={setShowAssignDialog}
          recordId={assignDialogRecordId}
          onAssigned={(pubkeys) => {
            setRecords(prev =>
              prev.map(r => {
                if (r.id !== assignDialogRecordId) return r
                const assignedTo = [...new Set([...r.assignedTo, ...pubkeys])]
                return { ...r, assignedTo, updatedAt: new Date().toISOString() }
              }),
            )
          }}
        />
      )}
    </div>
  )
}

// --- List card for a single record ---

function RecordCard({
  record,
  entityType,
  isSelected,
  onSelect,
  hasDeviceKey,
}: {
  record: CaseRecord
  entityType: EntityTypeDefinition | undefined
  isSelected: boolean
  onSelect: (id: string) => void
  hasDeviceKey: boolean
}) {
  const { t } = useTranslation()
  const [title, setTitle] = useState<string | null>(null)

  // Decrypt summary to extract title
  useEffect(() => {
    let cancelled = false
    const canDecrypt = hasDeviceKey && keyManager.isUnlocked()
    if (!canDecrypt || !record.encryptedSummary || !record.summaryEnvelopes?.length) return
    decryptMessage(record.encryptedSummary, record.summaryEnvelopes).then(plaintext => {
      if (cancelled || !plaintext) return
      try {
        const summary = JSON.parse(plaintext)
        if (summary.title) setTitle(summary.title)
      } catch { /* ignore parse errors */ }
    })
    return () => { cancelled = true }
  }, [record.id, record.encryptedSummary, hasDeviceKey])

  const statusDef = entityType?.statuses.find(s => s.value === record.statusHash)
  const statusColor = statusDef?.color ?? '#6b7280'
  const statusLabel = statusDef?.label ?? record.statusHash

  const severityDef = record.severityHash
    ? entityType?.severities?.find(s => s.value === record.severityHash)
    : undefined

  const relativeTime = formatRelativeTime(record.updatedAt, t)

  return (
    <button
      type="button"
      data-testid="case-card"
      onClick={() => onSelect(record.id)}
      className={`w-full rounded-lg border px-3 py-2.5 text-left transition-colors ${
        isSelected
          ? 'border-primary bg-primary/5 ring-1 ring-primary/20'
          : 'border-border bg-card hover:bg-accent/50'
      }`}
    >
      <div className="flex items-center gap-2">
        {/* Status dot */}
        <span
          className="inline-block h-2.5 w-2.5 rounded-full shrink-0"
          style={{ backgroundColor: statusColor }}
        />
        <span className="truncate text-sm font-medium text-foreground flex-1">
          {title ? `${record.caseNumber || record.id.slice(0, 8)} — ${title}` : (record.caseNumber || record.id.slice(0, 8))}
        </span>
        <span data-testid="case-card-timestamp" className="flex items-center gap-1 text-xs text-muted-foreground shrink-0">
          <Clock className="h-3 w-3" />
          {relativeTime}
        </span>
      </div>

      <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
        {/* Status badge */}
        <Badge
          data-testid="case-card-status-badge"
          variant="secondary"
          className="text-[10px] gap-1"
          style={{
            borderColor: statusColor,
            color: statusColor,
            backgroundColor: `${statusColor}15`,
          }}
        >
          <span
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: statusColor }}
          />
          {statusLabel}
        </Badge>

        {/* Severity badge */}
        {severityDef && (
          <Badge
            variant="secondary"
            className="text-[10px]"
            style={{
              borderColor: severityDef.color ?? '#6b7280',
              color: severityDef.color ?? '#6b7280',
            }}
          >
            {severityDef.label}
          </Badge>
        )}

        {/* Entity type label */}
        {entityType && (
          <Badge variant="secondary" className="text-[10px]">
            {entityType.label}
          </Badge>
        )}

        {/* Assignment indicator */}
        {record.assignedTo.length > 0 && (
          <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground">
            <Users className="h-3 w-3" />
            {record.assignedTo.length}
          </span>
        )}
      </div>
    </button>
  )
}

// --- Record detail panel ---

type DetailTab = 'details' | 'timeline' | 'contacts' | 'evidence' | 'related'

function RecordDetail({
  record,
  entityType,
  hasPermission,
  publicKey,
  hasDeviceKey,
  adminDecryptionPubkey,
  onStatusChange,
  onAssignToMe,
  onUnassign,
  onOpenAssignDialog,
  onMergeClick,
  onBack,
}: {
  record: CaseRecord
  entityType: EntityTypeDefinition
  hasPermission: (p: string) => boolean
  publicKey: string | null
  hasDeviceKey: boolean
  adminDecryptionPubkey: string
  onStatusChange: (id: string, newStatus: string) => void
  onAssignToMe: (id: string) => void
  onUnassign: (id: string) => void
  onOpenAssignDialog?: (recordId: string) => void
  onMergeClick?: (record: CaseRecord) => void
  onBack: () => void
}) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<DetailTab>('details')
  const [contacts, setContacts] = useState<RecordContact[]>([])
  const [contactsLoading, setContactsLoading] = useState(false)

  // Who may read this record's working content — the server decides, from the
  // entity type's roles, the record's assignees and each member's permissions.
  // Passing `[publicKey]` here, as this did, made every timeline comment and
  // every piece of evidence unreadable by the volunteers assigned to the case.
  const fieldRecipients = useRecordFieldRecipients(record.id)

  // Decrypt summary for title/description display
  const [decryptedSummary, setDecryptedSummary] = useState<{ title?: string; description?: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    const canDecrypt = hasDeviceKey && keyManager.isUnlocked()
    if (!canDecrypt || !record.encryptedSummary || !record.summaryEnvelopes?.length) {
      setDecryptedSummary(null)
      return
    }
    decryptMessage(record.encryptedSummary, record.summaryEnvelopes).then(plaintext => {
      if (cancelled || !plaintext) return
      try {
        setDecryptedSummary(JSON.parse(plaintext))
      } catch {
        setDecryptedSummary(null)
      }
    })
    return () => { cancelled = true }
  }, [record.id, record.encryptedSummary, hasDeviceKey])

  // Derive severity info
  const severityDef = record.severityHash
    ? entityType.severities?.find(s => s.value === record.severityHash)
    : undefined

  const isAssigned = publicKey ? record.assignedTo.includes(publicKey) : false

  // Load contacts when tab is active
  useEffect(() => {
    if (activeTab !== 'contacts') return
    setContactsLoading(true)
    listRecordContacts(record.id)
      .then(({ contacts: c }) => setContacts(c))
      .catch(() => {})
      .finally(() => setContactsLoading(false))
  }, [activeTab, record.id])

  const tabs: Array<{ key: DetailTab; label: string; icon: typeof FileText }> = [
    { key: 'details', label: t('cases.tabDetails', { defaultValue: 'Details' }), icon: FileText },
    { key: 'timeline', label: t('cases.tabTimeline', { defaultValue: 'Timeline' }), icon: Clock },
    { key: 'contacts', label: t('cases.tabContacts', { defaultValue: 'Contacts' }), icon: Users },
    { key: 'evidence', label: t('cases.tabEvidence', { defaultValue: 'Evidence' }), icon: Link2 },
    { key: 'related', label: t('cases.tabRelated', { defaultValue: 'Related' }), icon: MessageSquare },
  ]

  return (
    <>
      {/* Header */}
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
              {decryptedSummary?.title && (
                <span data-testid="case-detail-title" className="text-sm font-medium text-foreground truncate max-w-[200px]">
                  {decryptedSummary.title}
                </span>
              )}
              <StatusPill
                currentStatus={record.statusHash}
                statuses={entityType.statuses}
                onStatusChange={
                  (hasPermission('cases:update') || (hasPermission('cases:update-own') && isAssigned))
                    ? (s) => onStatusChange(record.id, s)
                    : undefined
                }
                readOnly={!hasPermission('cases:update') && !(hasPermission('cases:update-own') && isAssigned)}
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
              <Badge variant="secondary" className="text-[10px]">
                {entityType.label}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {t('cases.createdAt', {
                defaultValue: 'Created {{time}}',
                time: formatRelativeTime(record.createdAt, t),
              })}
              {record.assignedTo.length > 0 && (
                <>
                  {' '}&middot;{' '}
                  {t('cases.assignedCount', {
                    defaultValue: '{{count}} assigned',
                    count: record.assignedTo.length,
                  })}
                </>
              )}
            </p>
            {decryptedSummary?.description && (
              <p data-testid="case-detail-description" className="text-xs text-muted-foreground mt-1 line-clamp-2">
                {decryptedSummary.description}
              </p>
            )}
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-1.5 shrink-0">
            {!isAssigned && hasPermission('cases:assign') && (
              <Button
                size="sm"
                variant="outline"
                data-testid="case-assign-btn"
                onClick={() => onAssignToMe(record.id)}
              >
                <UserPlus className="h-3.5 w-3.5" />
                {t('cases.assignToMe', { defaultValue: 'Assign to me' })}
              </Button>
            )}
            {record.assignedTo.length > 0 && hasPermission('cases:assign') && (
              <Button
                size="sm"
                variant="outline"
                data-testid="case-unassign-btn"
                onClick={() => {
                  // Unassign the current user if assigned, otherwise unassign the first assignee
                  const target = isAssigned && publicKey ? publicKey : record.assignedTo[0]
                  if (target) onUnassign(record.id)
                }}
              >
                <UserMinus className="h-3.5 w-3.5" />
                {t('cases.unassign', { defaultValue: 'Unassign' })}
              </Button>
            )}
            {hasPermission('cases:assign') && (
              <Button
                size="sm"
                variant="outline"
                data-testid="case-assign-dialog-btn"
                onClick={() => onOpenAssignDialog?.(record.id)}
              >
                <Users className="h-3.5 w-3.5" />
                {t('cases.assign', { defaultValue: 'Assign' })}
              </Button>
            )}
            {hasPermission('cases:update') && onMergeClick && (
              <Button
                size="sm"
                variant="outline"
                data-testid="case-merge-btn"
                onClick={() => onMergeClick(record)}
              >
                <GitMerge className="h-3.5 w-3.5" />
                {t('cms.mergeEntity', { defaultValue: 'Merge' })}
              </Button>
            )}
          </div>
        </div>

        {/* Tabs */}
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
              {tab.key === 'contacts' && record.contactCount > 0 && (
                <Badge variant="secondary" className="text-[9px] px-1 py-0">{record.contactCount}</Badge>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto p-4">
        {activeTab === 'details' && (
          <DetailsTab
            record={record}
            entityType={entityType}
            hasPermission={hasPermission}
            isAssigned={isAssigned}
            hasDeviceKey={hasDeviceKey}
            publicKey={publicKey}
            adminDecryptionPubkey={adminDecryptionPubkey}
          />
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
        {activeTab === 'contacts' && (
          <ContactsTab
            contacts={contacts}
            loading={contactsLoading}
            entityType={entityType}
          />
        )}
        {activeTab === 'evidence' && (
          <EvidenceTab
            recordId={record.id}
            volunteerNames={{}}
            readerPubkeys={fieldRecipients}
          />
        )}
        {activeTab === 'related' && <RelatedTab record={record} />}
      </div>
    </>
  )
}

// --- Details tab: renders schema fields ---

function DetailsTab({
  record,
  entityType,
  hasPermission,
  isAssigned,
  hasDeviceKey,
  publicKey,
  adminDecryptionPubkey,
}: {
  record: CaseRecord
  entityType: EntityTypeDefinition
  hasPermission: (p: string) => boolean
  isAssigned: boolean
  hasDeviceKey: boolean
  publicKey: string | null
  adminDecryptionPubkey: string
}) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [fieldValues, setFieldValues] = useState<SchemaFieldValues>({})
  const [decrypting, setDecrypting] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Decrypt encrypted fields on load
  useEffect(() => {
    let cancelled = false
    const canDecrypt = hasDeviceKey && keyManager.isUnlocked()
    if (!canDecrypt || !record.encryptedFields || !record.fieldEnvelopes?.length) {
      setFieldValues({})
      return
    }
    setDecrypting(true)
    decryptMessage(record.encryptedFields, record.fieldEnvelopes).then(plaintext => {
      if (cancelled) return
      if (plaintext) {
        try {
          setFieldValues(JSON.parse(plaintext))
        } catch {
          setFieldValues({})
        }
      }
    }).finally(() => {
      if (!cancelled) setDecrypting(false)
    })
    return () => { cancelled = true }
  }, [record.id, record.encryptedFields, hasDeviceKey])

  // Cleanup save timeout on unmount
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current)
    }
  }, [])

  const canEdit = hasPermission('cases:update') || (hasPermission('cases:update-own') && isAssigned)

  // Debounced encrypted save
  const handleFieldChange = useCallback((newValues: SchemaFieldValues) => {
    setFieldValues(newValues)
    setSaveStatus('idle')

    if (!canEdit || !publicKey || !hasDeviceKey) return

    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current)
    saveTimeoutRef.current = setTimeout(async () => {
      setSaveStatus('saving')
      try {
        const readerPubkeys = [publicKey]
        if (adminDecryptionPubkey && adminDecryptionPubkey !== publicKey) {
          readerPubkeys.push(adminDecryptionPubkey)
        }

        const encrypted = await encryptMessage(JSON.stringify(newValues), readerPubkeys)
        await updateRecord(record.id, {
          encryptedFields: encrypted.encryptedContent,
          fieldEnvelopes: encrypted.readerEnvelopes,
        })
        setSaveStatus('saved')
        setTimeout(() => setSaveStatus(prev => prev === 'saved' ? 'idle' : prev), 2000)
      } catch {
        setSaveStatus('error')
        toast(t('cases.saveError', { defaultValue: 'Failed to save field changes' }), 'error')
      }
    }, 800)
  }, [publicKey, hasDeviceKey, adminDecryptionPubkey, canEdit, record.id, toast, t])

  if (entityType.fields.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
        <FileText className="h-8 w-8 mb-2 text-muted-foreground/40" />
        <p className="text-sm">{t('cases.noFields', { defaultValue: 'No custom fields defined for this case type.' })}</p>
      </div>
    )
  }

  if (decrypting) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div data-testid="case-details-tab">
      {saveStatus !== 'idle' && (
        <div className="mb-3 flex items-center gap-1.5 text-xs text-muted-foreground">
          {saveStatus === 'saving' && <Loader2 className="h-3 w-3 animate-spin" />}
          {saveStatus === 'saving' && t('cases.saving', { defaultValue: 'Saving...' })}
          {saveStatus === 'saved' && <span className="text-green-600">{t('cases.saved', { defaultValue: 'Saved' })}</span>}
          {saveStatus === 'error' && <span className="text-destructive">{t('cases.saveError', { defaultValue: 'Save failed' })}</span>}
        </div>
      )}
      <SchemaForm
        entityType={entityType}
        values={fieldValues}
        onChange={handleFieldChange}
        readOnly={!canEdit}
        showAccessIndicators
      />
    </div>
  )
}

// --- Contacts tab ---

function ContactsTab({
  contacts,
  loading,
  entityType,
}: {
  contacts: RecordContact[]
  loading: boolean
  entityType: EntityTypeDefinition
}) {
  const { t } = useTranslation()

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (contacts.length === 0) {
    return (
      <div data-testid="case-contacts-empty" className="flex flex-col items-center justify-center py-12 text-muted-foreground">
        <Users className="h-8 w-8 mb-2 text-muted-foreground/40" />
        <p className="text-sm">{t('cases.noContacts', { defaultValue: 'No contacts linked to this case.' })}</p>
      </div>
    )
  }

  return (
    <div data-testid="case-contacts-tab" className="space-y-2">
      {contacts.map(contact => {
        const roleDef = entityType.contactRoles?.find(r => r.value === contact.role)
        return (
          <div
            key={`${contact.recordId}-${contact.contactId}`}
            data-testid="case-contact-card"
            className="flex items-center gap-3 rounded-md border border-border px-3 py-2"
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground">
              <Users className="h-4 w-4" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{contact.contactId.slice(0, 12)}...</p>
              <p className="text-xs text-muted-foreground">
                {t('cases.addedAt', {
                  defaultValue: 'Added {{time}}',
                  time: formatRelativeTime(contact.addedAt, t),
                })}
              </p>
            </div>
            {roleDef && (
              <Badge
                variant="secondary"
                className="text-[10px]"
                style={{
                  borderColor: roleDef.color ?? undefined,
                  color: roleDef.color ?? undefined,
                }}
              >
                {roleDef.label}
              </Badge>
            )}
          </div>
        )
      })}
    </div>
  )
}

// --- Related tab: shows parent, children, and sibling records ---

function RelatedTab({ record }: { record: CaseRecord }) {
  const { t } = useTranslation()
  const [parentRecord, setParentRecord] = useState<CaseRecord | null>(null)
  const [childRecords, setChildRecords] = useState<CaseRecord[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    const tasks: Promise<void>[] = []

    if (record.parentRecordId) {
      tasks.push(
        getRecord(record.parentRecordId)
          .then(r => setParentRecord(r))
          .catch(() => setParentRecord(null)),
      )
    } else {
      setParentRecord(null)
    }

    tasks.push(
      listChildRecords(record.id)
        .then(({ records }) => setChildRecords(records))
        .catch(() => setChildRecords([])),
    )

    Promise.all(tasks).finally(() => setLoading(false))
  }, [record.id, record.parentRecordId])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const hasRelated = parentRecord || childRecords.length > 0

  if (!hasRelated) {
    return (
      <div data-testid="case-related-tab" className="flex flex-col items-center justify-center py-12 text-muted-foreground">
        <Link2 className="h-8 w-8 mb-2 text-muted-foreground/40" />
        <p className="text-sm font-medium">{t('cases.noRelated', { defaultValue: 'No related records' })}</p>
        <p className="text-xs mt-1">{t('cases.noRelatedHint', { defaultValue: 'Child and parent records will appear here.' })}</p>
      </div>
    )
  }

  return (
    <div data-testid="case-related-tab" className="space-y-4">
      {parentRecord && (
        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            {t('cases.parentRecord', { defaultValue: 'Parent Record' })}
          </h4>
          <RelatedRecordCard record={parentRecord} />
        </div>
      )}

      {childRecords.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            {t('cases.childRecords', { defaultValue: 'Child Records' })} ({childRecords.length})
          </h4>
          {childRecords.map(child => (
            <RelatedRecordCard key={child.id} record={child} />
          ))}
        </div>
      )}
    </div>
  )
}

function RelatedRecordCard({ record }: { record: CaseRecord }) {
  const { t } = useTranslation()
  return (
    <div
      data-testid="related-record-card"
      className="flex items-center gap-3 rounded-md border border-border px-3 py-2 hover:bg-accent/30 transition-colors"
    >
      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground">
        <FileText className="h-4 w-4" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">
          {record.caseNumber || record.id.slice(0, 8)}
        </p>
        <p className="text-xs text-muted-foreground">
          {t('cases.createdAt', {
            defaultValue: 'Created {{time}}',
            time: formatRelativeTime(record.createdAt, t),
          })}
        </p>
      </div>
      <Badge variant="secondary" className="text-[10px]">
        {record.statusHash.slice(0, 8)}
      </Badge>
    </div>
  )
}
