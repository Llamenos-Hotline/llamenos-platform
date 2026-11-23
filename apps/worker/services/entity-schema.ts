import { eq, and, sql } from 'drizzle-orm'
import type { Database } from '../db'
import {
  entityTypeDefinitions,
  relationshipTypeDefinitions,
  caseNumberSequences,
} from '../db/schema'
import { MAX_ENTITY_TYPES, MAX_RELATIONSHIP_TYPES } from '@shared/types'
import type {
  EntityTypeDefinition,
  EntityFieldDefinition,
  RelationshipTypeDefinition,
} from '@protocol/schemas/entity-schema'
import { lockReplaceAll } from './replace-all-lock'
import { ServiceError } from './service-error'

/**
 * Case-management schema: entity-type and relationship-type definitions, and the case-number sequences.
 */
export class EntitySchemaService {
  constructor(protected db: Database) {}

  async getEntityTypes(hubId?: string): Promise<{
    entityTypes: EntityTypeDefinition[]
  }> {
    const rows = hubId !== undefined
      ? await this.db.select().from(entityTypeDefinitions).where(eq(entityTypeDefinitions.hubId, hubId))
      : await this.db.select().from(entityTypeDefinitions)
    return {
      entityTypes: rows.map((r) => this.rowToEntityType(r)),
    }
  }

  /**
   * An entity type of `hubId`. `hubId` is required, not optional: an entity
   * type carries the numbering prefix, default status and auto-assignment of
   * the hub that defined it, so a lookup by id alone would let one hub apply
   * another hub's configuration (#2605). A type of another hub is
   * indistinguishable from one that does not exist.
   */
  async getEntityTypeById(
    id: string,
    hubId: string,
  ): Promise<EntityTypeDefinition> {
    const [row] = await this.db
      .select()
      .from(entityTypeDefinitions)
      .where(and(eq(entityTypeDefinitions.id, id), eq(entityTypeDefinitions.hubId, hubId)))
    if (!row) {
      throw new ServiceError(404, 'Entity type not found')
    }
    return this.rowToEntityType(row)
  }

  async createEntityType(
    data: Record<string, unknown>,
  ): Promise<EntityTypeDefinition> {
    const hubId = (data.hubId as string) ?? ''
    const count = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(entityTypeDefinitions)
      .where(eq(entityTypeDefinitions.hubId, hubId))
    if (Number(count[0].count) >= MAX_ENTITY_TYPES) {
      throw new ServiceError(
        400,
        `Maximum of ${MAX_ENTITY_TYPES} entity types allowed`,
      )
    }

    const name = data.name as string
    // Check for duplicate name (non-archived) within the same hub
    const [dup] = await this.db
      .select()
      .from(entityTypeDefinitions)
      .where(
        and(
          eq(entityTypeDefinitions.hubId, hubId),
          eq(entityTypeDefinitions.name, name),
          eq(entityTypeDefinitions.isArchived, false),
        ),
      )
    if (dup) {
      throw new ServiceError(
        409,
        `Entity type with name "${name}" already exists`,
      )
    }

    const now = new Date()
    const id = crypto.randomUUID()

    // Assign IDs to fields
    const fields = ((data.fields as EntityFieldDefinition[]) ?? []).map(
      (f) => ({
        ...f,
        id: f.id || crypto.randomUUID(),
      }),
    )

    await this.db.insert(entityTypeDefinitions).values({
      id,
      hubId: (data.hubId as string) ?? '',
      name,
      label: (data.label as string) ?? name,
      labelPlural: (data.labelPlural as string) ?? '',
      description: (data.description as string) ?? '',
      icon: data.icon as string | undefined,
      color: data.color as string | undefined,
      category: (data.category as string) ?? 'case',
      templateId: data.templateId as string | undefined,
      templateVersion: data.templateVersion as string | undefined,
      fields,
      statuses: (data.statuses as unknown[]) ?? [],
      defaultStatus: (data.defaultStatus as string) ?? '',
      closedStatuses: (data.closedStatuses as string[]) ?? [],
      severities: data.severities as unknown,
      defaultSeverity: data.defaultSeverity as string | undefined,
      categories: data.categories as unknown,
      contactRoles: data.contactRoles as unknown,
      numberPrefix: data.numberPrefix as string | undefined,
      numberingEnabled: (data.numberingEnabled as boolean) ?? false,
      defaultAccessLevel: (data.defaultAccessLevel as string) ?? 'assigned',
      piiFields: (data.piiFields as string[]) ?? [],
      allowSubRecords: (data.allowSubRecords as boolean) ?? false,
      allowFileAttachments: (data.allowFileAttachments as boolean) ?? true,
      allowInteractionLinks: (data.allowInteractionLinks as boolean) ?? true,
      showInNavigation: (data.showInNavigation as boolean) ?? true,
      showInDashboard: (data.showInDashboard as boolean) ?? true,
      accessRoles: data.accessRoles as string[] | undefined,
      editRoles: data.editRoles as string[] | undefined,
      autoAssign: (data.autoAssign as boolean) ?? false,
      autoAssignThreshold: (data.autoAssignThreshold as number) ?? 30,
      requiredSpecializations: (data.requiredSpecializations as string[]) ?? [],
      notifyContactsOnStatusChange: (data.notifyContactsOnStatusChange as boolean) ?? false,
      isArchived: false,
      isSystem: (data.isSystem as boolean) ?? false,
      createdAt: now,
      updatedAt: now,
    })

    const [created] = await this.db
      .select()
      .from(entityTypeDefinitions)
      .where(eq(entityTypeDefinitions.id, id))
    return this.rowToEntityType(created)
  }

