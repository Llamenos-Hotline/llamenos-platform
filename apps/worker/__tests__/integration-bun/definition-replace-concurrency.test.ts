/**
 * Concurrent "replace the whole list" writes to a hub's entity-type definitions
 * — real PostgreSQL, Bun-native driver.
 *
 * MUST run under `bun test`, NOT vitest (see hub-last-admin.test.ts):
 *   bun test apps/worker/__tests__/integration-bun/definition-replace-concurrency.test.ts
 *
 * Applying a template is read existing → merge → `bulkSetEntityTypes`, which
 * deletes the hub's rows and re-inserts the merged list. A type that already
 * exists keeps its id, so two applications racing each other both re-insert that
 * id: under READ COMMITTED the second DELETE cannot see the row the first one
 * just committed, and the second INSERT fails on the primary key — an unhandled
 * 500 from `POST /settings/cms/templates/apply`. Each `it` is a head-on race on
 * ONE hub; both must succeed and leave exactly the replaced list behind.
 */
import { describe, it, expect, afterAll } from 'bun:test'
import { eq } from 'drizzle-orm'
import '../../db/pg-array-patch'
import { createDatabase } from '../../db'
import { entityTypeDefinitions } from '../../db/schema'
import { SettingsService } from '../../services/settings'
import { applyTemplate } from '../../lib/template-engine'
import { loadBundledTemplates } from '../../lib/template-loader'

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

const db = createDatabase(DATABASE_URL)
const settings = new SettingsService(db)

const hubId = `hub-replace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

afterAll(async () => {
  await db.delete(entityTypeDefinitions).where(eq(entityTypeDefinitions.hubId, hubId))
})

/** The route's own sequence (routes/entity-schema.ts, POST /templates/apply), minus HTTP. */
async function applyEventTemplate(): Promise<void> {
  const templates = await loadBundledTemplates()
  const template = templates.find(t => t.id === 'builtin:event')
  if (!template) throw new Error('builtin:event template is missing')
  const { entityTypes: existing } = await settings.getEntityTypes(hubId)
  const { reportTypes } = await settings.getCmsReportTypes(hubId)
  const result = applyTemplate(template, hubId, new Map(templates.map(t => [t.id, t])), existing, reportTypes)
  const merged = [...existing]
  for (const created of result.entityTypes) {
    const at = merged.findIndex(e => e.name === created.name)
    if (at >= 0) merged[at] = created
    else merged.push(created)
  }
  await settings.bulkSetEntityTypes({ entityTypes: merged, hubId })
}

describe('replacing a hub\'s entity types', () => {
  it('survives concurrent applications of a template the hub already has', async () => {
    await applyEventTemplate()
    const settled = await Promise.allSettled(Array.from({ length: 6 }, applyEventTemplate))

    const failures = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(failures.map(f => String((f.reason as { cause?: unknown }).cause ?? f.reason))).toEqual([])

    const rows = await db.select().from(entityTypeDefinitions).where(eq(entityTypeDefinitions.hubId, hubId))
    expect(rows.filter(r => r.templateId === 'builtin:event')).toHaveLength(1)
  })
})
