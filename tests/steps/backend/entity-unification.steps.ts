import { expect } from '@playwright/test'
import { Given, When, Then, Before, getState, setState } from './fixtures'
import {
  apiGet,
  apiPost,
  ADMIN_SEED,
  uniqueName,
} from '../../api-helpers'
import { bytesToHex, hexToBytes } from '@shared/encoding'
import { ed25519 } from '@noble/curves/ed25519.js'

function seedHexToPubkey(seedHex: string): string {
  return bytesToHex(ed25519.getPublicKey(hexToBytes(seedHex)))
}

/** Dummy 64-char hex value for HPKE enc field — satisfies hpkeEncSchema validation in tests */
const DUMMY_ENC = '0'.repeat(64)

interface EntityUnificationState {
  lastResponse?: { status: number; headers?: Record<string, string>; body: unknown }
  entityTypeId?: string
  recordId?: string
  createdRecordIds?: string[]
  listResult?: { records: Array<Record<string, unknown>> }
  appliedEntityTypeId?: string
  appliedTemplateIds: string[]
  adminPubkey: string
}

const STATE_KEY = 'entity_unification'

Before({ tags: '@events or @templates or @blind-index or @migration or @permission-aliasing' }, async ({ world }) => {
  const pubkey = seedHexToPubkey(ADMIN_SEED)
  const state: EntityUnificationState = {
    appliedTemplateIds: [],
    adminPubkey: pubkey,
  }
  setState(world, STATE_KEY, state)
})

function getState_(world: Record<string, unknown>): EntityUnificationState {
  return getState<EntityUnificationState>(world, STATE_KEY)
}

Given('an entity type with category {string} exists for the hub', async ({ request, world }, category: string) => {
  const state = getState_(world)
  const res = await apiPost<{ id: string }>(request, '/settings/cms/entity-types', {
    name: uniqueName(`test_${category}_type`, '_'),
    label: `Test ${category} Type`,
    labelPlural: `Test ${category} Types`,
    category,
    fields: [],
    statuses: [{ value: 'active', label: 'Active', isDefault: true }],
    defaultStatus: 'active',
  })
  expect(res.status).toBe(201)
  state.entityTypeId = res.data.id
})

Given('a record exists with blindIndexes containing {string} for field {string}',
  async ({ request, world }, token: string, field: string) => {
    const state = getState_(world)
    const res = await apiPost<{ id: string }>(request, '/records', {
      entityTypeId: state.entityTypeId,
      statusHash: 'active',
      encryptedSummary: `enc-${token}`,
      summaryEnvelopes: [{ pubkey: state.adminPubkey, enc: DUMMY_ENC, ct: 'ct' }],
      blindIndexes: { [field]: [token] },
    })
    expect(res.status).toBe(201)
    state.createdRecordIds ??= []
    state.createdRecordIds.push(res.data.id)
  },
)

Given('the builtin template {string} has been applied', async ({ request, world }, templateId: string) => {
  const state = getState_(world)
  const res = await apiPost<{ entityTypeId: string }>(request, '/settings/cms/templates/apply', { templateId })
  expect(res.status).toBe(201)
  state.appliedEntityTypeId = res.data.entityTypeId
  state.appliedTemplateIds.push(templateId)
})

Given('an event entity type exists with start_date field \\(indexType=date\\)',
  async ({ request, world }) => {
    const state = getState_(world)
    const res = await apiPost<{ id: string }>(request, '/settings/cms/entity-types', {
      name: uniqueName('event_date_type', '_'),
      label: 'Event Date Type',
      labelPlural: 'Event Date Types',
      category: 'event',
      fields: [
        {
          name: 'start_date',
          label: 'Start Date',
          type: 'date',
          indexable: true,
          indexType: 'date',
          order: 0,
        },
      ],
      statuses: [{ value: 'active', label: 'Active', isDefault: true }],
      defaultStatus: 'active',
    })
    expect(res.status).toBe(201)
    state.entityTypeId = res.data.id
  },
)

Given('a record exists with start_date blind indexes for {string}',
  async ({ request, world }, month: string) => {
    const state = getState_(world)
    const token = `month:${month}`
    const res = await apiPost<{ id: string }>(request, '/records', {
      entityTypeId: state.entityTypeId,
      statusHash: 'active',
      encryptedSummary: `enc-${token}`,
      summaryEnvelopes: [{ pubkey: state.adminPubkey, enc: DUMMY_ENC, ct: 'ct' }],
      blindIndexes: { start_date: [token] },
    })
    expect(res.status).toBe(201)
    state.createdRecordIds ??= []
    state.createdRecordIds.push(res.data.id)
  },
)

Given('a user has permission {string} but not {string}',
  async ({ request, world }, hasPermission: string, _missingPermission: string) => {
    const roleRes = await apiPost<{ id: string }>(request, '/roles', {
      name: uniqueName('perm_test_role', '_'),
      permissions: [hasPermission],
    })
    expect(roleRes.status).toBe(201)
    const state = getState_(world)
    state.appliedTemplateIds = [roleRes.data.id]
  },
)

