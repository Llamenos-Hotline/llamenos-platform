import { request, hp } from './client'
import type { TagResponse, CreateTagBody, TagDeleteResponse, TagListResponse, UpdateTagBody } from '@protocol/schemas'

// ---------------------------------------------------------------------------
// Tags API
// ---------------------------------------------------------------------------

export async function listTags() {
  return request<TagListResponse>(hp('/tags'))
}

export async function createTag(body: CreateTagBody): Promise<TagResponse> {
  return request<TagResponse>(hp('/tags'), { method: 'POST', body: JSON.stringify(body) })
}

export async function updateTag(tagId: string, body: UpdateTagBody): Promise<TagResponse> {
  return request<TagResponse>(hp(`/tags/${tagId}`), { method: 'PATCH', body: JSON.stringify(body) })
}

export async function deleteTag(tagId: string) {
  return request<TagDeleteResponse>(hp(`/tags/${tagId}`), { method: 'DELETE' })
}