  /**
   * Update an entity type of `hubId`. The hub is a required argument and part of
   * every statement's WHERE, not a check done once up front: a type of another
   * hub is indistinguishable from one that does not exist, and the write itself
   * cannot land on it (#2631).
   */
  async updateEntityType(
    id: string,
    hubId: string,
    data: Record<string, unknown>,
  ): Promise<EntityTypeDefinition> {
    const inHub = and(eq(entityTypeDefinitions.id, id), eq(entityTypeDefinitions.hubId, hubId))
    const [existing] = await this.db
      .select()
      .from(entityTypeDefinitions)
      .where(inHub)
    if (!existing) {
      throw new ServiceError(404, 'Entity type not found')
    }

    // Assign IDs to new fields
    if (data.fields && Array.isArray(data.fields)) {
      data.fields = (data.fields as EntityFieldDefinition[]).map((f) => ({
        ...f,
        id: f.id || crypto.randomUUID(),
      }))
    }

    const now = new Date()
    const updates: Record<string, unknown> = { updatedAt: now }

    // Map through all possible update fields
    const fieldMap: Record<string, string> = {
      name: 'name',
      label: 'label',
      labelPlural: 'labelPlural',
      description: 'description',
      icon: 'icon',
      color: 'color',
      category: 'category',
      fields: 'fields',
      statuses: 'statuses',
      defaultStatus: 'defaultStatus',
      closedStatuses: 'closedStatuses',
      severities: 'severities',
      defaultSeverity: 'defaultSeverity',
      categories: 'categories',
      contactRoles: 'contactRoles',
      numberPrefix: 'numberPrefix',
      numberingEnabled: 'numberingEnabled',
      defaultAccessLevel: 'defaultAccessLevel',
      piiFields: 'piiFields',
      allowSubRecords: 'allowSubRecords',
      allowFileAttachments: 'allowFileAttachments',
      allowInteractionLinks: 'allowInteractionLinks',
      showInNavigation: 'showInNavigation',
      showInDashboard: 'showInDashboard',
      accessRoles: 'accessRoles',
      editRoles: 'editRoles',
      autoAssign: 'autoAssign',
      autoAssignThreshold: 'autoAssignThreshold',
      requiredSpecializations: 'requiredSpecializations',
      notifyContactsOnStatusChange: 'notifyContactsOnStatusChange',
      isArchived: 'isArchived',
      isSystem: 'isSystem',
      templateId: 'templateId',
      templateVersion: 'templateVersion',
    }

    for (const [dataKey, dbKey] of Object.entries(fieldMap)) {
      if (data[dataKey] !== undefined) {
        updates[dbKey] = data[dataKey]
      }
    }

    await this.db
      .update(entityTypeDefinitions)
      .set(updates)
      .where(inHub)

    const [updated] = await this.db
      .select()
      .from(entityTypeDefinitions)
      .where(inHub)
    return this.rowToEntityType(updated)
  }

