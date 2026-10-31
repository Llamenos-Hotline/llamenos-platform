import { request, activeHubPath } from './client'
import type { AuditLogEntry, ListAuditQuery } from '@protocol/schemas'

export type { AuditLogEntry }

// --- Audit Log (admin only) ---

function auditQuery(params?: ListAuditQuery): URLSearchParams {
  const qs = new URLSearchParams()
  if (params?.page) qs.set('page', String(params.page))
  if (params?.limit) qs.set('limit', String(params.limit))
  if (params?.actorPubkey) qs.set('actorPubkey', params.actorPubkey)
  if (params?.eventType) qs.set('eventType', params.eventType)
  if (params?.dateFrom) qs.set('dateFrom', params.dateFrom)
  if (params?.dateTo) qs.set('dateTo', params.dateTo)
  if (params?.search) qs.set('search', params.search)
  return qs
}

/** The active hub's audit chain. */
export async function listAuditLog(params?: ListAuditQuery) {
  return request<{ entries: AuditLogEntry[]; total: number }>(activeHubPath(`/audit?${auditQuery(params)}`))
}

/**
 * The platform chain: deployment-level actions, no hub's entries. Its own route
 * and permission (`system:view-audit`) — never "the audit log with no hub" (#2395).
 */
export async function listPlatformAuditLog(params?: ListAuditQuery) {
  return request<{ entries: AuditLogEntry[]; total: number }>(`/admin/audit?${auditQuery(params)}`)
}
