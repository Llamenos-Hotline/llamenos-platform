/**
 * CMS step definitions for Epics 317–325.
 *
 * Covers templates, contacts, records, events, interactions,
 * and evidence. Reuses the existing "case management is enabled"
 * and "the server is reset" steps from entity-schema.steps.ts
 * and common.steps.ts respectively.
 */
import { expect } from '@playwright/test'
import { Given, When, Then, Before, After, getState, setState } from './fixtures'
import { setLastResponse, getSharedState } from './shared-state'
import { getScenarioState } from './common.steps'
import type { TemplateSummary } from '../../api-helpers'
import {
  createEntityTypeViaApi,
  listEntityTypesViaApi,
  listTemplatesViaApi,
  getTemplateViaApi,
  applyTemplateViaApi,
  createContactViaApi,
  listContactsViaApi,
  lookupContactViaApi,
  updateContactViaApi,
  deleteContactViaApi,
  createRecordViaApi,
  listRecordsViaApi,
  getRecordViaApi,
  updateRecordViaApi,
  linkContactToRecordViaApi,
  listRecordContactsViaApi,
  assignRecordViaApi,
  createEventViaApi,
  linkRecordToEventViaApi,
  linkReportToEventViaApi,
  listEventRecordsViaApi,
  listEventReportsViaApi,
  createInteractionViaApi,
  listInteractionsViaApi,
  uploadEvidenceViaApi,
  getEvidenceCustodyViaApi,
  verifyEvidenceIntegrityViaApi,
  createVolunteerViaApi,
  createReportViaApi,
  createRoleViaApi,
  createHubViaApi,
  deleteHubViaApi,
  apiGet,
  apiPost,
} from '../../api-helpers'

// ── Local State ────────────────────────────────────────────────────

interface CmsState {
  // Templates
  templateCatalog: TemplateSummary[]
  templateDetails?: Record<string, unknown>
  applyResult?: Record<string, unknown>
  // Contacts
  contacts: Array<Record<string, unknown>>
  lastContact?: Record<string, unknown>
  lookedUpContact?: Record<string, unknown> | null
  contactListResult?: { contacts: Record<string, unknown>[]; total: number; hasMore: boolean }
  // Records
  entityTypeIds: Map<string, string>
  records: Array<Record<string, unknown>>
  lastRecord?: Record<string, unknown>
  recordListResult?: { records: Record<string, unknown>[]; total: number; hasMore: boolean }
  numberedEntityTypeId?: string
  // Events
  eventEntityTypeIds: Map<string, string>
  lastEvent?: Record<string, unknown>
  eventRecordLinks?: { links: Record<string, unknown>[] }
  eventReportLinks?: { links: Record<string, unknown>[] }
  /** An event-category CASE RECORD (what the UI's Events page lists), as opposed to a legacy events-table row. */
  lastEventRecord?: Record<string, unknown>
  otherHubEventRecord?: Record<string, unknown>
  otherHubId?: string
  // Interactions
  lastInteraction?: Record<string, unknown>
  interactionListResult?: { interactions: Record<string, unknown>[]; total: number }
  // Evidence
  lastEvidence?: Record<string, unknown>
  custodyChain?: { custodyChain: Record<string, unknown>[]; total: number }
  verifyResult?: { valid: boolean; originalHash: string; currentHash: string }
  // Evidence access log (Issue #730 — hash-chained chain-of-custody audit trail)
  accessLogResult?: { entries: Record<string, unknown>[]; total: number }
  // Report
  lastReportId?: string
  // Contact cases tab (#797)
  contactCases?: Array<{ recordId: string; caseNumber?: string; entityTypeLabel: string; role: string; status: string; createdAt: string }>
  otherHubContact?: Record<string, unknown>
  // Volunteer for permission tests
  volunteerDeviceKey?: string
  volunteerPubkey?: string
}

const CMS_KEY = 'cms'

function getCmsState(world: Record<string, unknown>): CmsState {
  return getState<CmsState>(world, CMS_KEY)
}


Before({ tags: '@cases or @contacts or @contact-write or @events or @evidence or @templates or @reports' }, async ({ world }) => {
  const cms = {
    templateCatalog: [],
    contacts: [],
    entityTypeIds: new Map(),
    records: [],
    eventEntityTypeIds: new Map(),
  }
  setState(world, CMS_KEY, cms)
})

// ── Helper: resolve or create entity type by name ──────────────────

async function resolveEntityTypeId(
  world: Record<string, unknown>,
  request: import('@playwright/test').APIRequestContext,
  name: string,
): Promise<string> {
  const cached = getCmsState(world).entityTypeIds.get(name)
  if (cached) return cached

  const hubId = getScenarioState(world).hubId
  const types = await listEntityTypesViaApi(request, hubId)
  const existing = types.find(t => t.name === name)
  if (existing) {
    const id = existing.id as string
    getCmsState(world).entityTypeIds.set(name, id)
    return id
  }

  const created = await createEntityTypeViaApi(request, { name, category: 'case', hubId })
  const id = created.id as string
  getCmsState(world).entityTypeIds.set(name, id)
  return id
}

