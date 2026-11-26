import { request, hp } from './client'
import type { Blast, BlastDelivery, BlastDeliveryListResponse, BlastSettings, BlastStats, Subscriber, RetryDeliveryResponse, RetryFailedResponse, BlastEnvelopeResponse, BlastListResponse, CreateBlastBody, ImportSubscribersBody, ImportSubscribersResponse, OkResponse, SubscriberListResponse, SubscriberStatsResponse, UpdateBlastBody, UpdateBlastSettingsBody } from '@protocol/schemas'

export type { Subscriber, Blast, BlastSettings, BlastStats, BlastDelivery, SubscriberStatsResponse }
export type BlastDeliveryStatus = BlastDelivery['status']

// --- Blasts ---

export async function listSubscribers(params?: { tag?: string; channel?: string; status?: string }) {
  const searchParams = new URLSearchParams()
  if (params?.tag) searchParams.set('tag', params.tag)
  if (params?.channel) searchParams.set('channel', params.channel)
  if (params?.status) searchParams.set('status', params.status)
  const qs = searchParams.toString()
  return request<SubscriberListResponse>(hp(`/blasts/subscribers${qs ? `?${qs}` : ''}`))
}

export async function importSubscribers(data: ImportSubscribersBody) {
  return request<ImportSubscribersResponse>(hp('/blasts/subscribers/import'), {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function removeSubscriber(id: string) {
  return request<OkResponse>(hp(`/blasts/subscribers/${id}`), { method: 'DELETE' })
}

export async function getSubscriberStats() {
  return request<SubscriberStatsResponse>(hp('/blasts/subscribers/stats'))
}

export async function listBlasts() {
  return request<BlastListResponse>(hp('/blasts'))
}

export async function createBlast(data: CreateBlastBody) {
  return request<BlastEnvelopeResponse>(hp('/blasts'), {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function updateBlast(id: string, data: UpdateBlastBody) {
  return request<BlastEnvelopeResponse>(hp(`/blasts/${id}`), {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

export async function deleteBlast(id: string) {
  return request<OkResponse>(hp(`/blasts/${id}`), { method: 'DELETE' })
}

export async function sendBlast(id: string) {
  return request<BlastEnvelopeResponse>(hp(`/blasts/${id}/send`), { method: 'POST' })
}

export async function scheduleBlast(id: string, scheduledAt: string) {
  return request<BlastEnvelopeResponse>(hp(`/blasts/${id}/schedule`), {
    method: 'POST',
    body: JSON.stringify({ scheduledAt }),
  })
}

export async function cancelBlast(id: string) {
  return request<BlastEnvelopeResponse>(hp(`/blasts/${id}/cancel`), { method: 'POST' })
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
  return request<BlastDeliveryListResponse>(
    hp(`/blasts/${id}/deliveries${qs ? `?${qs}` : ''}`)
  )
}

export async function retryBlastDelivery(blastId: string, deliveryId: string) {
  return request<RetryDeliveryResponse>(hp(`/blasts/${blastId}/deliveries/${deliveryId}/retry`), {
    method: 'POST',
  })
}

export async function retryAllFailedDeliveries(blastId: string) {
  return request<RetryFailedResponse>(hp(`/blasts/${blastId}/retry-failed`), {
    method: 'POST',
  })
}

export async function getBlastSettings() {
  return request<BlastSettings>(hp('/blasts/settings'))
}

export async function updateBlastSettings(data: UpdateBlastSettingsBody) {
  return request<BlastSettings>(hp('/blasts/settings'), {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}
