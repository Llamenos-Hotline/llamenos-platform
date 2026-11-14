import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '@/lib/toast'
import { useAuth } from '@/lib/auth'
import {
  listHubRoles,
  createHubRole,
  updateHubRole,
  deleteHubRole,
  getPermissionsCatalog,
} from '@/lib/api'
import { readableRoles, sealHubRoleField, type ReadableRole } from '@/lib/role-vocabulary'
import { SettingsSection } from '@/components/settings-section'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import {
  ShieldCheck,
  Lock,
  Pencil,
  Trash2,
  Plus,
  Save,
  X,
  ChevronDown,
  ChevronRight,
} from 'lucide-react'
import { cn } from '@/lib/utils'

interface Props {
  expanded: boolean
  onToggle: (open: boolean) => void
  statusSummary?: string
}

interface PermissionCatalog {
  permissions: Record<string, string>
  byDomain: Record<string, { key: string; label: string }[]>
}

interface RoleFormData {
  name: string
  description: string
  permissions: string[]
}

const EMPTY_FORM: RoleFormData = { name: '', description: '', permissions: [] }

/**
 * The roles the active hub offers, and the editor for the ones it owns.
 *
 * A hub's own role is sealed under the hub key before it leaves this device —
 * its name and description never reach the server in the clear, and it has no
 * name-derived slug (#2780). The deployment-wide roles listed beside them (the
 * seeded defaults, platform roles) are shown here but edited only from the
 * platform settings: a change to one reaches every hub, which is not this
 * hub's to make.
 */
