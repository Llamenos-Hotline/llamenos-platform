import { createFileRoute, useNavigate, Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/lib/auth'
import { useEffect, useState, useCallback, useMemo } from 'react'
import { listNotes, createNote, updateNote, getActiveHub, listNoteReplies, createNoteReply, getCallHistory, listUsers, getCustomFields, type EncryptedNote, type CallRecord, type User, type ConversationMessage } from '@/lib/api'
import type { CustomFieldDefinition } from '@shared/types'
import { fieldMatchesContext } from '@shared/types'
import { encryptNote, encryptMessage, decryptNote, decryptLegacyNote, decryptTranscription, decryptCallRecord, encryptExport } from '@/lib/platform'
import * as keyManager from '@/lib/key-manager'
import { resolveCallHubId } from '@/lib/call-hubs'
import { useToast } from '@/lib/toast'
import type { NotePayload } from '@shared/types'
import { StickyNote, Plus, Pencil, Lock, Mic, X, Search, ChevronLeft, ChevronRight, Download, MessageCircle, Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { NewNoteForm } from '@/components/notes/new-note-form'
import { NoteEditForm } from '@/components/notes/note-edit-form'
import { RecordingPlayer } from '@/components/recording-player'
import { ConversationThread } from '@/components/ConversationThread'
import { CustomFieldBadges } from '@/components/notes/custom-field-badges'
import { Textarea } from '@/components/ui/textarea'

type NotesSearch = { page: number; callId: string; search: string }

export const Route = createFileRoute('/notes')({
  validateSearch: (search: Record<string, unknown>): NotesSearch => ({
    page: Number(search?.page ?? 1),
    callId: (search?.callId as string) || '',
    search: (search?.search as string) || '',
  }),
  component: NotesPage,
})

interface DecryptedNote extends EncryptedNote {
  decrypted: string
  payload: NotePayload
  isTranscription: boolean
}

function NotesPage() {
  const { t } = useTranslation()
  const { hasDeviceKey, publicKey, isAdmin, adminDecryptionPubkey } = useAuth()
  const { toast } = useToast()
  const navigate = useNavigate({ from: '/notes' })
  const { page, callId, search } = Route.useSearch()
  const [notes, setNotes] = useState<DecryptedNote[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showNewNote, setShowNewNote] = useState(false)
  const [saving, setSaving] = useState(false)
  const [expandedThreadId, setExpandedThreadId] = useState<string | null>(null)
  const [threadReplies, setThreadReplies] = useState<ConversationMessage[]>([])
  const [threadLoading, setThreadLoading] = useState(false)
  const [replyText, setReplyText] = useState('')
  const [sendingReply, setSendingReply] = useState(false)
  const [recentCalls, setRecentCalls] = useState<CallRecord[]>([])
  const [searchInput, setSearchInput] = useState(search)
  const [customFields, setCustomFields] = useState<CustomFieldDefinition[]>([])
  const [users, setUsers] = useState<User[]>([])
  const limit = 50

  useEffect(() => {
    getCustomFields().then(r => setCustomFields(r.fields)).catch(() => toast(t('common.error'), 'error'))
    if (isAdmin) {
      getCallHistory({ limit: 100 }).then(r => setRecentCalls(r.calls)).catch(() => toast(t('common.error'), 'error'))
      listUsers().then(r => setUsers(r.users)).catch(() => toast(t('common.error'), 'error'))
    }
  }, [isAdmin, t, toast])

  // Decrypt encrypted call records client-side (Epic 77)
  // Uses cancelled flag to avoid updating state after unmount or re-render
  useEffect(() => {
    if (!hasDeviceKey || !publicKey || recentCalls.length === 0) return
    if (!keyManager.isUnlocked()) return
    const hasUndecrypted = recentCalls.some(c => c.answeredBy === undefined && c.encryptedContent && c.adminEnvelopes?.length)
    if (!hasUndecrypted) return

    let cancelled = false
    ;(async () => {
      const decrypted = await Promise.all(recentCalls.map(async call => {
        if (call.answeredBy !== undefined) return call
        if (!call.encryptedContent || !call.adminEnvelopes?.length) return call
        const meta = await decryptCallRecord(call.encryptedContent, call.adminEnvelopes)
        if (meta) return { ...call, answeredBy: meta.answeredBy, callerNumber: meta.callerNumber }
        return call
      }))
      if (!cancelled) setRecentCalls(decrypted)
    })()
    return () => { cancelled = true }
  }, [recentCalls, hasDeviceKey, publicKey])

  const nameMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const u of users) map.set(u.pubkey, u.name)
    return map
  }, [users])

  const callInfoMap = useMemo(() => {
    const map = new Map<string, CallRecord>()
    for (const c of recentCalls) map.set(c.id, c)
    return map
  }, [recentCalls])

  const loadNotes = useCallback(async () => {
    setLoading(true)
    try {
      const res = await listNotes({ callId: callId || undefined, page, limit })
      const filtered = res.notes.filter(note => {
        if (note.authorPubkey === 'system:transcription:admin') return isAdmin
        if (note.authorPubkey === 'system:transcription') return !isAdmin
        return true
      })
      const canDecrypt = hasDeviceKey && keyManager.isUnlocked()
      const decryptedNotes: DecryptedNote[] = await Promise.all(
        filtered.map(async note => {
          const isTranscription = note.authorPubkey.startsWith('system:transcription')
          let payload: NotePayload
          if (isTranscription && canDecrypt) {
            // Transcriptions are encrypted as messages with reader envelopes in adminEnvelopes
            const text = note.adminEnvelopes?.length
              ? await decryptTranscription(note.encryptedContent, note.adminEnvelopes) || '[Decryption failed]'
              : note.encryptedContent
            payload = { text }
          } else if (isTranscription) {
            payload = { text: note.encryptedContent }
          } else if (canDecrypt) {
            // Decrypt per-note HPKE envelope
            const myPubkey = publicKey ?? ''
            const envelope = isAdmin
              ? note.adminEnvelopes?.find(e => e.pubkey === myPubkey) ?? note.adminEnvelopes?.[0]
              : note.authorEnvelope
            if (envelope) {
              const decryptedJson = await decryptNote(note.encryptedContent, envelope)
              payload = decryptedJson ? JSON.parse(decryptedJson) : { text: '[Decryption failed]' }
            } else {
              payload = await decryptLegacyNote(note.encryptedContent) || { text: '[Decryption failed]' }
            }
          } else {
            payload = { text: '[No key]' }
          }
          return { ...note, decrypted: payload.text, payload, isTranscription }
        })
      )
      setNotes(decryptedNotes)
      setTotal(res.total)
    } catch {
      toast(t('common.error'), 'error')
    } finally {
      setLoading(false)
    }
  }, [page, callId, hasDeviceKey, isAdmin])

  useEffect(() => { loadNotes() }, [loadNotes])

  async function handleSaveEdit(noteId: string, text: string, fields: Record<string, string | number | boolean>) {
    if (!hasDeviceKey || !publicKey || !text.trim()) return
    setSaving(true)
    try {
      const payload: NotePayload = { text }
      if (Object.keys(fields).length > 0) payload.fields = fields
      const authorPub = publicKey
      const adminPub = adminDecryptionPubkey || authorPub
      const { encryptedContent, authorEnvelope, adminEnvelopes } = await encryptNote(JSON.stringify(payload), authorPub, [adminPub])
      const res = await updateNote(noteId, { encryptedContent, authorEnvelope, adminEnvelopes })
      setNotes(prev => prev.map(n =>
        n.id === noteId ? { ...res.note, decrypted: text, payload, isTranscription: n.isTranscription } : n
      ))
      setEditingId(null)
    } catch {
      toast(t('common.error'), 'error')
    } finally {
      setSaving(false)
    }
  }

  async function handleCreateNote(callId: string, text: string, fields: Record<string, string | number | boolean>) {
    if (!hasDeviceKey || !publicKey || !text.trim() || !callId.trim()) return
    // A note about a call belongs to the call's hub, which may not be the active one.
    const hubId = resolveCallHubId(callId, getActiveHub())
    setSaving(true)
    try {
      const payload: NotePayload = { text }
      if (Object.keys(fields).length > 0) payload.fields = fields
      const authorPub = publicKey
      const adminPub = adminDecryptionPubkey || authorPub
      const { encryptedContent, authorEnvelope, adminEnvelopes } = await encryptNote(JSON.stringify(payload), authorPub, [adminPub])
      const res = await createNote({ callId, encryptedContent, authorEnvelope, adminEnvelopes }, hubId)
      setNotes(prev => [{ ...res.note, decrypted: text, payload, isTranscription: false }, ...prev])
      setTotal(prev => prev + 1)
      setShowNewNote(false)
    } catch {
      toast(t('common.error'), 'error')
    } finally {
      setSaving(false)
    }
  }

  function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    navigate({ search: { page: 1, callId, search: searchInput } })
  }

  function setPage(newPage: number) {
    navigate({ search: (prev) => ({ ...prev, page: newPage }) })
  }

  const filteredNotes = search
    ? notes.filter(n => n.decrypted.toLowerCase().includes(search.toLowerCase()))
    : notes

  const notesByCall = filteredNotes.reduce<Record<string, DecryptedNote[]>>((acc, note) => {
    const key = note.callId || note.conversationId || 'unlinked'
    if (!acc[key]) acc[key] = []
    acc[key].push(note)
    return acc
  }, {})

  const totalPages = Math.ceil(total / limit)
  const visibleFields = customFields
    .filter(f => fieldMatchesContext(f, 'call-notes'))
    .filter(f => isAdmin || f.visibleToUsers)

  async function handleExpandThread(noteId: string) {
    if (expandedThreadId === noteId) {
      setExpandedThreadId(null)
      setThreadReplies([])
      setReplyText('')
      return
    }
    setExpandedThreadId(noteId)
    setThreadLoading(true)
    try {
      const res = await listNoteReplies(noteId)
      setThreadReplies(res.replies)
    } catch {
      toast(t('common.error'), 'error')
    } finally {
      setThreadLoading(false)
    }
  }

  async function handleSendReply(noteId: string) {
    if (!replyText.trim() || !hasDeviceKey || !publicKey) return
    setSendingReply(true)
    try {
      const readerPubkeys = [publicKey]
      if (adminDecryptionPubkey && adminDecryptionPubkey !== publicKey) {
        readerPubkeys.push(adminDecryptionPubkey)
      }
      const encrypted = await encryptMessage(replyText.trim(), readerPubkeys)
      const res = await createNoteReply(noteId, {
        encryptedContent: encrypted.encryptedContent,
        readerEnvelopes: encrypted.readerEnvelopes,
      })
      setThreadReplies(prev => [...prev, res.reply])
      setReplyText('')
      // Update reply count in the note list
      setNotes(prev => prev.map(n =>
        n.id === noteId ? { ...n, replyCount: (n.replyCount || 0) + 1 } : n
      ))
    } catch {
      toast(t('common.error'), 'error')
    } finally {
      setSendingReply(false)
    }
  }

  async function handleExport() {
    if (!hasDeviceKey || !keyManager.isUnlocked()) return
    const rows = filteredNotes.map(n => ({
      id: n.id, callId: n.callId, content: n.decrypted, fields: n.payload.fields,
      isTranscription: n.isTranscription, createdAt: n.createdAt, updatedAt: n.updatedAt,
    }))
    const jsonString = JSON.stringify(rows, null, 2)
    const ciphertextHex = await encryptExport(jsonString)
    const binary = new Uint8Array((ciphertextHex.match(/.{2}/g) ?? []).map(b => parseInt(b, 16)))
    const blob = new Blob([binary.buffer as ArrayBuffer], { type: 'application/octet-stream' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `notes-export-${new Date().toISOString().slice(0, 10)}.enc`
    a.click()
    URL.revokeObjectURL(url)
    toast(t('notes.exportEncrypted'), 'success')
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <StickyNote className="h-6 w-6 text-primary" />
            <h1 data-testid="page-title" className="text-xl font-bold sm:text-2xl">{t('notes.title')}</h1>
          </div>
          <p className="mt-1 flex items-center gap-1 text-sm text-muted-foreground">
            <Lock className="h-3 w-3" />
            {t('notes.encryptionNote')}
          </p>
        </div>
        <div className="flex gap-2">
          {isAdmin && (
            <Button data-testid="note-export-btn" variant="outline" size="sm" onClick={handleExport}>
              <Download className="h-4 w-4" />
              {t('notes.export')}
            </Button>
          )}
          <Button data-testid="note-new-btn" onClick={() => setShowNewNote(!showNewNote)}>
            <Plus className="h-4 w-4" />
            {t('notes.newNote')}
          </Button>
        </div>
      </div>

      {/* Search bar */}
      <Card>
        <CardContent className="py-3">
          <form onSubmit={handleSearch} className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex-1">
              <label className="mb-1 block text-xs text-muted-foreground">{t('notes.searchNotes')}</label>
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  data-testid="note-search"
                  value={searchInput}
                  onChange={e => setSearchInput(e.target.value)}
                  placeholder={t('notes.searchPlaceholder')}
                  className="pl-9"
                />
              </div>
            </div>
            <div className="flex gap-2">
              <Button data-testid="note-search-btn" type="submit" size="sm" aria-label={t('a11y.searchButton')}>
                <Search className="h-4 w-4" />
              </Button>
              {(search || callId) && (
                <Button
                  data-testid="note-clear-filters"
                  type="button" variant="ghost" size="sm"
                  onClick={() => { setSearchInput(''); navigate({ search: { page: 1, callId: '', search: '' } }) }}
                  aria-label={t('a11y.clearFilters')}
                >
                  <X className="h-4 w-4" />
                </Button>
              )}
            </div>
          </form>
        </CardContent>
      </Card>

      {/* New note form */}
      {showNewNote && (
        <NewNoteForm
          recentCalls={recentCalls}
          customFieldDefs={visibleFields}
          saving={saving}
          onSave={handleCreateNote}
          onCancel={() => setShowNewNote(false)}
        />
      )}

      {loading ? (
        <Card>
          <CardContent className="space-y-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="space-y-2">
                <div className="h-4 w-40 animate-pulse rounded bg-muted" />
                <div className="h-3 w-full animate-pulse rounded bg-muted" />
                <div className="h-3 w-3/4 animate-pulse rounded bg-muted" />
              </div>
            ))}
          </CardContent>
        </Card>
      ) : Object.keys(notesByCall).length === 0 ? (
        <Card data-testid="empty-state">
          <CardContent>
            <div className="py-8 text-center text-muted-foreground">
              <StickyNote className="mx-auto mb-2 h-8 w-8 opacity-40" />
              {search ? t('notes.noSearchResults') : t('notes.noNotes')}
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4" data-testid="note-list">
          {Object.entries(notesByCall).map(([cId, callNotes]) => (
            <Card key={cId} data-testid="note-group">
              <CardHeader className="border-b py-3">
                <CardTitle className="text-sm">
                  {(() => {
                    const callInfo = callInfoMap.get(cId)
                    if (!callInfo) return t('notes.callWith', { number: cId.slice(0, 12) + '...' })
                    const answeredBy = callInfo.answeredBy
                    const volunteerName = answeredBy ? nameMap.get(answeredBy) : null
                    const phone = callInfo.callerLast4 ? `***${callInfo.callerLast4}` : ''
                    return (
                      <span className="flex flex-wrap items-center gap-1.5">
                        {callInfo.status === 'unanswered' ? (
                          <span className="text-destructive">{t('callHistory.unanswered')}</span>
                        ) : volunteerName && isAdmin && answeredBy ? (
                          <Link to="/users/$pubkey" params={{ pubkey: answeredBy }} className="text-primary hover:underline">
                            {volunteerName}
                          </Link>
                        ) : volunteerName ? (
                          <span>{volunteerName}</span>
                        ) : (
                          <span>{t('callHistory.answeredBy')}</span>
                        )}
                        {phone && (
                          <>
                            <span className="text-muted-foreground">&middot;</span>
                            <code className="text-xs font-mono text-muted-foreground">{phone}</code>
                          </>
                        )}
                        <span className="text-muted-foreground">&middot;</span>
                        <span className="text-xs text-muted-foreground font-normal">
                          {new Date(callInfo.startedAt).toLocaleString()}
                        </span>
                      </span>
                    )
                  })()}
                </CardTitle>
                {callInfoMap.get(cId)?.hasRecording && (
                  <div className="mt-2">
                    <RecordingPlayer callId={cId} />
                  </div>
                )}
              </CardHeader>
              <CardContent className="p-0 divide-y divide-border">
                {callNotes.map(note => (
                  <div key={note.id} data-testid="note-card" className="px-6 py-4">
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <p className="text-xs text-muted-foreground">
                            {new Date(note.createdAt).toLocaleString()}
                            {note.authorPubkey && !note.authorPubkey.startsWith('system:') && (
                              <span className="ml-1.5 font-mono opacity-60" title={note.authorPubkey}>
                                {nameMap.get(note.authorPubkey) || note.authorPubkey.slice(0, 8)}
                              </span>
                            )}
                          </p>
                          {note.isTranscription && (
                            <Badge variant="secondary">
                              <Mic className="h-3 w-3" />
                              {t('transcription.title')}
                            </Badge>
                          )}
                          {note.conversationId && (
                            <Badge variant="outline" className="text-[10px]">
                              <MessageCircle className="h-3 w-3" />
                              {t('notes.conversationNote', { defaultValue: 'Conversation' })}
                            </Badge>
                          )}
                        </div>
                        {editingId === note.id ? (
                          <NoteEditForm
                            text={note.decrypted}
                            fields={note.payload.fields || {}}
                            customFieldDefs={visibleFields}
                            saving={saving}
                            onSave={(text, fields) => handleSaveEdit(note.id, text, fields)}
                            onCancel={() => setEditingId(null)}
                          />
                        ) : (
                          <>
                            <p data-testid="note-detail-text" className="mt-2 text-sm whitespace-pre-wrap">{note.decrypted}</p>
                            {note.payload.fields && visibleFields.length > 0 && (
                              <CustomFieldBadges fields={visibleFields} values={note.payload.fields} />
                            )}
                          </>
                        )}
                      </div>
                      <div className="flex items-center gap-1">
                        {editingId !== note.id && (
                          <Button
                            data-testid="note-edit-btn"
                            variant="ghost" size="icon-xs"
                            onClick={() => setEditingId(note.id)}
                            aria-label={t('a11y.editItem')}
                          >
                            <Pencil className="h-3 w-3" />
                          </Button>
                        )}
                      </div>
                    </div>

                    {/* Reply count + expand thread */}
                    <div className="mt-2 flex items-center gap-2">
                      <Button
                        variant="ghost" size="sm"
                        className="text-xs text-muted-foreground"
                        data-testid="note-reply-btn"
                        onClick={() => handleExpandThread(note.id)}
                      >
                        <MessageCircle className="h-3 w-3" />
                        {(note.replyCount || 0) > 0
                          ? t('notes.repliesCount', { count: note.replyCount, defaultValue: '{{count}} replies' })
                          : t('notes.reply', { defaultValue: 'Reply' })}
                      </Button>
                    </div>

                    {/* Expanded thread */}
                    {expandedThreadId === note.id && (
                      <div className="mt-3 rounded-lg border border-border bg-muted/30 p-3" data-testid="note-thread">
                        <ConversationThread
                          conversationId={note.id}
                          messages={threadReplies}
                          isLoading={threadLoading}
                          compact
                        />
                        {/* Reply composer */}
                        <div className="mt-3 flex gap-2">
                          <Textarea
                            data-testid="note-reply-text"
                            value={replyText}
                            onChange={e => setReplyText(e.target.value)}
                            placeholder={t('notes.replyPlaceholder', { defaultValue: 'Write a reply...' })}
                            rows={2}
                            className="flex-1 resize-none text-sm"
                            onKeyDown={e => {
                              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                                e.preventDefault()
                                handleSendReply(note.id)
                              }
                            }}
                          />
                          <Button
                            size="sm"
                            data-testid="note-reply-send"
                            disabled={sendingReply || !replyText.trim()}
                            onClick={() => handleSendReply(note.id)}
                          >
                            <Send className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <Button data-testid="pagination-prev" variant="outline" size="sm" onClick={() => setPage(Math.max(1, page - 1))} disabled={page === 1}>
            <ChevronLeft className="h-4 w-4" />
            {t('common.back')}
          </Button>
          <span data-testid="pagination-info" className="text-sm text-muted-foreground">{page} / {totalPages}</span>
          <Button data-testid="pagination-next" variant="outline" size="sm" onClick={() => setPage(Math.min(totalPages, page + 1))} disabled={page === totalPages}>
            {t('common.next')}
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  )
}
