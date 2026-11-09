import { useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '@/lib/toast'
import {
  listRecords,
  listEntityTypes,
  updateRecord,
  getCaseManagementEnabled,
  type CaseRecord,
  type EntityTypeDefinition,
} from '@/lib/api'
import { CreateRecordDialog } from '@/components/cases/create-record-dialog'
import { CaseCard } from '@/components/cases/case-card'
import { CaseDetail } from '@/components/cases/case-detail'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Plus, Loader2 } from 'lucide-react'
import { useHubOwned } from '@/lib/hub-owned'
import { NoActiveHubNotice } from '@/components/no-active-hub-notice'

interface EntityTypeFilteredRecordListProps {
  /** Filter records to entity types with this category */
  entityCategory: 'case' | 'event' | 'incident_report' | 'custom'
  /** Icon displayed in the header and empty states */
  headerIcon: React.ReactNode
  /** Page heading */
  title: string
  /** i18n key prefix for empty state messages */
  i18nPrefix: string
  // Whether to show the calendar display toggle for date-bearing entities
  showCalendarToggle?: boolean
}

/**
 * Reusable list+detail panel that shows records filtered to a given entity category.
 * Used by both /cases and /events routes — the events route is now just this component
 * filtered to category='event'.
 */
type RecordsPage = { records: CaseRecord[]; total: number }
const EMPTY_RECORDS_PAGE: RecordsPage = { records: [], total: 0 }

export function EntityTypeFilteredRecordList({
  entityCategory,
  headerIcon,
  title,
  i18nPrefix,
}: EntityTypeFilteredRecordListProps) {
  const { t } = useTranslation()
  const { toast } = useToast()

  const [entityTypes, setEntityTypes] = useState<EntityTypeDefinition[]>([])
  const [cmsEnabled, setCmsEnabled] = useState<boolean | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showCreateDialog, setShowCreateDialog] = useState(false)

  const filteredEntityTypes = useMemo(
    () => entityTypes.filter(et => et.category === entityCategory && !et.isArchived),
    [entityTypes, entityCategory],
  )

  const entityTypeMap = useMemo(
    () => new Map(entityTypes.map(et => [et.id, et])),
    [entityTypes],
  )


  useEffect(() => {
    getCaseManagementEnabled()
      .then(({ enabled }) => setCmsEnabled(enabled))
      .catch(() => setCmsEnabled(false))

    listEntityTypes()
      .then(({ entityTypes: types }) => setEntityTypes(types.filter(et => !et.isArchived)))
      .catch(() => {})
  }, [])

  const loadRecords = useCallback((): Promise<RecordsPage> => {
    if (filteredEntityTypes.length === 0) return Promise.resolve(EMPTY_RECORDS_PAGE)
    return listRecords({ entityTypeId: filteredEntityTypes[0].id, limit: 50 })
      .then(({ records: recs, total: tot }) => ({ records: recs, total: tot }))
  }, [filteredEntityTypes])
  const { data: recordsPage, setData: setRecordsPage, noHub, loading, reload: fetchRecords } = useHubOwned(loadRecords, {
    empty: EMPTY_RECORDS_PAGE,
    onError: () => toast(t(`${i18nPrefix}.loadError`, { defaultValue: 'Failed to load records' }), 'error'),
  })
  const { records, total } = recordsPage
  const setRecords = useCallback(
    (update: (prev: CaseRecord[]) => CaseRecord[]) => setRecordsPage(prev => ({ ...prev, records: update(prev.records) })),
    [setRecordsPage],
  )

  const selectedRecord = records.find(r => r.id === selectedId)
  const selectedEntityType = selectedRecord
    ? entityTypeMap.get(selectedRecord.entityTypeId)
    : undefined

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
      toast(t('cases.statusUpdated', { defaultValue: 'Status updated' }), 'success')
    } catch {
      toast(t('cases.statusUpdateError', { defaultValue: 'Failed to update status' }), 'error')
    }
  }, [toast, t])

  if (cmsEnabled === false) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          {headerIcon}
          <h1 data-testid="page-title" className="text-xl font-bold sm:text-2xl">{title}</h1>
        </div>
        <Card data-testid="cms-not-enabled">
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            {headerIcon}
            <p className="mt-3 text-muted-foreground">
              {t(`${i18nPrefix}.cmsDisabled`, { defaultValue: 'Case management is not enabled.' })}
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (cmsEnabled === null || loading) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          {headerIcon}
          <h1 data-testid="page-title" className="text-xl font-bold sm:text-2xl">{title}</h1>
        </div>
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    )
  }

  const defaultEntityTypeId = filteredEntityTypes.length > 0 ? filteredEntityTypes[0].id : undefined
  const showEmptyState = !noHub && !loading && records.length === 0

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          {headerIcon}
          <h1 data-testid="page-title" className="text-xl font-bold sm:text-2xl">{title}</h1>
          {total > 0 && <Badge variant="secondary" className="text-xs">{total}</Badge>}
        </div>
        <Button size="sm" data-testid="case-new-btn" onClick={() => setShowCreateDialog(true)}>
          <Plus className="h-3.5 w-3.5" />
          {t(`${i18nPrefix}.newRecord`, { defaultValue: 'New' })}
        </Button>
      </div>

      {noHub ? (
        <Card>
          <CardContent>
            <NoActiveHubNotice />
          </CardContent>
        </Card>
      ) : showEmptyState ? (
        <Card data-testid="empty-state">
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            {headerIcon}
            <p className="mt-3 text-muted-foreground">
              {t(`${i18nPrefix}.noRecords`, { defaultValue: 'Nothing here yet.' })}
            </p>
            <Button size="sm" className="mt-4" data-testid="case-empty-create-btn"
              onClick={() => setShowCreateDialog(true)}>
              <Plus className="h-3.5 w-3.5" />
              {t(`${i18nPrefix}.newRecord`, { defaultValue: 'New' })}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="flex h-[calc(100vh-12rem)] gap-4">
          <div data-testid="case-list"
            className="w-80 shrink-0 space-y-1.5 overflow-y-auto rounded-lg border border-border bg-card p-2">
            {records.map(record => (
              <CaseCard
                key={record.id}
                record={record}
                entityType={entityTypeMap.get(record.entityTypeId)}
                isSelected={selectedId === record.id}
                onSelect={setSelectedId}
              />
            ))}
          </div>
          <div data-testid="case-detail"
            className="flex flex-1 flex-col rounded-lg border border-border bg-card overflow-hidden">
            {selectedRecord && selectedEntityType ? (
              <CaseDetail
                record={selectedRecord}
                entityType={selectedEntityType}
                onStatusChange={handleStatusChange}
                onBack={() => setSelectedId(null)}
              />
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center text-muted-foreground">
                {headerIcon}
                <p className="mt-3">
                  {t(`${i18nPrefix}.selectRecord`, { defaultValue: 'Select a record to view details' })}
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      <CreateRecordDialog
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
        onCreated={handleRecordCreated}
        defaultEntityTypeId={defaultEntityTypeId}
      />
    </div>
  )
}
