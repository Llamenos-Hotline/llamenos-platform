import { eq, and, sql } from 'drizzle-orm'
import type { Database } from '../db'
import { systemSettings, reportTypeDefinitions } from '../db/schema'
import type { ReportType } from '@shared/types'
import {
  MAX_CUSTOM_FIELDS,
  MAX_REPORT_TYPES,
  MAX_REPORT_TYPE_NAME_LENGTH,
  MAX_REPORT_TYPE_DESCRIPTION_LENGTH,
  DEFAULT_REPORT_TYPES,
  MAX_ENTITY_TYPES,
} from '@shared/types'
import type { ReportTypeDefinition, ReportFieldDefinition } from '@protocol/schemas/report-types'
import { lockReplaceAll } from './replace-all-lock'
import { ServiceError } from './service-error'
import { SINGLETON_ID, getSettings } from './system-settings-row'

/**
 * Report categories and report-type definitions: the system-settings report types and the case-management
 * report types (`report_type_definitions`).
 */
export class ReportTypesService {
  constructor(protected db: Database) {}

  async getReportCategories(): Promise<{ categories: string[] }> {
    const row = await getSettings(this.db)
    return {
      categories: row.reportCategories ?? [
        'Incident Report',
        'Field Observation',
        'Evidence',
        'Other',
      ],
    }
  }

  async updateReportCategories(data: {
    categories: string[]
  }): Promise<{ categories: string[] }> {
    if (!Array.isArray(data.categories)) {
      throw new ServiceError(400, 'categories must be an array')
    }
    const categories = data.categories.slice(0, 50)
    await this.db
      .update(systemSettings)
      .set({ reportCategories: categories })
      .where(eq(systemSettings.id, SINGLETON_ID))
    return { categories }
  }

  async getReportTypes(): Promise<{ reportTypes: ReportType[] }> {
    const row = await getSettings(this.db)
    let reportTypes = row.reportTypes as ReportType[] | null
    if (!reportTypes || reportTypes.length === 0) {
      const now = new Date().toISOString()
      reportTypes = DEFAULT_REPORT_TYPES.map((d) => ({
        ...d,
        id: crypto.randomUUID(),
        fields: [],
        isArchived: false,
        createdAt: now,
        updatedAt: now,
      }))
      await this.db
        .update(systemSettings)
        .set({ reportTypes })
        .where(eq(systemSettings.id, SINGLETON_ID))
    }
    return { reportTypes }
  }

  async createReportType(data: Partial<ReportType>): Promise<ReportType> {
    if (!data || typeof data !== 'object') {
      throw new ServiceError(400, 'Invalid request body')
    }

    const { name, description, icon, fields, isDefault } = data

    if (!name || !name.trim()) {
      throw new ServiceError(400, 'Name is required')
    }
    if (name.length > MAX_REPORT_TYPE_NAME_LENGTH) {
      throw new ServiceError(
        400,
        `Name too long (max ${MAX_REPORT_TYPE_NAME_LENGTH} chars)`,
      )
    }
    if (description && description.length > MAX_REPORT_TYPE_DESCRIPTION_LENGTH) {
      throw new ServiceError(
        400,
        `Description too long (max ${MAX_REPORT_TYPE_DESCRIPTION_LENGTH} chars)`,
      )
    }

    const row = await getSettings(this.db)
    const reportTypes = (row.reportTypes as ReportType[]) ?? []

    if (reportTypes.filter((rt) => !rt.isArchived).length >= MAX_REPORT_TYPES) {
      throw new ServiceError(
        400,
        `Maximum ${MAX_REPORT_TYPES} active report types`,
      )
    }

    if (fields && fields.length > MAX_CUSTOM_FIELDS) {
      throw new ServiceError(
        400,
        `Maximum ${MAX_CUSTOM_FIELDS} fields per report type`,
      )
    }

    const now = new Date().toISOString()

    if (isDefault) {
      for (const rt of reportTypes) {
        rt.isDefault = false
      }
    }

    const reportType: ReportType = {
      id: crypto.randomUUID(),
      name: name.trim(),
      description: (description || '').trim(),
      icon: icon || undefined,
      fields: fields || [],
      isDefault: isDefault || false,
      isArchived: false,
      createdAt: now,
      updatedAt: now,
    }

    reportTypes.push(reportType)
    await this.db
      .update(systemSettings)
      .set({ reportTypes })
      .where(eq(systemSettings.id, SINGLETON_ID))
    return reportType
  }

