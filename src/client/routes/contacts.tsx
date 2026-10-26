import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/lib/auth'
import { useEffect, useState, useCallback } from 'react'
import { listContacts, getContactTimeline, type ContactSummary, type EncryptedNote, type Conversation } from '@/lib/api'
import { decryptNote, decryptLegacyNote } from '@/lib/platform'
import * as keyManager from '@/lib/key-manager'
import { useToast } from '@/lib/toast'
import type { NotePayload } from '@shared/types'
import { Contact, StickyNote, MessageSquare, Phone, FileText, ChevronLeft, ChevronRight, ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ChannelBadge } from '@/components/ChannelBadge'

type ContactsSearch = { page: number }

export const Route = createFileRoute('/contacts')({
  validateSearch: (search: Record<string, unknown>): ContactsSearch => ({
    page: Number(search?.page ?? 1),
  }),
  component: ContactsPage,
})

function ContactsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate({ from: '/contacts' })
  const { hasDeviceKey, publicKey, isAdmin } = useAuth()
  const { toast } = useToast()
  const { page } = Route.useSearch()
  const [contacts, setContacts] = useState<ContactSummary[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [selectedHash, setSelectedHash] = useState<string | null>(null)
  const [timeline, setTimeline] = useState<{ notes: EncryptedNote[]; conversations: Conversation[] }>({ notes: [], conversations: [] })
  const [timelineLoading, setTimelineLoading] = useState(false)
  const [decryptedNotes, setDecryptedNotes] = useState<Map<string, string>>(new Map())
  const limit = 50

  const loadContacts = useCallback(async () => {
    setLoading(true)
    try {
      const res = await listContacts({ page, limit })
      setContacts(res.contacts)
      setTotal(res.total)
    } catch {
      toast(t('common.error'), 'error')
    } finally {
      setLoading(false)
    }
  }, [page, t, toast])

  useEffect(() => { loadContacts() }, [loadContacts])

  async function handleSelectContact(hash: string) {
    setSelectedHash(hash)
    setTimelineLoading(true)
    try {
      const res = await getContactTimeline(hash)
      setTimeline({ notes: res.notes, conversations: res.conversations })

      // Decrypt notes
      if (hasDeviceKey && keyManager.isUnlocked() && publicKey) {
        const newDecrypted = new Map<string, string>()
        for (const note of res.notes) {
          const envelope = isAdmin
            ? note.adminEnvelopes?.find(e => e.pubkey === publicKey) ?? note.adminEnvelopes?.[0]
            : note.authorEnvelope
          if (envelope) {
            const json = await decryptNote(note.encryptedContent, envelope)
            if (json) {
              const payload: NotePayload = JSON.parse(json)
              newDecrypted.set(note.id, payload.text)
            }
          } else {
            const payload = await decryptLegacyNote(note.encryptedContent)
            if (payload) newDecrypted.set(note.id, payload.text)
          }
        }
        setDecryptedNotes(newDecrypted)
      }
    } catch {
      toast(t('common.error'), 'error')
    } finally {
      setTimelineLoading(false)
    }
  }

  const totalPages = Math.ceil(total / limit)
  const selectedContact = contacts.find(c => c.contactHash === selectedHash)

  if (selectedHash) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <Button data-testid="back-btn" variant="ghost" size="sm" onClick={() => setSelectedHash(null)}>
            <ArrowLeft className="h-4 w-4" />
            {t('common.back')}
          </Button>
          <Contact className="h-6 w-6 text-primary" />
          <h1 data-testid="page-title" className="text-xl font-bold sm:text-2xl">
            {selectedContact ? `${selectedContact.contactHash.slice(0, 12)}...` : t('contacts.contact', { defaultValue: 'Contact' })}
          </h1>
        </div>

        {selectedContact && (
          <div className="flex gap-4 text-sm text-muted-foreground">
            <span>{t('contacts.firstSeen', { defaultValue: 'First seen' })}: {new Date(selectedContact.firstSeen).toLocaleDateString()}</span>
            <span>{t('contacts.lastSeen', { defaultValue: 'Last seen' })}: {new Date(selectedContact.lastSeen).toLocaleDateString()}</span>
          </div>
        )}

        {timelineLoading ? (
          <Card>
            <CardContent className="py-8">
              <div className="space-y-3">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="h-16 animate-pulse rounded bg-muted" />
                ))}
              </div>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {/* Notes timeline */}
            {timeline.notes.length > 0 && (
              <Card>
                <CardHeader className="py-3">
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <StickyNote className="h-4 w-4" />
                    {t('notes.title')}
                    <Badge variant="secondary" className="text-xs">{timeline.notes.length}</Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0 divide-y divide-border">
                  {timeline.notes.map(note => (
                    <div key={note.id} className="px-6 py-3">
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span>{new Date(note.createdAt).toLocaleString()}</span>
                        {note.callId && <Badge variant="outline" className="text-[10px]"><Phone className="h-2.5 w-2.5" /> {t('contacts.call', { defaultValue: 'Call' })}</Badge>}
                        {note.conversationId && <Badge variant="outline" className="text-[10px]"><MessageSquare className="h-2.5 w-2.5" /> {t('contacts.conversation', { defaultValue: 'Conversation' })}</Badge>}
                        {(note.replyCount || 0) > 0 && (
                          <Badge variant="secondary" className="text-[10px]">
                            {t('notes.repliesCount', { count: note.replyCount, defaultValue: '{{count}} replies' })}
                          </Badge>
                        )}
                      </div>
                      <p className="mt-1 text-sm whitespace-pre-wrap">
                        {decryptedNotes.get(note.id) || t('conversations.encrypted', '[Encrypted]')}
                      </p>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            {/* Conversations timeline */}
            {timeline.conversations.length > 0 && (
              <Card>
                <CardHeader className="py-3">
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <MessageSquare className="h-4 w-4" />
                    {t('conversations.title', { defaultValue: 'Conversations' })}
                    <Badge variant="secondary" className="text-xs">{timeline.conversations.length}</Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0 divide-y divide-border">
                  {timeline.conversations.map(conv => (
                    <div key={conv.id} className="flex items-center gap-3 px-6 py-3">
                      <ChannelBadge channelType={conv.channelType} />
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">
                            {conv.metadata?.type === 'report'
                              ? t('contacts.report', { defaultValue: 'Report' })
                              : t('contacts.conversation', { defaultValue: 'Conversation' })}
                          </span>
                          <Badge variant={conv.status === 'active' ? 'default' : conv.status === 'waiting' ? 'secondary' : 'outline'} className="text-[10px]">
                            {conv.status}
                          </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {conv.messageCount} {t('contacts.messages', { defaultValue: 'messages' })} &middot; {new Date(conv.lastMessageAt ?? conv.updatedAt).toLocaleString()}
                        </p>
                      </div>
                      {conv.metadata?.reportTitle && (
                        <Badge variant="outline" className="text-[10px]">
                          <FileText className="h-2.5 w-2.5" />
                          {conv.metadata.reportCategory || t('contacts.report', { defaultValue: 'Report' })}
                        </Badge>
                      )}
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            {timeline.notes.length === 0 && timeline.conversations.length === 0 && (
              <Card>
                <CardContent className="py-8 text-center text-muted-foreground">
                  <Contact className="mx-auto mb-2 h-8 w-8 opacity-40" />
                  {t('contacts.noHistory', { defaultValue: 'No interaction history found' })}
                </CardContent>
              </Card>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Contact className="h-6 w-6 text-primary" />
        <h1 data-testid="page-title" className="text-xl font-bold sm:text-2xl">{t('contacts.title', { defaultValue: 'Contacts' })}</h1>
      </div>
      <p className="text-sm text-muted-foreground">
        {t('contacts.description', { defaultValue: 'View unified interaction history across calls, conversations, and reports.' })}
      </p>

      {loading ? (
        <Card>
          <CardContent className="py-8">
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="h-12 animate-pulse rounded bg-muted" />
              ))}
            </div>
          </CardContent>
        </Card>
      ) : contacts.length === 0 ? (
        <Card data-testid="empty-state">
          <CardContent className="py-8 text-center text-muted-foreground">
            <Contact className="mx-auto mb-2 h-8 w-8 opacity-40" />
            {t('contacts.noContacts', { defaultValue: 'No contacts found' })}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0 divide-y divide-border">
            {contacts.map(contact => (
              <button
                key={contact.contactHash}
                data-testid="contact-row"
                onClick={() => handleSelectContact(contact.contactHash)}
                className="flex w-full items-center gap-4 px-6 py-4 text-left hover:bg-muted/50 transition-colors"
              >
                <Contact className="h-5 w-5 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="font-medium">
                    {contact.contactHash.slice(0, 12) + '...'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t('contacts.lastSeen', { defaultValue: 'Last seen' })}: {new Date(contact.lastSeen).toLocaleDateString()}
                  </p>
                </div>
                <div className="flex gap-2">
                  {contact.noteCount > 0 && (
                    <Badge variant="outline" className="text-[10px]">
                      <StickyNote className="h-2.5 w-2.5" />
                      {contact.noteCount}
                    </Badge>
                  )}
                  {contact.conversationCount > 0 && (
                    <Badge variant="outline" className="text-[10px]">
                      <MessageSquare className="h-2.5 w-2.5" />
                      {contact.conversationCount}
                    </Badge>
                  )}
                  {contact.reportCount > 0 && (
                    <Badge variant="outline" className="text-[10px]">
                      <FileText className="h-2.5 w-2.5" />
                      {contact.reportCount}
                    </Badge>
                  )}
                </div>
              </button>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <Button data-testid="pagination-prev" variant="outline" size="sm" disabled={page === 1} onClick={() => navigate({ search: { page: page - 1 } })}>
            <ChevronLeft className="h-4 w-4" />
            {t('common.back')}
          </Button>
          <span data-testid="pagination-info" className="text-sm text-muted-foreground">{page} / {totalPages}</span>
          <Button data-testid="pagination-next" variant="outline" size="sm" disabled={page === totalPages} onClick={() => navigate({ search: { page: page + 1 } })}>
            {t('common.next')}
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  )
}
