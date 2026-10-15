import { request, hp } from './client'
import type { CaseRecord, RecordContact, CreateRecordBody, UpdateRecordBody } from '@protocol/schemas/records'
import type { MergeRecordsBody, MergeRecordsResponse } from '@protocol/schemas/entity-merge'
import type { AssignmentSuggestion } from '@protocol/schemas'

export type { CaseRecord, RecordContact, CreateRecordBody, UpdateRecordBody }
export type { AssignmentSuggestion }

// --- Case Records (Epic 330) ---

export async function listRecords(params?: {
  entityTypeId?: string
  statusHash?: string
  severityHash?: string
  assignedTo?: string
  page?: number
  limit?: number
}) {
  const qs = new URLSearchParams()
  if (params?.entityTypeId) qs.set('entityTypeId', params.entityTypeId)
  if (params?.statusHash) qs.set('statusHash', params.statusHash)
  if (params?.severityHash) qs.set('severityHash', params.severityHash)
  if (params?.assignedTo) qs.set('assignedTo', params.assignedTo)
  if (params?.page) qs.set('page', String(params.page))
  qs.set('limit', String(params?.limit ?? 50))
  return request<{ records: CaseRecord[]; total: number; page: number; limit: number; hasMore: boolean }>(hp(`/records?${qs}`))
}

export async function getRecord(id: string) {
  return request<CaseRecord>(hp(`/records/${id}`))
}

