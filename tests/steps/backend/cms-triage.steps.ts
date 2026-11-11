/**
 * CMS Triage Queue step definitions.
 *
 * Tests triage queue filtering, conversion status updates,
 * and case creation from reports.
 */
import { expect } from '@playwright/test'
import { Given, When, Then, Before, getState, setState } from './fixtures'
import { getScenarioState } from './common.steps'

import { getSharedState, setLastResponse } from './shared-state'
import {
  apiGet,
  apiPost,
  apiPatch,
  createCmsReportTypeViaApi,
  createShiftViaApi,
  createUserViaApi,
  generateTestKeypair,
  uniqueName,
  encryptForTest,
  ADMIN_SEED,
} from '../../api-helpers'
import { ALWAYS_ON_SHIFT } from '@shared/always-on-shift'

// ── Local State ──────────────────────────────────────────────────

interface TriageState {
  enabledReportTypeId?: string
  disabledReportTypeId?: string
  enabledReportTypeName?: string
  disabledReportTypeName?: string
  reportId?: string
  reportIds: string[]
  entityTypeId?: string
  caseRecordId?: string
  triageQueue?: Array<Record<string, unknown>>
  volunteerNsec?: string
}

const CMS_TRIAGE_KEY = 'cms_triage'

function getTriageState(world: Record<string, unknown>): TriageState {
  return getState<TriageState>(world, CMS_TRIAGE_KEY)
}


Before({ tags: '@backend' }, async ({ world }) => {
  const triage = { reportIds: [] }
  setState(world, CMS_TRIAGE_KEY, triage)
})

/** Parse metadata that may be double-serialized by the JSONB layer */
function parseMetadata(report: Record<string, unknown>): Record<string, unknown> {
  let meta = report.metadata
  if (typeof meta === 'string') {
    try { meta = JSON.parse(meta) } catch { /* ignore */ }
  }
  return (meta as Record<string, unknown>) ?? {}
}

// ── CMS Report Type Steps ────────────────────────────────────────

Given('a CMS report type with allowCaseConversion enabled exists', async ({ request, world }) => {
  const hubId = getScenarioState(world).hubId
  const rt = await createCmsReportTypeViaApi(request, {
    name: uniqueName('triage_enabled', '_'),
    allowCaseConversion: true,
    hubId,
  })
  getTriageState(world).enabledReportTypeId = rt.id as string
  getTriageState(world).enabledReportTypeName = rt.name as string
})

Given('a CMS report type with allowCaseConversion disabled exists', async ({ request, world }) => {
  const hubId = getScenarioState(world).hubId
  const rt = await createCmsReportTypeViaApi(request, {
    name: uniqueName('triage_disabled', '_'),
    allowCaseConversion: false,
    hubId,
  })
  getTriageState(world).disabledReportTypeId = rt.id as string
  getTriageState(world).disabledReportTypeName = rt.name as string
})

// ── Report Creation Steps ────────────────────────────────────────

Given('a report of the conversion-enabled type exists', async ({ request, world, workerHub }) => {
  // Sealed to the admin as every real client does: the server refuses a report no admin can open (#2113).
  const sealed = await encryptForTest('triage-report-content', [ADMIN_SEED])
  const { data } = await apiPost<{ id?: string; report?: { id: string } }>(
    request,
    `/hubs/${workerHub}/reports`,
    {
      title: uniqueName('Triage Report'),
      category: 'general',
      reportTypeId: getTriageState(world).enabledReportTypeId,
      encryptedContent: sealed.encryptedContent,
      readerEnvelopes: sealed.envelopes,
    },
  )
  const id = (data as Record<string, unknown>)?.id as string
    ?? ((data as Record<string, unknown>)?.report as Record<string, unknown>)?.id as string
  getTriageState(world).reportId = id
  getTriageState(world).reportIds.push(id)
})

