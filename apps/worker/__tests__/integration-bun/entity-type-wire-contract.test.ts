/**
 * The entity-types response carries every key its schema requires — real PostgreSQL.
 *
 * MUST run under `bun test`, NOT vitest:
 *   bun test apps/worker/__tests__/integration-bun/entity-type-wire-contract.test.ts
 *
 * Why this exists: `rowToEntityType` ends in `as EntityTypeDefinition`, which stops the
 * compiler from noticing a key the schema declares and the service never emits. That is
 * exactly what happened to `notifyContactsOnStatusChange` — declared with
 * `.optional().default(false)`, accepted on create and PATCH, and then neither stored
 * nor returned. The Swift generator reads the OUTPUT JSON Schema, in which a defaulted
 * field is required, so the generated `EntityType` demands the key, and every iOS
 * client that listed entity types failed with `keyNotFound` (the merge-queue run that
 * ejected #1653: 21 CaseManagementUITests, "Cases failed to load"). Kotlin hid it by
 * injecting defaults; nothing on the server side noticed.
 *
 * Requires postgres at DATABASE_URL with migrations applied
 * (`bun scripts/worktree-db.ts use-isolated`). Rows created here are deleted on teardown.
 */
import { describe, it, expect, afterAll } from 'bun:test'
import { inArray } from 'drizzle-orm'
import { z } from 'zod'
import '../../db/pg-array-patch'
import { createDatabase } from '../../db'
import { entityTypeDefinitions, hubs } from '../../db/schema'
import { SettingsService } from '../../services/settings'
import { entityTypeDefinitionSchema } from '@protocol/schemas/entity-schema'

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

const db = createDatabase(DATABASE_URL)
const settings = new SettingsService(db)

const createdHubIds: string[] = []

async function freshHub(label: string): Promise<string> {
  const id = `hub-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await db.insert(hubs).values({ id, name: `Wire contract ${label}`, slug: id, createdBy: 'integration-test' })
  createdHubIds.push(id)
  return id
}

afterAll(async () => {
  if (createdHubIds.length > 0) {
    await db.delete(entityTypeDefinitions).where(inArray(entityTypeDefinitions.hubId, createdHubIds))
    await db.delete(hubs).where(inArray(hubs.id, createdHubIds))
  }
})

function baseBody(hubId: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    hubId,
    name,
    label: name,
    labelPlural: `${name}s`,
    category: 'case',
    statuses: [{ value: 'open', label: 'Open', order: 0 }],
    defaultStatus: 'open',
    closedStatuses: [],
    fields: [],
    ...extra,
  }
}

describe('entity-types wire contract', () => {
  it('emits every key the OUTPUT schema requires (what the Swift/Kotlin codegen reads)', async () => {
    const hubId = await freshHub('contract')
    await settings.createEntityType(baseBody(hubId, 'contract_type'))
    const { entityTypes } = await settings.getEntityTypes(hubId)
    expect(entityTypes).toHaveLength(1)

    const outputSchema = z.toJSONSchema(entityTypeDefinitionSchema, { io: 'output' }) as {
      required?: string[]
    }
    const required = outputSchema.required ?? []
    // Guard the guard: an empty list would make the loop below vacuous.
    expect(required).toContain('notifyContactsOnStatusChange')
    expect(required).toContain('id')

    const emitted = new Set(Object.keys(entityTypes[0]))
    const missing = required.filter((key) => !emitted.has(key))
    expect(missing).toEqual([])
  })

  it('stores notifyContactsOnStatusChange on create, returns it, and honours PATCH', async () => {
    const hubId = await freshHub('notify')

    const off = await settings.createEntityType(baseBody(hubId, 'notify_default'))
    expect(off.notifyContactsOnStatusChange).toBe(false)

    const on = await settings.createEntityType(
      baseBody(hubId, 'notify_on', { notifyContactsOnStatusChange: true }),
    )
    expect(on.notifyContactsOnStatusChange).toBe(true)
    expect((await settings.getEntityTypeById(on.id)).notifyContactsOnStatusChange).toBe(true)

    const flipped = await settings.updateEntityType(on.id, { notifyContactsOnStatusChange: false })
    expect(flipped.notifyContactsOnStatusChange).toBe(false)
    expect((await settings.getEntityTypeById(on.id)).notifyContactsOnStatusChange).toBe(false)

    // A PATCH that does not mention the flag must not reset it.
    const set = await settings.updateEntityType(on.id, { notifyContactsOnStatusChange: true })
    expect(set.notifyContactsOnStatusChange).toBe(true)
    const untouched = await settings.updateEntityType(on.id, { label: 'renamed' })
    expect(untouched.notifyContactsOnStatusChange).toBe(true)
  })
})