async function resolveEventEntityTypeId(
  world: Record<string, unknown>,
  request: import('@playwright/test').APIRequestContext,
  name: string,
): Promise<string> {
  const cached = getCmsState(world).eventEntityTypeIds.get(name)
  if (cached) return cached

  const hubId = getScenarioState(world).hubId
  const types = await listEntityTypesViaApi(request, hubId)
  const existing = types.find(t => t.name === name)
  if (existing) {
    const id = existing.id as string
    getCmsState(world).eventEntityTypeIds.set(name, id)
    return id
  }

  const created = await createEntityTypeViaApi(request, { name, category: 'event', hubId })
  const id = created.id as string
  getCmsState(world).eventEntityTypeIds.set(name, id)
  return id
}

// ============================================================
// TEMPLATE STEPS (Epic 317)
// ============================================================

When('the admin lists available templates', async ({ request, world }) => {
  getCmsState(world).templateCatalog = await listTemplatesViaApi(request)
})

Then('the template catalog should have at least {int} templates', async ({ world }, count: number) => {
  expect(getCmsState(world).templateCatalog.length).toBeGreaterThanOrEqual(count)
})

Then('each template should have an id, name, and description', async ({ world }) => {
  for (const t of getCmsState(world).templateCatalog) {
    expect(t.id).toBeTruthy()
    expect(t.name).toBeTruthy()
    expect(t.description).toBeTruthy()
  }
})

When('the admin gets details for template {string}', async ({ request, world }, templateId: string) => {
  getCmsState(world).templateDetails = await getTemplateViaApi(request, templateId)
})

Then('the template should have entity types', async ({ world }) => {
  expect(getCmsState(world).templateDetails).toBeTruthy()
  const entityTypes = getCmsState(world).templateDetails!.entityTypes as unknown[]
  expect(entityTypes.length).toBeGreaterThan(0)
})

Then('the template should have relationship types', async ({ world }) => {
  expect(getCmsState(world).templateDetails).toBeTruthy()
  const relTypes = getCmsState(world).templateDetails!.relationshipTypes as unknown[]
  expect(relTypes.length).toBeGreaterThan(0)
})

Given('the {string} template is applied', async ({ request, world }, templateId: string) => {
  const hubId = getScenarioState(world).hubId
  await applyTemplateViaApi(request, templateId, undefined, hubId)
})

When('the admin applies template {string}', async ({ request, world }, templateId: string) => {
  const hubId = getScenarioState(world).hubId
  const result = await applyTemplateViaApi(request, templateId, undefined, hubId)
  if (result.status !== 201 && result.status !== 200) {
    setLastResponse(world, { status: result.status, data: result.data })
    return
  }
  getCmsState(world).applyResult = result.data
})

Then('the template should be applied successfully', async ({ world }) => {
  expect(getCmsState(world).applyResult).toBeTruthy()
  expect(getCmsState(world).applyResult!.applied).toBe(true)
})

Then('entity types from the template should exist', async ({request, world}) => {
  const hubId = getScenarioState(world).hubId
  const types = await listEntityTypesViaApi(request, hubId)
  expect(types.length).toBeGreaterThan(0)
})

Then('relationship types from the template should exist', async ({request, world: _world}) => {
  const { data } = await apiGet<{ relationshipTypes: unknown[] }>(request, '/settings/cms/relationship-types')
  expect(data.relationshipTypes.length).toBeGreaterThan(0)
})

Then('entity types from both templates should exist', async ({request, world}) => {
  const hubId = getScenarioState(world).hubId
  const types = await listEntityTypesViaApi(request, hubId)
  // jail-support creates arrest_case; street-medic creates medical_encounter
  const hasArrest = types.some(t => t.name === 'arrest_case')
  const hasPatient = types.some(t => t.name === 'medical_encounter')
  expect(hasArrest).toBe(true)
  expect(hasPatient).toBe(true)
})

When('a volunteer tries to apply template {string}', async ({request, world}, templateId: string) => {
  const hubId = getScenarioState(world).hubId
  const vol = await createVolunteerViaApi(request, { name: `vol-tmpl-${Date.now()}` })
  const result = await applyTemplateViaApi(request, templateId, vol.deviceKey, hubId)
  setLastResponse(world, { status: result.status, data: result.data })
})

// ============================================================
// CONTACT STEPS (Epic 318)
// ============================================================

When('the admin creates a contact with encrypted profile', async ({ request, world }) => {
  const hubId = getScenarioState(world).hubId
  getCmsState(world).lastContact = await createContactViaApi(request, { hubId })
})