Given('a report of the conversion-disabled type exists', async ({ request, world, workerHub }) => {
  // Sealed to the admin as every real client does: the server refuses a report no admin can open (#2113).
  const sealed = await encryptForTest('disabled-report-content', [ADMIN_SEED])
  await apiPost(
    request,
    `/hubs/${workerHub}/reports`,
    {
      title: uniqueName('Disabled Report'),
      category: 'general',
      reportTypeId: getTriageState(world).disabledReportTypeId,
      encryptedContent: sealed.encryptedContent,
      readerEnvelopes: sealed.envelopes,
    },
  )
})

Given('a report of the conversion-enabled type exists with conversionStatus {string}', async ({ request, world, workerHub }, conversionStatus: string) => {
  // Sealed to the admin as every real client does: the server refuses a report no admin can open (#2113).
  const sealed = await encryptForTest('triage-status-report', [ADMIN_SEED])
  const { data } = await apiPost<{ id?: string; report?: { id: string } }>(
    request,
    `/hubs/${workerHub}/reports`,
    {
      title: uniqueName('Triage Status Report'),
      category: 'general',
      reportTypeId: getTriageState(world).enabledReportTypeId,
      encryptedContent: sealed.encryptedContent,
      conversionStatus,
      readerEnvelopes: sealed.envelopes,
    },
  )
  const id = (data as Record<string, unknown>)?.id as string
    ?? ((data as Record<string, unknown>)?.report as Record<string, unknown>)?.id as string
  if (!getTriageState(world).reportId) getTriageState(world).reportId = id
  getTriageState(world).reportIds.push(id)
})

// ── Triage Queue Listing Steps ───────────────────────────────────

When('the admin lists reports with conversionEnabled true', async ({ request, world }) => {
  const hubId = getScenarioState(world).hubId
  const prefix = `/hubs/${hubId}`
  const { status, data } = await apiGet<{ conversations?: Array<Record<string, unknown>>; reports?: Array<Record<string, unknown>> }>(
    request,
    `${prefix}/reports?conversionEnabled=true`,
  )
  // A refused or malformed list is not an empty queue (#2465).
  expect(status, 'list the triage queue').toBe(200)
  const reports = data.conversations ?? data.reports
  expect(reports, 'the triage list carried no report array').toBeDefined()
  getTriageState(world).triageQueue = reports!
})

When('the admin lists reports with conversionEnabled true and conversionStatus {string}', async ({ request, world }, conversionStatus: string) => {
  const hubId = getScenarioState(world).hubId
  const prefix = `/hubs/${hubId}`
  const { status, data } = await apiGet<{ conversations?: Array<Record<string, unknown>>; reports?: Array<Record<string, unknown>> }>(
    request,
    `${prefix}/reports?conversionEnabled=true&conversionStatus=${conversionStatus}`,
  )
  // A refused or malformed list is not an empty queue (#2465).
  expect(status, 'list the triage queue').toBe(200)
  const reports = data.conversations ?? data.reports
  expect(reports, 'the triage list carried no report array').toBeDefined()
  getTriageState(world).triageQueue = reports!
})

Then('only reports of the conversion-enabled type should be returned', async ({ world }) => {
  expect(getTriageState(world).triageQueue).toBeDefined()
  // All returned reports should have the enabled report type
  for (const report of getTriageState(world).triageQueue!) {
    const meta = parseMetadata(report)
    const reportTypeId = meta.reportTypeId as string ?? report.reportTypeId as string
    expect(reportTypeId).toBe(getTriageState(world).enabledReportTypeId)
  }
})

Then('only reports with conversionStatus {string} should be returned', async ({ world }, expectedStatus: string) => {
  expect(getTriageState(world).triageQueue).toBeDefined()
  for (const report of getTriageState(world).triageQueue!) {
    const meta = parseMetadata(report)
    const status = meta.conversionStatus as string ?? report.conversionStatus as string
    expect(status).toBe(expectedStatus)
  }
})

