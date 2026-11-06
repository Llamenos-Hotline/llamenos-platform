import { useTranslation } from 'react-i18next'
import { useState, useEffect } from 'react'
import {
  listAffinityGroups, createAffinityGroup, deleteAffinityGroup,
  type AffinityGroup,
} from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { encryptMessage } from '@/lib/platform'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Users, Plus, Trash2, Loader2 } from 'lucide-react'
import { useToast } from '@/lib/toast'
import { activeHubAdminReaders } from '@/lib/admin-recipient'

interface AffinityGroupsSidebarProps {
  selectedGroupId: string | null
  onGroupSelect: (groupId: string | null) => void
}

export function AffinityGroupsSidebar({ selectedGroupId, onGroupSelect }: AffinityGroupsSidebarProps) {
  const { t } = useTranslation()
  const { hasPermission } = useAuth()
  const { toast } = useToast()
  const canManage = hasPermission('contacts:manage-groups')

  const [groups, setGroups] = useState<AffinityGroup[]>([])
  const [creating, setCreating] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    listAffinityGroups()
      .then(r => setGroups(r.groups))
      .catch(() => toast(t('contactDirectory.groupsLoadError', { defaultValue: 'Failed to load groups' }), 'error'))
  }, [toast, t])

  async function handleCreate() {
    if (!newGroupName.trim()) return
    setSaving(true)
    try {
      const readerPubkeys: string[] = await activeHubAdminReaders()
      const encrypted = await encryptMessage(
        JSON.stringify({ name: newGroupName.trim() }),
        readerPubkeys,
      )
      const group = await createAffinityGroup({
        encryptedDetails: encrypted.encryptedContent,
        detailEnvelopes: encrypted.readerEnvelopes,
        members: [],
      })
      setGroups(prev => [...prev, group])
      setCreating(false)
      setNewGroupName('')
    } catch {
      toast(t('contactDirectory.groupCreateError', { defaultValue: 'Failed to create group' }), 'error')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(groupId: string) {
    try {
      await deleteAffinityGroup(groupId)
      setGroups(prev => prev.filter(g => g.id !== groupId))
      if (selectedGroupId === groupId) onGroupSelect(null)
    } catch {
      toast(t('contactDirectory.groupDeleteError', { defaultValue: 'Failed to delete group' }), 'error')
    }
  }

  return (
    <div className="flex h-full flex-col" data-testid="affinity-groups-sidebar">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {t('contactDirectory.groups', { defaultValue: 'Groups' })}
        </span>
        {canManage && (
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setCreating(true)}>
            <Plus className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      <ScrollArea className="flex-1">
        <div className="space-y-0.5 p-1">
          <button
            onClick={() => onGroupSelect(null)}
            className={`w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors
              ${selectedGroupId === null ? 'bg-accent text-accent-foreground' : 'hover:bg-muted'}`}
          >
            <Users className="h-3.5 w-3.5" />
            {t('contactDirectory.allContacts', { defaultValue: 'All Contacts' })}
          </button>
          {groups.map(group => (
            <div key={group.id} className="group/item flex items-center">
              <button
                onClick={() => onGroupSelect(group.id)}
                className={`flex-1 flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors
                  ${selectedGroupId === group.id ? 'bg-accent text-accent-foreground' : 'hover:bg-muted'}`}
              >
                <Users className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{group.id.slice(0, 8)}</span>
                <span className="ml-auto text-xs text-muted-foreground">{group.memberCount}</span>
              </button>
              {canManage && (
                <Button
                  variant="ghost" size="icon"
                  className="h-6 w-6 opacity-0 group-hover/item:opacity-100 transition-opacity"
                  onClick={() => handleDelete(group.id)}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              )}
            </div>
          ))}
        </div>
      </ScrollArea>
      {creating && (
        <div className="border-t p-2 space-y-2">
          <Input
            placeholder={t('contactDirectory.groupNamePlaceholder', { defaultValue: 'Group name' })}
            value={newGroupName}
            onChange={e => setNewGroupName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleCreate()}
            disabled={saving}
            autoFocus
          />
          <div className="flex gap-1">
            <Button size="sm" onClick={handleCreate} disabled={saving || !newGroupName.trim()}>
              {saving && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              {t('common.create', { defaultValue: 'Create' })}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setCreating(false); setNewGroupName('') }}>
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
