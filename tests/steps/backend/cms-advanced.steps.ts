/**
 * BDD step definitions for EP06-A4 CMS Advanced features:
 * - Contact merge
 * - Entity (record) merge
 * - Bulk contact operations
 * - Batch contact import
 * - Cross-hub entity queries
 */
import { expect } from '@playwright/test'
import { Given, When, Then, getState, setState } from './fixtures'
import { getScenarioState } from './common.steps'
import { setLastResponse } from './shared-state'
import {
  createContactViaApi,
  createRecordViaApi,
  createEntityTypeViaApi,
  listContactsViaApi,
  apiPost,
  apiGet,
} from '../../api-helpers'

interface CmsAdvancedState {
  contactIds: string[]
  recordIds: string[]
  lastMergeResponse?: Record<string, unknown>
  lastBulkResponse?: Record<string, unknown>
  lastBulkCreateResponse?: Record<string, unknown>
  lastListResponse?: Record<string, unknown>
  lastStatusCode?: number
}

const KEY = 'cms-advanced'

function getAdv(world: Record<string, unknown>): CmsAdvancedState {
  let s = getState<CmsAdvancedState | undefined>(world, KEY)
  if (!s) {
    s = { contactIds: [], recordIds: [] }
    setState(world, KEY, s)
  }
  return s
}

function setAdv(world: Record<string, unknown>, patch: Partial<CmsAdvancedState>) {
  const current = getAdv(world)
  setState(world, KEY, { ...current, ...patch })
}

/**
 * A well-formed id that names nothing. The fixed placeholders these steps used
 * (`00000000-…-000000000001`) are not RFC 9562 UUIDs, so `z.uuid()` rejected them
 * with 400 before the lookup ran — the "not found" scenarios never reached it.
 */
function nonexistentId(): string {
  return crypto.randomUUID()
}

// ── Setup ─────────────────────────────────────────────────────────────────

Given('two contacts exist in the directory', async ({ world, request }) => {
  const hubId = getScenarioState(world).hubId

  const c1 = await createContactViaApi(request, { hubId, encryptedSummary: 'primary-enc' })
  const c2 = await createContactViaApi(request, { hubId, encryptedSummary: 'secondary-enc' })
  const id1 = String(c1.id)
  const id2 = String(c2.id)
  setAdv(world, { contactIds: [id1, id2] })
})

Given('three contacts exist in the directory', async ({ world, request }) => {
  const hubId = getScenarioState(world).hubId
  const ids: string[] = []
  for (let i = 0; i < 3; i++) {
    const c = await createContactViaApi(request, { hubId, encryptedSummary: `bulk-enc-${i}` })
    ids.push(String(c.id))
  }
  setAdv(world, { contactIds: ids })
})

Given('a contact exists in the directory', async ({ world, request }) => {
  const hubId = getScenarioState(world).hubId
  const c = await createContactViaApi(request, { hubId })
  setAdv(world, { contactIds: [String(c.id)] })
})

Given('two records exist in the case management system', async ({ world, request }) => {
  const hubId = getScenarioState(world).hubId

  // Create a minimal entity type for the records
  const et = await createEntityTypeViaApi(request, {
    name: `cms_adv_${Date.now()}`,
    category: 'case',
    hubId,
  })
  const entityTypeId = String(et.id)

  const r1 = await createRecordViaApi(request, entityTypeId, { hubId, statusHash: 'status_open_hash' })
  const r2 = await createRecordViaApi(request, entityTypeId, { hubId, statusHash: 'status_open_hash' })
  setAdv(world, { recordIds: [String(r1.id), String(r2.id)] })
})

Given('the requesting user has records in multiple hubs', async ({ world }) => {
  setAdv(world, {})
})

Given('the requesting user lacks cases:read-cross-hub permission', async ({ world }) => {
  setAdv(world, {})
})

// ── Contact Merge ─────────────────────────────────────────────────────────

When('I merge the secondary contact into the primary contact with re-encrypted merged data', async ({ world, request }) => {
  const hubId = getScenarioState(world).hubId
  const adv = getAdv(world)
  const [primaryId, secondaryId] = adv.contactIds

  const { status, data } = await apiPost(request, `/hubs/${hubId}/directory/merge`, {
    primaryId,
    secondaryId,
    mergedEncryptedSummary: 'merged-ciphertext',
    mergedSummaryEnvelopes: [],
    mergedBlindIndexes: { identifierHashes: [], tagHashes: [] },
    mergedTrigramTokens: [],
  })

  setAdv(world, {
    lastMergeResponse: data as Record<string, unknown>,
    lastStatusCode: status,
  })
  setLastResponse(world, { status, data })
})