  async updateReportType(
    id: string,
    data: Partial<ReportType>,
  ): Promise<ReportType> {
    if (!data || typeof data !== 'object') {
      throw new ServiceError(400, 'Invalid request body')
    }

    const row = await getSettings(this.db)
    const reportTypes = (row.reportTypes as ReportType[]) ?? []
    const idx = reportTypes.findIndex((rt) => rt.id === id)
    if (idx === -1) {
      throw new ServiceError(404, 'Report type not found')
    }

    const rt = reportTypes[idx]

    if (data.name !== undefined) {
      if (!data.name.trim()) {
        throw new ServiceError(400, 'Name cannot be empty')
      }
      if (data.name.length > MAX_REPORT_TYPE_NAME_LENGTH) {
        throw new ServiceError(
          400,
          `Name too long (max ${MAX_REPORT_TYPE_NAME_LENGTH} chars)`,
        )
      }
      rt.name = data.name.trim()
    }

    if (data.description !== undefined) {
      if (data.description.length > MAX_REPORT_TYPE_DESCRIPTION_LENGTH) {
        throw new ServiceError(
          400,
          `Description too long (max ${MAX_REPORT_TYPE_DESCRIPTION_LENGTH} chars)`,
        )
      }
      rt.description = data.description.trim()
    }

    if (data.icon !== undefined) rt.icon = data.icon || undefined
    if (data.fields !== undefined) {
      if (data.fields.length > MAX_CUSTOM_FIELDS) {
        throw new ServiceError(
          400,
          `Maximum ${MAX_CUSTOM_FIELDS} fields per report type`,
        )
      }
      rt.fields = data.fields
    }

    if (data.isDefault !== undefined) {
      if (data.isDefault) {
        for (const other of reportTypes) {
          other.isDefault = false
        }
      }
      rt.isDefault = data.isDefault
    }

    rt.updatedAt = new Date().toISOString()
    reportTypes[idx] = rt
    await this.db
      .update(systemSettings)
      .set({ reportTypes })
      .where(eq(systemSettings.id, SINGLETON_ID))
    return rt
  }

  async archiveReportType(id: string): Promise<{ ok: true }> {
    const row = await getSettings(this.db)
    const reportTypes = (row.reportTypes as ReportType[]) ?? []
    const idx = reportTypes.findIndex((rt) => rt.id === id)
    if (idx === -1) {
      throw new ServiceError(404, 'Report type not found')
    }

    const activeCount = reportTypes.filter((rt) => !rt.isArchived).length
    if (activeCount <= 1 && !reportTypes[idx].isArchived) {
      throw new ServiceError(
        400,
        'Cannot archive the last active report type',
      )
    }

    reportTypes[idx].isArchived = true
    reportTypes[idx].isDefault = false
    reportTypes[idx].updatedAt = new Date().toISOString()

    if (!reportTypes.some((rt) => rt.isDefault && !rt.isArchived)) {
      const firstActive = reportTypes.find((rt) => !rt.isArchived)
      if (firstActive) firstActive.isDefault = true
    }

    await this.db
      .update(systemSettings)
      .set({ reportTypes })
      .where(eq(systemSettings.id, SINGLETON_ID))
    return { ok: true }
  }

  /**
   * Report type definitions for one hub, or — when `hubId` is `undefined` —
   * every hub's. The parameter is required rather than optional on purpose:
   * omitting it silently widened the triage queue's conversion filter to every
   * hub's configuration (#1591), so each caller has to state its scope and the
   * type checker catches any that does not.
   */
  async getCmsReportTypes(hubId: string | undefined): Promise<{
    reportTypes: ReportTypeDefinition[]
  }> {
    const rows = hubId !== undefined
      ? await this.db.select().from(reportTypeDefinitions).where(eq(reportTypeDefinitions.hubId, hubId))
      : await this.db.select().from(reportTypeDefinitions)
    return {
      reportTypes: rows.map((r) => this.rowToReportTypeDefinition(r)),
    }
  }