Then('the contact should have a generated UUID id', async ({ world }) => {
  expect(getCmsState(world).lastContact).toBeTruthy()
  const id = getCmsState(world).lastContact!.id as string
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
})

Then('the contact should have an encrypted summary', async ({ world }) => {
  expect(getCmsState(world).lastContact!.encryptedSummary).toBeTruthy()
})

Given('{int} contacts exist', async ({ request, world }, count: number) => {
  const hubId = getScenarioState(world).hubId
  for (let i = 0; i < count; i++) {
    const c = await createContactViaApi(request, { hubId })
    getCmsState(world).contacts.push(c)
  }
})

When('the admin lists contacts with limit {int}', async ({ request, world }, limit: number) => {
  const hubId = getScenarioState(world).hubId
  getCmsState(world).contactListResult = await listContactsViaApi(request, { page: 1, limit, hubId })
})

Then('the contact list should have {int} contacts', async ({ world }, count: number) => {
  expect(getCmsState(world).contactListResult).toBeTruthy()
  expect(getCmsState(world).contactListResult!.contacts.length).toBe(count)
})

Then('the contact list should indicate more pages', async ({ world }) => {
  expect(getCmsState(world).contactListResult!.hasMore).toBe(true)
})

Given('a contact exists with identifier hash {string}', async ({ request, world }, hash: string) => {
  const hubId = getScenarioState(world).hubId
  getCmsState(world).lastContact = await createContactViaApi(request, { identifierHashes: [hash], hubId })
})

When('the admin looks up contact by identifier hash {string}', async ({ request, world }, hash: string) => {
  const hubId = getScenarioState(world).hubId
  const result = await lookupContactViaApi(request, hash, hubId)
  getCmsState(world).lookedUpContact = result.contact
})

Then('the looked-up contact should match the created contact', async ({ world }) => {
  expect(getCmsState(world).lookedUpContact).toBeTruthy()
  expect(getCmsState(world).lookedUpContact!.id).toBe(getCmsState(world).lastContact!.id)
})

Given('a contact exists', async ({ request, world }) => {
  const hubId = getScenarioState(world).hubId
  getCmsState(world).lastContact = await createContactViaApi(request, { hubId })
})

When('the admin updates the contact encrypted summary', async ({ request, world }) => {
  const hubId = getScenarioState(world).hubId
  const updated = await updateContactViaApi(
    request,
    getCmsState(world).lastContact!.id as string,
    { encryptedSummary: 'dXBkYXRlZCBjb250YWN0' },
    hubId,
  )
  getCmsState(world).lastContact = updated
})

Then('the contact should have the updated summary', async ({ world }) => {
  expect(getCmsState(world).lastContact!.encryptedSummary).toBe('dXBkYXRlZCBjb250YWN0')
})

When('the admin deletes the contact', async ({ request, world }) => {
  const hubId = getScenarioState(world).hubId
  await deleteContactViaApi(request, getCmsState(world).lastContact!.id as string, hubId)
})

Then('the contact should no longer exist', async ({ request, world }) => {
  const { status } = await apiGet(request, `/directory/${getCmsState(world).lastContact!.id}`)
  expect(status).toBe(404)
})

Given('a volunteer exists with only contacts:view permission', async ({ request, world }) => {
  const role = await createRoleViaApi(request, {
    name: `Viewer ${Date.now()}`,
    slug: `viewer-${Date.now()}`,
    permissions: ['contacts:view'],
    description: 'Contacts view only',
  })
  const vol = await createVolunteerViaApi(request, {
    name: `vol-viewer-${Date.now()}`,
    roleIds: [role.id],
  })
  getCmsState(world).volunteerDeviceKey = vol.deviceKey
  getCmsState(world).volunteerPubkey = vol.pubkey
})

When('the volunteer lists contacts', async ({ request, world }) => {
  try {
    getCmsState(world).contactListResult = await listContactsViaApi(request, {}, getCmsState(world).volunteerDeviceKey!)
  } catch {
    // If it fails with an error, capture the status
    setLastResponse(world, { status: 403, data: null })
  }
})

Then('the contact list request should succeed', async ({ world }) => {
  expect(getCmsState(world).contactListResult).toBeTruthy()
})

When('the volunteer tries to create a contact', async ({ request, world }) => {
  try {
    await createContactViaApi(request, {}, getCmsState(world).volunteerDeviceKey!)
    setLastResponse(world, { status: 201, data: null })
  } catch (e: unknown) {
    const msg = (e as Error).message
    const match = msg.match(/(\d{3})/)
    setLastResponse(world, { status: match ? parseInt(match[1]) : 500, data: null })
  }
})

// ============================================================
// RECORD STEPS (Epic 319)
// ============================================================

// NOTE: "an entity type {string} exists" is defined in entity-schema.steps.ts.
// CMS steps use resolveEntityTypeId() internally to get the ID when needed.