Then('the triage queue should be empty', async ({ world }) => {
  expect(getTriageState(world).triageQueue).toBeDefined()
  // With hub-per-worker isolation, other triage scenarios may have created
  // conversion-enabled reports in this hub. Scope to this scenario's report type.
  const enabledId = getTriageState(world).enabledReportTypeId
  const queue = getTriageState(world).triageQueue!
  const matching = enabledId
    ? queue.filter((r) => {
        const meta = parseMetadata(r)
        return (meta.reportTypeId ?? r.reportTypeId) === enabledId
      })
    : queue
  expect(matching.length).toBe(0)
})

// ── Conversion Status Update Steps ───────────────────────────────

When('the admin updates the report conversionStatus to {string}', async ({ request, world, workerHub }, conversionStatus: string) => {
  expect(getTriageState(world).reportId).toBeDefined()
  await apiPatch(request, `/hubs/${workerHub}/reports/${getTriageState(world).reportId}`, {
    conversionStatus,
  })
})

Then('the report metadata should include conversionStatus {string}', async ({ request, world, workerHub }, expectedStatus: string) => {
  expect(getTriageState(world).reportId).toBeDefined()
  const { data, status } = await apiGet<Record<string, unknown>>(
    request,
    `/hubs/${workerHub}/reports/${getTriageState(world).reportId}`,
  )
  expect(status).toBe(200)
  expect(data).toBeTruthy()
  const report = data as Record<string, unknown>
  const meta = parseMetadata(report)
  const conversionStatus = meta.conversionStatus as string
    ?? report.conversionStatus as string
  expect(conversionStatus).toBe(expectedStatus)
})

When('the admin fetches the report', async ({ request, world, workerHub }) => {
  expect(getTriageState(world).reportId).toBeDefined()
  // Record the status the server returned, not an assumed 200.
  setLastResponse(world, await apiGet<Record<string, unknown>>(
    request,
    `/hubs/${workerHub}/reports/${getTriageState(world).reportId}`,
  ))
})

// ── Case Creation from Report Steps ──────────────────────────────

// 'an entity type {string} exists' is defined in entity-schema.steps.ts

When('the admin creates a case record from the report', async ({ request, world }) => {
  expect(getTriageState(world).reportId).toBeDefined()
  // Look up entity type by name if not already set
  if (!getTriageState(world).entityTypeId) {
    const { listEntityTypesViaApi } = await import('../../api-helpers')
    const hubId = getScenarioState(world).hubId
    const types = await listEntityTypesViaApi(request, hubId)
    const caseType = types.find(t => t.name === 'triage_case_type' || t.category === 'case')
    if (caseType) getTriageState(world).entityTypeId = caseType.id as string
  }

  // Step 1: Create the case record with all required fields
  const kp = generateTestKeypair()
  const hubId = getScenarioState(world).hubId
  const { data, status } = await apiPost<{ id?: string; record?: { id: string } }>(
    request,
    `/hubs/${hubId}/records`,
    {
      entityTypeId: getTriageState(world).entityTypeId,
      statusHash: 'open',
      encryptedSummary: 'triage-case-summary',
      summaryEnvelopes: [{ pubkey: kp.pubkey, ct: 'key', enc: kp.pubkey }],
    },
  )
  // Both writes are this scenario's subject. They used to be guarded by
  // `if (status < 300)` and an unchecked link, so a refused create or link left
  // the Then step to pass on whatever it could still find (#2465).
  expect(status, `create the case record: ${JSON.stringify(data)}`).toBe(201)
  const caseRecordId = (data as Record<string, unknown>)?.id as string
    ?? ((data as Record<string, unknown>)?.record as Record<string, unknown>)?.id as string
  expect(caseRecordId, 'the case create returned no id').toBeTruthy()
  getTriageState(world).caseRecordId = caseRecordId

  // Step 2: Link the report to the case
  const link = await apiPost(request, `/hubs/${hubId}/records/${caseRecordId}/reports`, {
    reportId: getTriageState(world).reportId,
  })
  expect(link.status, `link the report to the case: ${JSON.stringify(link.data)}`).toBeLessThan(300)
})

