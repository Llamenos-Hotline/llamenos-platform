import { request, hubPath, activeHubPath, NoActiveHubError } from './client'
import type { EncryptedNote, CreateNoteBody, CreateReplyBody, NoteListResponse, NoteRepliesResponse, NoteReplyStoredResponse, NoteStoredResponse, UpdateNoteBody } from '@protocol/schemas'

export type { EncryptedNote }

// --- Notes ---

export async function listNotes(params?: { callId?: string; conversationId?: string; contactHash?: string; page?: number; limit?: number }) {
  const qs = new URLSearchParams()
  if (params?.callId) qs.set('callId', params.callId)
  if (params?.conversationId) qs.set('conversationId', params.conversationId)
  if (params?.contactHash) qs.set('contactHash', params.contactHash)
  if (params?.page) qs.set('page', String(params.page))
  if (params?.limit) qs.set('limit', String(params.limit))
  return request<NoteListResponse>(activeHubPath(`/notes?${qs}`))
}

export async function createNote(data: CreateNoteBody, hubId: string | null) {
  // A note belongs to the hub of the call/conversation it is about, which may not be
  // the active one (multi-hub axiom). `hubId` is therefore required: omitting it is a
  // type error instead of a silent filing into the active hub. With no hub known there
  // is nowhere to file it: notes have no unscoped route (#2395).
  if (!hubId) throw new NoActiveHubError('/notes')
  return request<NoteStoredResponse>(hubPath(hubId, '/notes'), {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function updateNote(id: string, data: UpdateNoteBody) {
  return request<NoteStoredResponse>(activeHubPath(`/notes/${id}`), {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

// Note replies (Epic 123)
export async function listNoteReplies(noteId: string) {
  return request<NoteRepliesResponse>(activeHubPath(`/notes/${noteId}/replies`))
}

export async function createNoteReply(noteId: string, data: CreateReplyBody) {
  return request<NoteReplyStoredResponse>(activeHubPath(`/notes/${noteId}/replies`), {
    method: 'POST',
    body: JSON.stringify(data),
  })
}
