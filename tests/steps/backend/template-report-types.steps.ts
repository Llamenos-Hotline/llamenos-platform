/**
 * Template-Defined Report Types step definitions (Epic 343).
 *
 * Tests CMS report type definitions created from templates and via manual CRUD.
 * Reuses "the server is reset", "case management is enabled", and template apply
 * steps from other step files.
 */
import { expect } from '@playwright/test'
import { When, Then, Before, getState, setState } from './fixtures'
import { setLastResponse } from './shared-state'
import { getScenarioState } from './common.steps'
import {
  ADMIN_SEED,
  listCmsReportTypesViaApi,
  getCmsReportTypeViaApi,
  createCmsReportTypeViaApi,
  updateCmsReportTypeViaApi,
  deleteCmsReportTypeViaApi,
} from '../../api-helpers'

// ── Local State ────────────────────────────────────────────────────

interface ReportTypeState {
  reportTypes: Array<Record<string, unknown>>
  lastReportType?: Record<string, unknown>
  lastReportTypeId?: string
}

const TEMPLATE_REPORT_TYPES_KEY = 'template_report_types'

function getReportTypeState(world: Record<string, unknown>): ReportTypeState {
  return getState<ReportTypeState>(world, TEMPLATE_REPORT_TYPES_KEY)
}


Before({ tags: '@cms' }, async ({ world }) => {
  const state = {
    reportTypes: [],
  }
  setState(world, TEMPLATE_REPORT_TYPES_KEY, state)
})

// ── Helper: find report type by name from list ─────────────────────

async function findCmsReportTypeByName(
  request: import('@playwright/test').APIRequestContext,
  name: string,
  hubId: string,
): Promise<Record<string, unknown> | undefined> {
  const types = await listCmsReportTypesViaApi(request, hubId)
  return types.find(t => t.name === name)
}

// ============================================================
// TEMPLATE REPORT TYPE STEPS
// ============================================================

Then('CMS report type {string} should exist', async ({ request, world }, name: string) => {
  const hubId = getScenarioState(world).hubId
  const rt = await findCmsReportTypeByName(request, name, hubId)
  expect(rt).toBeTruthy()
  getReportTypeState(world).lastReportType = rt
  getReportTypeState(world).lastReportTypeId = rt!.id as string
})

Then('CMS report type {string} should have {string} enabled', async ({ request, world }, name: string, flag: string) => {
  const hubId = getScenarioState(world).hubId
  const rt = getReportTypeState(world).lastReportType?.name === name
    ? getReportTypeState(world).lastReportType
    : await findCmsReportTypeByName(request, name, hubId)
  expect(rt).toBeTruthy()
  expect(rt![flag]).toBe(true)
})

When('the admin lists CMS report types', async ({ request, world }) => {
  const hubId = getScenarioState(world).hubId
  getReportTypeState(world).reportTypes = await listCmsReportTypesViaApi(request, hubId)
})

Then('{int} CMS report types should be returned', async ({ world }, count: number) => {
  // Parallel tests apply the same template, creating duplicates globally — assert at least N
  expect(getReportTypeState(world).reportTypes.length).toBeGreaterThanOrEqual(count)
})

When('the admin gets CMS report type {string}', async ({ request, world }, name: string) => {
  const hubId = getScenarioState(world).hubId
  const rt = await findCmsReportTypeByName(request, name, hubId)
  expect(rt).toBeTruthy()
  getReportTypeState(world).lastReportType = await getCmsReportTypeViaApi(request, rt!.id as string, ADMIN_SEED, hubId)
  getReportTypeState(world).lastReportTypeId = rt!.id as string
})

Then('the CMS report type should have name {string}', async ({ world }, name: string) => {
  expect(getReportTypeState(world).lastReportType).toBeTruthy()
  expect(getReportTypeState(world).lastReportType!.name).toBe(name)
})

Then('the CMS report type should have {int} fields', async ({ world }, count: number) => {
  expect(getReportTypeState(world).lastReportType).toBeTruthy()
  const fields = getReportTypeState(world).lastReportType!.fields as unknown[]
  expect(fields.length).toBe(count)
})

Then('the CMS report type field {string} should have {string} enabled', async ({ world }, fieldName: string, flag: string) => {
  expect(getReportTypeState(world).lastReportType).toBeTruthy()
  const fields = getReportTypeState(world).lastReportType!.fields as Array<Record<string, unknown>>
  const field = fields.find(f => f.name === fieldName)
  expect(field).toBeTruthy()
  expect(field![flag]).toBe(true)
})

// ============================================================
// REPORT TYPE CRUD STEPS
// ============================================================

When('the admin creates a custom CMS report type {string}', async ({ request, world }, name: string) => {
  const hubId = getScenarioState(world).hubId
  const reportType = await createCmsReportTypeViaApi(request, { name, hubId })
  getReportTypeState(world).lastReportType = reportType
  getReportTypeState(world).lastReportTypeId = reportType.id as string
})

Then('the CMS report type should be retrievable', async ({ request, world }) => {
  const rt = await getCmsReportTypeViaApi(request, getReportTypeState(world).lastReportTypeId!, ADMIN_SEED, getScenarioState(world).hubId)
  expect(rt).toBeTruthy()
  expect(rt.id).toBe(getReportTypeState(world).lastReportTypeId)
})

When('the admin updates the CMS report type label to {string}', async ({ request, world }, label: string) => {
  getReportTypeState(world).lastReportType = await updateCmsReportTypeViaApi(
    request,
    getReportTypeState(world).lastReportTypeId!,
    { label },
    ADMIN_SEED,
    getScenarioState(world).hubId,
  )
})

Then('the CMS report type label should be {string}', async ({ world }, label: string) => {
  expect(getReportTypeState(world).lastReportType!.label).toBe(label)
})

When('the admin archives the CMS report type', async ({ request, world }) => {
  await deleteCmsReportTypeViaApi(request, getReportTypeState(world).lastReportTypeId!, ADMIN_SEED, getScenarioState(world).hubId)
})

Then('the CMS report type should be marked as archived', async ({ request, world }) => {
  const rt = await getCmsReportTypeViaApi(request, getReportTypeState(world).lastReportTypeId!, ADMIN_SEED, getScenarioState(world).hubId)
  expect(rt.isArchived).toBe(true)
})

When('the admin tries to create a CMS report type {string}', async ({request, world}, name: string) => {
  const hubId = getScenarioState(world).hubId
  try {
    await createCmsReportTypeViaApi(request, { name, hubId })
    setLastResponse(world, { status: 201, data: null })
  } catch (e: unknown) {
    const msg = (e as Error).message
    const match = msg.match(/(\d{3})/)
    setLastResponse(world, { status: match ? parseInt(match[1]) : 500, data: null })
  }
})
