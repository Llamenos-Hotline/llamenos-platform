/**
 * `POST /api/test-seed` reports what it did, step by step (#3088).
 *
 * It used to return `ok: true` unconditionally, with partial failures in a
 * `warnings` list the Android client never read (it read `errors`) — so a seed
 * that dropped a step passed, and #3082/#3083 took hours to find. These tests
 * pin the response a client can act on: `ok` is false when any requested step
 * did not happen, the failed step is named, and a warning is never a failure.
 *
 * The literal wire JSON in the last test is the same document
 * `SeedResultTest.kt` (Android) decodes — change one, change both.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('@worker/db', () => ({
  createDatabase: vi.fn(),
  getDb: vi.fn(),
  closeDb: vi.fn(),
  schema: {},
}))

import { Hono } from 'hono'
import dev from '@worker/routes/dev'
import { seedResultSchema } from '@worker/lib/test-seed-result'
import type { AppEnv } from '@worker/types'

const SECRET = 'test-reset-secret'
const HUB_ID = '11111111-1111-4111-8111-111111111111'
const ADMIN_SEED = 'b'.repeat(64)
const MEMBER = 'c'.repeat(64)
const ENV = { ENVIRONMENT: 'development', DEV_ROUTES_ENABLED: 'true', DEV_RESET_SECRET: SECRET }

function seedApp(overrides: {
  setHubRole?: () => Promise<void>
  createEntityType?: (arg: unknown) => Promise<{ id: string }>
  buildReaderPubkeys?: () => Promise<string[]>
} = {}) {
  const services = {
    settingsBootstrap: { ensureInit: vi.fn(async () => undefined) },
    hubSettings: { setCaseManagementEnabled: vi.fn(async () => ({ enabled: true })) },
    identity: {
      setHubRole: vi.fn(overrides.setHubRole ?? (async () => undefined)),
      // No registered device: the record keeps the dummy envelope (see routes/dev.ts).
      buildReaderPubkeys: vi.fn(overrides.buildReaderPubkeys ?? (async () => [])),
    },
    entitySchema: {
      createEntityType: vi.fn(overrides.createEntityType ?? (async () => ({ id: 'et-1' }))),
      getEntityTypes: vi.fn(async () => ({ entityTypes: [{ id: 'et-existing', name: 'arrest_case' }] })),
    },
    cases: { create: vi.fn(async () => ({ id: 'rec-1', caseNumber: 'JS-1' })) },
  }
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('services', services as never)
    await next()
  })
  app.route('/', dev)
  const seed = async (body: Record<string, unknown>) => {
    const res = await app.request(
      '/test-seed',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Test-Secret': SECRET },
        body: JSON.stringify({ hubId: HUB_ID, adminSeed: ADMIN_SEED, ...body }),
      },
      ENV,
    )
    return { status: res.status, body: seedResultSchema.parse(await res.json()) }
  }
  return { seed, services }
}

describe('test-seed reports per-step outcomes (#3088)', () => {
  it('is ok with every step ok, no failures and no warnings', async () => {
    const { seed } = seedApp()
    const { status, body } = await seed({
      permissions: { enableCaseManagement: true },
      members: [{ pubkey: MEMBER }],
      entityTypes: [{ template: 'arrest_case', records: 1 }],
    })

    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.failures).toEqual([])
    expect(body.warnings).toEqual([])
    expect(body.steps.map((s) => [s.step, s.outcome])).toEqual([
      ['setCaseManagementEnabled', 'ok'],
      [`member ${MEMBER.slice(0, 8)}...`, 'ok'],
      ['entityType arrest_case', 'ok'],
      ['record arrest_case[0]', 'ok'],
    ])
    expect(body.members).toEqual([{ pubkey: MEMBER }])
    expect(body.records).toHaveLength(1)
  })

  it('is NOT ok when a requested step fails, and names the step and why', async () => {
    const { seed } = seedApp({ setHubRole: async () => { throw new Error('role-volunteer not found') } })
    const { status, body } = await seed({ members: [{ pubkey: MEMBER }], entityTypes: [{ template: 'arrest_case', records: 1 }] })

    expect(status).toBe(200)
    expect(body.ok).toBe(false)
    expect(body.failures).toEqual([`member ${MEMBER.slice(0, 8)}...: role-volunteer not found`])
    expect(body.members).toEqual([]) // not reported as seeded
    // The steps that did happen are still reported: a client can tell "did some of it".
    expect(body.entityTypes).toHaveLength(1)
    expect(body.steps.filter((s) => s.outcome === 'failed').map((s) => s.step)).toEqual([`member ${MEMBER.slice(0, 8)}...`])
  })

  it('skips the records of an entity type that could not be created, and fails the entity type step', async () => {
    const { seed } = seedApp({ createEntityType: async () => { throw new Error('boom') } })
    const { body } = await seed({ entityTypes: [{ template: 'arrest_case', records: 2 }] })

    expect(body.ok).toBe(false)
    expect(body.failures).toEqual(['entityType arrest_case: boom'])
    expect(body.records).toEqual([])
  })

  it('fails a record step whose reader lookup fails, and creates no record it could not seal', async () => {
    const { seed, services } = seedApp({ buildReaderPubkeys: async () => { throw new Error('reader lookup failed') } })
    const { body } = await seed({ entityTypes: [{ template: 'arrest_case', records: 1 }] })

    expect(body.ok).toBe(false)
    expect(body.failures).toEqual(['record arrest_case[0]: reader lookup failed'])
    expect(body.records).toEqual([])
    expect(services.cases.create).not.toHaveBeenCalled()
  })

  it('treats a reused entity type as ok with a warning — a warning is not a failure', async () => {
    const { seed } = seedApp({ createEntityType: async () => { throw new Error('Entity type already exists') } })
    const { body } = await seed({ entityTypes: [{ template: 'arrest_case', records: 1 }] })

    expect(body.ok).toBe(true)
    expect(body.failures).toEqual([])
    expect(body.warnings).toEqual(['entityType arrest_case: already existed, reused et-existing'])
    expect(body.entityTypes).toEqual([{ id: 'et-existing', name: 'arrest_case', category: 'case' }])
  })
})

describe('test-seed wire shape (shared with SeedResultTest.kt on Android)', () => {
  it('accepts the fixture the Android client decodes', () => {
    const wire = {
      ok: false,
      hubId: HUB_ID,
      entityTypes: [{ id: 'et-1', name: 'arrest_case', category: 'case' }],
      records: [{ id: 'rec-1', entityTypeId: 'et-1', caseNumber: 'JS-1' }],
      reportTypes: [],
      triageReports: [],
      shifts: [],
      members: [],
      contacts: [],
      steps: [
        { step: 'entityType arrest_case', outcome: 'ok' },
        { step: 'member cccccccc...', outcome: 'failed', error: 'role-volunteer not found' },
      ],
      failures: ['member cccccccc...: role-volunteer not found'],
      warnings: ['entityType arrest_case: already existed, reused et-1'],
    }
    expect(seedResultSchema.parse(wire)).toEqual(wire)
  })
})
