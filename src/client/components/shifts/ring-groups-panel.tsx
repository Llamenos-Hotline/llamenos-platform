import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '@/lib/toast'
import { DeletionConfirmed } from '@/lib/admin-deletion'
import {
  listRingGroups,
  createRingGroup,
  updateRingGroup,
  deleteRingGroup,
  addRingGroupMembers,
  removeRingGroupMembers,
  listUsers,
  NoActiveHubError,
  type User,
} from '@/lib/api'
import { Users, Trash2, UserPlus, UserMinus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { UserMultiSelect } from '@/components/user-multi-select'

type RingGroup = {
  id: string
  hubId: string
  encryptedName: string
  memberCount: number
  createdAt: string
}

type RingGroupDetail = Omit<RingGroup, 'memberCount'> & {
  memberCount: number
  members: Array<{ pubkey: string; addedBy: string; createdAt: string }>
}

export function RingGroupsPanel() {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [groups, setGroups] = useState<RingGroup[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [editingGroup, setEditingGroup] = useState<RingGroupDetail | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [nameInput, setNameInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [confirmingGroup, setConfirmingGroup] = useState<RingGroup | null>(null)

  useEffect(() => {
    Promise.all([
      listRingGroups().then(r => setGroups(r.ringGroups)),
      listUsers().then(r => setUsers(r.users)),
      // No hub to browse is an empty list, not a failure to load one (#2405, #2461).
    ]).catch((err) => { if (!(err instanceof NoActiveHubError)) toast(t('common.error'), 'error') })
      .finally(() => setLoading(false))
  }, [])

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!nameInput.trim()) return
    setSaving(true)
    try {
      const res = await createRingGroup({ id: crypto.randomUUID(), encryptedName: nameInput.trim() })
      setGroups(prev => [...prev, { ...res, memberCount: 0 }])
      setNameInput('')
      setShowForm(false)
      toast(t('common.success'), 'success')
    } catch {
      toast(t('common.error'), 'error')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: string, confirmed: DeletionConfirmed) {
    try {
      await deleteRingGroup(id, confirmed)
      setGroups(prev => prev.filter(g => g.id !== id))
    } catch {
      toast(t('common.error'), 'error')
    }
  }

  async function handleEditOpen(group: RingGroup) {
    try {
      const res = await updateRingGroup(group.id, { encryptedName: group.encryptedName })
      setEditingGroup({ ...res, memberCount: res.members.length })
    } catch {
      toast(t('common.error'), 'error')
    }
  }

  async function handleAddMembers(groupId: string, pubkeys: string[]) {
    try {
      const res = await addRingGroupMembers(groupId, pubkeys)
      setEditingGroup({ ...res, memberCount: res.members.length })
      setGroups(prev => prev.map(g => g.id === groupId ? { ...g, memberCount: res.members.length } : g))
    } catch {
      toast(t('common.error'), 'error')
    }
  }

  async function handleRemoveMember(groupId: string, pubkey: string) {
    try {
      const res = await removeRingGroupMembers(groupId, [pubkey])
      setEditingGroup({ ...res, memberCount: res.members.length })
      setGroups(prev => prev.map(g => g.id === groupId ? { ...g, memberCount: res.members.length } : g))
    } catch {
      toast(t('common.error'), 'error')
    }
  }

  if (loading) return <div className="py-8 text-center text-muted-foreground">{t('common.loading')}</div>

  return (
    <div className="space-y-4">
      {confirmingGroup && (
        <DeletionConfirmed.Dialog
          action="ringGroup"
          targetId={confirmingGroup.id}
          subject={confirmingGroup.encryptedName}
          open
          onOpenChange={(open) => { if (!open) setConfirmingGroup(null) }}
          onConfirmed={(confirmed) => handleDelete(confirmingGroup.id, confirmed)}
        />
      )}
      <div className="flex justify-end">
        <Button data-testid="ring-group-create-btn" onClick={() => { setShowForm(true); setNameInput('') }}>
          <UserPlus className="h-4 w-4" />
          {t('shifts.ringGroups.create')}
        </Button>
      </div>

      {showForm && (
        <Card>
          <CardContent className="pt-4">
            <form data-testid="ring-group-form" onSubmit={handleCreate} className="flex gap-2">
              <Input
                data-testid="ring-group-name-input"
                value={nameInput}
                onChange={e => setNameInput(e.target.value)}
                placeholder={t('shifts.ringGroups.name')}
                required
              />
              <Button type="submit" disabled={saving}>{saving ? t('common.loading') : t('common.save')}</Button>
              <Button type="button" variant="outline" onClick={() => setShowForm(false)}>{t('common.cancel')}</Button>
            </form>
          </CardContent>
        </Card>
      )}

      <div data-testid="ring-group-list" className="space-y-3">
        {groups.length === 0 ? (
          <Card>
            <CardContent>
              <div className="py-8 text-center text-muted-foreground">
                <Users className="mx-auto mb-2 h-8 w-8 opacity-40" />
                <p>{t('shifts.ringGroups.empty')}</p>
                <p className="text-xs">{t('shifts.ringGroups.emptySubtitle')}</p>
              </div>
            </CardContent>
          </Card>
        ) : groups.map(group => (
          <Card key={group.id} data-testid="ring-group-card" data-ring-group-id={group.id}>
            <CardContent>
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-medium">{group.encryptedName}</h3>
                  <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
                    <Users className="h-3 w-3" />
                    {t('shifts.ringGroups.memberCount', { count: group.memberCount })}
                  </p>
                </div>
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    data-testid="ring-group-edit-btn"
                    onClick={() => handleEditOpen(group)}
                  >
                    <UserPlus className="h-3 w-3" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="text-destructive hover:text-destructive"
                    data-testid="ring-group-delete-btn"
                    onClick={() => setConfirmingGroup(group)}
                    aria-label={t('a11y.deleteItem')}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {editingGroup && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{editingGroup.encryptedName} — {t('shifts.ringGroups.members')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              {editingGroup.members.map(m => (
                <div key={m.pubkey} className="flex items-center justify-between text-sm">
                  <span className="font-mono text-xs text-muted-foreground">{m.pubkey.slice(0, 16)}…</span>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="text-destructive hover:text-destructive"
                    onClick={() => handleRemoveMember(editingGroup.id, m.pubkey)}
                  >
                    <UserMinus className="h-3 w-3" />
                  </Button>
                </div>
              ))}
            </div>
            <div>
              <Label>{t('shifts.ringGroups.addMembers')}</Label>
              <UserMultiSelect
                users={users.filter(u => u.active && !editingGroup.members.some(m => m.pubkey === u.pubkey))}
                selected={[]}
                onSelectionChange={(pubkeys) => handleAddMembers(editingGroup.id, pubkeys)}
                placeholder={t('shifts.searchUsers')}
              />
            </div>
            <Button variant="outline" onClick={() => setEditingGroup(null)}>{t('common.close')}</Button>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
