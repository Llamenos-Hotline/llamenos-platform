import { request, getAuthHeaders, notifyAuthExpired, notifyApiActivity, ApiError, NetworkError } from './client'
import { getApiUrl } from '../api-config'
import { netFetch } from '../net'
import type { IvrAudioRecording } from '@protocol/schemas'
import { toIvrPromptWav } from '../ivr-wav'

export type { IvrAudioRecording }

// --- IVR Audio ---

export async function listIvrAudio() {
  return request<{ recordings: IvrAudioRecording[] }>('/settings/ivr-audio')
}

/**
 * A binary request to an IVR prompt (`request()` is JSON-only). Same auth,
 * activity and error handling as `request()`.
 */
async function ivrAudioFetch(method: 'GET' | 'PUT', promptType: string, language: string, body?: Blob): Promise<Response> {
  const path = `/settings/ivr-audio/${promptType}/${language}`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000)
  try {
    const headers: Record<string, string> = await getAuthHeaders(method, path)
    if (body) headers['Content-Type'] = body.type
    const res = await netFetch(getApiUrl(path), { method, headers, body, signal: controller.signal })
    if (!res.ok) {
      if (res.status === 401 && 'Authorization' in headers) notifyAuthExpired()
      throw new ApiError(res.status, await res.text())
    }
    notifyApiActivity()
    return res
  } catch (err) {
    if (err instanceof ApiError) throw err
    const e = err instanceof Error ? err : new Error(String(err))
    throw new NetworkError(e.message, e)
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Upload a prompt. The telephony provider plays it, not the browser, so it is
 * converted to the WAV every provider plays before it leaves the device.
 */
export async function uploadIvrAudio(promptType: string, language: string, audio: Blob) {
  const wav = await toIvrPromptWav(audio)
  const res = await ivrAudioFetch('PUT', promptType, language, wav)
  return res.json() as Promise<{ ok: true }>
}

/** An uploaded prompt, for the operator to listen back to */
export async function downloadIvrAudio(promptType: string, language: string): Promise<Blob> {
  const res = await ivrAudioFetch('GET', promptType, language)
  return res.blob()
}

export async function deleteIvrAudio(promptType: string, language: string) {
  return request<{ ok: true }>(`/settings/ivr-audio/${promptType}/${language}`, { method: 'DELETE' })
}