When('the admin creates a record of type {string} with status hash {string}', async ({ request, world }, typeName: string, statusHash: string) => {
  const entityTypeId = await resolveEntityTypeId(world, request, typeName)
  const hubId = getScenarioState(world).hubId
  const record = await createRecordViaApi(request, entityTypeId, { statusHash, hubId })
  getCmsState(world).lastRecord = record
  getCmsState(world).records.push(record)
})

Then('the record should have a generated UUID id', async ({ world }) => {
  expect(getCmsState(world).lastRecord).toBeTruthy()
  const id = getCmsState(world).lastRecord!.id as string
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
})

Then('the record should have entity type {string}', async ({ request, world }, typeName: string) => {
  const entityTypeId = await resolveEntityTypeId(world, request, typeName)
  expect(getCmsState(world).lastRecord!.entityTypeId).toBe(entityTypeId)
})

Then('the record should have status hash {string}', async ({ world }, statusHash: string) => {
  expect(getCmsState(world).lastRecord!.statusHash).toBe(statusHash)
})

Given('a record of type {string} exists', async ({ request, world }, typeName: string) => {
  const entityTypeId = await resolveEntityTypeId(world, request, typeName)
  const hubId = getScenarioState(world).hubId
  const record = await createRecordViaApi(request, entityTypeId, { hubId })
  getCmsState(world).lastRecord = record
  getCmsState(world).records.push(record)
})

Given('a record of type {string} exists with status hash {string}', async ({ request, world }, typeName: string, statusHash: string) => {
  const entityTypeId = await resolveEntityTypeId(world, request, typeName)
  const hubId = getScenarioState(world).hubId
  const record = await createRecordViaApi(request, entityTypeId, { statusHash, hubId })
  getCmsState(world).lastRecord = record
  getCmsState(world).records.push(record)
})

When('the admin lists records filtered by entity type {string}', async ({ request, world }, typeName: string) => {
  const entityTypeId = await resolveEntityTypeId(world, request, typeName)
  const hubId = getScenarioState(world).hubId
  getCmsState(world).recordListResult = await listRecordsViaApi(request, { entityTypeId, hubId })
})

Then('all returned records should have entity type {string}', async ({ request, world }, typeName: string) => {
  const entityTypeId = await resolveEntityTypeId(world, request, typeName)
  expect(getCmsState(world).recordListResult).toBeTruthy()
  for (const r of getCmsState(world).recordListResult!.records) {
    expect(r.entityTypeId).toBe(entityTypeId)
  }
})

When('the admin links the contact to the record with role {string}', async ({ request, world }, role: string) => {
  await linkContactToRecordViaApi(
    request,
    getCmsState(world).lastRecord!.id as string,
    getCmsState(world).lastContact!.id as string,
    role,
  )
})

Then('the record should have {int} linked contact', async ({ request, world }, count: number) => {
  const result = await listRecordContactsViaApi(request, getCmsState(world).lastRecord!.id as string)
  expect(result.contacts.length).toBe(count)
})

Then('the linked contact should have role {string}', async ({ request, world }, role: string) => {
  const result = await listRecordContactsViaApi(request, getCmsState(world).lastRecord!.id as string)
  expect(result.contacts.some(c => c.role === role)).toBe(true)
})

After({ tags: '@contact-cases' }, async ({ request, world }) => {
  const otherHubId = getCmsState(world).otherHubId
  if (otherHubId) await deleteHubViaApi(request, otherHubId).catch(() => {})
})

Given('a contact exists in another hub', async ({ request, world }) => {
  const otherHubId = await createHubViaApi(request, `bdd-contact-cases-${Date.now()}`)
  getCmsState(world).otherHubId = otherHubId
  getCmsState(world).otherHubContact = await createContactViaApi(request, { hubId: otherHubId })
})

When('the admin lists the cases of the contact', async ({ request, world }) => {
  const hubId = getScenarioState(world).hubId
  const contactId = getCmsState(world).lastContact!.id as string
  const res = await apiGet<{ cases: NonNullable<CmsState['contactCases']> }>(request, `/hubs/${hubId}/directory/${contactId}/cases`)
  setLastResponse(world, res)
  if (res.status === 200) getCmsState(world).contactCases = res.data.cases
})

When("the admin lists the cases of the other hub's contact through this hub", async ({ request, world }) => {
  const hubId = getScenarioState(world).hubId
  const contactId = getCmsState(world).otherHubContact!.id as string
  setLastResponse(world, await apiGet(request, `/hubs/${hubId}/directory/${contactId}/cases`))
})

Then('the response should not disclose any cases', async ({ world }) => {
  const data = getSharedState(world).lastResponse!.data as Record<string, unknown>
  expect(data.cases).toBeUndefined()
})

Then("the contact's case list should have {int} linked record(s)", async ({ world }, count: number) => {
  expect(getCmsState(world).contactCases).toBeDefined()
  expect(getCmsState(world).contactCases!.length).toBe(count)
})

