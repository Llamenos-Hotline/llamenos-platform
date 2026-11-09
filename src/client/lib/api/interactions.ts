import { request, hp, hubPath } from './client'
import type { CaseInteraction } from '@protocol/schemas/interactions'
import type { RecipientEnvelope } from '@shared/types'

export type InteractionType = CaseInteraction['interactionType']

export type { CaseInteraction }

// --- Case Interactions (Epic 332 — Timeline) ---

/** A record's own hub when known, else the hub being browsed. */
function recordPath(hubId: string | undefined, path: string): string {
  return hubId ? hubPath(hubId, path) : hp(path)
}

export async function listInteractions(recordId: string, params?: {
  interactionTypeHash?: string
  after?: string
  before?: string
  page?: number
  limit?: number
}, hubId?: string) {
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
  }>(recordPath(hubId, `/records/${recordId}/interactions?${qs}`))
}

/**
 * `hubId` is the record's own hub (`record.hubId`). Required: a comment is
 * sealed to that hub's admins, so it must also be filed in it.
 */
export async function createInteraction(recordId: string, hubId: string, body: {
  interactionType: InteractionType
  sourceId?: string
  encryptedContent?: string
  contentEnvelopes?: RecipientEnvelope[]
  interactionTypeHash: string
  previousStatusHash?: string
  newStatusHash?: string
}) {
  return request<CaseInteraction>(hubPath(hubId, `/records/${recordId}/interactions`), {
    method: 'POST',
    body: JSON.stringify(body),
  })
}