  async bulkSetEntityTypes(data: {
    entityTypes: EntityTypeDefinition[]
    hubId?: string
  }): Promise<{ entityTypes: EntityTypeDefinition[] }> {
    await this.db.transaction(async (tx) => {
      await lockReplaceAll(tx, 'entity_type_definitions')
      if (data.hubId !== undefined) {
        await tx.delete(entityTypeDefinitions).where(eq(entityTypeDefinitions.hubId, data.hubId))
      } else {
        await tx.delete(entityTypeDefinitions)
      }
      for (const et of data.entityTypes) {
        const now = new Date()
        await tx.insert(entityTypeDefinitions).values({
          id: et.id,
          hubId: et.hubId ?? '',
          name: et.name,
          label: et.label,
          labelPlural: et.labelPlural ?? '',
          description: et.description ?? '',
          icon: et.icon,
          color: et.color,
          category: et.category ?? 'case',
          templateId: et.templateId,
          templateVersion: et.templateVersion,
          fields: et.fields ?? [],
          statuses: et.statuses ?? [],
          defaultStatus: et.defaultStatus ?? '',
          closedStatuses: et.closedStatuses ?? [],
          severities: et.severities,
          defaultSeverity: et.defaultSeverity,
          categories: et.categories,
          contactRoles: et.contactRoles,
          numberPrefix: et.numberPrefix,
          numberingEnabled: et.numberingEnabled ?? false,
          defaultAccessLevel: et.defaultAccessLevel ?? 'assigned',
          piiFields: et.piiFields ?? [],
          allowSubRecords: et.allowSubRecords ?? false,
          allowFileAttachments: et.allowFileAttachments ?? true,
          allowInteractionLinks: et.allowInteractionLinks ?? true,
          showInNavigation: et.showInNavigation ?? true,
          showInDashboard: et.showInDashboard ?? true,
          accessRoles: et.accessRoles,
          editRoles: et.editRoles,
          notifyContactsOnStatusChange: et.notifyContactsOnStatusChange ?? false,
          isArchived: et.isArchived ?? false,
          isSystem: et.isSystem ?? false,
          createdAt: et.createdAt ? new Date(et.createdAt) : now,
          updatedAt: et.updatedAt ? new Date(et.updatedAt) : now,
        })
      }
    })
    return { entityTypes: data.entityTypes }
  }

  /** Delete an entity type of `hubId` — see {@link updateEntityType} for why the hub is required. */
  async deleteEntityType(id: string, hubId: string): Promise<{ deleted: true }> {
    const result = await this.db
      .delete(entityTypeDefinitions)
      .where(and(eq(entityTypeDefinitions.id, id), eq(entityTypeDefinitions.hubId, hubId)))
      .returning()
    if (result.length === 0) {
      throw new ServiceError(404, 'Entity type not found')
    }
    return { deleted: true }
  }

  async getRelationshipTypes(hubId?: string): Promise<{
    relationshipTypes: RelationshipTypeDefinition[]
  }> {
    const rows = hubId !== undefined
      ? await this.db.select().from(relationshipTypeDefinitions).where(eq(relationshipTypeDefinitions.hubId, hubId))
      : await this.db.select().from(relationshipTypeDefinitions)
    return {
      relationshipTypes: rows.map((r) => this.rowToRelationshipType(r)),
    }
  }

  async createRelationshipType(
    data: Record<string, unknown>,
  ): Promise<RelationshipTypeDefinition> {
    const hubId = (data.hubId as string) ?? ''
    const count = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(relationshipTypeDefinitions)
      .where(eq(relationshipTypeDefinitions.hubId, hubId))
    if (Number(count[0].count) >= MAX_RELATIONSHIP_TYPES) {
      throw new ServiceError(
        400,
        `Maximum of ${MAX_RELATIONSHIP_TYPES} relationship types allowed`,
      )
    }

    const now = new Date()
    const id = crypto.randomUUID()

    await this.db.insert(relationshipTypeDefinitions).values({
      id,
      hubId: (data.hubId as string) ?? '',
      sourceEntityTypeId: data.sourceEntityTypeId as string | undefined,
      targetEntityTypeId: data.targetEntityTypeId as string | undefined,
      cardinality: (data.cardinality as string) ?? 'M:N',
      label: data.label as string,
      reverseLabel: (data.reverseLabel as string) ?? '',
      sourceLabel: (data.sourceLabel as string) ?? '',
      targetLabel: (data.targetLabel as string) ?? '',
      roles: data.roles as unknown,
      defaultRole: data.defaultRole as string | undefined,
      joinFields: data.joinFields as unknown,
      cascadeDelete: (data.cascadeDelete as boolean) ?? false,
      required: (data.required as boolean) ?? false,
      templateId: data.templateId as string | undefined,
      isSystem: (data.isSystem as boolean) ?? false,
      createdAt: now,
      updatedAt: now,
    })

    const [created] = await this.db
      .select()
      .from(relationshipTypeDefinitions)
      .where(eq(relationshipTypeDefinitions.id, id))
    return this.rowToRelationshipType(created)
  }