Then("the contact's case list should include the linked record with role {string}", async ({ world }, role: string) => {
  const recordId = getCmsState(world).lastRecord!.id as string
  const link = getCmsState(world).contactCases!.find(l => l.recordId === recordId)
  expect(link, 'linked record should be listed').toBeDefined()
  expect(link!.role).toBe(role)
  expect(link!.entityTypeLabel).not.toBe('')
  expect(link!.status).not.toBe('')
  expect(Number.isNaN(Date.parse(link!.createdAt))).toBe(false)
})

Given('a volunteer exists for assignment', async ({ request, world }) => {
  const vol = await createVolunteerViaApi(request, { name: `vol-assign-${Date.now()}` })
  getCmsState(world).volunteerDeviceKey = vol.deviceKey
  getCmsState(world).volunteerPubkey = vol.pubkey
})

When('the admin assigns the volunteer to the record', async ({ request, world }) => {
  await assignRecordViaApi(request, getCmsState(world).lastRecord!.id as string, [getCmsState(world).volunteerPubkey!])
})

Then('the record should include the volunteer in assignedTo', async ({ request, world }) => {
  const hubId = getScenarioState(world).hubId
  const record = await getRecordViaApi(request, getCmsState(world).lastRecord!.id as string, hubId)
  const assignedTo = record.assignedTo as string[]
  expect(assignedTo).toContain(getCmsState(world).volunteerPubkey!)
})

Given('an entity type with number prefix {string} exists', async ({ request, world }, prefix: string) => {
  const hubId = getScenarioState(world).hubId
  const name = `numbered_type_${Date.now()}`
  const created = await createEntityTypeViaApi(request, {
    name,
    category: 'case',
    numberPrefix: prefix,
    hubId,
  })
  getCmsState(world).numberedEntityTypeId = created.id as string
  getCmsState(world).entityTypeIds.set(name, created.id as string)
})

When('the admin creates a record of the numbered type', async ({ request, world }) => {
  const hubId = getScenarioState(world).hubId
  const record = await createRecordViaApi(request, getCmsState(world).numberedEntityTypeId!, { hubId })
  getCmsState(world).lastRecord = record
  getCmsState(world).records.push(record)
})

Then('the record should have a case number matching {string}', async ({ world }, pattern: string) => {
  const year = new Date().getFullYear()
  const expected = pattern.replace('{year}', String(year))
  expect(getCmsState(world).lastRecord!.caseNumber).toBe(expected)
})

When('the admin creates another record of the numbered type', async ({ request, world }) => {
  const hubId = getScenarioState(world).hubId
  const record = await createRecordViaApi(request, getCmsState(world).numberedEntityTypeId!, { hubId })
  getCmsState(world).lastRecord = record
  getCmsState(world).records.push(record)
})

Then('the second record should have a case number matching {string}', async ({ world }, pattern: string) => {
  const year = new Date().getFullYear()
  const expected = pattern.replace('{year}', String(year))
  expect(getCmsState(world).lastRecord!.caseNumber).toBe(expected)
})

When('the admin updates the record status hash to {string}', async ({ request, world }, statusHash: string) => {
  const hubId = getScenarioState(world).hubId
  const updated = await updateRecordViaApi(
    request,
    getCmsState(world).lastRecord!.id as string,
    { statusHash },
    hubId,
  )
  getCmsState(world).lastRecord = updated
})

Given('a volunteer exists with cases:read-own and cases:create permissions', async ({ request, world }) => {
  const role = await createRoleViaApi(request, {
    name: `Scoped Vol ${Date.now()}`,
    slug: `scoped-vol-${Date.now()}`,
    permissions: ['cases:read-own', 'cases:create', 'cases:update-own'],
    description: 'Scoped record access',
  })
  // Scoped role held IN the scenario hub — a global role grants nothing there (#1037)
  const vol = await createVolunteerViaApi(request, {
    name: `vol-scoped-${Date.now()}`,
    roleIds: [role.id],
    hubId: getScenarioState(world).hubId,
  })
  getCmsState(world).volunteerDeviceKey = vol.deviceKey
  getCmsState(world).volunteerPubkey = vol.pubkey
})

When('the volunteer lists records', async ({ request, world }) => {
  const hubId = getScenarioState(world).hubId
  getCmsState(world).recordListResult = await listRecordsViaApi(request, { hubId }, getCmsState(world).volunteerDeviceKey!)
})

Then('the volunteer should see {int} records', async ({ world }, count: number) => {
  expect(getCmsState(world).recordListResult).toBeTruthy()
  expect(getCmsState(world).recordListResult!.records.length).toBe(count)
})

// ============================================================
// EVENT STEPS (Epic 320)
// ============================================================

Given('an event entity type {string} exists', async ({request, world}, name: string) => {
  await resolveEventEntityTypeId(world, request, name)
})

