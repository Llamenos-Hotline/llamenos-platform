import { request } from './client'
import type { CustomFieldDefinition } from '@shared/types'

export type { CustomFieldDefinition } from '@shared/types'

// SpamSettings response has all fields required (schema uses optional for input)
export type SpamSettings = Required<import('@protocol/schemas').SpamSettings>

// --- Spam Mitigation ---

export async function getSpamSettings() {
  return request<SpamSettings>('/settings/spam')
}

export async function updateSpamSettings(data: Partial<SpamSettings>) {
  return request<SpamSettings>('/settings/spam', {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

// --- Call Settings ---

// CallSettings response has all fields required (schema uses optional for input)
export type CallSettings = Required<import('@protocol/schemas').CallSettings>

export async function getCallSettings() {
  return request<CallSettings>('/settings/call')
}

export async function updateCallSettings(data: Partial<CallSettings>) {
  return request<CallSettings>('/settings/call', {
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

export async function updateCustomFields(fields: CustomFieldDefinition[]) {
  return request<{ fields: CustomFieldDefinition[] }>('/settings/custom-fields', {
    method: 'PUT',
    body: JSON.stringify({ fields }),
  })
}
