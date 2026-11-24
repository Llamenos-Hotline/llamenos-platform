import { sql } from 'drizzle-orm'
import type { Database } from '../db'
import { customFieldDefinitions } from '../db/schema'
import type { CustomFieldDefinition } from '@shared/types'
import {
  MAX_CUSTOM_FIELDS,
  MAX_SELECT_OPTIONS,
  MAX_FIELD_NAME_LENGTH,
  MAX_FIELD_LABEL_LENGTH,
  MAX_OPTION_LENGTH,
  FIELD_NAME_REGEX,
} from '@shared/types'
import { ServiceError } from './service-error'

/**
 * The custom field definitions (`custom_field_definitions`) for call notes.
 */
export class CustomFieldsService {
  constructor(protected db: Database) {}

  async getCustomFields(
    role: string = 'admin',
  ): Promise<{ fields: CustomFieldDefinition[] }> {
    let rows = await this.db
      .select()
      .from(customFieldDefinitions)
      .orderBy(customFieldDefinitions.sortOrder)

    if (role !== 'admin') {
      rows = rows.filter((r) => r.visibleToUsers)
    }

    // Map DB rows to CustomFieldDefinition shape
    const fields: CustomFieldDefinition[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      label: r.label,
      type: r.fieldType as CustomFieldDefinition['type'],
      required: r.required ?? false,
      options: r.options ?? undefined,
      validation: r.validation as CustomFieldDefinition['validation'],
      visibleToUsers: r.visibleToUsers ?? true,
      editableByUsers: r.editableByUsers ?? true,
      context: r.context as CustomFieldDefinition['context'],
      maxFileSize: r.maxFileSize ?? undefined,
      allowedMimeTypes: r.allowedMimeTypes ?? undefined,
      maxFiles: r.maxFiles ?? 1,
      order: r.sortOrder ?? 0,
      createdAt: r.createdAt.toISOString(),
    }))

    return { fields }
  }

  async updateCustomFields(data: {
    fields: CustomFieldDefinition[]
  }): Promise<{ fields: CustomFieldDefinition[] }> {
    if (!data || !Array.isArray(data.fields)) {
      throw new ServiceError(
        400,
        'Invalid request: fields array required',
      )
    }

    const { fields } = data

    if (fields.length > MAX_CUSTOM_FIELDS) {
      throw new ServiceError(
        400,
        `Maximum ${MAX_CUSTOM_FIELDS} custom fields`,
      )
    }

    // Validate each field
    const names = new Set<string>()
    for (const field of fields) {
      if (!field.name || !field.label || !field.type) {
        throw new ServiceError(
          400,
          'Each field must have name, label, and type',
        )
      }
      if (!FIELD_NAME_REGEX.test(field.name)) {
        throw new ServiceError(
          400,
          `Invalid field name: ${field.name}. Use alphanumeric and underscores only.`,
        )
      }
      if (field.name.length > MAX_FIELD_NAME_LENGTH) {
        throw new ServiceError(
          400,
          `Field name too long: ${field.name}`,
        )
      }
      if (field.label.length > MAX_FIELD_LABEL_LENGTH) {
        throw new ServiceError(
          400,
          `Field label too long (max ${MAX_FIELD_LABEL_LENGTH} chars)`,
        )
      }
      if (names.has(field.name)) {
        throw new ServiceError(
          400,
          `Duplicate field name: ${field.name}`,
        )
      }
      names.add(field.name)
      if (
        !['text', 'number', 'select', 'checkbox', 'textarea', 'file'].includes(
          field.type,
        )
      ) {
        throw new ServiceError(
          400,
          `Invalid field type: ${field.type}`,
        )
      }
      if (field.type === 'select') {
        if (!field.options || field.options.length === 0) {
          throw new ServiceError(
            400,
            `Select field "${field.name}" must have options`,
          )
        }
        if (field.options.length > MAX_SELECT_OPTIONS) {
          throw new ServiceError(
            400,
            `Too many options for "${field.name}" (max ${MAX_SELECT_OPTIONS})`,
          )
        }
        for (const opt of field.options) {
          if (typeof opt !== 'string' || opt.length > MAX_OPTION_LENGTH) {
            throw new ServiceError(
              400,
              `Option too long in "${field.name}" (max ${MAX_OPTION_LENGTH} chars)`,
            )
          }
        }
      }
    }

    const validContexts = ['call-notes', 'conversation-notes', 'reports', 'all']
    const normalized = fields.map((f, i) => ({
      ...f,
      order: i,
      context:
        (f.context as string) === 'both'
          ? 'all'
          : validContexts.includes(f.context)
            ? f.context
            : 'all',
    }))

    // Replace all custom fields in a transaction, serialized across writers.
    // DELETE-all + INSERT under READ COMMITTED is not safe on its own: a
    // concurrent writer's DELETE blocks on our row locks, then skips the rows
    // we deleted and cannot see the rows we inserted, so both inserts survive
    // and the table ends up holding the union of both lists (duplicate names)
    // (#686). The transaction-scoped advisory lock makes each replacement see
    // the previous one's committed state: last writer wins, never a union.
    await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('custom_field_definitions:replace'))`,
      )
      await tx.delete(customFieldDefinitions)
      for (const [i, f] of normalized.entries()) {
        await tx.insert(customFieldDefinitions).values({
          id: f.id || crypto.randomUUID(),
          name: f.name,
          label: f.label,
          fieldType: f.type,
          required: f.required ?? false,
          options: f.options,
          validation: f.validation,
          visibleToUsers: f.visibleToUsers ?? true,
          editableByUsers: f.editableByUsers ?? true,
          context: f.context ?? 'all',
          maxFileSize: f.maxFileSize,
          allowedMimeTypes: f.allowedMimeTypes,
          maxFiles: f.maxFiles ?? 1,
          sortOrder: i,
        })
      }
    })

    // The definitions as stored — ids minted, defaults applied, createdAt set —
    // not the request echoed back.
    return this.getCustomFields('admin')
  }
}
