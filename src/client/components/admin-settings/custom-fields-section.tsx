import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '@/lib/toast'
import { updateCustomFields, deleteCustomField } from '@/lib/api'
import { DeletionConfirmed } from '@/lib/admin-deletion'
import type { CustomFieldDefinition, CustomFieldContext } from '@shared/types'
import { MAX_CUSTOM_FIELDS, CUSTOM_FIELD_CONTEXT_LABELS } from '@shared/types'
import { SettingsSection } from '@/components/settings-section'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { StickyNote, ChevronUp, ChevronDown, Save, Trash2, Plus } from 'lucide-react'

interface Props {
  fields: CustomFieldDefinition[]
  onChange: (fields: CustomFieldDefinition[]) => void
  expanded: boolean
  onToggle: (open: boolean) => void
  statusSummary?: string
}

export function CustomFieldsSection({ fields, onChange, expanded, onToggle, statusSummary }: Props) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [editing, setEditing] = useState<Partial<CustomFieldDefinition> | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState<CustomFieldDefinition | null>(null)

  async function handleReorder(index: number, direction: -1 | 1) {
    const next = [...fields]
    const swapIdx = index + direction
    ;[next[index], next[swapIdx]] = [next[swapIdx], next[index]]
    next.forEach((f, i) => f.order = i)
    onChange(next)
    updateCustomFields(next).catch(() => toast(t('common.error'), 'error'))
  }

  async function handleDelete(fieldId: string, confirmed: DeletionConfirmed) {
    try {
      const res = await deleteCustomField(fields, fieldId, confirmed)
      onChange(res.fields)
    } catch {
      toast(t('common.error'), 'error')
    }
  }

  async function handleSave() {
    if (!editing || !editing.label?.trim() || !editing.name?.trim()) return
    setSaving(true)
    try {
      let next: CustomFieldDefinition[]
      if (editing.id) {
        next = fields.map(f =>
          f.id === editing.id ? { ...f, ...editing } as CustomFieldDefinition : f
        )
      } else {
        const newField: CustomFieldDefinition = {
          id: crypto.randomUUID(),
          name: editing.name,
          label: editing.label,
          type: editing.type || 'text',
          required: editing.required ?? false,
          options: editing.options,
          validation: editing.validation,
          visibleToUsers: editing.visibleToUsers ?? true,
          editableByUsers: editing.editableByUsers ?? true,
          context: editing.context ?? 'all',
          order: fields.length,
          createdAt: new Date().toISOString(),
        }
        next = [...fields, newField]
      }
      const res = await updateCustomFields(next)
      onChange(res.fields)
      setEditing(null)
      toast(t('common.success'), 'success')
    } catch {
      toast(t('common.error'), 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsSection
      id="custom-fields"
      title={t('customFields.title')}
      description={t('customFields.description')}
      icon={<StickyNote className="h-5 w-5 text-muted-foreground" />}
      expanded={expanded}
      onToggle={onToggle}
      basePath="/admin/settings"
      statusSummary={statusSummary}
    >
      {fields.length === 0 && !editing ? (
        <p className="text-sm text-muted-foreground">{t('customFields.noFields')}</p>
      ) : (
        <div className="space-y-2">
          {fields.map((field, index) => (
            <div key={field.id} data-testid="custom-field-row" className="flex items-center gap-2 rounded-lg border border-border px-4 py-3">
              <div className="flex flex-col gap-0.5">
                <Button variant="ghost" size="icon-xs" disabled={index === 0} onClick={() => handleReorder(index, -1)} aria-label={t('a11y.moveUp', { defaultValue: 'Move up' })}>
                  <ChevronUp className="h-3 w-3" />
                </Button>
                <Button variant="ghost" size="icon-xs" disabled={index === fields.length - 1} onClick={() => handleReorder(index, 1)} aria-label={t('a11y.moveDown', { defaultValue: 'Move down' })}>
                  <ChevronDown className="h-3 w-3" />
                </Button>
              </div>
              <div className="flex-1 space-y-0.5">
                <p className="text-sm font-medium">{field.label}</p>
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-[10px]">{t(`customFields.types.${field.type}`)}</Badge>
                  <Badge variant="outline" className="text-[10px]">{CUSTOM_FIELD_CONTEXT_LABELS[field.context as CustomFieldContext] || field.context}</Badge>
                  {field.required && <Badge variant="secondary" className="text-[10px]">{t('customFields.required')}</Badge>}
                  {!field.visibleToUsers && <Badge variant="secondary" className="text-[10px]">{t('customFields.adminOnly')}</Badge>}
                </div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setEditing({ ...field })}>
                {t('common.edit')}
              </Button>
              <Button data-testid="custom-field-delete-btn" variant="ghost" size="sm" onClick={() => setConfirmingDelete(field)}>
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </div>
          ))}
        </div>
      )}

      {/* Add/Edit field form */}
      {editing ? (
        <div className="space-y-4 rounded-lg border border-primary/30 bg-primary/5 p-4">
          <h4 className="text-sm font-medium">
            {editing.id ? t('common.edit') : t('customFields.addField')}
          </h4>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="custom-field-label">{t('customFields.fieldLabel')}</Label>
              <Input
                id="custom-field-label"
                data-testid="custom-field-label-input"
                value={editing.label || ''}
                onChange={e => {
                  const label = e.target.value
                  const autoName = !editing.id
                  setEditing({
                    ...editing,
                    label,
                    ...(autoName ? { name: label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 50) } : {}),
                  })
                }}
                placeholder="e.g. Severity Rating"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="custom-field-name">{t('customFields.fieldName')}</Label>
              <Input
                id="custom-field-name"
                data-testid="custom-field-name-input"
                value={editing.name || ''}
                onChange={e => setEditing({ ...editing, name: e.target.value })}
                placeholder="e.g. severity"
                maxLength={50}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="custom-field-type">{t('customFields.fieldType')}</Label>
              <select
                id="custom-field-type"
                data-testid="custom-field-type-select"
                value={editing.type || 'text'}
                onChange={e => setEditing({ ...editing, type: e.target.value as CustomFieldDefinition['type'] })}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="text">{t('customFields.types.text')}</option>
                <option value="number">{t('customFields.types.number')}</option>
                <option value="select">{t('customFields.types.select')}</option>
                <option value="checkbox">{t('customFields.types.checkbox')}</option>
                <option value="textarea">{t('customFields.types.textarea')}</option>
                <option value="file">{t('customFields.types.file', { defaultValue: 'File Upload' })}</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="field-context">{t('customFields.context', { defaultValue: 'Appears In' })}</Label>
              <select
                id="field-context"
                data-testid="field-context-select"
                value={editing.context || 'all'}
                onChange={e => setEditing({ ...editing, context: e.target.value as CustomFieldContext })}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {(Object.entries(CUSTOM_FIELD_CONTEXT_LABELS) as [CustomFieldContext, string][]).map(([key, label]) => (
                  <option key={key} value={key}>{label}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Switch
              checked={editing.required ?? false}
              onCheckedChange={checked => setEditing({ ...editing, required: checked })}
            />
            <Label className="text-sm">{t('customFields.required')}</Label>
          </div>

          {/* Select options */}
          {editing.type === 'select' && (
            <div className="space-y-2">
              <Label>{t('customFields.options')}</Label>
              {(editing.options || []).map((opt, i) => (
                <div key={i} className="flex gap-2">
                  <Input
                    value={opt}
                    onChange={e => {
                      const next = [...(editing.options || [])]
                      next[i] = e.target.value
                      setEditing({ ...editing, options: next })
                    }}
                  />
                  <Button variant="ghost" size="sm" onClick={() => {
                    setEditing({ ...editing, options: (editing.options ?? []).filter((_, j) => j !== i) })
                  }} aria-label={t('common.delete')}>
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              ))}
              <Button data-testid="custom-field-add-option-btn" variant="outline" size="sm" onClick={() => {
                setEditing({ ...editing, options: [...(editing.options || []), ''] })
              }}>
                <Plus className="h-3 w-3" />
                {t('customFields.addOption')}
              </Button>
            </div>
          )}

          {/* Validation */}
          {(editing.type === 'text' || editing.type === 'textarea') && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>{t('customFields.validation.minLength')}</Label>
                <Input
                  type="number"
                  value={editing.validation?.minLength ?? ''}
                  onChange={e => setEditing({
                    ...editing,
                    validation: { ...editing.validation, minLength: e.target.value ? Number(e.target.value) : undefined },
                  })}
                  min={0}
                />
              </div>
              <div className="space-y-1">
                <Label>{t('customFields.validation.maxLength')}</Label>
                <Input
                  type="number"
                  value={editing.validation?.maxLength ?? ''}
                  onChange={e => setEditing({
                    ...editing,
                    validation: { ...editing.validation, maxLength: e.target.value ? Number(e.target.value) : undefined },
                  })}
                  min={0}
                />
              </div>
            </div>
          )}
          {editing.type === 'number' && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>{t('customFields.validation.min')}</Label>
                <Input
                  type="number"
                  value={editing.validation?.min ?? ''}
                  onChange={e => setEditing({
                    ...editing,
                    validation: { ...editing.validation, min: e.target.value ? Number(e.target.value) : undefined },
                  })}
                />
              </div>
              <div className="space-y-1">
                <Label>{t('customFields.validation.max')}</Label>
                <Input
                  type="number"
                  value={editing.validation?.max ?? ''}
                  onChange={e => setEditing({
                    ...editing,
                    validation: { ...editing.validation, max: e.target.value ? Number(e.target.value) : undefined },
                  })}
                />
              </div>
            </div>
          )}

          {/* Visibility */}
          <div className="flex flex-wrap gap-4">
            <div className="flex items-center gap-2">
              <Switch
                checked={editing.visibleToUsers ?? true}
                onCheckedChange={checked => setEditing({ ...editing, visibleToUsers: checked })}
              />
              <Label className="text-sm">{t('customFields.visibleToUsers')}</Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                checked={editing.editableByUsers ?? true}
                onCheckedChange={checked => setEditing({ ...editing, editableByUsers: checked })}
              />
              <Label className="text-sm">{t('customFields.editableByUsers')}</Label>
            </div>
          </div>

          <div className="flex gap-2">
            <Button data-testid="form-save-btn" disabled={saving || !editing.label?.trim() || !editing.name?.trim()} onClick={handleSave}>
              <Save className="h-4 w-4" />
              {saving ? t('common.loading') : t('common.save')}
            </Button>
            <Button variant="outline" onClick={() => setEditing(null)}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      ) : (
        fields.length < MAX_CUSTOM_FIELDS && (
          <Button
            data-testid="custom-field-add-btn"
            variant="outline"
            onClick={() => setEditing({
              type: 'text',
              required: false,
              visibleToUsers: true,
              editableByUsers: true,
            })}
          >
            <Plus className="h-4 w-4" />
            {t('customFields.addField')}
          </Button>
        )
      )}

      {fields.length >= MAX_CUSTOM_FIELDS && (
        <p className="text-xs text-muted-foreground">{t('customFields.maxFields')}</p>
      )}

      {confirmingDelete && (
        <DeletionConfirmed.Dialog
          action="customField"
          targetId={confirmingDelete.id}
          subject={confirmingDelete.label}
          open
          onOpenChange={(open) => { if (!open) setConfirmingDelete(null) }}
          onConfirmed={(confirmed) => handleDelete(confirmingDelete.id, confirmed)}
        />
      )}
    </SettingsSection>
  )
}