export function RolesSection({ expanded, onToggle, statusSummary }: Props) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const { hasPermission } = useAuth()
  const canManageRoles = hasPermission('system:manage-roles')

  const [roles, setRoles] = useState<ReadableRole[]>([])
  const [catalog, setCatalog] = useState<PermissionCatalog | null>(null)
  const [loading, setLoading] = useState(true)

  // Editing state: role ID being edited, or 'new' for create mode
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<RoleFormData>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<ReadableRole | null>(null)

  // Expanded permission domains in the editor
  const [expandedDomains, setExpandedDomains] = useState<Set<string>>(new Set())

  const loadData = useCallback(async () => {
    try {
      const [rolesRes, catalogRes] = await Promise.all([
        listHubRoles(),
        getPermissionsCatalog(),
      ])
      setRoles(await readableRoles(rolesRes.roles))
      setCatalog(catalogRes)
    } catch {
      toast(t('common.error', { defaultValue: 'Error' }), 'error')
    } finally {
      setLoading(false)
    }
  }, [t, toast])

  useEffect(() => {
    loadData()
  }, [loadData])

  function startCreate() {
    setEditingId('new')
    setForm(EMPTY_FORM)
    setExpandedDomains(new Set())
  }

  function startEdit(role: ReadableRole) {
    setEditingId(role.id)
    setForm({
      name: role.readable ? role.displayName : '',
      description: role.displayDescription,
      permissions: [...role.permissions],
    })
    // Expand domains that have selected permissions
    if (catalog) {
      const domainsWithSelections = new Set<string>()
      for (const [domain, perms] of Object.entries(catalog.byDomain)) {
        if (perms.some(p => role.permissions.includes(p.key))) {
          domainsWithSelections.add(domain)
        }
      }
      setExpandedDomains(domainsWithSelections)
    }
  }

  function cancelEdit() {
    setEditingId(null)
    setForm(EMPTY_FORM)
    setExpandedDomains(new Set())
  }

  function togglePermission(key: string) {
    setForm(prev => ({
      ...prev,
      permissions: prev.permissions.includes(key)
        ? prev.permissions.filter(p => p !== key)
        : [...prev.permissions, key],
    }))
  }

  function toggleDomainAll(domain: string) {
    if (!catalog) return
    const domainPerms = catalog.byDomain[domain]
    if (!domainPerms) return
    const domainKeys = domainPerms.map(p => p.key)
    const allSelected = domainKeys.every(k => form.permissions.includes(k))

    setForm(prev => {
      if (allSelected) {
        return { ...prev, permissions: prev.permissions.filter(p => !domainKeys.includes(p)) }
      } else {
        const existing = new Set(prev.permissions)
        domainKeys.forEach(k => existing.add(k))
        return { ...prev, permissions: Array.from(existing) }
      }
    })
  }

  function toggleDomainExpanded(domain: string) {
    setExpandedDomains(prev => {
      const next = new Set(prev)
      if (next.has(domain)) next.delete(domain)
      else next.add(domain)
      return next
    })
  }

  async function handleSave() {
    const name = form.name.trim()
    const description = form.description.trim()
    if (!name) return
    setSaving(true)
    try {
      const encryptedName = await sealHubRoleField(name)
      if (editingId === 'new') {
        const created = await createHubRole({
          permissions: form.permissions,
          encryptedName,
          ...(description ? { encryptedDescription: await sealHubRoleField(description) } : {}),
        })
        const [readable] = await readableRoles([created])
        setRoles(prev => [...prev, readable])
        toast(t('common.success', { defaultValue: 'Success' }), 'success')
      } else if (editingId) {
        const updated = await updateHubRole(editingId, {
          permissions: form.permissions,
          encryptedName,
          encryptedDescription: description ? await sealHubRoleField(description) : null,
        })
        const [readable] = await readableRoles([updated])
        setRoles(prev => prev.map(r => r.id === editingId ? readable : r))
        toast(t('common.success', { defaultValue: 'Success' }), 'success')
      }
      cancelEdit()
    } catch {
      toast(t('common.error', { defaultValue: 'Error' }), 'error')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return
    try {
      await deleteHubRole(deleteTarget.id)
      setRoles(prev => prev.filter(r => r.id !== deleteTarget.id))
        toast(t('common.success', { defaultValue: 'Success' }), 'success')
      if (editingId === deleteTarget.id) cancelEdit()
    } catch {
      toast(t('common.error', { defaultValue: 'Error' }), 'error')
    }
  }

  function getDomainSelectionState(domain: string): 'all' | 'some' | 'none' {
    if (!catalog) return 'none'
    const domainPerms = catalog.byDomain[domain]
    if (!domainPerms?.length) return 'none'
    const domainKeys = domainPerms.map(p => p.key)
    const selectedCount = domainKeys.filter(k => form.permissions.includes(k)).length
    if (selectedCount === 0) return 'none'
    if (selectedCount === domainKeys.length) return 'all'
    return 'some'
  }

  function formatDomainName(domain: string): string {
    return domain.charAt(0).toUpperCase() + domain.slice(1).replace(/-/g, ' ')
  }

  // Only the roles this hub owns are this hub's to change.
  const canEdit = (role: ReadableRole) => canManageRoles && !!role.hubId
  const canDelete = canEdit

  if (loading) return null

  return (
    <SettingsSection
      id="roles"
      title={t('roles.permissions', { defaultValue: 'Permissions' })}
      description={t('roles.description', { defaultValue: 'Define roles and assign permissions to control access across your hotline.' })}
      icon={<ShieldCheck className="h-5 w-5 text-muted-foreground" />}
      expanded={expanded}
      onToggle={onToggle}
      basePath="/admin/settings"
      statusSummary={statusSummary}
    >
      {/* Role list */}
      <div className="space-y-2">
        {roles.map(role => (
          <div
            key={role.id}
            data-testid={`hub-role-item-${role.id}`}
            className={cn(
              'flex items-center gap-3 rounded-lg border border-border px-4 py-3 transition-colors',
              editingId === role.id && 'border-primary/30 bg-primary/5'
            )}
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span data-testid="hub-role-name" className="text-sm font-medium truncate">{role.displayName}</span>
                {role.isSystem && (
                  <Badge variant="secondary" className="text-[10px] gap-1">
                    <Lock className="h-2.5 w-2.5" />
                    {t('roles.system', { defaultValue: 'System' })}
                  </Badge>
                )}
                {role.isDefault && !role.isSystem && (
                  <Badge variant="outline" className="text-[10px]">
                    {t('roles.default', { defaultValue: 'Default' })}
                  </Badge>
                )}
              </div>
              {role.displayDescription && (
                <p className="text-xs text-muted-foreground mt-0.5 truncate">{role.displayDescription}</p>
              )}
              <p className="text-xs text-muted-foreground mt-0.5">
                {role.permissions.length} {t('roles.permissionCount', { defaultValue: 'permissions' })}
              </p>
            </div>

            <div className="flex items-center gap-1 shrink-0">
              {canEdit(role) && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => startEdit(role)}
                  disabled={editingId !== null}
                >
                  <Pencil className="h-3.5 w-3.5" />
                  <span className="sr-only">{t('common.edit', { defaultValue: 'Edit' })}</span>
                </Button>
              )}
              {canDelete(role) && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDeleteTarget(role)}
                  disabled={editingId !== null}
                >
                  <Trash2 className="h-3.5 w-3.5 text-destructive" />
                  <span className="sr-only">{t('common.delete', { defaultValue: 'Delete' })}</span>
                </Button>
              )}
              {role.isSystem && (
                <span className="text-xs text-muted-foreground px-2">
                  {t('roles.system', { defaultValue: 'System' })}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Edit / Create form */}
      {editingId !== null && catalog && (
        <div className="space-y-4 rounded-lg border border-primary/30 bg-primary/5 p-4">
          <h4 className="text-sm font-medium">
            {editingId === 'new'
              ? t('roles.create', { defaultValue: 'Create role' })
              : t('common.edit', { defaultValue: 'Edit' })}
          </h4>

          <div className="space-y-1">
            <Label>{t('roles.name', { defaultValue: 'Name' })}</Label>
            <Input
              data-testid="hub-role-name-input"
              value={form.name}
              onChange={e => setForm(prev => ({ ...prev, name: e.target.value }))}
              placeholder={t('roles.namePlaceholder', { defaultValue: 'e.g. Team Lead' })}
              maxLength={50}
            />
          </div>

          <div className="space-y-1">
            <Label>{t('roles.description', { defaultValue: 'Description' })}</Label>
            <Textarea
              data-testid="hub-role-description-input"
              value={form.description}
              onChange={e => setForm(prev => ({ ...prev, description: e.target.value }))}
              placeholder={t('roles.descriptionPlaceholder', { defaultValue: 'Brief description of this role...' })}
              rows={2}
              maxLength={200}
            />
          </div>

          {/* Permissions by domain */}
          <div className="space-y-1">
            <Label>{t('roles.permissions', { defaultValue: 'Permissions' })}</Label>
            <p className="text-xs text-muted-foreground">
              {form.permissions.length} {t('roles.permissions', { defaultValue: 'Permissions' })}
            </p>
          </div>

          <div className="space-y-1">
            {Object.entries(catalog.byDomain).map(([domain, perms]) => {
              const domainState = getDomainSelectionState(domain)
              const isExpanded = expandedDomains.has(domain)

              return (
                <div key={domain} className="rounded-md border border-border">
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/50 transition-colors"
                    onClick={() => toggleDomainExpanded(domain)}
                  >
                    {isExpanded ? (
                      <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    )}
                    <input
                      type="checkbox"
                      checked={domainState === 'all'}
                      ref={el => {
                        if (el) el.indeterminate = domainState === 'some'
                      }}
                      onChange={(e) => {
                        e.stopPropagation()
                        toggleDomainAll(domain)
                      }}
                      onClick={(e) => e.stopPropagation()}
                      className="h-4 w-4 rounded border-input accent-primary shrink-0"
                    />
                    <span className="text-sm font-medium flex-1">{formatDomainName(domain)}</span>
                    <Badge variant="outline" className="text-[10px]">
                      {perms.filter(p => form.permissions.includes(p.key)).length}/{perms.length}
                    </Badge>
                  </button>

                  {isExpanded && (
                    <div className="border-t border-border px-3 py-2 space-y-1">
                      {perms.map(perm => (
                        <label
                          key={perm.key}
                          className="flex items-center gap-2 rounded px-2 py-1 hover:bg-muted/30 cursor-pointer transition-colors"
                        >
                          <input
                            type="checkbox"
                            checked={form.permissions.includes(perm.key)}
                            onChange={() => togglePermission(perm.key)}
                            className="h-4 w-4 rounded border-input accent-primary shrink-0"
                          />
                          <span className="text-sm">{perm.label}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          <div className="flex gap-2">
            <Button
              data-testid="hub-role-save-btn"
              disabled={saving || !form.name.trim()}
              onClick={handleSave}
            >
              <Save className="h-4 w-4" />
              {saving
                ? t('common.loading', { defaultValue: 'Loading...' })
                : t('common.save', { defaultValue: 'Save' })}
            </Button>
            <Button variant="outline" onClick={cancelEdit}>
              <X className="h-4 w-4" />
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </Button>
          </div>
        </div>
      )}

      {/* Create button (shown when not editing) */}
      {editingId === null && canManageRoles && (
        <Button variant="outline" data-testid="hub-role-create-btn" onClick={startCreate}>
          <Plus className="h-4 w-4" />
          {t('roles.create', { defaultValue: 'Create role' })}
        </Button>
      )}

      {/* Delete confirmation dialog */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}
        title={t('roles.deleteTitle')}
        description={
          deleteTarget
            ? t('roles.deleteConfirm.description')
            : ''
        }
        variant="destructive"
        onConfirm={handleDelete}
      />
    </SettingsSection>
  )
}
