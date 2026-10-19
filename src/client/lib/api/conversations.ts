import { request, hp, hubPath } from './client'
import type { Conversation, ConversationMessage } from '@protocol/schemas'

export type { Conversation, ConversationMessage }

/** A conversation together with the hub it belongs to (the server rows do not carry it). */
export type HubConversation = Conversation & { hubId: string }

export type MessageDeliveryStatus = 'pending' | 'sent' | 'delivered' | 'read' | 'failed'

/** @deprecated Import RecipientEnvelope from @shared/types instead. */
export type { RecipientEnvelope as MessageKeyEnvelope } from '@shared/types'

// --- Conversations ---
// Conversations belong to a specific hub. Every call below that acts on one takes its hub
// explicitly — never the active hub — because the user receives conversations from every
// hub they belong to while browsing only one (multi-hub axiom).

export async function listConversations(hubId: string, params?: {
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
  const res = await request<{
    conversations: Conversation[]
    total?: number
    assignedCount?: number
    waitingCount?: number
  }>(hubPath(hubId, `/conversations?${qs}`))
  return { ...res, conversations: res.conversations.map((c): HubConversation => ({ ...c, hubId })) }
}

export async function getConversation(id: string) {
  return request<Conversation>(hp(`/conversations/${id}`))
}

export async function getConversationMessages(hubId: string, id: string, params?: { page?: number; limit?: number }) {
  const qs = new URLSearchParams()
  if (params?.page) qs.set('page', String(params.page))
  if (params?.limit) qs.set('limit', String(params.limit))
  return request<{ messages: ConversationMessage[]; total: number }>(hubPath(hubId, `/conversations/${id}/messages?${qs}`))
}

export async function sendConversationMessage(hubId: string, id: string, data: {
  encryptedContent: string
  readerEnvelopes: import('@shared/types').RecipientEnvelope[]
  plaintextForSending?: string
}) {
  return request<ConversationMessage>(hubPath(hubId, `/conversations/${id}/messages`), {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function claimConversation(hubId: string, id: string): Promise<HubConversation> {
  const conversation = await request<Conversation>(hubPath(hubId, `/conversations/${id}/claim`), { method: 'POST' })
  return { ...conversation, hubId }
}

export async function updateConversation(hubId: string, id: string, data: { status?: string; assignedTo?: string }): Promise<HubConversation> {
  const conversation = await request<Conversation>(hubPath(hubId, `/conversations/${id}`), {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
  return { ...conversation, hubId }
}

export async function getConversationStats() {
  return request<{ waiting: number; active: number; closed: number; today: number; total: number }>(hp('/conversations/stats'))
}

export async function getUserLoads(hubId: string) {
  return request<{ loads: Record<string, number> }>(hubPath(hubId, '/conversations/load'))
}
