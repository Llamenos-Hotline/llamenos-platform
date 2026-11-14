import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '@/lib/toast'
import { useAuth } from '@/lib/auth'
import {
  listRoles,
  createRole,
  updateRole,
  deleteRole,
  addRoleEnvelopes,
  getPermissionsCatalog,
  type RoleDefinition,
} from '@/lib/api'
import { getDevicePubkeys } from '@/lib/platform'
import { readableRoles, sealPlatformRoleEnvelopes, type ReadableRole } from '@/lib/role-vocabulary'
import { SectionBody, SectionDescription } from '@/components/admin-shell/section-layout'
import { RoleList } from '@/components/admin-settings/role-list'
import { RoleEditor, type RoleFormData } from '@/components/admin-settings/role-editor'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'
import { Plus } from 'lucide-react'

export function PlatformRolesSection() {
  const { t } = useTranslation()
  const { toast } = useToast()
  const { hasPermission, adminDecryptionPubkey } = useAuth()
  const canManageRoles = hasPermission('system:manage-roles')

  const [roles, setRoles] = useState<ReadableRole[]>([])
  const [catalog, setCatalog] = useState<Record<string, { key: string; label: string }[]> | null>(null)
  const [loading, setLoading] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<RoleDefinition | null>(null)

  const loadData = useCallback(async () => {
    try {
      const [rolesRes, catalogRes] = await Promise.all([
        listRoles(),
        canManageRoles ? getPermissionsCatalog() : Promise.resolve(null),
      ])
      setRoles(await readableRoles(rolesRes.roles))
      if (catalogRes) setCatalog(catalogRes.byDomain)
    } catch {
      toast(t('common.error', { defaultValue: 'Error' }), 'error')
    } finally {
      setLoading(false)
    }
  }, [t, toast, canManageRoles])

  useEffect(() => {
    loadData()
  }, [loadData])

  /** This device, and the platform-wide admin key when it is another one. */
  async function envelopesFor(roleId: string, name: string, description: string) {
    const deviceState = await getDevicePubkeys()
    if (!deviceState) throw new Error('Device keys not available')
    const recipients = [deviceState.encryptionPubkeyHex]
    if (adminDecryptionPubkey) recipients.push(adminDecryptionPubkey)
    return sealPlatformRoleEnvelopes(roleId, name, description, recipients)
  }

  async function handleSave(form: RoleFormData) {
    setSaving(true)
    try {
      if (editingId === 'new') {
        // The id is minted here because the envelopes bind it in their AAD.
        const roleId = `role-${crypto.randomUUID()}`
        const res = await createRole({
          id: roleId,
          permissions: form.permissions,
          envelopes: await envelopesFor(roleId, form.name, form.description),
        })
        const [created] = await readableRoles([res])
        setRoles(prev => [...prev, created])
        toast(t('common.success', { defaultValue: 'Success' }), 'success')
      } else if (editingId) {
        await updateRole(editingId, { permissions: form.permissions })
        // Re-seal envelopes with updated name/description
        await addRoleEnvelopes(editingId, await envelopesFor(editingId, form.name, form.description))
        const rolesRes = await listRoles()
        setRoles(await readableRoles(rolesRes.roles))
        toast(t('common.success', { defaultValue: 'Success' }), 'success')
      }
      setEditingId(null)
    } catch {
      toast(t('common.error', { defaultValue: 'Error' }), 'error')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return
    try {
      await deleteRole(deleteTarget.id)
      setRoles(prev => prev.filter(r => r.id !== deleteTarget.id))
      toast(t('common.success', { defaultValue: 'Success' }), 'success')
      if (editingId === deleteTarget.id) setEditingId(null)
    } catch {
      toast(t('common.error', { defaultValue: 'Error' }), 'error')
    } finally {
      setDeleteTarget(null)
    }
  }

  function startEdit(role: RoleDefinition) {
    setEditingId(role.id)
  }

  function getInitialForm(role: ReadableRole): RoleFormData {
    return {
      name: role.readable ? role.displayName : '',
      description: role.displayDescription,
      permissions: [...role.permissions],
    }
  }

  if (loading) return null

  // Map roles to show decrypted names in the RoleList
  const displayRoles: RoleDefinition[] = roles.map(r => ({
    ...r,
    name: r.displayName,
    description: r.displayDescription,
  }))

  const editingRole = editingId && editingId !== 'new'
    ? roles.find(r => r.id === editingId)
    : undefined

  return (
    <SectionBody>
      <SectionDescription>{t('platformRoles.description', { defaultValue: 'Manage platform-wide roles that apply across all hubs. Role names are end-to-end encrypted.' })}</SectionDescription>

      <RoleList
        roles={displayRoles}
        editingId={editingId}
        onEdit={startEdit}
        onDelete={setDeleteTarget}
      />

      {editingId !== null && catalog && (
        <RoleEditor
          initial={editingId === 'new' ? null : editingRole ? getInitialForm(editingRole) : null}
          catalog={catalog}
          saving={saving}
          onSave={handleSave}
          onCancel={() => setEditingId(null)}
        />
      )}

      {editingId === null && canManageRoles && (
        <Button
          variant="outline"
          data-testid="platform-role-create-btn"
          onClick={() => setEditingId('new')}
        >
          <Plus className="h-4 w-4 mr-1" />
          {t('roles.create', { defaultValue: 'Create role' })}
        </Button>
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}
        title={t('roles.deleteTitle', { defaultValue: 'Delete role' })}
        description={t('roles.deleteConfirm.description', { defaultValue: 'This action cannot be undone. Users with this role will lose their permissions.' })}
        variant="destructive"
        onConfirm={handleDelete}
      />
    </SectionBody>
  )
}