  /** Update a relationship type of `hubId` — the hub is required, as for {@link updateEntityType}. */
  async updateRelationshipType(
    id: string,
    hubId: string,
    data: Record<string, unknown>,
  ): Promise<RelationshipTypeDefinition> {
    const inHub = and(eq(relationshipTypeDefinitions.id, id), eq(relationshipTypeDefinitions.hubId, hubId))
    const [existing] = await this.db
      .select()
      .from(relationshipTypeDefinitions)
      .where(inHub)
    if (!existing) {
      throw new ServiceError(404, 'Relationship type not found')
    }

    const now = new Date()
    const updates: Record<string, unknown> = { updatedAt: now }

    const fieldMap: Record<string, string> = {
      sourceEntityTypeId: 'sourceEntityTypeId',
      targetEntityTypeId: 'targetEntityTypeId',
      cardinality: 'cardinality',
      label: 'label',
      reverseLabel: 'reverseLabel',
      sourceLabel: 'sourceLabel',
      targetLabel: 'targetLabel',
      roles: 'roles',
      defaultRole: 'defaultRole',
      joinFields: 'joinFields',
      cascadeDelete: 'cascadeDelete',
      required: 'required',
      templateId: 'templateId',
      isSystem: 'isSystem',
    }

    for (const [dataKey, dbKey] of Object.entries(fieldMap)) {
      if (data[dataKey] !== undefined) {
        updates[dbKey] = data[dataKey]
      }
    }

    await this.db
      .update(relationshipTypeDefinitions)
      .set(updates)
      .where(inHub)

    const [updated] = await this.db
      .select()
      .from(relationshipTypeDefinitions)
      .where(inHub)
    return this.rowToRelationshipType(updated)
  }

  async bulkSetRelationshipTypes(data: {
    relationshipTypes: RelationshipTypeDefinition[]
    hubId?: string
  }): Promise<{ relationshipTypes: RelationshipTypeDefinition[] }> {
    await this.db.transaction(async (tx) => {
      await lockReplaceAll(tx, 'relationship_type_definitions')
      if (data.hubId !== undefined) {
        await tx.delete(relationshipTypeDefinitions).where(eq(relationshipTypeDefinitions.hubId, data.hubId))
      } else {
        await tx.delete(relationshipTypeDefinitions)
      }
      for (const rt of data.relationshipTypes) {
        const now = new Date()
        await tx.insert(relationshipTypeDefinitions).values({
          id: rt.id,
          hubId: rt.hubId ?? '',
          sourceEntityTypeId: rt.sourceEntityTypeId,
          targetEntityTypeId: rt.targetEntityTypeId,
          cardinality: rt.cardinality ?? 'M:N',
          label: rt.label,
          reverseLabel: rt.reverseLabel ?? '',
          sourceLabel: rt.sourceLabel ?? '',
          targetLabel: rt.targetLabel ?? '',
          roles: rt.roles,
          defaultRole: rt.defaultRole,
          joinFields: rt.joinFields,
          cascadeDelete: rt.cascadeDelete ?? false,
          required: rt.required ?? false,
          templateId: rt.templateId,
          isSystem: rt.isSystem ?? false,
          createdAt: rt.createdAt ? new Date(rt.createdAt) : now,
          updatedAt: rt.updatedAt ? new Date(rt.updatedAt) : now,
        })
      }
    })
    return { relationshipTypes: data.relationshipTypes }
  }

  /** Delete a relationship type of `hubId` — the hub is required, as for {@link updateEntityType}. */
  async deleteRelationshipType(id: string, hubId: string): Promise<{ deleted: true }> {
    const result = await this.db
      .delete(relationshipTypeDefinitions)
      .where(and(eq(relationshipTypeDefinitions.id, id), eq(relationshipTypeDefinitions.hubId, hubId)))
      .returning()
    if (result.length === 0) {
      throw new ServiceError(404, 'Relationship type not found')
    }
    return { deleted: true }
  }