When('the admin creates an event of type {string}', async ({ request, world }, typeName: string) => {
  const entityTypeId = await resolveEventEntityTypeId(world, request, typeName)
  getCmsState(world).lastEvent = await createEventViaApi(request, entityTypeId)
})

Then('the event should have a generated UUID id', async ({ world }) => {
  expect(getCmsState(world).lastEvent).toBeTruthy()
  const id = getCmsState(world).lastEvent!.id as string
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
})

Then('the event should have a start date', async ({ world }) => {
  expect(getCmsState(world).lastEvent!.startDate).toBeTruthy()
})

Given('an event of type {string} exists', async ({ request, world }, typeName: string) => {
  const entityTypeId = await resolveEventEntityTypeId(world, request, typeName)
  getCmsState(world).lastEvent = await createEventViaApi(request, entityTypeId)
})

When('the admin links the record to the event', async ({ request, world }) => {
  await linkRecordToEventViaApi(
    request,
    getCmsState(world).lastEvent!.id as string,
    getCmsState(world).lastRecord!.id as string,
  )
})

Then('the event should have {int} linked record', async ({ request, world }, count: number) => {
  const result = await listEventRecordsViaApi(request, getCmsState(world).lastEvent!.id as string)
  expect(result.links.length).toBe(count)
})

Given('an event record of type {string} exists', async ({ request, world }, typeName: string) => {
  const entityTypeId = await resolveEventEntityTypeId(world, request, typeName)
  const hubId = getScenarioState(world).hubId
  getCmsState(world).lastEventRecord = await createRecordViaApi(request, entityTypeId, { hubId })
})

When('the admin links the record to the event record', async ({ request, world }) => {
  await linkRecordToEventViaApi(
    request,
    getCmsState(world).lastEventRecord!.id as string,
    getCmsState(world).lastRecord!.id as string,
    undefined,
    getScenarioState(world).hubId,
  )
})

Then('the event record should have {int} linked record', async ({ request, world }, count: number) => {
  const result = await listEventRecordsViaApi(
    request,
    getCmsState(world).lastEventRecord!.id as string,
    undefined,
    getScenarioState(world).hubId,
  )
  expect(result.links.length).toBe(count)
})

When('the admin links the report to the event record', async ({ request, world }) => {
  await linkReportToEventViaApi(
    request,
    getCmsState(world).lastEventRecord!.id as string,
    getCmsState(world).lastReportId!,
    undefined,
    getScenarioState(world).hubId,
  )
})

Then('the event record should have {int} linked report', async ({ request, world }, count: number) => {
  const result = await listEventReportsViaApi(
    request,
    getCmsState(world).lastEventRecord!.id as string,
    undefined,
    getScenarioState(world).hubId,
  )
  expect(result.links.length).toBe(count)
})

Given('an event record exists in another hub', async ({ request, world }) => {
  const otherHubId = await createHubViaApi(request, `Other Hub ${Date.now()}`)
  const entityType = await createEntityTypeViaApi(request, { name: 'Protest', category: 'event', hubId: otherHubId })
  getCmsState(world).otherHubId = otherHubId
  getCmsState(world).otherHubEventRecord = await createRecordViaApi(request, entityType.id as string, { hubId: otherHubId })
})

When('the admin links the record to the other hub\'s event record', async ({ request, world }) => {
  // Authenticated as an admin of both hubs, but addressed through THIS scenario's hub:
  // the event id must not resolve across the hub boundary.
  const result = await apiPost(
    request,
    `/hubs/${getScenarioState(world).hubId}/events/${getCmsState(world).otherHubEventRecord!.id as string}/records`,
    { recordId: getCmsState(world).lastRecord!.id as string },
  )
  setLastResponse(world, { status: result.status, data: result.data })
})

When('the admin links the record to the non-event record', async ({ request, world }) => {
  const records = getCmsState(world).records
  const target = records[records.length - 1]
  const source = records[records.length - 2]
  const result = await apiPost(
    request,
    `/hubs/${getScenarioState(world).hubId}/events/${target.id as string}/records`,
    { recordId: source.id as string },
  )
  setLastResponse(world, { status: result.status, data: result.data })
})

Given('a report exists', async ({ request, world }) => {
  const report = await createReportViaApi(request)
  getCmsState(world).lastReportId = report.id
})

When('the admin links the report to the event', async ({ request, world }) => {
  await linkReportToEventViaApi(
    request,
    getCmsState(world).lastEvent!.id as string,
    getCmsState(world).lastReportId!,
  )
})

Then('the event should have {int} linked report', async ({ request, world }, count: number) => {
  const result = await listEventReportsViaApi(request, getCmsState(world).lastEvent!.id as string)
  expect(result.links.length).toBe(count)
})

