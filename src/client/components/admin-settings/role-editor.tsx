import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { PermissionPicker } from './permission-picker'
import { Save, X, Plus } from 'lucide-react'

/**
 * There is no slug field: a custom role's slug is its id, because a label typed
 * from the name is the name again in the clear (#2780).
 */
export interface RoleFormData {
  name: string
  description: string
  permissions: string[]
}

interface RoleEditorProps {
  initial: RoleFormData | null
  catalog: Record<string, { key: string; label: string }[]>
  excludeDomains?: string[]
  saving: boolean
  onSave: (data: RoleFormData) => void
  onCancel: () => void
}

export function RoleEditor({
  initial,
  catalog,
  excludeDomains,
  saving,
  onSave,
  onCancel,
}: RoleEditorProps) {
  const { t } = useTranslation()
  const [form, setForm] = useState<RoleFormData>(
    initial ?? { name: '', description: '', permissions: [] },
  )

  const isValid = form.name.trim().length > 0

  return (
    <div className="space-y-4 border rounded-md p-4 bg-muted/20">
      <div className="grid gap-3">
        <div>
          <Label htmlFor="role-name">{t('roles.name', { defaultValue: 'Name' })}</Label>
          <Input
            id="role-name"
            data-testid="role-name-input"
            value={form.name}
            onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
            maxLength={100}
            placeholder={t('roles.namePlaceholder', { defaultValue: 'e.g. Team Lead' })}
          />
        </div>

        <div>
          <Label htmlFor="role-desc">{t('roles.description', { defaultValue: 'Description' })}</Label>
          <Textarea
            id="role-desc"
            data-testid="role-description-input"
            value={form.description}
            onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
            maxLength={500}
            rows={2}
            placeholder={t('roles.descriptionPlaceholder', { defaultValue: 'Brief description of this role...' })}
          />
        </div>
      </div>

      <div>
        <Label>{t('roles.permissions', { defaultValue: 'Permissions' })}</Label>
        <div className="mt-2 max-h-[400px] overflow-y-auto">
          <PermissionPicker
            catalog={catalog}
            selected={form.permissions}
            onChange={(permissions) => setForm((prev) => ({ ...prev, permissions }))}
            excludeDomains={excludeDomains}
          />
        </div>
      </div>

      <div className="flex gap-2">
        <Button
          data-testid="role-save-btn"
          onClick={() => onSave(form)}
          disabled={saving || !isValid}
        >
          {initial ? <Save className="h-4 w-4 mr-1" /> : <Plus className="h-4 w-4 mr-1" />}
          {initial ? t('common.save', { defaultValue: 'Save' }) : t('roles.create', { defaultValue: 'Create' })}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          <X className="h-4 w-4 mr-1" />
          {t('common.cancel', { defaultValue: 'Cancel' })}
        </Button>
      </div>
    </div>
  )
}