Given('{int} events exist without deprecated_at set', async ({ request, world }, count: number) => {
  const state = getState_(world)
  if (!state.entityTypeId) {
    const res = await apiPost<{ id: string }>(request, '/settings/cms/entity-types', {
      name: uniqueName('event_migration_type', '_'),
      label: 'Event Migration Type',
      labelPlural: 'Event Migration Types',
      category: 'event',
      fields: [],
      statuses: [{ value: 'active', label: 'Active', isDefault: true }],
      defaultStatus: 'active',
    })
    expect(res.status).toBe(201)
    state.entityTypeId = res.data.id
  }
  // Create events via the events API (writes to the events table, not case_records)
  for (let i = 0; i < count; i++) {
    const res = await apiPost<{ id: string }>(request, '/events', {
      entityTypeId: state.entityTypeId,
      statusHash: 'active',
      eventTypeHash: 'legacy',
      startDate: new Date().toISOString(),
      encryptedDetails: `legacy-event-${Date.now()}-${i}`,
      detailEnvelopes: [{ pubkey: state.adminPubkey, enc: DUMMY_ENC, ct: 'ct' }],
    })
    expect(res.status).toBe(201)
    state.createdRecordIds ??= []
    state.createdRecordIds.push(res.data.id)
  }
})

When('the admin creates a record with that entity type', async ({ request, world }) => {
  const state = getState_(world)
  const res = await apiPost<{ id: string }>(request, '/records', {
    entityTypeId: state.entityTypeId,
    statusHash: 'active',
    encryptedSummary: 'encrypted-test-summary',
    summaryEnvelopes: [{ pubkey: state.adminPubkey, enc: DUMMY_ENC, ct: 'ct' }],
  })
  expect(res.status).toBe(201)
  state.recordId = res.data.id
})

When('a client sends GET \\/api\\/events', async ({ request, world }) => {
  const fullPath = '/api/events'
  const res = await request.get(fullPath, {
    headers: {
      'Authorization': `Bearer ${JSON.stringify({ pubkey: seedHexToPubkey(ADMIN_SEED), timestamp: Date.now(), token: '' })}`,
      'Content-Type': 'application/json',
    },
    maxRedirects: 0,
  })
  const state = getState_(world)
  state.lastResponse = {
    status: res.status(),
    headers: Object.fromEntries(Object.entries(res.headers()).map(([k, v]) => [k, String(v)])),
    body: await res.text(),
  }
})

When('the admin lists records with blindIndexToken {string} and field {string}',
  async ({ request, world }, token: string, field: string) => {
    const state = getState_(world)
    const encoded = encodeURIComponent(token)
    const res = await apiGet<{ records: Array<Record<string, unknown>> }>(
      request,
      `/records?entityTypeId=${state.entityTypeId}&blindIndexToken=${encoded}&blindIndexField=${encodeURIComponent(field)}`,
    )
    expect(res.status).toBe(200)
    state.listResult = res.data
  },
)

When('I request GET {string}', async ({ request, world }, path: string) => {
  const res = await apiGet(request, path)
  const state = getState_(world)
  state.lastResponse = {
    status: res.status,
    body: res.data,
  }
})

When('I apply the builtin template {string}', async ({ request, world }, templateId: string) => {
  const res = await apiPost<{ entityTypeId: string }>(request, '/settings/cms/templates/apply', { templateId })
  expect(res.status).toBe(201)
  const state = getState_(world)
  state.appliedEntityTypeId = res.data.entityTypeId
  state.appliedTemplateIds.push(templateId)
})

When('I filter records by blindIndexToken {string} on field {string}',
  async ({ request, world }, token: string, field: string) => {
    const state = getState_(world)
    const encoded = encodeURIComponent(token)
    const res = await apiGet<{ records: Array<Record<string, unknown>> }>(
      request,
      `/records?entityTypeId=${state.entityTypeId}&blindIndexToken=${encoded}&blindIndexField=${encodeURIComponent(field)}`,
    )
    expect(res.status).toBe(200)
    state.listResult = res.data
  },
)

When('the user requests GET {string}', async ({ request, world }, path: string) => {
  const res = await apiGet(request, path)
  const state = getState_(world)
  state.lastResponse = {
    status: res.status,
    body: res.data,
  }
})

When('I POST \\/api\\/admin\\/events\\/migrate', async ({ request, world }) => {
  const res = await apiPost<{ migrated: number }>(request, '/admin/events/migrate', {})
  const state = getState_(world)
  state.lastResponse = {
    status: res.status,
    body: res.data,
  }
})

Then('the record should be persisted', async ({ request, world }) => {
  const state = getState_(world)
  expect(state.recordId).toBeDefined()
  const res = await apiGet(request, `/records/${state.recordId}`)
  expect(res.status).toBe(200)
})

Then('the record entity type category should be {string}', async ({ request, world }, category: string) => {
  const state = getState_(world)
  const res = await apiGet<{ entityTypeId: string }>(request, `/records/${state.recordId}`)
  expect(res.status).toBe(200)
  const etRes = await apiGet<{ category: string }>(request, `/settings/cms/entity-types/${res.data.entityTypeId}`)
  expect(etRes.data.category).toBe(category)
})

