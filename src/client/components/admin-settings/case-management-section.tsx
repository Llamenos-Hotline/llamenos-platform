import { useState, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '@/lib/toast'
import {
  listEntityTypes,
  createEntityType,
  updateEntityType,
  deleteEntityType,
  type CreateEntityTypeBody,
} from '@/lib/api'
import type { EntityTypeDefinition, EntityFieldDefinition, EnumOption, EntityCategory } from '@shared/types'
import { ENTITY_CATEGORY_LABELS, MAX_ENTITY_TYPES } from '@shared/types'
import { SettingsSection } from '@/components/settings-section'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import {
  Briefcase,
  Plus,
  Save,
  Trash2,
  Archive,
  ChevronDown,
  ChevronUp,
} from 'lucide-react'
import { HelpTooltip } from '@/components/ui/help-tooltip'

// --- Props ---

interface Props {
  expanded: boolean
  onToggle: (open: boolean) => void
  statusSummary?: string
}

// --- Entity Type Draft (partial for create/edit forms) ---

type EntityTypeDraft = Partial<CreateEntityTypeBody> & {
  id?: string
  isArchived?: boolean
}

/** Normalize enum option items — ensures order is always set (defaults to array index) */
function normalizeEnumOptions(items: Array<EnumOption | (Omit<EnumOption, 'order'> & { order?: number })>): EnumOption[] {
  return items.map((item, i) => ({ ...item, order: item.order ?? i }))
}

// Tab names for the inline entity type editor
type EditorTab = 'general' | 'fields' | 'statuses' | 'severities' | 'contactRoles'

// --- Main Component ---

export function CaseManagementSection({ expanded, onToggle, statusSummary }: Props) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [entityTypes, setEntityTypes] = useState<EntityTypeDefinition[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<EntityTypeDraft | null>(null)
  const [activeTab, setActiveTab] = useState<EditorTab>('general')
  const [saving, setSaving] = useState(false)
  const [loadRequested, setLoadRequested] = useState(false)

  const loadEntityTypes = useCallback(() => {
    listEntityTypes()
      .then(({ entityTypes: types }) => setEntityTypes(types))
      .catch(() => toast(t('common.error'), 'error'))
      .finally(() => setLoading(false))
  }, [toast, t])

  // Load once, on first expand. Fetching from the render body fired a new
  // request on every re-render until the first one resolved.
  useEffect(() => {
    if (!expanded || loadRequested) return
    setLoadRequested(true)
    loadEntityTypes()
  }, [expanded, loadRequested, loadEntityTypes])

  const activeTypes = entityTypes.filter(et => !et.isArchived)
  const archivedTypes = entityTypes.filter(et => et.isArchived)

  const handleCreate = useCallback(async () => {
    if (!editing || !editing.name?.trim() || !editing.label?.trim() || !editing.labelPlural?.trim()) return
    if (!editing.statuses || editing.statuses.length === 0 || !editing.defaultStatus) return
    setSaving(true)
    try {
      const body: CreateEntityTypeBody = {
        name: editing.name.trim(),
        label: editing.label.trim(),
        labelPlural: editing.labelPlural.trim(),
        description: editing.description?.trim() ?? '',
        icon: editing.icon?.trim() || undefined,
        color: editing.color || undefined,
        category: editing.category || 'case',
        fields: (editing.fields || []) as EntityFieldDefinition[],
        statuses: editing.statuses,
        defaultStatus: editing.defaultStatus,
        closedStatuses: editing.closedStatuses || [],
        severities: editing.severities || undefined,
        defaultSeverity: editing.defaultSeverity || undefined,
        contactRoles: editing.contactRoles || undefined,
      }
      const created = await createEntityType(body)
      setEntityTypes(prev => [...prev, created])
      setEditing(null)
      toast(t('caseManagement.createdSuccess'), 'success')
    } catch {
      toast(t('common.error'), 'error')
    } finally {
      setSaving(false)
    }
  }, [editing, toast, t])

  const handleUpdate = useCallback(async () => {
    if (!editing?.id || !editing?.label?.trim()) return
    setSaving(true)
    try {
      const updated = await updateEntityType(editing.id, {
        label: editing.label?.trim(),
        labelPlural: editing.labelPlural?.trim(),
        description: editing.description?.trim(),
        icon: editing.icon?.trim() || undefined,
        color: editing.color || undefined,
        fields: (editing.fields || []) as EntityFieldDefinition[],
        statuses: editing.statuses,
        defaultStatus: editing.defaultStatus,
        closedStatuses: editing.closedStatuses,
        severities: editing.severities || undefined,
        defaultSeverity: editing.defaultSeverity || undefined,
        contactRoles: editing.contactRoles || undefined,
      })
      setEntityTypes(prev => prev.map(et => et.id === updated.id ? updated : et))
      setEditing(null)
      toast(t('caseManagement.updatedSuccess'), 'success')
    } catch {
      toast(t('common.error'), 'error')
    } finally {
      setSaving(false)
    }
  }, [editing, toast, t])

  const handleSave = useCallback(() => {
    if (editing?.id) handleUpdate()
    else handleCreate()
  }, [editing, handleCreate, handleUpdate])

  const handleArchive = useCallback(async (id: string) => {
    if (!confirm(t('caseManagement.archiveConfirm'))) return
    try {
      await updateEntityType(id, { isArchived: true })
      loadEntityTypes()
      toast(t('caseManagement.archivedSuccess'), 'success')
    } catch {
      toast(t('common.error'), 'error')
    }
  }, [toast, t, loadEntityTypes])

  const handleDelete = useCallback(async (id: string) => {
    if (!confirm(t('caseManagement.deleteConfirm'))) return
    try {
      await deleteEntityType(id)
      setEntityTypes(prev => prev.filter(et => et.id !== id))
      toast(t('caseManagement.deletedSuccess'), 'success')
    } catch {
      toast(t('common.error'), 'error')
    }
  }, [toast, t])

  function startCreate() {
    setEditing({
      category: 'case',
      fields: [],
      statuses: [
        { value: 'open', label: 'Open', color: '#3b82f6', order: 0 },
        { value: 'closed', label: 'Closed', color: '#6b7280', order: 1, isClosed: true },
      ],
      defaultStatus: 'open',
      closedStatuses: ['closed'],
      severities: [],
      contactRoles: [],
    })
    setActiveTab('general')
  }

  function startEdit(et: EntityTypeDefinition) {
    setEditing({
      id: et.id,
      name: et.name,
      label: et.label,
      labelPlural: et.labelPlural,
      description: et.description,
      icon: et.icon,
      color: et.color,
      category: et.category,
      fields: et.fields,
      statuses: et.statuses,
      defaultStatus: et.defaultStatus,
      closedStatuses: et.closedStatuses,
      severities: et.severities || [],
      defaultSeverity: et.defaultSeverity,
      contactRoles: et.contactRoles || [],
    })
    setActiveTab('general')
  }

  const canSave = editing &&
    editing.label?.trim() &&
    editing.labelPlural?.trim() &&
    (editing.id || editing.name?.trim()) &&
    editing.statuses &&
    editing.statuses.length > 0 &&
    editing.defaultStatus

  return (
    <SettingsSection
      id="entity-types"
      title={t('caseManagement.entityTypes')}
      description={t('caseManagement.entityTypesDescription')}
      icon={<Briefcase className="h-5 w-5 text-muted-foreground" />}
      expanded={expanded}
      onToggle={onToggle}
      basePath="/admin/case-management"
      statusSummary={statusSummary}
    >
      {/* Help tooltip */}
      <div className="flex items-center gap-2 mb-3">
        <HelpTooltip helpKey="entityTypes" side="right" />
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : (
        <>
          {/* Active entity types list */}
          {activeTypes.length === 0 && !editing ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <Briefcase className="mb-2 h-8 w-8 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">{t('caseManagement.noEntityTypes')}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('caseManagement.help.gettingStarted', { defaultValue: 'Get started by applying a template that matches your organization type, or create custom entity types.' })}
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {activeTypes.map(et => (
                <div
                  key={et.id}
                  data-testid="entity-type-row"
                  className="flex items-center gap-3 rounded-lg border border-border px-4 py-3"
                >
                  <div className="flex-1 space-y-0.5">
                    <div className="flex items-center gap-2">
                      {et.icon && <span className="text-base">{et.icon}</span>}
                      <p data-testid="entity-type-label" className="text-sm font-medium">{et.label}</p>
                      <Badge variant="outline" className="text-[10px]">
                        {ENTITY_CATEGORY_LABELS[et.category] || et.category}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                      <Badge variant="outline" className="text-[10px]">
                        {t('caseManagement.fieldCount', { count: et.fields.length })}
                      </Badge>
                      <Badge variant="outline" className="text-[10px]">
                        {t('caseManagement.statusCount', { count: et.statuses.length })}
                      </Badge>
                      {et.color && (
                        <span
                          data-testid="color-swatch"
                          className="inline-block h-3 w-3 rounded-full border border-border"
                          style={{ backgroundColor: et.color }}
                        />
                      )}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    data-testid="entity-type-edit-btn"
                    onClick={() => startEdit(et)}
                  >
                    {t('common.edit')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    data-testid="entity-type-archive-btn"
                    onClick={() => handleArchive(et.id)}
                  >
                    <Archive className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          {/* Archived types */}
          {archivedTypes.length > 0 && (
            <div data-testid="archived-section" className="mt-4 space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                {t('caseManagement.archived')} ({archivedTypes.length})
              </p>
              {archivedTypes.map(et => (
                <div
                  key={et.id}
                  className="flex items-center gap-3 rounded-lg border border-border/50 bg-muted/30 px-4 py-2 opacity-60"
                >
                  <div className="flex-1">
                    <p className="text-sm">{et.label}</p>
                  </div>
                  <Badge variant="outline" className="text-[10px]">{t('caseManagement.archived')}</Badge>
                  <Button
                    variant="ghost"
                    size="sm"
                    data-testid="entity-type-delete-btn"
                    onClick={() => handleDelete(et.id)}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          {/* Add/Edit form */}
          {editing ? (
            <div data-testid="entity-type-editor" className="space-y-4 rounded-lg border border-primary/30 bg-primary/5 p-4 mt-4">
              <h4 className="text-sm font-medium">
                {editing.id ? t('caseManagement.editEntityType') : t('caseManagement.createEntityType')}
              </h4>

              {/* Tab bar */}
              <div className="flex gap-1 border-b border-border pb-1">
                {(['general', 'fields', 'statuses', 'severities', 'contactRoles'] as EditorTab[]).map(tab => (
                  <button
                    key={tab}
                    data-testid={`entity-tab-${tab}`}
                    onClick={() => setActiveTab(tab)}
                    className={`rounded-t-md px-3 py-1.5 text-xs font-medium transition-colors ${
                      activeTab === tab
                        ? 'bg-background text-foreground border border-b-0 border-border'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {t(`caseManagement.${tab === 'contactRoles' ? 'contactRoles' : tab}`)}
                  </button>
                ))}
              </div>

              {/* General tab */}
              {activeTab === 'general' && (
                <GeneralTab editing={editing} onChange={setEditing} />
              )}

              {/* Fields tab */}
              {activeTab === 'fields' && (
                <FieldsEditor
                  fields={(editing.fields || []) as EntityFieldDefinition[]}
                  onChange={fields => setEditing({ ...editing, fields })}
                />
              )}

              {/* Statuses tab */}
              {activeTab === 'statuses' && (
                <EnumListEditor
                  items={normalizeEnumOptions(editing.statuses || [])}
                  onChange={statuses => setEditing({
                    ...editing,
                    statuses,
                    closedStatuses: statuses.filter(s => s.isClosed).map(s => s.value),
                  })}
                  defaultValue={editing.defaultStatus}
                  onDefaultChange={val => setEditing({ ...editing, defaultStatus: val })}
                  showColor
                  showClosed
                  addLabel={t('caseManagement.addStatus')}
                  itemLabel={t('caseManagement.statusLabel')}
                  testIdPrefix="status"
                />
              )}

              {/* Severities tab */}
              {activeTab === 'severities' && (
                <EnumListEditor
                  items={normalizeEnumOptions(editing.severities || [])}
                  onChange={severities => setEditing({ ...editing, severities })}
                  defaultValue={editing.defaultSeverity}
                  onDefaultChange={val => setEditing({ ...editing, defaultSeverity: val })}
                  showColor
                  addLabel={t('caseManagement.addSeverity')}
                  itemLabel={t('caseManagement.severityLabel')}
                  testIdPrefix="severity"
                />
              )}

              {/* Contact Roles tab */}
              {activeTab === 'contactRoles' && (
                <EnumListEditor
                  items={normalizeEnumOptions(editing.contactRoles || [])}
                  onChange={contactRoles => setEditing({ ...editing, contactRoles })}
                  addLabel={t('caseManagement.addContactRole')}
                  itemLabel={t('caseManagement.contactRoleLabel')}
                  testIdPrefix="contact-role"
                />
              )}

              <div className="flex gap-2 pt-2">
                <Button
                  data-testid="entity-type-save-btn"
                  disabled={saving || !canSave}
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
            activeTypes.length < MAX_ENTITY_TYPES && (
              <Button
                data-testid="entity-type-add-btn"
                variant="outline"
                className="mt-4"
                onClick={startCreate}
              >
                <Plus className="h-4 w-4" />
                {t('caseManagement.createEntityType')}
              </Button>
            )
          )}
        </>
      )}
    </SettingsSection>
  )
}

// --- General Tab ---

function GeneralTab({
  editing,
  onChange,
}: {
  editing: EntityTypeDraft
  onChange: (draft: EntityTypeDraft) => void
}) {
  const { t } = useTranslation()

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {/* Only show name for new types — immutable after creation */}
        {!editing.id && (
          <div className="space-y-1">
            <Label htmlFor="et-name">{t('caseManagement.name')}</Label>
            <Input
              id="et-name"
              data-testid="entity-type-name-input"
              value={editing.name || ''}
              onChange={e => onChange({ ...editing, name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') })}
              placeholder={t('caseManagement.namePlaceholder')}
              maxLength={100}
            />
          </div>
        )}
        <div className="space-y-1">
          <Label htmlFor="et-label">{t('caseManagement.label')}</Label>
          <Input
            id="et-label"
            data-testid="entity-type-label-input"
            value={editing.label || ''}
            onChange={e => {
              const label = e.target.value
              const updates: Partial<EntityTypeDraft> = { label }
              // Auto-generate name and plural on create
              if (!editing.id) {
                updates.name = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 100)
                updates.labelPlural = label.endsWith('s') ? label : label + 's'
              }
              onChange({ ...editing, ...updates })
            }}
            placeholder={t('caseManagement.labelPlaceholder')}
            maxLength={200}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="et-label-plural">{t('caseManagement.labelPlural')}</Label>
          <Input
            id="et-label-plural"
            data-testid="entity-type-label-plural-input"
            value={editing.labelPlural || ''}
            onChange={e => onChange({ ...editing, labelPlural: e.target.value })}
            placeholder={t('caseManagement.labelPluralPlaceholder')}
            maxLength={200}
          />
        </div>
      </div>

      <div className="space-y-1">
        <Label htmlFor="et-description">{t('caseManagement.description')}</Label>
        <Textarea
          id="et-description"
          data-testid="entity-type-description-input"
          value={editing.description || ''}
          onChange={e => onChange({ ...editing, description: e.target.value })}
          placeholder={t('caseManagement.descriptionPlaceholder')}
          rows={2}
          className="resize-y"
        />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="et-category">{t('caseManagement.category')}</Label>
          <select
            id="et-category"
            data-testid="entity-type-category-select"
            value={editing.category || 'case'}
            onChange={e => onChange({ ...editing, category: e.target.value as EntityCategory })}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {Object.entries(ENTITY_CATEGORY_LABELS).map(([key, label]) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="et-icon">{t('caseManagement.icon')}</Label>
          <Input
            id="et-icon"
            data-testid="entity-type-icon-input"
            value={editing.icon || ''}
            onChange={e => onChange({ ...editing, icon: e.target.value })}
            placeholder={t('caseManagement.iconPlaceholder')}
            maxLength={50}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="et-color">{t('caseManagement.color')}</Label>
          <div className="flex gap-2">
            <Input
              id="et-color"
              data-testid="entity-type-color-input"
              type="color"
              value={editing.color || '#3b82f6'}
              onChange={e => onChange({ ...editing, color: e.target.value })}
              className="h-9 w-12 cursor-pointer p-1"
            />
            <Input
              value={editing.color || '#3b82f6'}
              onChange={e => onChange({ ...editing, color: e.target.value })}
              placeholder="#3b82f6"
              maxLength={7}
              className="flex-1 font-mono text-xs"
            />
          </div>
        </div>
      </div>
    </div>
  )
}

// --- Fields Editor (tab for entity type's fields) ---

function FieldsEditor({
  fields,
  onChange,
}: {
  fields: EntityFieldDefinition[]
  onChange: (fields: EntityFieldDefinition[]) => void
}) {
  const { t } = useTranslation()
  const [editingField, setEditingField] = useState<Partial<EntityFieldDefinition> | null>(null)

  function handleAddField() {
    setEditingField({
      type: 'text',
      required: false,
      visibleToUsers: true,
      editableByUsers: true,
      accessLevel: 'all',
      indexable: false,
      indexType: 'none',
      hubEditable: true,
      order: fields.length,
    })
  }

  function handleSaveField() {
    if (!editingField || !editingField.label?.trim() || !editingField.name?.trim()) return

    let next: EntityFieldDefinition[]
    if (editingField.id) {
      next = fields.map(f =>
        f.id === editingField.id ? { ...f, ...editingField } as EntityFieldDefinition : f
      )
    } else {
      const newField: EntityFieldDefinition = {
        id: crypto.randomUUID(),
        name: editingField.name,
        label: editingField.label,
        type: editingField.type || 'text',
        required: editingField.required ?? false,
        options: editingField.options,
        validation: editingField.validation,
        visibleToUsers: editingField.visibleToUsers ?? true,
        editableByUsers: editingField.editableByUsers ?? true,
        accessLevel: editingField.accessLevel || 'all',
        section: editingField.section,
        helpText: editingField.helpText,
        placeholder: editingField.placeholder,
        indexable: editingField.indexable ?? false,
        indexType: editingField.indexType || 'none',
        hubEditable: editingField.hubEditable ?? true,
        order: fields.length,
      }
      next = [...fields, newField]
    }
    next.forEach((f, i) => f.order = i)
    onChange(next)
    setEditingField(null)
  }

  function handleDeleteField(id: string) {
    const next = fields.filter(f => f.id !== id)
    next.forEach((f, i) => f.order = i)
    onChange(next)
  }

  function handleReorder(index: number, direction: -1 | 1) {
    const next = [...fields]
    const swapIdx = index + direction
    ;[next[index], next[swapIdx]] = [next[swapIdx], next[index]]
    next.forEach((f, i) => f.order = i)
    onChange(next)
  }

  return (
    <div className="space-y-3">
      <h5 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {t('caseManagement.fields')}
      </h5>

      {fields.length === 0 && !editingField ? (
        <p className="text-xs text-muted-foreground">{t('caseManagement.noEntityTypes')}</p>
      ) : (
        <div className="space-y-1.5">
          {fields.map((field, index) => (
            <div
              key={field.id}
              data-testid="entity-field-row"
              className="flex items-center gap-2 rounded border border-border/50 px-3 py-2 text-sm"
            >
              <div className="flex flex-col gap-0.5">
                <Button variant="ghost" size="icon-xs" disabled={index === 0} onClick={() => handleReorder(index, -1)} aria-label={t('a11y.moveUp')}>
                  <ChevronUp className="h-3 w-3" />
                </Button>
                <Button variant="ghost" size="icon-xs" disabled={index === fields.length - 1} onClick={() => handleReorder(index, 1)} aria-label={t('a11y.moveDown')}>
                  <ChevronDown className="h-3 w-3" />
                </Button>
              </div>
              <div className="flex-1 space-y-0.5">
                <p data-testid="entity-field-label" className="font-medium text-xs">{field.label}</p>
                <div className="flex gap-1">
                  <Badge data-testid="entity-field-type" variant="outline" className="text-[9px]">{field.type}</Badge>
                  {field.required && <Badge variant="secondary" className="text-[9px]">{t('caseManagement.fieldRequired')}</Badge>}
                  {field.section && <Badge variant="outline" className="text-[9px]">{field.section}</Badge>}
                </div>
              </div>
              <Button variant="ghost" size="icon-xs" data-testid="entity-field-edit-btn" onClick={() => setEditingField({ ...field })}>
                <Save className="h-3 w-3" />
              </Button>
              <Button variant="ghost" size="icon-xs" data-testid="entity-field-delete-btn" onClick={() => handleDeleteField(field.id)}>
                <Trash2 className="h-3 w-3 text-destructive" />
              </Button>
            </div>
          ))}
        </div>
      )}

      {editingField ? (
        <div className="space-y-3 rounded border border-primary/20 bg-background p-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs">{t('caseManagement.fieldLabel')}</Label>
              <Input
                data-testid="entity-field-label-input"
                size={1}
                value={editingField.label || ''}
                onChange={e => {
                  const label = e.target.value
                  const autoName = !editingField.id
                  setEditingField({
                    ...editingField,
                    label,
                    ...(autoName ? { name: label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 50) } : {}),
                  })
                }}
                placeholder="e.g. Location"
                className="text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('caseManagement.fieldType')}</Label>
              <select
                data-testid="entity-field-type-select"
                value={editingField.type || 'text'}
                onChange={e => setEditingField({ ...editingField, type: e.target.value as EntityFieldDefinition['type'] })}
                className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="text">{t('customFields.types.text')}</option>
                <option value="number">{t('customFields.types.number')}</option>
                <option value="select">{t('customFields.types.select')}</option>
                <option value="multiselect">Multi-Select</option>
                <option value="checkbox">{t('customFields.types.checkbox')}</option>
                <option value="textarea">{t('customFields.types.textarea')}</option>
                <option value="date">Date</option>
                <option value="file">{t('customFields.types.file', { defaultValue: 'File Upload' })}</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs">{t('caseManagement.fieldSection')}</Label>
              <Input
                data-testid="entity-field-section-input"
                size={1}
                value={editingField.section || ''}
                onChange={e => setEditingField({ ...editingField, section: e.target.value })}
                placeholder="e.g. Arrest Details"
                className="text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('caseManagement.fieldAccessLevel')}</Label>
              <select
                data-testid="entity-field-access-select"
                value={editingField.accessLevel || 'all'}
                onChange={e => setEditingField({ ...editingField, accessLevel: e.target.value as EntityFieldDefinition['accessLevel'] })}
                className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="all">{t('caseManagement.summaryTier')}</option>
                <option value="assigned">{t('caseManagement.fieldsTier')}</option>
                <option value="admin">{t('caseManagement.piiTier')}</option>
              </select>
            </div>
          </div>

          <div className="flex flex-wrap gap-4">
            <div className="flex items-center gap-2">
              <Switch
                checked={editingField.required ?? false}
                onCheckedChange={checked => setEditingField({ ...editingField, required: checked })}
              />
              <Label className="text-xs">{t('caseManagement.fieldRequired')}</Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                checked={editingField.visibleToUsers ?? true}
                onCheckedChange={checked => setEditingField({ ...editingField, visibleToUsers: checked })}
              />
              <Label className="text-xs">{t('customFields.visibleToUsers')}</Label>
            </div>
          </div>

          {/* Select options */}
          {(editingField.type === 'select' || editingField.type === 'multiselect') && (
            <div className="space-y-1.5">
              <Label className="text-xs">{t('customFields.options')}</Label>
              {(editingField.options || []).map((opt, i) => (
                <div key={i} className="flex gap-1">
                  <Input
                    size={1}
                    value={opt.label}
                    onChange={e => {
                      const next = [...(editingField.options || [])]
                      const label = e.target.value
                      next[i] = { ...next[i], label, key: label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') }
                      setEditingField({ ...editingField, options: next })
                    }}
                    className="text-xs"
                    placeholder="Option label"
                  />
                  <Button variant="ghost" size="icon-xs" onClick={() => {
                    setEditingField({ ...editingField, options: (editingField.options ?? []).filter((_, j) => j !== i) })
                  }}>
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              ))}
              <Button variant="outline" size="sm" data-testid="entity-field-add-option-btn" onClick={() => {
                setEditingField({ ...editingField, options: [...(editingField.options || []), { key: '', label: '' }] })
              }}>
                <Plus className="h-3 w-3" />
                {t('customFields.addOption')}
              </Button>
            </div>
          )}

          <div className="flex gap-2">
            <Button
              size="sm"
              data-testid="entity-field-save-btn"
              disabled={!editingField.label?.trim()}
              onClick={handleSaveField}
            >
              <Save className="h-3 w-3" />
              {t('common.save')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setEditingField(null)}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="outline" size="sm" data-testid="entity-field-add-btn" onClick={handleAddField}>
          <Plus className="h-3 w-3" />
          {t('caseManagement.addField')}
        </Button>
      )}
    </div>
  )
}

// --- Enum List Editor (for statuses, severities, contact roles) ---

function EnumListEditor({
  items,
  onChange,
  defaultValue,
  onDefaultChange,
  showColor,
  showClosed,
  addLabel,
  itemLabel,
  testIdPrefix,
}: {
  items: EnumOption[]
  onChange: (items: EnumOption[]) => void
  defaultValue?: string
  onDefaultChange?: (val: string) => void
  showColor?: boolean
  showClosed?: boolean
  addLabel: string
  itemLabel: string
  testIdPrefix: string
}) {
  const { t } = useTranslation()
  const [editingItem, setEditingItem] = useState<Partial<EnumOption> | null>(null)
  const [editingIndex, setEditingIndex] = useState<number | null>(null)

  function handleAdd() {
    setEditingItem({ value: '', label: '', order: items.length, color: '#3b82f6' })
    setEditingIndex(null)
  }

  function handleEdit(index: number) {
    setEditingItem({ ...items[index] })
    setEditingIndex(index)
  }

  function handleSaveItem() {
    if (!editingItem || !editingItem.label?.trim() || !editingItem.value?.trim()) return
    const item: EnumOption = {
      value: editingItem.value.trim(),
      label: editingItem.label.trim(),
      color: editingItem.color,
      icon: editingItem.icon,
      order: editingItem.order ?? items.length,
      isClosed: editingItem.isClosed,
      isDefault: editingItem.isDefault,
    }

    let next: EnumOption[]
    if (editingIndex !== null) {
      next = items.map((it, i) => i === editingIndex ? item : it)
    } else {
      next = [...items, item]
    }
    next.forEach((it, i) => it.order = i)
    onChange(next)
    setEditingItem(null)
    setEditingIndex(null)
  }

  function handleDelete(index: number) {
    const next = items.filter((_, i) => i !== index)
    next.forEach((it, i) => it.order = i)
    onChange(next)
  }

  function handleReorder(index: number, direction: -1 | 1) {
    const next = [...items]
    const swapIdx = index + direction
    ;[next[index], next[swapIdx]] = [next[swapIdx], next[index]]
    next.forEach((it, i) => it.order = i)
    onChange(next)
  }

  return (
    <div className="space-y-3">
      {items.length === 0 && !editingItem ? (
        <p className="text-xs text-muted-foreground">{t('common.none', { defaultValue: 'None' })}</p>
      ) : (
        <div className="space-y-1.5">
          {items.map((item, index) => (
            <div
              key={`${item.value}-${index}`}
              data-testid={`${testIdPrefix}-row`}
              className="flex items-center gap-2 rounded border border-border/50 px-3 py-2 text-sm"
            >
              <div className="flex flex-col gap-0.5">
                <Button variant="ghost" size="icon-xs" disabled={index === 0} onClick={() => handleReorder(index, -1)} aria-label={t('a11y.moveUp')}>
                  <ChevronUp className="h-3 w-3" />
                </Button>
                <Button variant="ghost" size="icon-xs" disabled={index === items.length - 1} onClick={() => handleReorder(index, 1)} aria-label={t('a11y.moveDown')}>
                  <ChevronDown className="h-3 w-3" />
                </Button>
              </div>
              {showColor && item.color && (
                <span
                  data-testid="color-swatch"
                  className="inline-block h-3 w-3 rounded-full border border-border"
                  style={{ backgroundColor: item.color }}
                />
              )}
              <div className="flex-1 space-y-0.5">
                <p data-testid={`${testIdPrefix}-label`} className="font-medium text-xs">{item.label}</p>
                <div className="flex gap-1">
                  <Badge data-testid={`${testIdPrefix}-value`} variant="outline" className="text-[9px] font-mono">{item.value}</Badge>
                  {showClosed && item.isClosed && (
                    <Badge variant="secondary" className="text-[9px]">{t('caseManagement.closedStatus')}</Badge>
                  )}
                  {defaultValue === item.value && (
                    <Badge data-testid={`${testIdPrefix}-default-badge`} variant="secondary" className="text-[9px]">{t('caseManagement.defaultStatus')}</Badge>
                  )}
                </div>
              </div>
              {onDefaultChange && defaultValue !== item.value && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  data-testid={`${testIdPrefix}-set-default-btn`}
                  onClick={() => onDefaultChange(item.value)}
                  title={t('caseManagement.defaultStatus')}
                >
                  <span className="text-[9px]">Default</span>
                </Button>
              )}
              <Button variant="ghost" size="icon-xs" data-testid={`${testIdPrefix}-edit-btn`} onClick={() => handleEdit(index)}>
                <Save className="h-3 w-3" />
              </Button>
              <Button variant="ghost" size="icon-xs" data-testid={`${testIdPrefix}-delete-btn`} onClick={() => handleDelete(index)}>
                <Trash2 className="h-3 w-3 text-destructive" />
              </Button>
            </div>
          ))}
        </div>
      )}

      {editingItem ? (
        <div className="space-y-3 rounded border border-primary/20 bg-background p-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs">{itemLabel}</Label>
              <Input
                data-testid={`${testIdPrefix}-label-input`}
                size={1}
                value={editingItem.label || ''}
                onChange={e => {
                  const label = e.target.value
                  const autoValue = editingIndex === null
                  setEditingItem({
                    ...editingItem,
                    label,
                    ...(autoValue ? { value: label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') } : {}),
                  })
                }}
                className="text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Value</Label>
              <Input
                data-testid={`${testIdPrefix}-value-input`}
                size={1}
                value={editingItem.value || ''}
                onChange={e => setEditingItem({ ...editingItem, value: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '') })}
                className="text-xs font-mono"
              />
            </div>
          </div>

          <div className="flex flex-wrap gap-4">
            {showColor && (
              <div className="flex items-center gap-2">
                <Input
                  data-testid={`${testIdPrefix}-color-input`}
                  type="color"
                  value={editingItem.color || '#3b82f6'}
                  onChange={e => setEditingItem({ ...editingItem, color: e.target.value })}
                  className="h-7 w-10 cursor-pointer p-0.5"
                />
              </div>
            )}
            {showClosed && (
              <div className="flex items-center gap-2">
                <Switch
                  checked={editingItem.isClosed ?? false}
                  onCheckedChange={checked => setEditingItem({ ...editingItem, isClosed: checked })}
                />
                <Label className="text-xs">{t('caseManagement.closedStatus')}</Label>
              </div>
            )}
          </div>

          <div className="flex gap-2">
            <Button
              size="sm"
              data-testid={`${testIdPrefix}-save-btn`}
              disabled={!editingItem.label?.trim() || !editingItem.value?.trim()}
              onClick={handleSaveItem}
            >
              <Save className="h-3 w-3" />
              {t('common.save')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => { setEditingItem(null); setEditingIndex(null) }}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="outline" size="sm" data-testid={`${testIdPrefix}-add-btn`} onClick={handleAdd}>
          <Plus className="h-3 w-3" />
          {addLabel}
        </Button>
      )}
    </div>
  )
}
