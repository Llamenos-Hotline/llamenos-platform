import { request, hp } from './client'
import type { Subscriber, Blast as StoredBlast, BlastSettings, BlastStats, BlastDelivery, BlastDeliveryStatus } from '@shared/types'
import type { SingleBlastContent, MultiBlastContent } from '@protocol/schemas/blasts'

export type { Subscriber, BlastSettings, BlastStats, BlastDelivery, BlastDeliveryStatus, SingleBlastContent, MultiBlastContent }

/**
 * A blast as the server answers it: content on the wire shape (`{ body, mediaUrl? }`
 * or a record of those by language), which is what `blastResponseSchema` declares
 * and what Android decodes. `@shared/types` `Blast` carries the storage shape
 * (`{ text }`), which no response ever has (#2572).
 */
export type Blast = Omit<StoredBlast, 'content'> & { content: SingleBlastContent | MultiBlastContent }

/** True for single-language wire content (a `body` string), false for a record by language. */
export function isSingleBlastContent(content: Blast['content']): content is SingleBlastContent {
  return typeof (content as Partial<SingleBlastContent>).body === 'string'
}

// --- Blasts ---

export async function listSubscribers(params?: { tag?: string; channel?: string; status?: string }) {
  const searchParams = new URLSearchParams()
  if (params?.tag) searchParams.set('tag', params.tag)
  if (params?.channel) searchParams.set('channel', params.channel)
  if (params?.status) searchParams.set('status', params.status)
  const qs = searchParams.toString()
  return request<{ subscribers: Subscriber[] }>(hp(`/blasts/subscribers${qs ? `?${qs}` : ''}`))
}

export async function importSubscribers(data: { subscribers: Array<{ identifier: string; channel: string; tags?: string[]; language?: string }> }) {
  return request<{ imported: number; skipped: number }>(hp('/blasts/subscribers/import'), {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function removeSubscriber(id: string) {
  return request<{ ok: boolean }>(hp(`/blasts/subscribers/${id}`), { method: 'DELETE' })
}

export async function getSubscriberStats() {
  return request<{ total: number; active: number; paused: number; byChannel: Record<string, number> }>(hp('/blasts/subscribers/stats'))
}

export async function listBlasts() {
  return request<{ blasts: Blast[] }>(hp('/blasts'))
}

export async function createBlast(data: { name: string; content: { body: string; mediaUrl?: string } | Record<string, { body: string; mediaUrl?: string }>; defaultLanguage?: string; channels: string[]; targetTags?: string[]; targetLanguages?: string[]; scheduledAt?: string }) {
  return request<{ blast: Blast }>(hp('/blasts'), {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function updateBlast(id: string, data: Partial<Blast>) {
  return request<{ blast: Blast }>(hp(`/blasts/${id}`), {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

export async function deleteBlast(id: string) {
  return request<{ ok: boolean }>(hp(`/blasts/${id}`), { method: 'DELETE' })
}

export async function sendBlast(id: string) {
  return request<{ blast: Blast }>(hp(`/blasts/${id}/send`), { method: 'POST' })
}

export async function scheduleBlast(id: string, scheduledAt: string) {
  return request<{ blast: Blast }>(hp(`/blasts/${id}/schedule`), {
    method: 'POST',
    body: JSON.stringify({ scheduledAt }),
  })
}

export async function cancelBlast(id: string) {
  return request<{ blast: Blast }>(hp(`/blasts/${id}/cancel`), { method: 'POST' })
}

export async function getBlastStats(id: string) {
  return request<BlastStats>(hp(`/blasts/${id}/stats`))
}

export async function getBlastDeliveries(id: string, opts?: { status?: BlastDeliveryStatus; page?: number; limit?: number }) {
  const params = new URLSearchParams()
  if (opts?.status) params.set('status', opts.status)
  if (opts?.page) params.set('page', String(opts.page))
  if (opts?.limit) params.set('limit', String(opts.limit))
  const qs = params.toString()
  return request<{ deliveries: BlastDelivery[]; total: number; page: number; limit: number }>(
    hp(`/blasts/${id}/deliveries${qs ? `?${qs}` : ''}`)
  )
}

export async function retryBlastDelivery(blastId: string, deliveryId: string) {
  return request<{ ok: boolean; delivery: BlastDelivery }>(hp(`/blasts/${blastId}/deliveries/${deliveryId}/retry`), {
    method: 'POST',
  })
}

export async function retryAllFailedDeliveries(blastId: string) {
  return request<{ ok: boolean; retriedCount: number }>(hp(`/blasts/${blastId}/retry-failed`), {
    method: 'POST',
  })
}

export async function getBlastSettings() {
  return request<BlastSettings>(hp('/blasts/settings'))
}

export async function updateBlastSettings(data: Partial<BlastSettings>) {
  return request<BlastSettings>(hp('/blasts/settings'), {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}