export async function createRecord(body: CreateRecordBody) {
  return request<CaseRecord>(hp('/records'), {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function updateRecord(id: string, body: UpdateRecordBody) {
  return request<CaseRecord>(hp(`/records/${id}`), {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export async function deleteRecord(id: string) {
  return request<{ ok: boolean }>(hp(`/records/${id}`), { method: 'DELETE' })
}

// --- Event linking (cases ↔ events, reports ↔ events) ---

export type EventRecordLink = { recordId: string; eventId: string; linkedAt: string; linkedBy: string }
export type EventReportLink = { reportId: string; eventId: string; linkedAt: string; linkedBy: string }

export async function listEventLinkedRecords(eventId: string) {
  return request<{ links: EventRecordLink[] }>(hp(`/events/${eventId}/records`))
}

export async function listEventLinkedReports(eventId: string) {
  return request<{ links: EventReportLink[] }>(hp(`/events/${eventId}/reports`))
}

export async function linkRecordToEvent(eventId: string, recordId: string) {
  return request<EventRecordLink>(hp(`/events/${eventId}/records`), {
    method: 'POST',
    body: JSON.stringify({ recordId }),
  })
}

export async function linkReportToEvent(eventId: string, reportId: string) {
  return request<EventReportLink>(hp(`/events/${eventId}/reports`), {
    method: 'POST',
    body: JSON.stringify({ reportId }),
  })
}

export async function listChildRecords(parentId: string) {
  const qs = new URLSearchParams()
  qs.set('parentRecordId', parentId)
  qs.set('limit', '50')
  return request<{ records: CaseRecord[]; total: number; page: number; limit: number; hasMore: boolean }>(hp(`/records?${qs}`))
}

export async function listRecordContacts(id: string) {
  return request<{ contacts: RecordContact[] }>(hp(`/records/${id}/contacts`))
}

export async function linkContactToRecord(id: string, contactId: string, role: string) {
  return request<RecordContact>(hp(`/records/${id}/contacts`), {
    method: 'POST',
    body: JSON.stringify({ contactId, role }),
  })
}

export async function unlinkContactFromRecord(id: string, contactId: string) {
  return request<{ ok: boolean }>(hp(`/records/${id}/contacts/${contactId}`), { method: 'DELETE' })
}

export async function assignRecord(id: string, pubkeys: string[]) {
  return request<CaseRecord>(hp(`/records/${id}/assign`), {
    method: 'POST',
    body: JSON.stringify({ pubkeys }),
  })
}

export async function unassignRecord(id: string, pubkey: string) {
  return request<CaseRecord>(hp(`/records/${id}/unassign`), {
    method: 'POST',
    body: JSON.stringify({ pubkey }),
  })
}

// --- Assignment Suggestions (Epic 342) ---

export async function getAssignmentSuggestions(recordId: string) {
  return request<{ suggestions: AssignmentSuggestion[] }>(hp(`/records/${recordId}/suggest-assignees`))
}

export async function getAutoAssignmentStatus() {
  return request<{ enabled: boolean }>(hp('/settings/cms/auto-assignment'))
}

export async function setAutoAssignment(enabled: boolean) {
  return request<{ enabled: boolean }>(hp('/settings/cms/auto-assignment'), {
    method: 'PUT',
    body: JSON.stringify({ enabled }),
  })
}

// --- Report-to-entity atomic conversion (EP06-A3) ---

export interface ConvertFromReportParams {
  reportId: string
  entityTypeId: string
  additionalFields?: Record<string, unknown>
}

export interface ConvertFromReportResult {
  recordId: string
  reportId: string
  entityTypeId: string
  caseNumber?: string
  autoAssigned: boolean
  assignedTo: string[]
}

export async function convertReportToEntity(params: ConvertFromReportParams): Promise<ConvertFromReportResult> {
  return request<ConvertFromReportResult>(hp('/records/convert-from-report'), {
    method: 'POST',
    body: JSON.stringify({
      reportId: params.reportId,
      entityTypeId: params.entityTypeId,
      additionalFields: params.additionalFields ?? {},
    }),
  })
}

// --- Contact notification dispatch (EP06-A3) ---

export interface NotifyContactParams {
  recordId: string
  notifications: Array<{
    recipientHash: string
    channel: 'sms' | 'signal' | 'whatsapp' | 'telegram'
    message: string
  }>
}

export async function notifyContacts(params: NotifyContactParams): Promise<{ results: Array<{ recipientHash: string; success: boolean; error?: string }> }> {
  return request(hp(`/records/${params.recordId}/notify-contacts`), {
    method: 'POST',
    body: JSON.stringify({ notifications: params.notifications }),
  })
}

/**
 * Who may read each tier of a record, per the server.
 *
 * Two forms, matching the two protocol endpoints: pass `recordId` for an
 * existing record (the server reads its `assignedTo` and hub itself), or
 * `entityTypeId` plus the intended `assignedTo` for a record not yet created.
 * Every returned string is an X25519 device encryption key.
 */
export async function getRecordEnvelopeRecipients(params: {
  entityTypeId?: string
  assignedTo?: string[]
  recordId?: string
}) {
  if (params.recordId) {
    return request<{
      summary: string[]
      fields: string[]
      pii: string[]
    }>(hp(`/records/${params.recordId}/envelope-recipients`))
  }
  if (!params.entityTypeId) {
    throw new Error('getRecordEnvelopeRecipients: pass recordId or entityTypeId')
  }
  const qs = new URLSearchParams({ entityTypeId: params.entityTypeId })
  if (params.assignedTo?.length) qs.set('assignedTo', params.assignedTo.join(','))
  return request<{
    summary: string[]
    fields: string[]
    pii: string[]
  }>(hp(`/records/envelope-recipients?${qs}`))
}

// --- Entity Merge API ---

export async function mergeEntities(body: MergeRecordsBody) {
  return request<MergeRecordsResponse>(hp('/records/merge'), {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

// --- Entity list with cross-hub support ---

export async function listEntitiesCrossHub(params: { crossHub?: boolean; page?: number; limit?: number; entityTypeId?: string }) {
  const qs = new URLSearchParams()
  if (params.crossHub) qs.set('crossHub', 'true')
  if (params.page) qs.set('page', String(params.page))
  if (params.limit) qs.set('limit', String(params.limit))
  if (params.entityTypeId) qs.set('entityTypeId', params.entityTypeId)
  return request<{ records: unknown[]; total: number; page: number; limit: number; hasMore: boolean }>(hp(`/records?${qs}`))
}
