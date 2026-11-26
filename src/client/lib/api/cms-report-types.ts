import { request, hp } from './client'
import type { ReportTypeDefinition } from '@protocol/schemas/report-types'
import type {  } from '@shared/types'
import type { CmsReportTypeListResponse, CreateCmsReportTypeBody, OkResponse, UpdateCmsReportTypeBody } from '@protocol/schemas'

export type { ReportTypeDefinition }

// --- CMS Report Type Definitions (Epic 343) ---

export async function listCmsReportTypes() {
  return request<CmsReportTypeListResponse>(hp('/settings/cms/report-types'))
}

export async function getCmsReportType(id: string) {
  return request<ReportTypeDefinition>(hp(`/settings/cms/report-types/${id}`))
}

export async function createCmsReportType(body: CreateCmsReportTypeBody) {
  return request<ReportTypeDefinition>(hp('/settings/cms/report-types'), {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function updateCmsReportType(id: string, body: UpdateCmsReportTypeBody) {
  return request<ReportTypeDefinition>(hp(`/settings/cms/report-types/${id}`), {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export async function deleteCmsReportType(id: string) {
  return request<OkResponse>(hp(`/settings/cms/report-types/${id}`), {
    method: 'DELETE',
  })
}