Given('{int} records of type {string} are linked to the event', async ({ request, world }, count: number, typeName: string) => {
  const entityTypeId = await resolveEntityTypeId(world, request, typeName)
  const hubId = getScenarioState(world).hubId
  for (let i = 0; i < count; i++) {
    const record = await createRecordViaApi(request, entityTypeId, { hubId })
    await linkRecordToEventViaApi(request, getCmsState(world).lastEvent!.id as string, record.id as string)
    getCmsState(world).records.push(record)
  }
})

When('the admin lists records linked to the event', async ({ request, world }) => {
  getCmsState(world).eventRecordLinks = await listEventRecordsViaApi(request, getCmsState(world).lastEvent!.id as string)
})

Then('{int} record links should be returned', async ({ world }, count: number) => {
  expect(getCmsState(world).eventRecordLinks!.links.length).toBe(count)
})

// ============================================================
// INTERACTION STEPS (Epic 323)
// ============================================================

When('the admin creates a comment interaction on the record', async ({ request, world }) => {
  getCmsState(world).lastInteraction = await createInteractionViaApi(
    request,
    getCmsState(world).lastRecord!.id as string,
    {
      interactionType: 'comment',
      encryptedContent: 'dGVzdCBjb21tZW50',
      interactionTypeHash: 'comment_hash',
    },
  )
})

Then('the interaction should have type {string}', async ({ world }, interactionType: string) => {
  expect(getCmsState(world).lastInteraction!.interactionType).toBe(interactionType)
})

Then('the interaction should have encrypted content', async ({ world }) => {
  expect(getCmsState(world).lastInteraction!.encryptedContent).toBeTruthy()
})

When('the admin updates the record status with change metadata', async ({ request, world }) => {
  await updateRecordViaApi(
    request,
    getCmsState(world).lastRecord!.id as string,
    {
      statusHash: 'status_updated',
      statusChangeTypeHash: 'status_change_hash',
      statusChangeContent: 'dGVzdCBzdGF0dXMgY2hhbmdl',
      statusChangeEnvelopes: [{
        pubkey: 'a'.repeat(64),
        ct: 'b'.repeat(64),
        enc: 'a'.repeat(64),
      }],
    },
  )
})

Then('the record interactions should include a {string} entry', async ({ request, world }, interactionType: string) => {
  const result = await listInteractionsViaApi(request, getCmsState(world).lastRecord!.id as string)
  const hasType = result.interactions.some(i => i.interactionType === interactionType)
  expect(hasType).toBe(true)
})

Given('{int} comment interactions exist on the record', async ({ request, world }, count: number) => {
  for (let i = 0; i < count; i++) {
    await createInteractionViaApi(
      request,
      getCmsState(world).lastRecord!.id as string,
      {
        interactionType: 'comment',
        encryptedContent: `dGVzdCBjb21tZW50 ${i}`,
        interactionTypeHash: 'comment_hash',
      },
    )
  }
})

When('the admin lists interactions for the record', async ({ request, world }) => {
  getCmsState(world).interactionListResult = await listInteractionsViaApi(request, getCmsState(world).lastRecord!.id as string)
})

Then('{int} interactions should be returned', async ({ world }, count: number) => {
  expect(getCmsState(world).interactionListResult!.interactions.length).toBe(count)
})

Then('the interactions should be in chronological order', async ({ world }) => {
  const interactions = getCmsState(world).interactionListResult!.interactions
  for (let i = 1; i < interactions.length; i++) {
    const prev = new Date(interactions[i - 1].createdAt as string).getTime()
    const curr = new Date(interactions[i].createdAt as string).getTime()
    expect(curr).toBeGreaterThanOrEqual(prev)
  }
})

// ============================================================
// EVIDENCE STEPS (Epic 325)
// ============================================================

When('the admin uploads evidence to the record', async ({ request, world }) => {
  getCmsState(world).lastEvidence = await uploadEvidenceViaApi(request, getCmsState(world).lastRecord!.id as string)
})

Then('the evidence should have a generated UUID id', async ({ world }) => {
  expect(getCmsState(world).lastEvidence).toBeTruthy()
  const id = getCmsState(world).lastEvidence!.id as string
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
})

Then('the evidence should have classification {string}', async ({ world }, classification: string) => {
  expect(getCmsState(world).lastEvidence!.classification).toBe(classification)
})

Then('the evidence should have an integrity hash', async ({ world }) => {
  expect(getCmsState(world).lastEvidence!.integrityHash).toBeTruthy()
})

Given('evidence exists on the record', async ({ request, world }) => {
  getCmsState(world).lastEvidence = await uploadEvidenceViaApi(request, getCmsState(world).lastRecord!.id as string)
})

When('the admin gets the custody chain for the evidence', async ({ request, world }) => {
  getCmsState(world).custodyChain = await getEvidenceCustodyViaApi(request, getCmsState(world).lastEvidence!.id as string)
})

