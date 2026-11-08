import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '@/lib/toast'
import {
  getReportTypesAdmin,
  createReportType,
  updateReportType,
  archiveReportType,
} from '@/lib/api'
import type { ReportType, CustomFieldDefinition } from '@shared/types'
import { MAX_REPORT_TYPES } from '@shared/types'
import { SettingsSection } from '@/components/settings-section'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import {
  FileText, Plus, Save, Archive, Star,
} from 'lucide-react'
import { FieldDefinitionEditor, type EditableField } from './field-definition-editor'
import { DeletionConfirmed } from '@/lib/admin-deletion'

interface Props {
  expanded: boolean
  onToggle: (open: boolean) => void
  statusSummary?: string
}

export function ReportTypesSection({ expanded, onToggle, statusSummary }: Props) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [reportTypes, setReportTypes] = useState<ReportType[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Partial<ReportType> | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirmingArchive, setConfirmingArchive] = useState<ReportType | null>(null)

  const loadTypes = useCallback(() => {
    getReportTypesAdmin()
      .then(({ reportTypes: types }) => setReportTypes(types))
      .catch(() => toast(t('common.error'), 'error'))
      .finally(() => setLoading(false))
  }, [toast, t])

  useEffect(() => {
    if (expanded) loadTypes()
  }, [expanded, loadTypes])

  const handleCreate = useCallback(async () => {
    if (!editing || !editing.name?.trim()) return
    setSaving(true)
    try {
      const created = await createReportType({
        name: editing.name.trim(),
        description: editing.description?.trim(),
        icon: editing.icon?.trim() || undefined,
        fields: editing.fields || [],
        isDefault: editing.isDefault,
      })
      setReportTypes(prev => [...prev, created])
      setEditing(null)
      toast(t('reportTypes.created'), 'success')
    } catch {
      toast(t('reportTypes.createError'), 'error')
    } finally {
      setSaving(false)
    }
  }, [editing, toast, t])

  const handleUpdate = useCallback(async () => {
    if (!editing || !editing.id || !editing.name?.trim()) return
    setSaving(true)
    try {
      const updated = await updateReportType(editing.id, {
        name: editing.name.trim(),
        description: editing.description?.trim(),
        icon: editing.icon?.trim() || undefined,
        fields: editing.fields || [],
        isDefault: editing.isDefault,
      })
      setReportTypes(prev => prev.map(rt =>
        rt.id === updated.id ? updated : (updated.isDefault ? { ...rt, isDefault: false } : rt)
      ))
      setEditing(null)
      toast(t('reportTypes.updated'), 'success')
    } catch {
      toast(t('reportTypes.updateError'), 'error')
    } finally {
      setSaving(false)
    }
  }, [editing, toast, t])

  const handleSave = useCallback(() => {
    if (editing?.id) {
      handleUpdate()
    } else {
      handleCreate()
    }
  }, [editing, handleCreate, handleUpdate])

  const handleArchive = useCallback(async (id: string, confirmed: DeletionConfirmed) => {
    try {
      await archiveReportType(id, confirmed)
      loadTypes()
      toast(t('reportTypes.archiveSuccess'), 'success')
    } catch {
      toast(t('reportTypes.archiveError'), 'error')
    }
  }, [toast, t, loadTypes])

  const activeTypes = reportTypes.filter(rt => !rt.isArchived)
  const archivedTypes = reportTypes.filter(rt => rt.isArchived)

  return (
    <SettingsSection
      id="report-types"
      title={t('reportTypes.title')}
      description={t('reportTypes.description')}
      icon={<FileText className="h-5 w-5 text-muted-foreground" />}
      expanded={expanded}
      onToggle={onToggle}
      basePath="/admin/settings"
      statusSummary={statusSummary}
    >
      {loading ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : (
        <>
          {/* Active report types list */}
          {activeTypes.length === 0 && !editing ? (
            <p className="text-sm text-muted-foreground">{t('reports.noTypes')}</p>
          ) : (
            <div className="space-y-2">
              {activeTypes.map(rt => (
                <div
                  key={rt.id}
                  data-testid="report-type-row"
                  className="flex items-center gap-3 rounded-lg border border-border px-4 py-3"
                >
                  <div className="flex-1 space-y-0.5">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium">{rt.name}</p>
                      {rt.isDefault && (
                        <Badge variant="secondary" className="text-[10px] gap-1">
                          <Star className="h-2.5 w-2.5" />
                          {t('reportTypes.default')}
                        </Badge>
                      )}
                    </div>
                    {rt.description && (
                      <p className="text-xs text-muted-foreground">{rt.description}</p>
                    )}
                    <div className="flex items-center gap-2 mt-1">
                      {rt.icon && (
                        <Badge variant="outline" className="text-[10px]">{rt.icon}</Badge>
                      )}
                      <Badge variant="outline" className="text-[10px]">
                        {rt.fields.length} {t('settings.fields', { defaultValue: 'fields' })}
                      </Badge>
                    </div>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => setEditing({ ...rt })}>
                    {t('common.edit')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    data-testid="report-type-archive-btn"
                    onClick={() => setConfirmingArchive(rt)}
                    disabled={activeTypes.length <= 1}
                  >
                    <Archive className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          {/* Archived types (collapsed) */}
          {archivedTypes.length > 0 && (
            <div className="mt-4 space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                {t('reportTypes.archived')} ({archivedTypes.length})
              </p>
              {archivedTypes.map(rt => (
                <div
                  key={rt.id}
                  className="flex items-center gap-3 rounded-lg border border-border/50 bg-muted/30 px-4 py-2 opacity-60"
                >
                  <div className="flex-1">
                    <p className="text-sm">{rt.name}</p>
                  </div>
                  <Badge variant="outline" className="text-[10px]">{t('reportTypes.archived')}</Badge>
                </div>
              ))}
            </div>
          )}

          {/* Add/Edit form */}
          {editing ? (
            <div className="space-y-4 rounded-lg border border-primary/30 bg-primary/5 p-4 mt-4">
              <h4 className="text-sm font-medium">
                {editing.id ? t('reportTypes.editType') : t('reportTypes.addType')}
              </h4>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="rt-name">{t('reportTypes.name')}</Label>
                  <Input
                    id="rt-name"
                    data-testid="report-type-name-input"
                    value={editing.name || ''}
                    onChange={e => setEditing({ ...editing, name: e.target.value })}
                    placeholder={t('reportTypes.namePlaceholder')}
                    maxLength={100}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="rt-icon">{t('reportTypes.icon')}</Label>
                  <Input
                    id="rt-icon"
                    data-testid="report-type-icon-input"
                    value={editing.icon || ''}
                    onChange={e => setEditing({ ...editing, icon: e.target.value })}
                    placeholder={t('reportTypes.iconPlaceholder')}
                    maxLength={50}
                  />
                </div>
              </div>

              <div className="space-y-1">
                <Label htmlFor="rt-description">{t('reportTypes.typeDescription')}</Label>
                <Textarea
                  id="rt-description"
                  data-testid="report-type-description-input"
                  value={editing.description || ''}
                  onChange={e => setEditing({ ...editing, description: e.target.value })}
                  placeholder={t('reportTypes.descriptionPlaceholder')}
                  rows={2}
                  className="resize-y"
                />
              </div>

              <div className="flex items-center gap-2">
                <Switch
                  checked={editing.isDefault ?? false}
                  onCheckedChange={checked => setEditing({ ...editing, isDefault: checked })}
                />
                <Label className="text-sm">{t('reportTypes.default')}</Label>
                <p className="text-xs text-muted-foreground ml-2">{t('reportTypes.defaultHelp')}</p>
              </div>

              {/* Fields editor inline */}
              <FieldDefinitionEditor
                fields={(editing.fields || []).map(f => ({ ...f, order: f.order ?? 0 }) as EditableField)}
                onChange={fields => setEditing({ ...editing, fields: fields as CustomFieldDefinition[] })}
              />

              <div className="flex gap-2">
                <Button
                  data-testid="report-type-save-btn"
                  disabled={saving || !editing.name?.trim()}
                  onClick={handleSave}
                >
                  <Save className="h-4 w-4" />
                  {saving ? t('common.loading') : t('common.save')}
                </Button>
                <Button variant="outline" onClick={() => setEditing(null)}>
                  {t('common.cancel')}
                </Button>
              </div>
            </div>
          ) : (
            activeTypes.length < MAX_REPORT_TYPES && (
              <Button
                data-testid="report-type-add-btn"
                variant="outline"
                className="mt-4"
                onClick={() => setEditing({
                  fields: [],
                  isDefault: false,
                })}
              >
                <Plus className="h-4 w-4" />
                {t('reportTypes.addType')}
              </Button>
            )
          )}

          {activeTypes.length >= MAX_REPORT_TYPES && (
            <p className="text-xs text-muted-foreground mt-2">{t('reportTypes.maxTypes')}</p>
          )}
        </>
      )}

      {confirmingArchive && (
        <DeletionConfirmed.Dialog
          action="reportCategory"
          targetId={confirmingArchive.id}
          subject={confirmingArchive.name}
          open
          onOpenChange={(open) => { if (!open) setConfirmingArchive(null) }}
          onConfirmed={(confirmed) => handleArchive(confirmingArchive.id, confirmed)}
        />
      )}
    </SettingsSection>
  )
}