Then('the report should have {int} linked case record', async ({ request, world, workerHub }, count: number) => {
  expect(getTriageState(world).reportId).toBeDefined()
  // Ask the link table itself. This read `linkedRecords` off the report, a field
  // the report has never carried, and so always fell through to "a case id was
  // recorded" — it never checked a link at all (#2465).
  const { status, data } = await apiGet<{ records: Array<{ reportId: string; caseId: string }>; total: number }>(
    request,
    `/hubs/${workerHub}/reports/${getTriageState(world).reportId}/records`,
  )
  expect(status, 'list the cases linked to the report').toBe(200)
  expect(data.records).toHaveLength(count)
  if (count > 0) {
    expect(data.records.map(r => r.caseId)).toContain(getTriageState(world).caseRecordId)
  }
})

// ── Permission Steps ─────────────────────────────────────────────

Given('a volunteer exists with cases:create permission only', async ({ request, world }) => {
  const { createUserViaApi } = await import('../../api-helpers')
  // A member of the scenario hub, so the refusal is for the missing permission and
  // not for being outside the hub the report lives in (#2461).
  const vol = await createUserViaApi(request, { name: uniqueName('Triage Limited Vol'), hubId: getScenarioState(world).hubId })
  getTriageState(world).volunteerNsec = vol.seedHex
})

When('the volunteer lists reports with conversionEnabled true', async ({ request, world, workerHub }) => {
  const res = await apiGet<{ conversations?: unknown[]; reports?: unknown[] }>(
    request,
    `/hubs/${workerHub}/reports?conversionEnabled=true`,
    getTriageState(world).volunteerNsec!,
  )
  setLastResponse(world, res)
  getTriageState(world).triageQueue = []
})

Then('the request should be forbidden', async ({ world }) => {
  expect(getSharedState(world).lastResponse).toBeDefined()
  expect(getSharedState(world).lastResponse!.status).toBe(403)
})

// ── Atomic Conversion Steps (EP06-A3) ────────────────────────────

When('the admin converts the report to an entity using the atomic endpoint', async ({ request, world }) => {
  const state = getTriageState(world)
  expect(state.reportId).toBeDefined()

  // Resolve entity type ID if not set
  if (!state.entityTypeId) {
    const { listEntityTypesViaApi } = await import('../../api-helpers')
    const hubId = getScenarioState(world).hubId
    const types = await listEntityTypesViaApi(request, hubId)
    const et = types.find(t =>
      t.name?.toString().includes('triage') ||
      t.name?.toString().includes('auto_assign') ||
      t.name?.toString().includes('no_assign') ||
      t.category === 'case'
    )
    if (et) state.entityTypeId = et.id as string
  }

  const path = `/hubs/${getScenarioState(world).hubId}/records/convert-from-report`
  const res = await apiPost<Record<string, unknown>>(
    request,
    path,
    {
      reportId: state.reportId,
      entityTypeId: state.entityTypeId,
      additionalFields: {},
    },
  )
  setLastResponse(world, res)
  if (res.status === 201) {
    state.caseRecordId = (res.data as Record<string, unknown>)?.recordId as string
  }
})

When('the volunteer converts the report using the atomic endpoint', async ({ request, world }) => {
  const state = getTriageState(world)
  expect(state.reportId).toBeDefined()

  const res = await apiPost<Record<string, unknown>>(
    request,
    `/hubs/${getScenarioState(world).hubId}/records/convert-from-report`,
    {
      reportId: state.reportId,
      entityTypeId: state.entityTypeId ?? 'fake-entity-type-id',
      additionalFields: {},
    },
    state.volunteerNsec!,
  )
  setLastResponse(world, res)
})

