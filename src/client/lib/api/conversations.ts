import { request, hp, hubPath } from './client'
import type {
  AddAssigneeEnvelopesBody,
  AddAssigneeEnvelopesResponse,
  AssigneeEnvelopeGapsResponse,
  Conversation,
  ConversationListResponse,
  ConversationMessage,
} from '@protocol/schemas'

export type { Conversation, ConversationMessage }

export type MessageDeliveryStatus = 'pending' | 'sent' | 'delivered' | 'read' | 'failed'

/** @deprecated Import RecipientEnvelope from @shared/types instead. */
export type { RecipientEnvelope as MessageKeyEnvelope } from '@shared/types'

// --- Conversations ---

export async function listConversations(params?: {
  status?: string
  channel?: string
  page?: number
  limit?: number
}) {
  const qs = new URLSearchParams()
  if (params?.status) qs.set('status', params.status)
  if (params?.channel) qs.set('channel', params.channel)
  if (params?.page) qs.set('page', String(params.page))
  if (params?.limit) qs.set('limit', String(params.limit))
  return request<{
    conversations: Conversation[]
    total?: number
    assignedCount?: number
    waitingCount?: number
  }>(hp(`/conversations?${qs}`))
}

export async function getConversation(id: string) {
  return request<Conversation>(hp(`/conversations/${id}`))
}

export async function getConversationMessages(id: string, params?: { page?: number; limit?: number }) {
  const qs = new URLSearchParams()
  if (params?.page) qs.set('page', String(params.page))
  if (params?.limit) qs.set('limit', String(params.limit))
  return request<{ messages: ConversationMessage[]; total: number }>(hp(`/conversations/${id}/messages?${qs}`))
}

export async function sendConversationMessage(id: string, data: {
  encryptedContent: string
  readerEnvelopes: import('@shared/types').RecipientEnvelope[]
  plaintextForSending?: string
}) {
  return request<ConversationMessage>(hp(`/conversations/${id}/messages`), {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function claimConversation(id: string) {
  return request<Conversation>(hp(`/conversations/${id}/claim`), { method: 'POST' })
}

export async function updateConversation(id: string, data: { status?: string; assignedTo?: string }) {
  return request<Conversation>(hp(`/conversations/${id}`), {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

export async function getConversationStats() {
  return request<{ waiting: number; active: number; closed: number; today: number; total: number }>(hp('/conversations/stats'))
}

export async function getUserLoads() {
  return request<{ loads: Record<string, number> }>(hp('/conversations/load'))
}

// --- Assignee re-wrap (#1512, #2046) ---
//
// Hub-explicit, never `hp()`: a re-wrap answers an assignment event from
// whichever member hub published it, not the hub the user is browsing.

/**
 * Active conversations in `hubId` — the set an admin client sweeps for
 * assignee envelope gaps when it comes online.
 */
export async function listActiveConversationsInHub(hubId: string, page: number, limit: number) {
  const qs = new URLSearchParams({ status: 'active', page: String(page), limit: String(limit) })
  return request<Pick<ConversationListResponse, 'conversations' | 'total'>>(hubPath(hubId, `/conversations?${qs}`))
}

/** Messages the current assignee cannot open yet (≤ 200, oldest first). */
export async function getAssigneeEnvelopeGaps(hubId: string, conversationId: string) {
  return request<AssigneeEnvelopeGapsResponse>(
    hubPath(hubId, `/conversations/${conversationId}/assignee-envelopes`),
  )
}

/** Append client-sealed envelopes for the current assignee. All-or-nothing. */
export async function addAssigneeEnvelopes(hubId: string, conversationId: string, body: AddAssigneeEnvelopesBody) {
  return request<AddAssigneeEnvelopesResponse>(
    hubPath(hubId, `/conversations/${conversationId}/assignee-envelopes`),
    { method: 'POST', body: JSON.stringify(body) },
  )
}