Then('the custody chain should have at least {int} entry', async ({ world }, count: number) => {
  expect(getCmsState(world).custodyChain!.custodyChain.length).toBeGreaterThanOrEqual(count)
})

Then('the first custody entry should have action {string}', async ({ world }, action: string) => {
  expect(getCmsState(world).custodyChain!.custodyChain[0].action).toBe(action)
})

When('the admin verifies evidence integrity with the correct hash', async ({ request, world }) => {
  const originalHash = getCmsState(world).lastEvidence!.integrityHash as string
  getCmsState(world).verifyResult = await verifyEvidenceIntegrityViaApi(
    request,
    getCmsState(world).lastEvidence!.id as string,
    originalHash,
  )
})

Then('the verification should return valid true', async ({ world }) => {
  expect(getCmsState(world).verifyResult!.valid).toBe(true)
})

When('the admin verifies evidence integrity with a wrong hash', async ({ request, world }) => {
  getCmsState(world).verifyResult = await verifyEvidenceIntegrityViaApi(
    request,
    getCmsState(world).lastEvidence!.id as string,
    'f'.repeat(64),
  )
})

Then('the verification should return valid false', async ({ world }) => {
  expect(getCmsState(world).verifyResult!.valid).toBe(false)
})

// ============================================================
// EVIDENCE ACCESS LOG STEPS (Issue #730)
//
// The access log reuses the Epic 77 hash-chained audit_log table (see
// apps/worker/services/audit.ts AuditService.listForEvidence) rather than
// a parallel unchained table, so every access — and every denied access
// attempt — is tamper-evident the same way any other audit entry is.
// ============================================================

When('the admin views the evidence metadata', async ({ request, world }) => {
  const evidenceId = getCmsState(world).lastEvidence!.id as string
  const { status } = await apiGet(request, `/evidence/${evidenceId}`)
  expect(status).toBe(200)
})

When('the admin views the evidence via the hub-scoped API', async ({ request, world }) => {
  const hubId = getScenarioState(world).hubId
  const evidenceId = getCmsState(world).lastEvidence!.id as string
  const { status } = await apiGet(request, `/hubs/${hubId}/evidence/${evidenceId}`)
  expect(status).toBe(200)
})

When('the admin reads the evidence access log', async ({ request, world }) => {
  const evidenceId = getCmsState(world).lastEvidence!.id as string
  const { status, data } = await apiGet<{ entries: Record<string, unknown>[]; total: number }>(
    request,
    `/evidence/${evidenceId}/access-log`,
  )
  expect(status).toBe(200)
  getCmsState(world).accessLogResult = data
})

Then('the evidence access log should contain an entry with access type {string}', async ({ world }, accessType: string) => {
  const log = getCmsState(world).accessLogResult
  expect(log).toBeTruthy()
  const found = log!.entries.some((entry) => {
    if (accessType === 'denied') return entry.action === 'evidenceAccessDenied'
    const details = entry.details as Record<string, unknown> | null | undefined
    return details?.action === accessType
  })
  expect(found).toBe(true)
})

Given('a volunteer without evidence permissions exists', async ({ request, world }) => {
  const role = await createRoleViaApi(request, {
    name: `No Evidence Access ${Date.now()}`,
    slug: `no-evidence-access-${Date.now()}`,
    permissions: ['notes:read-own'],
    description: 'Cannot view or manage evidence',
  })
  const vol = await createVolunteerViaApi(request, {
    name: `vol-noevidence-${Date.now()}`,
    roleIds: [role.id],
  })
  getCmsState(world).volunteerDeviceKey = vol.deviceKey
  getCmsState(world).volunteerPubkey = vol.pubkey
})

When('the volunteer tries to view the evidence', async ({ request, world }) => {
  const evidenceId = getCmsState(world).lastEvidence!.id as string
  const res = await apiGet(request, `/evidence/${evidenceId}`, getCmsState(world).volunteerDeviceKey!)
  setLastResponse(world, res)
})

Given('a volunteer without audit:read permission exists', async ({ request, world }) => {
  const role = await createRoleViaApi(request, {
    name: `Evidence Only ${Date.now()}`,
    slug: `evidence-only-${Date.now()}`,
    permissions: ['evidence:download', 'evidence:manage-custody'],
    description: 'Can view evidence but not the admin-only access log',
  })
  const vol = await createVolunteerViaApi(request, {
    name: `vol-evidenceonly-${Date.now()}`,
    roleIds: [role.id],
  })
  getCmsState(world).volunteerDeviceKey = vol.deviceKey
  getCmsState(world).volunteerPubkey = vol.pubkey
})

When('the volunteer tries to read the evidence access log', async ({ request, world }) => {
  const evidenceId = getCmsState(world).lastEvidence!.id as string
  const res = await apiGet(request, `/evidence/${evidenceId}/access-log`, getCmsState(world).volunteerDeviceKey!)
  setLastResponse(world, res)
})
