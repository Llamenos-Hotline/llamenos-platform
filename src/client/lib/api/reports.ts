import { request, hp } from './client'
import type { Conversation, ConversationMessage } from '@protocol/schemas'

/** Narrowing of ConversationMessage conversionStatus enum from conversationResponseSchema */
export type ConversionStatus = NonNullable<NonNullable<Conversation['metadata']>['conversionStatus']>

/** Narrowing of Conversation where metadata is required and type is 'report' */
export type Report = Conversation & {
  metadata: NonNullable<Conversation['metadata']> & { type: 'report' }
}

// --- Reports ---

export async function listReports(params?: { status?: string; category?: string; page?: number; limit?: number }) {
  const qs = new URLSearchParams()
  if (params?.status) qs.set('status', params.status)
  if (params?.category) qs.set('category', params.category)
  if (params?.page) qs.set('page', String(params.page))
  if (params?.limit) qs.set('limit', String(params.limit))
  return request<{ conversations: Report[]; total: number }>(hp(`/reports?${qs}`))
}

export async function createReport(data: {
  title: string
  category?: string
  reportTypeId?: string
  encryptedContent: string
  readerEnvelopes: import('@shared/types').RecipientEnvelope[]
}) {
  return request<Report>(hp('/reports'), {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function getReport(id: string) {
  return request<Report>(hp(`/reports/${id}`))
}

export async function getReportMessages(id: string, params?: { page?: number; limit?: number }) {
  const qs = new URLSearchParams()
  if (params?.page) qs.set('page', String(params.page))
  if (params?.limit) qs.set('limit', String(params.limit))
  return request<{ messages: ConversationMessage[]; total: number }>(hp(`/reports/${id}/messages?${qs}`))
}

export async function sendReportMessage(id: string, data: {
  encryptedContent: string
  readerEnvelopes: import('@shared/types').RecipientEnvelope[]
  attachmentIds?: string[]
}) {
  return request<ConversationMessage>(hp(`/reports/${id}/messages`), {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function assignReport(id: string, assignedTo: string) {
  return request<Report>(hp(`/reports/${id}/assign`), {
    method: 'POST',
    body: JSON.stringify({ assignedTo }),
  })
}

export async function updateReport(id: string, data: { status?: string }) {
  return request<Report>(hp(`/reports/${id}`), {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

export async function getReportCategories() {
  return request<{ categories: string[] }>(hp('/reports/categories'))
}

// --- Report Types ---

export async function getReportTypes() {
  return request<{ reportTypes: import('@shared/types').ReportType[] }>(hp('/reports/types'))
}

// The admin report-type vocabulary is deployment-wide: it exists only at the
// unscoped `/settings/report-types`, never under a hub (#2367).
export async function getReportTypesAdmin() {
  return request<{ reportTypes: import('@shared/types').ReportType[] }>('/settings/report-types')
}

export async function createReportType(data: {
  name: string
  description?: string
  icon?: string
  fields?: import('@shared/types').CustomFieldDefinition[]
  isDefault?: boolean
}) {
  return request<import('@shared/types').ReportType>('/settings/report-types', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function updateReportType(id: string, data: Partial<import('@shared/types').ReportType>) {
  return request<import('@shared/types').ReportType>(`/settings/report-types/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

export async function archiveReportType(id: string) {
  return request<{ ok: boolean }>(`/settings/report-types/${id}`, {
    method: 'DELETE',
  })
}

export async function getReportFiles(id: string) {
  return request<{ files: import('@shared/types').FileRecord[] }>(hp(`/reports/${id}/files`))
}
