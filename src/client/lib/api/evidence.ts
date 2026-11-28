import { request, activeHubPath, hubPath } from './client'
import type { EvidenceClassification, CustodyAction, EvidenceMetadata, CustodyEntry, CustodyChainResponse, LogCustodyEventBody, UploadEvidenceBody, VerifyIntegrityResponse } from '@protocol/schemas'
import type {  } from '@shared/types'

export type { EvidenceClassification, CustodyAction, EvidenceMetadata, CustodyEntry }

// --- Case Evidence (Epic 332 — Evidence Viewer) ---

export async function listEvidence(recordId: string, params?: {
  classification?: EvidenceClassification
  page?: number
  limit?: number
}, hubId?: string) {
  const qs = new URLSearchParams()
  if (params?.classification) qs.set('classification', params.classification)
  qs.set('page', String(params?.page ?? 1))
  qs.set('limit', String(params?.limit ?? 50))
  return request<{
    evidence: EvidenceMetadata[]
    total: number
    page: number
    limit: number
    hasMore: boolean
  }>(hubId ? hubPath(hubId, `/records/${recordId}/evidence?${qs}`) : activeHubPath(`/records/${recordId}/evidence?${qs}`))
}

/**
 * `hubId` is the record's own hub (`record.hubId`). Required: the evidence is
 * sealed to that hub's admins, so it must also be filed in it.
 */
export async function uploadEvidence(recordId: string, hubId: string, body: UploadEvidenceBody) {
  return request<EvidenceMetadata>(hubPath(hubId, `/records/${recordId}/evidence`), {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function getEvidenceMetadata(evidenceId: string) {
  return request<EvidenceMetadata>(activeHubPath(`/evidence/${evidenceId}`))
}

export async function getEvidenceCustody(evidenceId: string) {
  return request<CustodyChainResponse>(activeHubPath(`/evidence/${evidenceId}/custody`))
}

export async function logEvidenceAccess(evidenceId: string, body: LogCustodyEventBody) {
  return request<CustodyEntry>(activeHubPath(`/evidence/${evidenceId}/access`), {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function verifyEvidenceIntegrity(evidenceId: string, currentHash: string) {
  return request<VerifyIntegrityResponse>(activeHubPath(`/evidence/${evidenceId}/verify`), {
    method: 'POST',
    body: JSON.stringify({ currentHash }),
  })
}
