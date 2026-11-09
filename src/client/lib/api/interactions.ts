import { request, activeHubPath } from './client'
import type { CaseInteraction } from '@protocol/schemas/interactions'
import type { RecipientEnvelope } from '@shared/types'

export type InteractionType = CaseInteraction['interactionType']

export type { CaseInteraction }

// --- Case Interactions (Epic 332 — Timeline) ---

export async function listInteractions(recordId: string, params?: {
  interactionTypeHash?: string
  after?: string
  before?: string
  page?: number
  limit?: number
}) {
  const qs = new URLSearchParams()
  if (params?.interactionTypeHash) qs.set('interactionTypeHash', params.interactionTypeHash)
  if (params?.after) qs.set('after', params.after)
  if (params?.before) qs.set('before', params.before)
  qs.set('page', String(params?.page ?? 1))
  qs.set('limit', String(params?.limit ?? 50))
  return request<{
    interactions: CaseInteraction[]
    total: number
    page: number
    limit: number
    hasMore: boolean
  }>(activeHubPath(`/records/${recordId}/interactions?${qs}`))
}

export async function createInteraction(recordId: string, body: {
  interactionType: InteractionType
  sourceId?: string
  encryptedContent?: string
  contentEnvelopes?: RecipientEnvelope[]
  interactionTypeHash: string
  previousStatusHash?: string
  newStatusHash?: string
}) {
  return request<CaseInteraction>(activeHubPath(`/records/${recordId}/interactions`), {
    method: 'POST',
    body: JSON.stringify(body),
  })
}
