import { request, getAuthHeaders, notifyAuthExpired, notifyApiActivity, ApiError, NetworkError, isRetryable, MAX_RETRIES, BASE_RETRY_DELAY, activeHubPath, hubPath } from './client'
import { getApiUrl } from '../api-config'
import { netFetch } from '../net'
import type {
  UploadInitBody,
  UploadInitResponse,
  ChunkUploadResponse,
  UploadCompleteResponse,
  UploadStatusResponse,
  FileEnvelopesResponse,
  FileMetadataResponse,
  ShareFileBody,
} from '@protocol/schemas'

// --- File Uploads ---
// Uploads and files are mounted only under /hubs/:hubId (#2462): a file belongs
// to the hub of the record it is attached to, which is the hub being browsed.

/**
 * An upload's path in `hubId` — the hub of the record or entity it is attached
 * to — or, when none is given, in the hub being browsed.
 */
function uploadHubPath(hubId: string | undefined, path: string): string {
  return hubId ? hubPath(hubId, path) : activeHubPath(path)
}

export async function initUpload(data: UploadInitBody, hubId?: string) {
  return request<UploadInitResponse>(uploadHubPath(hubId, '/uploads/init'), {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function uploadChunk(uploadId: string, chunkIndex: number, data: ArrayBuffer, hubId?: string) {
  const maxRetries = 2
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, BASE_RETRY_DELAY * Math.pow(2, attempt - 1)))
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30_000)
    try {
      const path = uploadHubPath(hubId, `/uploads/${uploadId}/chunks/${chunkIndex}`)
      const headers = {
        ...await getAuthHeaders('PUT', path),
        'Content-Type': 'application/octet-stream',
      }
      const res = await netFetch(getApiUrl(path), {
        method: 'PUT',
        headers,
        body: data,
        signal: controller.signal,
      })
      if (!res.ok) {
        if (res.status === 401 && 'Authorization' in headers) {
          if (attempt < maxRetries) { lastError = new ApiError(res.status, await res.text()); continue }
          notifyAuthExpired()
        }
        const err = new ApiError(res.status, await res.text())
        if (isRetryable(res.status) && attempt < maxRetries) { lastError = err; continue }
        throw err
      }
      notifyApiActivity()
      return res.json() as Promise<ChunkUploadResponse>
    } catch (err) {
      if (err instanceof ApiError) throw err
      lastError = err instanceof Error ? err : new Error(String(err))
      if (attempt < maxRetries) continue
      throw new NetworkError(lastError.message, lastError)
    } finally {
      clearTimeout(timeout)
    }
  }
  throw lastError ?? new Error('Upload chunk failed')
}

export async function completeUpload(uploadId: string, hubId?: string) {
  return request<UploadCompleteResponse>(uploadHubPath(hubId, `/uploads/${uploadId}/complete`), { method: 'POST' })
}

export async function getUploadStatus(uploadId: string) {
  return request<UploadStatusResponse>(activeHubPath(`/uploads/${uploadId}/status`))
}

export async function downloadFile(fileId: string): Promise<ArrayBuffer> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, BASE_RETRY_DELAY * Math.pow(2, attempt - 1)))
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30_000)
    try {
      const path = activeHubPath(`/files/${fileId}/content`)
      const headers: Record<string, string> = await getAuthHeaders('GET', path)
      const res = await netFetch(getApiUrl(path), { headers, signal: controller.signal })
      if (!res.ok) {
        if (res.status === 401 && 'Authorization' in headers) {
          if (attempt < MAX_RETRIES) continue
          notifyAuthExpired()
        }
        const err = new ApiError(res.status, await res.text())
        if (isRetryable(res.status) && attempt < MAX_RETRIES) continue
        throw err
      }
      notifyApiActivity()
      return res.arrayBuffer()
    } catch (err) {
      if (err instanceof ApiError) throw err
      if (attempt < MAX_RETRIES) continue
      const e = err instanceof Error ? err : new Error(String(err))
      throw new NetworkError(e.message, e)
    } finally {
      clearTimeout(timeout)
    }
  }
  throw new Error('Download failed')
}

export async function getFileEnvelopes(fileId: string) {
  return request<FileEnvelopesResponse>(activeHubPath(`/files/${fileId}/envelopes`))
}

export async function getFileMetadata(fileId: string) {
  return request<FileMetadataResponse>(activeHubPath(`/files/${fileId}/metadata`))
}

export async function shareFile(fileId: string, data: ShareFileBody) {
  return request<{ ok: true }>(activeHubPath(`/files/${fileId}/share`), {
    method: 'POST',
    body: JSON.stringify(data),
  })
}