  /**
   * A report type of `hubId`. The hub is required for the same reason as
   * {@link EntitySchemaService.getEntityTypeById}'s: a type of another hub is
   * indistinguishable from one that does not exist (#2631).
   */
  async getCmsReportTypeById(
    id: string,
    hubId: string,
  ): Promise<ReportTypeDefinition> {
    const [row] = await this.db
      .select()
      .from(reportTypeDefinitions)
      .where(and(eq(reportTypeDefinitions.id, id), eq(reportTypeDefinitions.hubId, hubId)))
    if (!row) {
      throw new ServiceError(404, 'Report type not found')
    }
    return this.rowToReportTypeDefinition(row)
  }

  async createCmsReportType(
    data: Record<string, unknown>,
  ): Promise<ReportTypeDefinition> {
    const hubId = (data.hubId as string) ?? ''
    const count = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(reportTypeDefinitions)
      .where(eq(reportTypeDefinitions.hubId, hubId))
    if (Number(count[0].count) >= MAX_ENTITY_TYPES) {
      throw new ServiceError(
        400,
        `Maximum of ${MAX_ENTITY_TYPES} report type definitions allowed`,
      )
    }

    const name = data.name as string
    const [dup] = await this.db
      .select()
      .from(reportTypeDefinitions)
      .where(
        and(
          eq(reportTypeDefinitions.hubId, hubId),
          eq(reportTypeDefinitions.name, name),
          eq(reportTypeDefinitions.isArchived, false),
        ),
      )
    if (dup) {
      throw new ServiceError(
        409,
        `Report type with name "${name}" already exists`,
      )
    }

    const now = new Date()
    const id = crypto.randomUUID()

    const fields = ((data.fields as ReportFieldDefinition[]) ?? []).map(
      (f) => ({
        ...f,
        id: f.id || crypto.randomUUID(),
      }),
    )

    await this.db.insert(reportTypeDefinitions).values({
      id,
      hubId: (data.hubId as string) ?? '',
      name,
      label: (data.label as string) ?? name,
      labelPlural: (data.labelPlural as string) ?? '',
      description: (data.description as string) ?? '',
      icon: data.icon as string | undefined,
      color: data.color as string | undefined,
      fields,
      statuses: (data.statuses as unknown[]) ?? [],
      defaultStatus: (data.defaultStatus as string) ?? '',
      closedStatuses: (data.closedStatuses as string[]) ?? [],
      allowCaseConversion: (data.allowCaseConversion as boolean) ?? false,
      mobileOptimized: (data.mobileOptimized as boolean) ?? false,
      templateId: data.templateId as string | undefined,
      isArchived: false,
      isSystem: (data.isSystem as boolean) ?? false,
      createdAt: now,
      updatedAt: now,
    })

    const [created] = await this.db
      .select()
      .from(reportTypeDefinitions)
      .where(eq(reportTypeDefinitions.id, id))
    return this.rowToReportTypeDefinition(created)
  }

  /** Update a report type of `hubId` — the hub is required and part of every statement's WHERE (#2631). */
  async updateCmsReportType(
    id: string,
    hubId: string,
    data: Record<string, unknown>,
  ): Promise<ReportTypeDefinition> {
    const inHub = and(eq(reportTypeDefinitions.id, id), eq(reportTypeDefinitions.hubId, hubId))
    const [existing] = await this.db
      .select()
      .from(reportTypeDefinitions)
      .where(inHub)
    if (!existing) {
      throw new ServiceError(404, 'Report type not found')
    }

    // Assign IDs to new fields
    if (data.fields && Array.isArray(data.fields)) {
      data.fields = (data.fields as ReportFieldDefinition[]).map((f) => ({
        ...f,
        id: f.id || crypto.randomUUID(),
      }))
    }

    const now = new Date()
    const updates: Record<string, unknown> = { updatedAt: now }

    const fieldMap: Record<string, string> = {
      name: 'name',
      label: 'label',
      labelPlural: 'labelPlural',
      description: 'description',
      icon: 'icon',
      color: 'color',
      fields: 'fields',
      statuses: 'statuses',
      defaultStatus: 'defaultStatus',
      closedStatuses: 'closedStatuses',
      allowCaseConversion: 'allowCaseConversion',
      mobileOptimized: 'mobileOptimized',
      templateId: 'templateId',
      isArchived: 'isArchived',
      isSystem: 'isSystem',
    }

    for (const [dataKey, dbKey] of Object.entries(fieldMap)) {
      if (data[dataKey] !== undefined) {
        updates[dbKey] = data[dataKey]
      }
    }

    await this.db
      .update(reportTypeDefinitions)
      .set(updates)
      .where(inHub)

    const [updated] = await this.db
      .select()
      .from(reportTypeDefinitions)
      .where(inHub)
    return this.rowToReportTypeDefinition(updated)
  }

