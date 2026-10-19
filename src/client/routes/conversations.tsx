import { createFileRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/lib/auth'
import { useConfig } from '@/lib/config'
import { useConversations } from '@/lib/hooks'
import { useState, useEffect, useCallback } from 'react'
import {
  getConversationMessages,
  sendConversationMessage,
  claimConversation,
  updateConversation,
  type ConversationMessage,
  type HubConversation,
} from '@/lib/api'
import { encryptMessage } from '@/lib/platform'
import { useToast } from '@/lib/toast'
import { useNoteSheet } from '@/lib/note-sheet-context'
import { ConversationList } from '@/components/ConversationList'
import { ConversationThread } from '@/components/ConversationThread'
import { MessageComposer } from '@/components/MessageComposer'
import { ChannelBadge } from '@/components/ChannelBadge'
import { MessageSquare, X, UserCheck, Lock, UserCog, StickyNote, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ReassignDialog } from '@/components/ReassignDialog'

export const Route = createFileRoute('/conversations')({
  component: ConversationsPage,
})

function ConversationsPage() {
  const { t } = useTranslation()
  const { isAdmin, hasDeviceKey, publicKey, adminDecryptionPubkey } = useAuth()
  const { channels, isLoading: configLoading } = useConfig()
  const { toast } = useToast()
  const { conversations, waitingConversations, applyConversation } = useConversations()

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ConversationMessage[]>([])
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [reassignOpen, setReassignOpen] = useState(false)
  const { openNewConversationNote } = useNoteSheet()

  const selectedConv = conversations.find(c => c.id === selectedId)
  // A conversation always acts on its own hub, never the active one.
  const selectedHubId = selectedConv?.hubId

  // Load messages when conversation is selected
  useEffect(() => {
    if (!selectedId || !selectedHubId) {
      setMessages([])
      return
    }

    setMessagesLoading(true)
    getConversationMessages(selectedHubId, selectedId, { limit: 100 })
      .then(({ messages: msgs }) => setMessages(msgs))
      .catch(() => toast(t('conversations.loadError', { defaultValue: 'Failed to load messages' }), 'error'))
      .finally(() => setMessagesLoading(false))
  }, [selectedId, selectedHubId, t, toast])

  // Refresh messages periodically when a conversation is selected
  useEffect(() => {
    if (!selectedId || !selectedHubId) return
    const interval = setInterval(() => {
      getConversationMessages(selectedHubId, selectedId, { limit: 100 })
        .then(({ messages: msgs }) => setMessages(msgs))
        .catch(() => {
          console.error('[conversations] Background message refresh failed')
        })
    }, 10_000)
    return () => clearInterval(interval)
  }, [selectedId, selectedHubId])

  const handleClaim = useCallback(async (conv: HubConversation) => {
    try {
      applyConversation(await claimConversation(conv.hubId, conv.id))
      toast(t('conversations.claimed', { defaultValue: 'Conversation claimed' }))
    } catch {
      toast(t('conversations.claimError', { defaultValue: 'Failed to claim conversation' }), 'error')
    }
  }, [applyConversation, t, toast])

  const handleClose = useCallback(async (conv: HubConversation) => {
    try {
      await updateConversation(conv.hubId, conv.id, { status: 'closed' })
      if (selectedId === conv.id) setSelectedId(null)
      toast(t('conversations.closed', { defaultValue: 'Conversation closed' }))
    } catch {
      toast(t('conversations.closeError', { defaultValue: 'Failed to close conversation' }), 'error')
    }
  }, [selectedId, t, toast])

  const handleReopen = useCallback(async (conv: HubConversation) => {
    try {
      applyConversation(await updateConversation(conv.hubId, conv.id, { status: 'active' }))
      toast(t('conversations.reopened', { defaultValue: 'Conversation reopened' }))
    } catch {
      toast(t('conversations.reopenError', { defaultValue: 'Failed to reopen conversation' }), 'error')
    }
  }, [applyConversation, t, toast])

  // Encrypt and send a message using envelope pattern
  const handleComposerSend = useCallback(async (plaintext: string) => {
    if (!selectedId || !selectedHubId || !hasDeviceKey || !publicKey) return

    // Build reader list: current user + admin decryption pubkey
    const readerPubkeys = [publicKey]
    if (adminDecryptionPubkey && adminDecryptionPubkey !== publicKey) {
      readerPubkeys.push(adminDecryptionPubkey)
    }

    const encrypted = await encryptMessage(plaintext, readerPubkeys)

    try {
      const msg = await sendConversationMessage(selectedHubId, selectedId, {
        encryptedContent: encrypted.encryptedContent,
        readerEnvelopes: encrypted.readerEnvelopes,
        plaintextForSending: plaintext,
      })
      setMessages(prev => [msg, ...prev])
    } catch {
      toast(t('conversations.sendError', { defaultValue: 'Failed to send message' }), 'error')
    }
  }, [selectedId, selectedHubId, hasDeviceKey, publicKey, adminDecryptionPubkey, t, toast])

  const hasAnyMessaging = channels.sms || channels.whatsapp || channels.signal || channels.reports

  if (configLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <MessageSquare className="h-6 w-6 text-primary" />
          <h1 data-testid="page-title" className="text-xl font-bold sm:text-2xl">{t('conversations.title', { defaultValue: 'Conversations' })}</h1>
        </div>
        <div data-testid="loading-skeleton" className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground">
          {t('common.loading')}
        </div>
      </div>
    )
  }

  if (!hasAnyMessaging) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <MessageSquare className="h-6 w-6 text-primary" />
          <h1 data-testid="page-title" className="text-xl font-bold sm:text-2xl">{t('conversations.title', { defaultValue: 'Conversations' })}</h1>
        </div>
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <MessageSquare className="h-12 w-12 text-muted-foreground mb-4" />
          <h2 className="text-xl font-semibold mb-2">
            {t('conversations.noChannels', { defaultValue: 'No messaging channels enabled' })}
          </h2>
          <p className="text-muted-foreground max-w-md">
            {t('conversations.noChannelsDescription', { defaultValue: 'Enable SMS, WhatsApp, Signal, or Reports in Hub Settings to start receiving messages.' })}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <MessageSquare className="h-6 w-6 text-primary" />
        <h1 data-testid="page-title" className="text-xl font-bold sm:text-2xl">{t('conversations.title', { defaultValue: 'Conversations' })}</h1>
      </div>
    <div className="flex h-[calc(100vh-12rem)] gap-4">
      {/* Conversation list sidebar */}
      <div className="w-80 shrink-0 overflow-y-auto rounded-lg border border-border bg-card">
        <div className="sticky top-0 z-10 border-b border-border bg-card p-3">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold flex items-center gap-2">
              <MessageSquare className="h-4 w-4" />
              {t('conversations.title', { defaultValue: 'Conversations' })}
            </h2>
            <div className="flex gap-1">
              {waitingConversations.length > 0 && (
                <Badge variant="secondary" className="text-xs">
                  {waitingConversations.length} {t('conversations.waiting', { defaultValue: 'waiting' })}
                </Badge>
              )}
            </div>
          </div>
        </div>
        <ConversationList
          conversations={conversations}
          onSelect={setSelectedId}
          selectedId={selectedId ?? undefined}
        />
      </div>

      {/* Conversation detail */}
      <div className="flex flex-1 flex-col rounded-lg border border-border bg-card overflow-hidden">
        {selectedConv ? (
          <>
            {/* Header */}
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div className="flex items-center gap-3">
                <ChannelBadge channelType={selectedConv.channelType} />
                <div>
                  <p className="font-medium">
                    {selectedConv.contactLast4 ? `...${selectedConv.contactLast4}` : t('conversations.unknownContact', { defaultValue: 'Unknown' })}
                  </p>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Lock className="h-3 w-3" />
                    {t('conversations.e2ee', { defaultValue: 'End-to-end encrypted' })}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {selectedConv.status === 'waiting' && (
                  <Button size="sm" data-testid="conv-assign-btn" onClick={() => handleClaim(selectedConv)}>
                    <UserCheck className="h-3.5 w-3.5 mr-1" />
                    {t('conversations.claim', { defaultValue: 'Claim' })}
                  </Button>
                )}
                {isAdmin && (selectedConv.status === 'active' || selectedConv.status === 'waiting') && (
                  <Button size="sm" variant="outline" data-testid="conv-reassign-btn" onClick={() => setReassignOpen(true)}>
                    <UserCog className="h-3.5 w-3.5 mr-1" />
                    {t('conversations.reassign', { defaultValue: 'Reassign' })}
                  </Button>
                )}
                <Button size="sm" variant="outline" data-testid="conv-add-note-btn" onClick={() => openNewConversationNote(selectedConv.id, selectedConv.hubId)}>
                  <StickyNote className="h-3.5 w-3.5 mr-1" />
                  {t('notes.addNote', { defaultValue: 'Add Note' })}
                </Button>
                {selectedConv.status === 'active' && (
                  <Button size="sm" variant="outline" data-testid="conv-close-btn" onClick={() => handleClose(selectedConv)}>
                    <X className="h-3.5 w-3.5 mr-1" />
                    {t('conversations.close', { defaultValue: 'Close' })}
                  </Button>
                )}
                {selectedConv.status === 'closed' && (
                  <Button size="sm" variant="outline" data-testid="conv-reopen-btn" onClick={() => handleReopen(selectedConv)}>
                    <RotateCcw className="h-3.5 w-3.5 mr-1" />
                    {t('conversations.reopen', { defaultValue: 'Reopen' })}
                  </Button>
                )}
              </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-hidden">
              <ConversationThread
                conversationId={selectedConv.id}
                messages={messages}
                isLoading={messagesLoading}
              />
            </div>

            {/* Composer */}
            {selectedConv.status === 'active' && (
              <div className="border-t border-border p-3">
                <MessageComposer
                  onSend={handleComposerSend}
                  disabled={!selectedConv.assignedTo}
                  channelType={selectedConv.channelType}
                />
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center text-muted-foreground">
            <MessageSquare className="h-10 w-10 mb-3" />
            <p>{t('conversations.selectConversation', { defaultValue: 'Select a conversation to view messages' })}</p>
          </div>
        )}
      </div>
    </div>

      {/* Reassign Dialog */}
      {selectedConv && (
        <ReassignDialog
          conversation={selectedConv}
          open={reassignOpen}
          onOpenChange={setReassignOpen}
        />
      )}
    </div>
  )
}
