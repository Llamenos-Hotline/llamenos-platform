import { request, activeHubPath } from './client'
import type { ConversionStatus, Report } from './reports'
import { createRecord } from './records'
import type { CreateRecordBody } from '@protocol/schemas/records'

// --- Triage Queue (Epic 342) ---

export async function listTriageQueue(params?: { conversionStatus?: ConversionStatus; page?: number; limit?: number }) {
  const qs = new URLSearchParams({ conversionEnabled: 'true' })
  if (params?.conversionStatus) qs.set('conversionStatus', params.conversionStatus)
  if (params?.page) qs.set('page', String(params.page))
  if (params?.limit) qs.set('limit', String(params.limit))
  return request<{ conversations: Report[]; total: number }>(activeHubPath(`/reports?${qs}`))
}

export async function updateReportConversionStatus(reportId: string, conversionStatus: ConversionStatus) {
  return request<Report>(activeHubPath(`/reports/${reportId}`), {
    method: 'PATCH',
    body: JSON.stringify({ conversionStatus }),
  })
}

export async function getLinkedCasesForReport(reportId: string) {
  return request<{ records: Array<{ reportId: string; caseId: string; linkedAt: string; linkedBy: string }>; total: number }>(activeHubPath(`/reports/${reportId}/records`))
}

export async function createCaseFromReport(
  reportId: string,
  recordBody: CreateRecordBody,
) {
  const record = await createRecord(recordBody)
  // Link the newly-created case to the report
  await request(activeHubPath(`/reports/${reportId}/records`), {
    method: 'POST',
    body: JSON.stringify({ caseId: record.id }),
  })
  return record
}
