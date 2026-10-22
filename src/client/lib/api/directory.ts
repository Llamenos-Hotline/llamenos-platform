import { request, hp } from './client'
import type { DirectoryContactType, IdentifierType, ContactIdentifier, ContactCaseLink } from '@protocol/schemas'
import type { Contact as RawContactBase, CreateContactBody as CreateRawContactBody } from '@protocol/schemas/contacts-v2'
import type { ContactRelationshipResponse, ContactGroupResponse, CreateRelationshipBody, AffinityGroup, CreateAffinityGroupBody, UpdateAffinityGroupBody } from '@protocol/schemas/contact-relationships'
import type { MergeContactsBody, MergeContactsResponse } from '@protocol/schemas/contact-merge'
import type { BulkContactAction, BulkContactActionResponse, BulkCreateContactBody, BulkCreateContactResponse } from '@protocol/schemas/contact-bulk'

export type { DirectoryContactType, IdentifierType, ContactIdentifier, ContactCaseLink }
export type { ContactSummary as DirectoryContactSummary } from '@protocol/schemas/contacts-v2'
export type { ContactPII } from '@protocol/schemas/contacts-v2'

/** Raw encrypted contact from the backend (alias for protocol Contact) */
export type RawContact = RawContactBase

/** Client-side decrypted contact for UI rendering (extends protocol DirectoryContact with _raw) */
export type DirectoryContact = import('@protocol/schemas').DirectoryContact & {
  _raw?: RawContact
}

export type ContactRelationship = ContactRelationshipResponse
export type ContactGroup = ContactGroupResponse

export type { CreateRawContactBody }

// --- Contact Directory (Epic 331) ---

/** Fetch raw encrypted contacts from /directory (backend returns encrypted data) */
export async function listRawContacts(params?: {
  page?: number
  limit?: number
  contactTypeHash?: string
  statusHash?: string
  nameToken?: string
}) {
  const qs = new URLSearchParams()
  if (params?.page) qs.set('page', String(params.page))
  qs.set('limit', String(params?.limit ?? 50))
  if (params?.contactTypeHash) qs.set('contactTypeHash', params.contactTypeHash)
  if (params?.statusHash) qs.set('statusHash', params.statusHash)
  if (params?.nameToken) qs.set('nameToken', params.nameToken)
  return request<{ contacts: RawContact[]; total: number; page: number; limit: number; hasMore: boolean }>(hp(`/directory?${qs}`))
}

/** Search contacts by trigram tokens */
export async function searchRawContacts(tokens: string) {
  return request<{ contacts: RawContact[] }>(hp(`/directory/search?tokens=${encodeURIComponent(tokens)}`))
}

/** Get a single raw contact by ID */
export async function getRawContact(id: string) {
  return request<RawContact>(hp(`/directory/${id}`))
}

/** Create an encrypted contact record */
export async function createRawContact(body: CreateRawContactBody) {
  return request<RawContact>(hp('/directory'), {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/** Legacy aliases for backwards compatibility with existing UI code */
export async function listDirectoryContacts(params?: {
  page?: number
  limit?: number
  contactType?: DirectoryContactType
}) {
  return listRawContacts({
    page: params?.page,
    limit: params?.limit,
    contactTypeHash: params?.contactType,
  })
}

export async function searchDirectoryContacts(tokens: string) {
  return searchRawContacts(tokens)
}

export async function getDirectoryContact(id: string) {
  return getRawContact(id)
}

export async function updateDirectoryContact(id: string, body: Partial<CreateRawContactBody>) {
  return request<RawContact>(hp(`/directory/${id}`), {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export async function deleteDirectoryContact(id: string) {
  return request<{ ok: boolean }>(hp(`/directory/${id}`), { method: 'DELETE' })
}

export async function listDirectoryContactRelationships(id: string) {
  return request<{ relationships: ContactRelationship[] }>(hp(`/directory/${id}/relationships`))
}

export async function listDirectoryContactGroups(id: string) {
  return request<{ groups: ContactGroup[] }>(hp(`/directory/${id}/groups`))
}

// --- Relationship write functions (EP06-A2) ---

export async function createContactRelationship(
  contactId: string,
  body: CreateRelationshipBody,
) {
  return request<ContactRelationship>(hp(`/directory/${contactId}/relationships`), {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function deleteContactRelationship(contactId: string, relId: string) {
  return request<{ deleted: boolean }>(hp(`/directory/${contactId}/relationships/${relId}`), {
    method: 'DELETE',
  })
}

// --- Affinity group write functions (EP06-A2) ---

export type { AffinityGroup, CreateAffinityGroupBody, UpdateAffinityGroupBody }

export async function listAffinityGroups() {
  return request<{ groups: AffinityGroup[] }>(hp('/directory/groups'))
}

export async function createAffinityGroup(body: CreateAffinityGroupBody) {
  return request<AffinityGroup>(hp('/directory/groups'), { method: 'POST', body: JSON.stringify(body) })
}

export async function updateAffinityGroup(groupId: string, body: UpdateAffinityGroupBody) {
  return request<AffinityGroup>(hp(`/directory/groups/${groupId}`), { method: 'PATCH', body: JSON.stringify(body) })
}

export async function deleteAffinityGroup(groupId: string) {
  return request<{ deleted: boolean }>(hp(`/directory/groups/${groupId}`), { method: 'DELETE' })
}

export async function addGroupMember(groupId: string, contactId: string, role?: string) {
  return request<{ added: boolean }>(hp(`/directory/groups/${groupId}/members`), {
    method: 'POST',
    body: JSON.stringify({ contactId, role, isPrimary: false }),
  })
}

export async function removeGroupMember(groupId: string, contactId: string) {
  return request<{ removed: boolean }>(hp(`/directory/groups/${groupId}/members/${contactId}`), {
    method: 'DELETE',
  })
}

// --- Entity file upload (EP06-A2) ---
// Mounted only unscoped (`/api/uploads/entity-file`); the handler never reads a hub id,
// so this path must not go through `hp()`.

export async function uploadEntityFile(file: File): Promise<{ fileId: string; uploadedAt: string }> {
  const fd = new FormData()
  fd.append('file', file)
  return request<{ fileId: string; uploadedAt: string }>('/uploads/entity-file', {
    method: 'POST',
    body: fd,
    headers: {},  // let browser set Content-Type with boundary
  })
}

export async function listDirectoryContactCases(id: string) {
  return request<{ cases: ContactCaseLink[] }>(hp(`/directory/${id}/cases`))
}

// --- Contact Merge API ---

export async function mergeContacts(body: MergeContactsBody) {
  return request<MergeContactsResponse>(hp('/directory/merge'), {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function bulkContactAction(body: BulkContactAction) {
  return request<BulkContactActionResponse>(hp('/directory/bulk'), {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function bulkCreateContacts(body: BulkCreateContactBody) {
  return request<BulkCreateContactResponse>(hp('/directory/bulk-create'), {
    method: 'POST',
    body: JSON.stringify(body),
  })
}