  async generateCaseNumber(data: {
    prefix: string
    year?: number
    hubId?: string
  }): Promise<{ number: string; sequence: number }> {
    const year = data.year ?? new Date().getFullYear()
    const hubId = data.hubId ?? ''

    // Use upsert with RETURNING to atomically get the next value
    const [result] = await this.db
      .insert(caseNumberSequences)
      .values({ hubId, prefix: data.prefix, year, nextValue: 1 })
      .onConflictDoUpdate({
        target: [caseNumberSequences.hubId, caseNumberSequences.prefix, caseNumberSequences.year],
        set: {
          nextValue: sql`${caseNumberSequences.nextValue} + 1`,
        },
      })
      .returning()

    const sequence = result.nextValue
    return {
      number: `${data.prefix}-${year}-${String(sequence).padStart(4, '0')}`,
      sequence,
    }
  }

  private rowToEntityType(
    r: typeof entityTypeDefinitions.$inferSelect,
  ): EntityTypeDefinition {
    return {
      id: r.id,
      hubId: r.hubId,
      name: r.name,
      label: r.label,
      labelPlural: r.labelPlural,
      description: r.description,
      icon: r.icon ?? undefined,
      color: r.color ?? undefined,
      category: r.category as EntityTypeDefinition['category'],
      templateId: r.templateId ?? undefined,
      templateVersion: r.templateVersion ?? undefined,
      fields: (r.fields as EntityFieldDefinition[]) ?? [],
      statuses: (r.statuses as EntityTypeDefinition['statuses']) ?? [],
      defaultStatus: r.defaultStatus,
      closedStatuses: r.closedStatuses ?? [],
      severities: r.severities as EntityTypeDefinition['severities'],
      defaultSeverity: r.defaultSeverity ?? undefined,
      categories: r.categories as EntityTypeDefinition['categories'],
      contactRoles: r.contactRoles as EntityTypeDefinition['contactRoles'],
      numberPrefix: r.numberPrefix ?? undefined,
      numberingEnabled: r.numberingEnabled ?? false,
      defaultAccessLevel:
        (r.defaultAccessLevel as EntityTypeDefinition['defaultAccessLevel']) ??
        'assigned',
      piiFields: r.piiFields ?? [],
      allowSubRecords: r.allowSubRecords ?? false,
      allowFileAttachments: r.allowFileAttachments ?? true,
      allowInteractionLinks: r.allowInteractionLinks ?? true,
      showInNavigation: r.showInNavigation ?? true,
      showInDashboard: r.showInDashboard ?? true,
      accessRoles: r.accessRoles ?? undefined,
      editRoles: r.editRoles ?? undefined,
      autoAssign: r.autoAssign ?? false,
      autoAssignThreshold: r.autoAssignThreshold ?? 30,
      requiredSpecializations: r.requiredSpecializations ?? [],
      notifyContactsOnStatusChange: r.notifyContactsOnStatusChange,
      isArchived: r.isArchived ?? false,
      isSystem: r.isSystem ?? false,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    } as EntityTypeDefinition
  }

  private rowToRelationshipType(
    r: typeof relationshipTypeDefinitions.$inferSelect,
  ): RelationshipTypeDefinition {
    return {
      id: r.id,
      hubId: r.hubId,
      sourceEntityTypeId: r.sourceEntityTypeId ?? undefined,
      targetEntityTypeId: r.targetEntityTypeId ?? undefined,
      cardinality:
        (r.cardinality as RelationshipTypeDefinition['cardinality']) ?? 'M:N',
      label: r.label,
      reverseLabel: r.reverseLabel,
      sourceLabel: r.sourceLabel,
      targetLabel: r.targetLabel,
      roles: r.roles as RelationshipTypeDefinition['roles'],
      defaultRole: r.defaultRole ?? undefined,
      joinFields: r.joinFields as RelationshipTypeDefinition['joinFields'],
      cascadeDelete: r.cascadeDelete ?? false,
      required: r.required ?? false,
      templateId: r.templateId ?? undefined,
      isSystem: r.isSystem ?? false,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    } as RelationshipTypeDefinition
  }
}
