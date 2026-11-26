import { DeletionConfirmed } from '@/lib/admin-deletion'
import { request, activeHubPath } from './client'
import type { Conversation, ConversationMessage, MessageListResponse, Report, CreateReportBody, CreateReportTypeBody, OkResponse, ReportCategoriesResponse, ReportFilesResponse, ReportListResponse, ReportMessageBody, ReportTypeListResponse, ReportTypeResponse, UpdateReportBody, UpdateReportTypeBody } from '@protocol/schemas'

/** Narrowing of ConversationMessage conversionStatus enum from conversationResponseSchema */
export type ConversionStatus = NonNullable<NonNullable<Conversation['metadata']>['conversionStatus']>

export type { Report }

// --- Reports ---

export async function listReports(params?: { status?: string; category?: string; page?: number; limit?: number }) {
  const qs = new URLSearchParams()
  if (params?.status) qs.set('status', params.status)
  if (params?.category) qs.set('category', params.category)
  if (params?.page) qs.set('page', String(params.page))
  if (params?.limit) qs.set('limit', String(params.limit))
  return request<ReportListResponse>(activeHubPath(`/reports?${qs}`))
}

export async function createReport(data: CreateReportBody) {
  return request<Report>(activeHubPath('/reports'), {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function getReport(id: string) {
  return request<Report>(activeHubPath(`/reports/${id}`))
}

export async function getReportMessages(id: string, params?: { page?: number; limit?: number }) {
  const qs = new URLSearchParams()
  if (params?.page) qs.set('page', String(params.page))
  if (params?.limit) qs.set('limit', String(params.limit))
  return request<MessageListResponse>(activeHubPath(`/reports/${id}/messages?${qs}`))
}

export async function sendReportMessage(id: string, data: ReportMessageBody) {
  return request<ConversationMessage>(activeHubPath(`/reports/${id}/messages`), {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function assignReport(id: string, assignedTo: string) {
  return request<Report>(activeHubPath(`/reports/${id}/assign`), {
    method: 'POST',
    body: JSON.stringify({ assignedTo }),
  })
}

export async function updateReport(id: string, data: UpdateReportBody) {
  return request<Report>(activeHubPath(`/reports/${id}`), {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

export async function getReportCategories() {
  return request<ReportCategoriesResponse>(activeHubPath('/reports/categories'))
}

// --- Report Types ---

export async function getReportTypes() {
  return request<ReportTypeListResponse>(activeHubPath('/reports/types'))
}

// The admin report-type vocabulary is deployment-wide: it exists only at the
// unscoped `/settings/report-types`, never under a hub (#2367).
export async function getReportTypesAdmin() {
  return request<ReportTypeListResponse>('/settings/report-types')
}

export async function createReportType(data: CreateReportTypeBody) {
  return request<ReportTypeResponse>('/settings/report-types', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function updateReportType(id: string, data: UpdateReportTypeBody) {
  return request<ReportTypeResponse>(`/settings/report-types/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

/** Archive a report type. Requires the admin's confirmation of exactly this type (#2575). */
export async function archiveReportType(id: string, confirmed: DeletionConfirmed) {
  DeletionConfirmed.require(confirmed, 'reportCategory', id)
  return request<OkResponse>(`/settings/report-types/${id}`, {
    method: 'DELETE',
  })
}

export async function getReportFiles(id: string) {
  return request<ReportFilesResponse>(activeHubPath(`/reports/${id}/files`))
}