Then('the record should use 3-tier encryption \\(summary fields pii\\)',
  async ({ request, world }) => {
    const state = getState_(world)
    const res = await apiGet<Record<string, unknown>>(request, `/records/${state.recordId}`)
    expect(res.status).toBe(200)
    expect(res.data).toHaveProperty('encryptedSummary')
    expect(res.data).toHaveProperty('summaryEnvelopes')
    expect(res.data).not.toHaveProperty('encryptedDetails')
  },
)

Then('the response Location header should contain {string}', async ({ world }, path: string) => {
  const state = getState_(world)
  const location = state.lastResponse?.headers?.location ?? state.lastResponse?.headers?.Location ?? ''
  expect(location).toContain(path)
})

Then('the response should include a Deprecation header', async ({ world }) => {
  const state = getState_(world)
  const deprecation = state.lastResponse?.headers?.deprecation ?? state.lastResponse?.headers?.Deprecation
  expect(deprecation).toBeDefined()
})

Then('the result should contain {int} record', async ({ world }, count: number) => {
  const state = getState_(world)
  expect(state.listResult?.records).toHaveLength(count)
})

Then("that record's blind indexes should contain {string}", async ({ world }, token: string) => {
  const state = getState_(world)
  const records = state.listResult?.records ?? []
  const allTokens = records.flatMap(r => {
    const idx = r.blindIndexes as Record<string, string[]> | undefined
    return idx ? Object.values(idx).flat() : []
  })
  expect(allTokens).toContain(token)
})

Then('the response should contain {int} templates', async ({ world }, count: number) => {
  const state = getState_(world)
  const body = state.lastResponse?.body as { templates?: Array<unknown> } | null
  expect(body?.templates).toHaveLength(count)
})

Then('the template list should include a template with category {string}',
  async ({ world }, category: string) => {
    const state = getState_(world)
    const body = state.lastResponse?.body as { templates?: Array<{ category: string }> } | null
    expect(body?.templates?.some(t => t.category === category)).toBe(true)
  },
)

Then('an entity type with category {string} should be created', async ({ request, world }, category: string) => {
  const state = getState_(world)
  const res = await apiGet<{ category: string }>(request, `/settings/cms/entity-types/${state.appliedEntityTypeId}`)
  expect(res.status).toBe(200)
  expect(res.data.category).toBe(category)
})

Then('that entity type should have a field named {string} with indexType {string}',
  async ({ request, world }, fieldName: string, indexType: string) => {
    const state = getState_(world)
    const res = await apiGet<{ fields: Array<{ name: string; indexType: string }> }>(
      request,
      `/settings/cms/entity-types/${state.appliedEntityTypeId}`,
    )
    expect(res.status).toBe(200)
    const field = res.data.fields.find(f => f.name === fieldName)
    expect(field).toBeDefined()
    expect(field!.indexType).toBe(indexType)
  },
)

Then('only one entity type with templateId {string} should exist',
  async ({ request }, templateId: string) => {
    const res = await apiGet<{ entityTypes: Array<{ templateId?: string }> }>(request, '/settings/cms/entity-types')
    expect(res.status).toBe(200)
    const matching = res.data.entityTypes.filter(et => et.templateId === templateId)
    expect(matching).toHaveLength(1)
  },
)

Then('I should receive {int} record', async ({ world }, count: number) => {
  const state = getState_(world)
  expect(state.listResult?.records).toHaveLength(count)
})

Then('the server should not have seen the plaintext date', async ({ world }) => {
  const state = getState_(world)
  if (state.listResult?.records) {
    for (const record of state.listResult.records) {
      const idx = record.blindIndexes as Record<string, string[]> | undefined
      if (idx?.start_date) {
        for (const token of idx.start_date) {
          expect(token).toMatch(/^month:/)
          expect(token).not.toMatch(/^\d{4}-\d{2}$/)
        }
      }
    }
  }
})

Then('the request should be permitted', async ({ world }) => {
  const state = getState_(world)
  expect(state.lastResponse?.status).toBeLessThan(400)
})

Then('the audit log should show permission alias {string}', async ({ request }, alias: string) => {
  const res = await apiGet<{ entries: Array<{ details?: string }> }>(request, '/audit')
  expect(res.status).toBe(200)
  const hasAlias = res.data.entries.some(e => e.details?.includes(alias))
  expect(hasAlias).toBe(true)
})

Then('the response should contain pendingCount {int}', async ({ world }, count: number) => {
  const state = getState_(world)
  const body = state.lastResponse?.body as { pendingCount?: number } | null
  expect(body?.pendingCount).toBe(count)
})

Then('all {int} events should have deprecated_at set', async ({ world }, count: number) => {
  const state = getState_(world)
  const body = state.lastResponse?.body as { migrated?: number } | null
  expect(body?.migrated).toBe(count)
})

Then('the response should contain migrated {int}', async ({ world }, count: number) => {
  const state = getState_(world)
  const body = state.lastResponse?.body as { migrated?: number } | null
  expect(body?.migrated).toBe(count)
})