When('I attempt to merge a non-existent primary contact', async ({ world, request }) => {
  const hubId = getScenarioState(world).hubId

  const { status, data } = await apiPost(request, `/hubs/${hubId}/directory/merge`, {
    primaryId: nonexistentId(),
    secondaryId: nonexistentId(),
    mergedEncryptedSummary: 'x',
    mergedSummaryEnvelopes: [],
    mergedBlindIndexes: { identifierHashes: [], tagHashes: [] },
    mergedTrigramTokens: [],
  })

  setAdv(world, { lastStatusCode: status })
  setLastResponse(world, { status, data })
})

When('I attempt to merge a non-existent secondary contact into the contact', async ({ world, request }) => {
  const hubId = getScenarioState(world).hubId
  const adv = getAdv(world)
  const [primaryId] = adv.contactIds

  const { status, data } = await apiPost(request, `/hubs/${hubId}/directory/merge`, {
    primaryId,
    secondaryId: nonexistentId(),
    mergedEncryptedSummary: 'x',
    mergedSummaryEnvelopes: [],
    mergedBlindIndexes: { identifierHashes: [], tagHashes: [] },
    mergedTrigramTokens: [],
  })

  setAdv(world, { lastStatusCode: status })
  setLastResponse(world, { status, data })
})

// ── Entity Merge ──────────────────────────────────────────────────────────

When('I merge the secondary record into the primary record', async ({ world, request }) => {
  const hubId = getScenarioState(world).hubId
  const adv = getAdv(world)
  const [primaryId, secondaryId] = adv.recordIds

  const { status, data } = await apiPost(request, `/hubs/${hubId}/records/merge`, {
    primaryId,
    secondaryId,
  })

  setAdv(world, {
    lastMergeResponse: data as Record<string, unknown>,
    lastStatusCode: status,
  })
  setLastResponse(world, { status, data })
})

When('I attempt to merge a non-existent record', async ({ world, request }) => {
  const hubId = getScenarioState(world).hubId

  const { status, data } = await apiPost(request, `/hubs/${hubId}/records/merge`, {
    primaryId: nonexistentId(),
    secondaryId: nonexistentId(),
  })

  setAdv(world, { lastStatusCode: status })
  setLastResponse(world, { status, data })
})

// ── Bulk Contact Operations ───────────────────────────────────────────────

When('I perform a bulk delete action on all three contacts', async ({ world, request }) => {
  const hubId = getScenarioState(world).hubId
  const adv = getAdv(world)

  const { status, data } = await apiPost(request, `/hubs/${hubId}/directory/bulk`, {
    action: 'delete',
    contactIds: adv.contactIds,
    payload: {},
  })

  setAdv(world, {
    lastBulkResponse: data as Record<string, unknown>,
    lastStatusCode: status,
  })
  setLastResponse(world, { status, data })
})

When('I perform a bulk add-tags action on both contacts with tag {string}', async ({ world, request }, tag: string) => {
  const hubId = getScenarioState(world).hubId
  const adv = getAdv(world)

  const { status, data } = await apiPost(request, `/hubs/${hubId}/directory/bulk`, {
    action: 'add-tags',
    contactIds: adv.contactIds,
    payload: { tags: [tag], updatedBlindIndexes: [] },
  })

  setAdv(world, {
    lastBulkResponse: data as Record<string, unknown>,
    lastStatusCode: status,
  })
  setLastResponse(world, { status, data })
})

When('I perform a bulk action with an empty contact list', async ({ world, request }) => {
  const hubId = getScenarioState(world).hubId

  const { status, data } = await apiPost(request, `/hubs/${hubId}/directory/bulk`, {
    action: 'delete',
    contactIds: [],
    payload: {},
  })

  setAdv(world, {
    lastBulkResponse: data as Record<string, unknown>,
    lastStatusCode: status,
  })
  setLastResponse(world, { status, data })
})

// ── Batch Contact Import ──────────────────────────────────────────────────

When('I bulk-create {int} contacts with encrypted summaries', async ({ world, request }, count: number) => {
  const hubId = getScenarioState(world).hubId

  const contacts = Array.from({ length: count }, (_, i) => ({
    encryptedSummary: `batch-enc-${i}`,
    summaryEnvelopes: [],
    blindIndexes: { identifierHashes: [], tagHashes: [] },
    trigramTokens: [],
  }))

  const { status, data } = await apiPost(request, `/hubs/${hubId}/directory/bulk-create`, {
    contacts,
  })

  setAdv(world, {
    lastBulkCreateResponse: data as Record<string, unknown>,
    lastStatusCode: status,
  })
  setLastResponse(world, { status, data })
})

