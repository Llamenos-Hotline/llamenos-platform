import { DeletionConfirmed } from '@/lib/admin-deletion'
import { request, hubPath } from './client'
import type { CustomFieldDefinition } from '@shared/types'

export type { CustomFieldDefinition } from '@shared/types'

// SpamSettings response has all fields required (schema uses optional for input)
export type SpamSettings = Required<import('@protocol/schemas').SpamSettings>

// --- Spam Mitigation ---
//
// Spam and call settings are hub-owned on the wire (#1051/#1137): the hub-scoped
// PATCH writes only that hub's overrides, while the unscoped /settings/spam|call
// writes the PLATFORM values every hub without an override inherits. Nothing in
// the desktop UI edits the platform values, so these take the hub being edited
// and never fall back to the unscoped form — an admin looking at hub B must never
// silently rewrite the default for every hub.

export async function getSpamSettings(hubId: string) {
  return request<SpamSettings>(hubPath(hubId, '/settings/spam'))
}

export async function updateSpamSettings(hubId: string, data: Partial<SpamSettings>) {
  return request<SpamSettings>(hubPath(hubId, '/settings/spam'), {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

// --- Call Settings ---

// CallSettings response has all fields required (schema uses optional for input)
export type CallSettings = Required<import('@protocol/schemas').CallSettings>

export async function getCallSettings(hubId: string) {
  return request<CallSettings>(hubPath(hubId, '/settings/call'))
}

export async function updateCallSettings(hubId: string, data: Partial<CallSettings>) {
  return request<CallSettings>(hubPath(hubId, '/settings/call'), {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

// --- IVR Language Settings ---

export type IvrLanguageSettings = import('@protocol/schemas').IvrLanguageSettings

export async function getIvrLanguages(hubId?: string) {
  const qs = hubId ? `?hubId=${encodeURIComponent(hubId)}` : ''
  return request<IvrLanguageSettings>(`/settings/ivr-languages${qs}`)
}

export async function updateIvrLanguages(data: { enabledLanguages: string[] }, hubId?: string) {
  const qs = hubId ? `?hubId=${encodeURIComponent(hubId)}` : ''
  return request<IvrLanguageSettings>(`/settings/ivr-languages${qs}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

// --- Transcription Settings ---

export async function getTranscriptionSettings() {
  return request<{ globalEnabled: boolean; allowUserOptOut: boolean }>('/settings/transcription')
}

export async function updateTranscriptionSettings(data: { globalEnabled?: boolean; allowUserOptOut?: boolean }) {
  return request<{ globalEnabled: boolean; allowUserOptOut: boolean }>('/settings/transcription', {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

export async function updateMyTranscriptionPreference(enabled: boolean) {
  return request<{ ok: true }>('/auth/me/transcription', {
    method: 'PATCH',
    body: JSON.stringify({ enabled }),
  })
}

export async function updateMyProfile(data: { name?: string; phone?: string; spokenLanguages?: string[]; uiLanguage?: string; profileCompleted?: boolean; callPreference?: 'phone' | 'browser' | 'both' }) {
  return request<{ ok: true }>('/auth/me/profile', {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

export async function updateMyAvailability(onBreak: boolean) {
  return request<{ ok: true }>('/auth/me/availability', {
    method: 'PATCH',
    body: JSON.stringify({ onBreak }),
  })
}

// --- Custom Fields ---

export async function getCustomFields() {
  return request<{ fields: CustomFieldDefinition[] }>('/settings/custom-fields')
}

/**
 * Delete one custom field definition: PUTs [fields] without it, renumbered. Requires the
 * admin's confirmation of exactly this field (#2575). Notes keep the values they hold.
 */
export async function deleteCustomField(
  fields: CustomFieldDefinition[],
  fieldId: string,
  confirmed: DeletionConfirmed,
) {
  DeletionConfirmed.require(confirmed, 'customField', fieldId)
  const remaining = fields
    .filter(f => f.id !== fieldId)
    .map((f, order) => ({ ...f, order }))
  return updateCustomFields(remaining)
}

export async function updateCustomFields(fields: CustomFieldDefinition[]) {
  return request<{ fields: CustomFieldDefinition[] }>('/settings/custom-fields', {
    method: 'PUT',
    body: JSON.stringify({ fields }),
  })
}
