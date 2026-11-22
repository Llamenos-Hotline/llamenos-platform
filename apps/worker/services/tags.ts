/**
 * TagsService — hub-scoped tag CRUD with encrypted labels.
 *
 * Tag labels and categories are HPKE-encrypted. The `name` field is a
 * plaintext slug (lowercase kebab-case) used for blind-index lookups.
 * Tag–contact associations are stored in contacts.tagHashes as HMAC indexes.
 */
import { eq, and } from 'drizzle-orm'
import type { Database } from '../db'
import { tags } from '../db/schema'
import { ServiceError } from './service-error'

// ---------------------------------------------------------------------------
// Row type
// ---------------------------------------------------------------------------

type TagRow = typeof tags.$inferSelect

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface CreateTagInput {
  id: string
  hubId: string
  name: string
  encryptedLabel: string
  color?: string
  encryptedCategory?: string
  createdBy: string
}

export interface UpdateTagInput {
  encryptedLabel?: string
  color?: string
  encryptedCategory?: string | null
}

// ---------------------------------------------------------------------------
// TagsService
// ---------------------------------------------------------------------------

export class TagsService {
  constructor(protected db: Database) {}

  async createTag(input: CreateTagInput): Promise<TagRow> {
    const [tag] = await this.db
      .insert(tags)
      .values({
        id: input.id,
        hubId: input.hubId,
        name: input.name,
        encryptedLabel: input.encryptedLabel,
        color: input.color ?? '#6b7280',
        encryptedCategory: input.encryptedCategory ?? null,
        createdBy: input.createdBy,
      })
      .returning()

    return tag
  }

  async getTag(id: string, hubId: string): Promise<TagRow> {
    const [tag] = await this.db
      .select()
      .from(tags)
      .where(and(eq(tags.id, id), eq(tags.hubId, hubId)))

    if (!tag) throw new ServiceError(404, 'Tag not found')
    return tag
  }

  async listTags(hubId: string): Promise<TagRow[]> {
    return this.db
      .select()
      .from(tags)
      .where(eq(tags.hubId, hubId))
      .orderBy(tags.name)
  }

  async updateTag(id: string, hubId: string, input: UpdateTagInput): Promise<TagRow> {
    const updates: Partial<typeof tags.$inferInsert> = {}
    if (input.encryptedLabel !== undefined) updates.encryptedLabel = input.encryptedLabel
    if (input.color !== undefined) updates.color = input.color
    if (input.encryptedCategory !== undefined) updates.encryptedCategory = input.encryptedCategory

    if (Object.keys(updates).length === 0) {
      return this.getTag(id, hubId)
    }

    const [updated] = await this.db
      .update(tags)
      .set(updates)
      .where(and(eq(tags.id, id), eq(tags.hubId, hubId)))
      .returning()

    if (!updated) throw new ServiceError(404, 'Tag not found')
    return updated
  }

  async deleteTag(id: string, hubId: string): Promise<void> {
    const result = await this.db
      .delete(tags)
      .where(and(eq(tags.id, id), eq(tags.hubId, hubId)))
      .returning({ id: tags.id })

    if (result.length === 0) throw new ServiceError(404, 'Tag not found')
  }
}