Then('the response should include a {string}', async ({ world }, field: string) => {
  const res = getSharedState(world).lastResponse
  expect(res).toBeDefined()
  expect(res!.data).toBeTruthy()
  expect((res!.data as Record<string, unknown>)[field]).toBeTruthy()
})

Then('the response should include {string} matching the original report', async ({ world }, field: string) => {
  const res = getSharedState(world).lastResponse
  expect(res).toBeDefined()
  const value = (res!.data as Record<string, unknown>)[field]
  expect(value).toBe(getTriageState(world).reportId)
})

Then('the report conversionStatus should be {string}', async ({ request, world, workerHub }, expectedStatus: string) => {
  const state = getTriageState(world)
  expect(state.reportId).toBeDefined()
  const { data } = await apiGet<Record<string, unknown>>(request, `/hubs/${workerHub}/reports/${state.reportId}`)
  const meta = parseMetadata(data as Record<string, unknown>)
  expect(meta.conversionStatus).toBe(expectedStatus)
})

Then('the response should have {string} true', async ({ world }, field: string) => {
  const res = getSharedState(world).lastResponse
  expect((res!.data as Record<string, unknown>)[field]).toBe(true)
})

Then('the response should have {string} false', async ({ world }, field: string) => {
  const res = getSharedState(world).lastResponse
  expect((res!.data as Record<string, unknown>)[field]).toBe(false)
})

Then('the response {string} should be non-empty', async ({ world }, field: string) => {
  const res = getSharedState(world).lastResponse
  const value = (res!.data as Record<string, unknown>)[field]
  expect(Array.isArray(value) ? value.length > 0 : Boolean(value)).toBe(true)
})

Given('an entity type {string} with autoAssign enabled exists', async ({ request, world }, name: string) => {
  const hubId = getScenarioState(world).hubId
  const label = name.replace(/_/g, ' ')
  const { data, status } = await apiPost<Record<string, unknown>>(
    request,
    `/hubs/${hubId}/settings/cms/entity-types`,
    {
      name,
      label,
      labelPlural: `${label}s`,
      description: `Auto-assign test entity type ${name}`,
      category: 'case',
      hubId,
      statuses: [
        { value: 'open', label: 'Open', order: 0 },
        { value: 'closed', label: 'Closed', order: 1 },
      ],
      defaultStatus: 'open',
      closedStatuses: ['closed'],
      fields: [],
      autoAssign: true,
      autoAssignThreshold: 30,
    },
  )
  expect(status, `create entity type: ${JSON.stringify(data)}`).toBe(201)
  getTriageState(world).entityTypeId = (data as Record<string, unknown>).id as string
})

Given('an entity type {string} with autoAssign disabled exists', async ({ request, world }, name: string) => {
  const hubId = getScenarioState(world).hubId
  const label = name.replace(/_/g, ' ')
  const { data, status } = await apiPost<Record<string, unknown>>(
    request,
    `/hubs/${hubId}/settings/cms/entity-types`,
    {
      name,
      label,
      labelPlural: `${label}s`,
      description: `No-auto-assign test entity type ${name}`,
      category: 'case',
      hubId,
      statuses: [
        { value: 'open', label: 'Open', order: 0 },
        { value: 'closed', label: 'Closed', order: 1 },
      ],
      defaultStatus: 'open',
      closedStatuses: ['closed'],
      fields: [],
      autoAssign: false,
    },
  )
  expect(status, `create entity type: ${JSON.stringify(data)}`).toBe(201)
  getTriageState(world).entityTypeId = (data as Record<string, unknown>).id as string
})

Given('an on-shift volunteer with capacity exists', async ({ request, workerHub }) => {
  const vol = await createUserViaApi(request, { name: uniqueName('AutoAssign Vol') })
  // Create an all-day, all-week shift so the volunteer is always on-shift
  await createShiftViaApi(request, {
    ...ALWAYS_ON_SHIFT,
    userPubkeys: [vol.pubkey],
    hubId: workerHub,
  })
})

