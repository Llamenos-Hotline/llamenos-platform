import { request, activeHubPath } from './client'
import type { ContactTimelineSummary, CallRecord, Conversation, EncryptedNote } from '@protocol/schemas'

// Contacts (Epic 123)
export type { ContactTimelineSummary }
/** @deprecated Use ContactTimelineSummary instead */
export type ContactSummary = ContactTimelineSummary

// Composed type — no single schema covers this
export type ContactTimeline = {
  contact: ContactTimelineSummary
  calls: CallRecord[]
  conversations: Conversation[]
  notes: EncryptedNote[]
}

export async function listContacts(params?: { page?: number; limit?: number }) {
  const qs = new URLSearchParams()
  if (params?.page) qs.set('page', String(params.page))
  if (params?.limit) qs.set('limit', String(params.limit))
  return request<{ contacts: ContactSummary[]; total: number }>(activeHubPath(`/contacts?${qs}`))
}

export async function getContactTimeline(hash: string) {
  return request<ContactTimeline>(activeHubPath(`/contacts/${hash}`))
}
