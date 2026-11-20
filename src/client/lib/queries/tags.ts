import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  listTags,
  createTag,
  updateTag,
  deleteTag,
} from '@/lib/api'
import type { TagResponse } from '@protocol/schemas'
import { getActiveHub, NoActiveHubError } from '@/lib/api/client'
import { encryptForHub, decryptFromHub } from '@/lib/hub-key-manager'
import { LABEL_TAG_ENCRYPT } from '@shared/crypto-labels'

export const tagKeys = {
  all: ['tags'] as const,
  list: () => [...tagKeys.all, 'list'] as const,
  detail: (id: string) => [...tagKeys.all, 'detail', id] as const,
}

// ---------------------------------------------------------------------------
// Decrypted types
// ---------------------------------------------------------------------------

export interface DecryptedTag extends Omit<TagResponse, 'encryptedLabel' | 'encryptedCategory'> {
  label: string
  category: string | null
  encryptedLabel: string
  encryptedCategory: string | null
}

async function decryptTag(tag: TagResponse): Promise<DecryptedTag> {
  const [label, category] = await Promise.all([
    decryptFromHub(tag.hubId, tag.encryptedLabel, LABEL_TAG_ENCRYPT),
    tag.encryptedCategory
      ? decryptFromHub(tag.hubId, tag.encryptedCategory, LABEL_TAG_ENCRYPT)
      : Promise.resolve(null),
  ])
  return {
    ...tag,
    label: label ?? tag.encryptedLabel,
    category: category,
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function useTags() {
  return useQuery({
    queryKey: tagKeys.list(),
    queryFn: async () => {
      const { tags } = await listTags()
      return Promise.all(tags.map(decryptTag))
    },
    staleTime: 5 * 60 * 1000,
  })
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export function useCreateTag() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({
      name,
      label,
      color,
      category,
    }: {
      name: string
      label: string
      color?: string
      category?: string
    }) => {
      // Sealed under the hub the request is about to be scoped to (`hp()`).
      const hubId = getActiveHub()
      if (!hubId) throw new NoActiveHubError('/tags')
      const encryptedLabel = await encryptForHub(hubId, label, LABEL_TAG_ENCRYPT)
      const encryptedCategory = category
        ? await encryptForHub(hubId, category, LABEL_TAG_ENCRYPT)
        : undefined
      return createTag({
        id: crypto.randomUUID(),
        name: name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''),
        encryptedLabel,
        color,
        encryptedCategory,
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: tagKeys.list() })
    },
  })
}

export function useUpdateTag() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({
      id,
      label,
      color,
      category,
    }: {
      id: string
      label?: string
      color?: string
      category?: string | null
    }) => {
      const hubId = getActiveHub()
      if (!hubId) throw new NoActiveHubError(`/tags/${id}`)
      const encryptedLabel = label !== undefined
        ? await encryptForHub(hubId, label, LABEL_TAG_ENCRYPT)
        : undefined
      const encryptedCategory =
        category === null
          ? null
          : category !== undefined
            ? await encryptForHub(hubId, category, LABEL_TAG_ENCRYPT)
            : undefined
      return updateTag(id, { encryptedLabel, color, encryptedCategory })
    },
    onSuccess: (_data, { id }) => {
      queryClient.invalidateQueries({ queryKey: tagKeys.list() })
      queryClient.invalidateQueries({ queryKey: tagKeys.detail(id) })
    },
  })
}

export function useDeleteTag() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: deleteTag,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: tagKeys.all })
    },
  })
}