  async bulkSetCmsReportTypes(data: {
    reportTypes: ReportTypeDefinition[]
    hubId?: string
  }): Promise<{ reportTypes: ReportTypeDefinition[] }> {
    await this.db.transaction(async (tx) => {
      await lockReplaceAll(tx, 'report_type_definitions')
      if (data.hubId !== undefined) {
        await tx.delete(reportTypeDefinitions).where(eq(reportTypeDefinitions.hubId, data.hubId))
      } else {
        await tx.delete(reportTypeDefinitions)
      }
      for (const rt of data.reportTypes) {
        const now = new Date()
        await tx.insert(reportTypeDefinitions).values({
          id: rt.id,
          hubId: rt.hubId ?? '',
          name: rt.name,
          label: rt.label,
          labelPlural: rt.labelPlural ?? '',
          description: rt.description ?? '',
          icon: rt.icon,
          color: rt.color,
          fields: rt.fields ?? [],
          statuses: rt.statuses ?? [],
          defaultStatus: rt.defaultStatus ?? '',
          closedStatuses: rt.closedStatuses ?? [],
          allowCaseConversion: rt.allowCaseConversion ?? false,
          mobileOptimized: rt.mobileOptimized ?? false,
          templateId: rt.templateId,
          isArchived: rt.isArchived ?? false,
          isSystem: rt.isSystem ?? false,
          createdAt: rt.createdAt ? new Date(rt.createdAt) : now,
          updatedAt: rt.updatedAt ? new Date(rt.updatedAt) : now,
        })
      }
    })
    return { reportTypes: data.reportTypes }
  }

  /** Archive a report type of `hubId` — the hub is required, as for {@link updateCmsReportType}. */
  async deleteCmsReportType(
    id: string,
    hubId: string,
  ): Promise<{ archived: true; id: string }> {
    const inHub = and(eq(reportTypeDefinitions.id, id), eq(reportTypeDefinitions.hubId, hubId))
    const [existing] = await this.db
      .select()
      .from(reportTypeDefinitions)
      .where(inHub)
    if (!existing) {
      throw new ServiceError(404, 'Report type not found')
    }

    // Soft delete: mark as archived
    await this.db
      .update(reportTypeDefinitions)
      .set({
        isArchived: true,
        updatedAt: new Date(),
      })
      .where(inHub)

    return { archived: true, id }
  }

  private rowToReportTypeDefinition(
    r: typeof reportTypeDefinitions.$inferSelect,
  ): ReportTypeDefinition {
    return {
      id: r.id,
      hubId: r.hubId,
      name: r.name,
      label: r.label,
      labelPlural: r.labelPlural,
      description: r.description,
      icon: r.icon ?? undefined,
      color: r.color ?? undefined,
      category: 'report',
      fields: (r.fields as ReportFieldDefinition[]) ?? [],
      statuses: (r.statuses as ReportTypeDefinition['statuses']) ?? [],
      defaultStatus: r.defaultStatus,
      closedStatuses: r.closedStatuses ?? [],
      allowCaseConversion: r.allowCaseConversion ?? false,
      mobileOptimized: r.mobileOptimized ?? false,
      templateId: r.templateId ?? undefined,
      isArchived: r.isArchived ?? false,
      isSystem: r.isSystem ?? false,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    } as ReportTypeDefinition
  }
}