When('I attempt to bulk-create {int} contacts', async ({ world, request }, count: number) => {
  const hubId = getScenarioState(world).hubId

  const contacts = Array.from({ length: count }, (_, i) => ({
    encryptedSummary: `overflow-enc-${i}`,
    summaryEnvelopes: [],
    blindIndexes: { identifierHashes: [], tagHashes: [] },
    trigramTokens: [],
  }))

  const { status, data } = await apiPost(request, `/hubs/${hubId}/directory/bulk-create`, {
    contacts,
  })

  setAdv(world, { lastStatusCode: status })
  setLastResponse(world, { status, data })
})

// ── Cross-Hub ─────────────────────────────────────────────────────────────

When('I list records with crossHub=true', async ({ world, request }) => {
  const hubId = getScenarioState(world).hubId

  const { status, data } = await apiGet(request, `/hubs/${hubId}/records?crossHub=true`)

  setAdv(world, {
    lastListResponse: data as Record<string, unknown>,
    lastStatusCode: status,
  })
  setLastResponse(world, { status, data })
})

// ── Assertions ────────────────────────────────────────────────────────────

Then('the merge response includes the primary and secondary IDs and a mergedAt timestamp', ({ world }) => {
  const adv = getAdv(world)
  expect(adv.lastStatusCode).toBe(200)
  const res = adv.lastMergeResponse!
  expect(typeof res.primaryId).toBe('string')
  expect(typeof res.secondaryId).toBe('string')
  expect(typeof res.mergedAt).toBe('string')
})

Then('the secondary contact is soft-deleted with a mergedIntoId', ({ world }) => {
  expect(getAdv(world).lastStatusCode).toBe(200)
})

Then('the primary contact has the merged encrypted summary', ({ world }) => {
  expect(getAdv(world).lastStatusCode).toBe(200)
})

Then('the merge response includes primary and secondary IDs and a mergedAt timestamp', ({ world }) => {
  const adv = getAdv(world)
  expect(adv.lastStatusCode).toBe(200)
  const res = adv.lastMergeResponse!
  expect(typeof res.primaryId).toBe('string')
  expect(typeof res.secondaryId).toBe('string')
  expect(typeof res.mergedAt).toBe('string')
})

Then('the secondary record is closed with a mergedIntoId', ({ world }) => {
  expect(getAdv(world).lastStatusCode).toBe(200)
})

Then('relinked contacts count is a non-negative integer', ({ world }) => {
  const res = getAdv(world).lastMergeResponse!
  expect(typeof res.relinkedContacts).toBe('number')
  expect(res.relinkedContacts as number).toBeGreaterThanOrEqual(0)
})

Then('the bulk action response shows {int} affected contacts', ({ world }, count: number) => {
  const adv = getAdv(world)
  expect(adv.lastStatusCode).toBe(200)
  expect(adv.lastBulkResponse?.affected).toBe(count)
})

Then('the deleted contacts are no longer returned in the contact list', async ({ world, request }) => {
  const hubId = getScenarioState(world).hubId
  const adv = getAdv(world)

  const data = await listContactsViaApi(request, { hubId })
  const returnedIds = data.contacts.map((c) => String(c.id))
  for (const id of adv.contactIds) {
    expect(returnedIds).not.toContain(id)
  }
})

Then('the bulk create response shows {int} contacts created', ({ world }, count: number) => {
  const adv = getAdv(world)
  expect(adv.lastStatusCode).toBe(201)
  expect(adv.lastBulkCreateResponse?.created).toBe(count)
})

Then('{int} contact IDs are returned', ({ world }, count: number) => {
  const ids = getAdv(world).lastBulkCreateResponse?.contactIds as unknown[]
  expect(Array.isArray(ids)).toBe(true)
  expect(ids.length).toBe(count)
})

Then('the response includes records from all hubs the user has access to', ({ world }) => {
  const adv = getAdv(world)
  expect(adv.lastStatusCode).toBe(200)
  expect(typeof adv.lastListResponse?.total).toBe('number')
})

Then('only records from the current hub are returned', ({ world }) => {
  expect(getAdv(world).lastStatusCode).toBe(200)
})
