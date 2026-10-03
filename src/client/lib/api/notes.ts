import { request, hp, hubPath } from './client'
import type { EncryptedNote, ConversationMessage } from '@protocol/schemas'

export type { EncryptedNote }

// --- Notes ---

export async function listNotes(params?: { callId?: string; conversationId?: string; contactHash?: string; page?: number; limit?: number }) {
  const qs = new URLSearchParams()
  if (params?.callId) qs.set('callId', params.callId)
  if (params?.conversationId) qs.set('conversationId', params.conversationId)
  if (params?.contactHash) qs.set('contactHash', params.contactHash)
  if (params?.page) qs.set('page', String(params.page))
  if (params?.limit) qs.set('limit', String(params.limit))
  return request<{ notes: EncryptedNote[]; total: number }>(hp(`/notes?${qs}`))
}

export async function createNote(data: {
  callId?: string
  conversationId?: string
  contactHash?: string
  encryptedContent: string
  authorEnvelope?: import('@shared/types').KeyEnvelope
  adminEnvelopes?: import('@shared/types').RecipientEnvelope[]
}, hubId: string | null) {
  // A note belongs to the hub of the call/conversation it is about, which may not be
  // the active one (multi-hub axiom). `hubId` is therefore required: omitting it is a
  // type error instead of a silent filing into the active hub. `null` is only for an
  // instance with no hub scope at all.
  return request<{ note: EncryptedNote }>(hubId ? hubPath(hubId, '/notes') : '/notes', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function updateNote(id: string, data: {
  encryptedContent: string
  authorEnvelope?: import('@shared/types').KeyEnvelope
  adminEnvelopes?: import('@shared/types').RecipientEnvelope[]
}) {
  return request<{ note: EncryptedNote }>(hp(`/notes/${id}`), {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

// Note replies (Epic 123)
export async function listNoteReplies(noteId: string) {
  return request<{ replies: ConversationMessage[] }>(hp(`/notes/${noteId}/replies`))
}

export async function createNoteReply(noteId: string, data: {
  encryptedContent: string
  readerEnvelopes: import('@shared/types').RecipientEnvelope[]
}) {
  return request<{ reply: ConversationMessage }>(hp(`/notes/${noteId}/replies`), {
    method: 'POST',
    body: JSON.stringify(data),
  })
}
