import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { listUsers, getUserLoads, updateConversation, type User, type HubConversation } from '@/lib/api'
import { useToast } from '@/lib/toast'
import { User as UserIcon, Users, AlertCircle, Loader2 } from 'lucide-react'

interface ReassignDialogProps {
  conversation: HubConversation
  open: boolean
  onOpenChange: (open: boolean) => void
  onReassigned?: () => void
}

export function ReassignDialog({
  conversation,
  open,
  onOpenChange,
  onReassigned,
}: ReassignDialogProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [users, setUsers] = useState<User[]>([])
  const [loads, setLoads] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [reassigning, setReassigning] = useState(false)
  const [selectedPubkey, setSelectedPubkey] = useState<string | null>(null)

  // Load users and their current loads when dialog opens
  useEffect(() => {
    if (!open) return

    setLoading(true)
    setSelectedPubkey(null)

    Promise.all([
      listUsers(),
      getUserLoads(conversation.hubId),
    ])
      .then(([userRes, loadRes]) => {
        // Filter to active users with messaging enabled
        const eligible = userRes.users.filter(u =>
          u.active &&
          u.messagingEnabled !== false &&
          u.pubkey !== conversation.assignedTo // Exclude current assignee
        )
        setUsers(eligible)
        setLoads(loadRes.loads)
      })
      .catch(() => {
        toast(t('conversations.loadUsersError', { defaultValue: 'Failed to load volunteers' }), 'error')
      })
      .finally(() => setLoading(false))
  }, [open, conversation.assignedTo, conversation.hubId, t, toast])

  const handleReassign = async () => {
    if (!selectedPubkey) return

    setReassigning(true)
    try {
      await updateConversation(conversation.hubId, conversation.id, { assignedTo: selectedPubkey })
      toast(t('conversations.reassigned', { defaultValue: 'Conversation reassigned' }))
      onOpenChange(false)
      onReassigned?.()
    } catch {
      toast(t('conversations.reassignError', { defaultValue: 'Failed to reassign conversation' }), 'error')
    } finally {
      setReassigning(false)
    }
  }

  const handleUnassign = async () => {
    setReassigning(true)
    try {
      await updateConversation(conversation.hubId, conversation.id, { status: 'waiting' })
      toast(t('conversations.unassigned', { defaultValue: 'Conversation unassigned' }))
      onOpenChange(false)
      onReassigned?.()
    } catch {
      toast(t('conversations.unassignError', { defaultValue: 'Failed to unassign conversation' }), 'error')
    } finally {
      setReassigning(false)
    }
  }

  // Check if user can handle this channel
  const canHandleChannel = (vol: User) => {
    if (!vol.supportedMessagingChannels || vol.supportedMessagingChannels.length === 0) {
      return true // Empty array means all channels
    }
    return vol.supportedMessagingChannels.some(ch => ch === conversation.channelType)
  }

  // Sort users: capable first, then by load (ascending)
  const sortedUsers = [...users].sort((a, b) => {
    const aCanHandle = canHandleChannel(a)
    const bCanHandle = canHandleChannel(b)
    if (aCanHandle && !bCanHandle) return -1
    if (!aCanHandle && bCanHandle) return 1
    return (loads[a.pubkey] || 0) - (loads[b.pubkey] || 0)
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-5 w-5" />
            {t('conversations.reassignTitle', { defaultValue: 'Reassign Conversation' })}
          </DialogTitle>
          <DialogDescription>
            {t('conversations.reassignDescription', { defaultValue: 'Select a volunteer to handle this conversation.' })}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : users.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <AlertCircle className="h-8 w-8 text-muted-foreground mb-2" />
            <p className="text-sm text-muted-foreground">
              {t('conversations.noUsersAvailable', { defaultValue: 'No volunteers available' })}
            </p>
          </div>
        ) : (
          <ScrollArea className="max-h-64">
            <div className="space-y-2 pr-4">
              {sortedUsers.map((vol) => {
                const load = loads[vol.pubkey] || 0
                const capable = canHandleChannel(vol)
                const isSelected = selectedPubkey === vol.pubkey

                return (
                  <button
                    key={vol.pubkey}
                    onClick={() => setSelectedPubkey(vol.pubkey)}
                    disabled={!capable}
                    className={`w-full flex items-center gap-3 rounded-lg border p-3 text-left transition-colors ${
                      isSelected
                        ? 'border-primary bg-primary/5'
                        : capable
                          ? 'border-border hover:bg-muted/50'
                          : 'border-border bg-muted/30 opacity-50 cursor-not-allowed'
                    }`}
                  >
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                      {vol.name.charAt(0).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium truncate">{vol.name}</span>
                        {vol.onBreak && (
                          <Badge variant="outline" className="text-xs border-yellow-500/50 text-yellow-600">
                            {t('dashboard.onBreak', { defaultValue: 'On break' })}
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <UserIcon className="h-3 w-3" />
                        <span>
                          {load} {t('conversations.activeConversations', { defaultValue: 'active' })}
                        </span>
                        {!capable && (
                          <span className="text-amber-600">
                            {t('conversations.channelNotSupported', { defaultValue: 'Channel not supported' })}
                          </span>
                        )}
                      </div>
                    </div>
                    {isSelected && (
                      <div className="h-2 w-2 rounded-full bg-primary" />
                    )}
                  </button>
                )
              })}
            </div>
          </ScrollArea>
        )}

        <DialogFooter className="flex-col gap-2 sm:flex-row">
          {conversation.status === 'active' && (
            <Button
              variant="outline"
              onClick={handleUnassign}
              disabled={reassigning}
              className="text-amber-600 border-amber-500/50 hover:bg-amber-50 dark:hover:bg-amber-950/20"
            >
              {t('conversations.unassign', { defaultValue: 'Return to queue' })}
            </Button>
          )}
          <div className="flex-1" />
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={reassigning}
          >
            {t('common.cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button
            onClick={handleReassign}
            disabled={!selectedPubkey || reassigning}
          >
            {reassigning && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
            {t('conversations.reassign', { defaultValue: 'Reassign' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
