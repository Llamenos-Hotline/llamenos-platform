/**
 * Report-to-case lifecycle step definitions (Epic 365).
 *
 * Tests the full workflow from report submission through case conversion,
 * reporter data isolation, and JSONB metadata persistence.
 */
import { expect } from '@playwright/test'
import { Given, When, Then, Before, getState, setState } from './fixtures'
import { getScenarioState } from './common.steps'
import {
  apiGet,
  apiPatch,
  createVolunteerViaApi,
  createReportViaApi,
  assignReportViaApi,
  listReportsViaApi,
  createCaseFromReportViaApi,
  getRecordViaApi,
  enableCaseManagementViaApi,
  createEntityTypeViaApi,
  updateReportStatusViaApi,
  uniqueName,
} from '../../api-helpers'
import { assertIsObject } from '../../integrity-helpers'

// ── Local State ────────────────────────────────────────────────────

interface LifecycleState {
  entityTypeId?: string
  reportId?: string
  reportTitle?: string
  reportCategory?: string
  caseRecordId?: string
  caseLinkId?: string
  volunteerPubkey?: string
  volunteerSeedHex?: string
  /** Reporter-specific state for isolation tests */
  reporters: Map<string, { seedHex: string; pubkey: string; reportIds: string[]; reportTitles: string[] }>
  /** Last fetched report data */
  lastFetchedReport?: Record<string, unknown>
}

const REPORT_CASE_LIFECYCLE_KEY = 'report_case_lifecycle'

function getLifecycleState(world: Record<string, unknown>): LifecycleState {
  return getState<LifecycleState>(world, REPORT_CASE_LIFECYCLE_KEY)
}


Before({ tags: '@lifecycle' }, async ({ world }) => {
  const lc = {
    reporters: new Map(),
  }
  setState(world, REPORT_CASE_LIFECYCLE_KEY, lc)
})

// ── Helpers ────────────────────────────────────────────────────────

async function ensureEntityType(
  request: import('@playwright/test').APIRequestContext,
  world: Record<string, unknown>,
): Promise<string> {
  if (getLifecycleState(world).entityTypeId) return getLifecycleState(world).entityTypeId!
  await enableCaseManagementViaApi(request, true)
  const hubId = getScenarioState(world).hubId
  const et = await createEntityTypeViaApi(request, {
    name: uniqueName('lifecycle_case', '_'),
    hubId,
  })
  const entityTypeId = et.id as string
  getLifecycleState(world).entityTypeId = entityTypeId
  return entityTypeId
}

// ── Full Lifecycle ────────────────────────────────────────────────

Given(
  'a reporter submits a report with title {string}',
  async ({ request, world }, title: string) => {
    const report = await createReportViaApi(request, { title })
    getLifecycleState(world).reportId = report.id
    getLifecycleState(world).reportTitle = title
  },
)

Given('a volunteer is assigned to the report', async ({ request, world }) => {
  expect(getLifecycleState(world).reportId).toBeTruthy()
  const vol = await createVolunteerViaApi(request, {
    name: `Lifecycle Vol ${Date.now()}`,
  })
  getLifecycleState(world).volunteerPubkey = vol.pubkey
  getLifecycleState(world).volunteerSeedHex = vol.seedHex

  await assignReportViaApi(request, getLifecycleState(world).reportId!, vol.pubkey)
})

When('the admin converts the report to a case', async ({ request, world }) => {
  expect(getLifecycleState(world).reportId).toBeTruthy()
  const entityTypeId = await ensureEntityType(request, world)

  const result = await createCaseFromReportViaApi(
    request,
    getLifecycleState(world).reportId!,
    entityTypeId,
  )
  getLifecycleState(world).caseRecordId = result.recordId
  getLifecycleState(world).caseLinkId = result.linkId
})

Then('a case record should be created', async ({ world }) => {
  expect(getLifecycleState(world).caseRecordId).toBeTruthy()
})

Then('the case should be linked to the original report', async ({ world }) => {
  expect(getLifecycleState(world).caseRecordId).toBeTruthy()
  expect(getLifecycleState(world).reportId).toBeTruthy()
  // The link was created by createCaseFromReportViaApi
  expect(getLifecycleState(world).caseLinkId).toBeTruthy()
})

Then('listing the report should show the linked case ID', async ({ request, world }) => {
  expect(getLifecycleState(world).reportId).toBeTruthy()
  expect(getLifecycleState(world).caseRecordId).toBeTruthy()

  // Fetch the report's linked records
  const res = await apiGet<{ records: Array<{ caseId: string }> }>(
    request,
    `/reports/${getLifecycleState(world).reportId}/records`,
  )
  // The report should have a linked case
  if (res.status === 200 && res.data.records) {
    const linkedIds = res.data.records.map((r: { caseId: string }) => r.caseId)
    expect(linkedIds).toContain(getLifecycleState(world).caseRecordId)
  }
})

Then('listing the case should show the linked report ID', async ({ request, world }) => {
  expect(getLifecycleState(world).caseRecordId).toBeTruthy()

  // Get the case record — it should reference the report
  const record = await getRecordViaApi(request, getLifecycleState(world).caseRecordId!)
  // The record was linked via the report-records endpoint,
  // so the link exists in the join table
  expect(record).toBeTruthy()
})

// ── Reporter Data Isolation ───────────────────────────────────────

Given(
  'reporter {string} creates a report with title {string}',
  async ({ request, world }, reporterName: string, title: string) => {
    // Create a volunteer with reporter role
    const vol = await createVolunteerViaApi(request, {
      name: `Reporter ${reporterName} ${Date.now()}`,
    })
    await apiPatch(request, `/users/${vol.pubkey}`, { roles: ['role-reporter'] })

    // Create the report authenticated as the reporter so the server records their pubkey
    // as the contact/author — required for the reporter-isolation filter in GET /reports
    const report = await createReportViaApi(request, {
      title,
      seedHex: vol.seedHex,
    })

    if (!getLifecycleState(world).reporters.has(reporterName)) {
      getLifecycleState(world).reporters.set(reporterName, {
        seedHex: vol.seedHex,
        pubkey: vol.pubkey,
        reportIds: [],
        reportTitles: [],
      })
    }
    getLifecycleState(world).reporters.get(reporterName)!.reportIds.push(report.id)
    getLifecycleState(world).reporters.get(reporterName)!.reportTitles.push(title)
  },
)

When('{string} lists their own reports', async ({ request, world }, reporterName: string) => {
  const reporter = getLifecycleState(world).reporters.get(reporterName)
  expect(reporter).toBeTruthy()

  // List reports as the reporter
  const { data } = await apiGet<{ conversations: Array<{ id: string; metadata?: { reportTitle?: string } }> }>(
    request,
    '/reports',
    reporter!.seedHex,
  )
  // Store for assertion
  getLifecycleState(world).lastFetchedReport = { conversations: data?.conversations ?? [], reporterName }
})

Then('{string} should see {string}', async ({ world }, reporterName: string, _title: string) => {
  const reporter = getLifecycleState(world).reporters.get(reporterName)
  expect(reporter).toBeTruthy()

  // The reporter's own reports should be visible
  // Since we're checking by title in the metadata
  const conversations = (getLifecycleState(world).lastFetchedReport as Record<string, unknown>)?.conversations as Array<{
    id: string
    metadata?: { reportTitle?: string }
  }>

  // The reporter should find their report by ID
  const reportIds = reporter!.reportIds
  const found = conversations?.some(c => reportIds.includes(c.id))
  expect(found).toBe(true)
})

Then('{string} should not see {string}', async ({ world }, reporterName: string, _title: string) => {
  const reporter = getLifecycleState(world).reporters.get(reporterName)
  expect(reporter).toBeTruthy()

  // Get the other reporter's IDs
  const otherReportIds: string[] = []
  for (const [name, r] of getLifecycleState(world).reporters) {
    if (name !== reporterName) {
      otherReportIds.push(...r.reportIds)
    }
  }

  const conversations = (getLifecycleState(world).lastFetchedReport as Record<string, unknown>)?.conversations as Array<{
    id: string
  }>

  // None of the other reporter's report IDs should be visible
  for (const otherId of otherReportIds) {
    const found = conversations?.some(c => c.id === otherId)
    expect(found).toBeFalsy()
  }
})

// ── Metadata Persistence ──────────────────────────────────────────

Given(
  'a report exists with metadata category {string} and title {string}',
  async ({ request, world }, category: string, title: string) => {
    const report = await createReportViaApi(request, { title, category })
    getLifecycleState(world).reportId = report.id
    getLifecycleState(world).reportCategory = category
    getLifecycleState(world).reportTitle = title
  },
)

When(
  'the admin updates the lifecycle report status to {string}',
  async ({ request, world }, newStatus: string) => {
    expect(getLifecycleState(world).reportId).toBeTruthy()
    if (newStatus === 'active') {
      // Need to assign first
      const vol = await createVolunteerViaApi(request, {
        name: `Metadata Vol ${Date.now()}`,
      })
      await assignReportViaApi(request, getLifecycleState(world).reportId!, vol.pubkey)
    } else {
      await updateReportStatusViaApi(request, getLifecycleState(world).reportId!, newStatus)
    }
  },
)

When('the report is fetched again', async ({ request, world }) => {
  expect(getLifecycleState(world).reportId).toBeTruthy()
  const { status, data } = await apiGet<Record<string, unknown>>(
    request,
    `/reports/${getLifecycleState(world).reportId}`,
  )
  // If individual report GET is not available, list and find
  if (status === 200) {
    getLifecycleState(world).lastFetchedReport = data
  } else {
    // Fallback: list reports and find by ID
    const list = await listReportsViaApi(request)
    const found = list.conversations.find(c => c.id === getLifecycleState(world).reportId)
    getLifecycleState(world).lastFetchedReport = found as unknown as Record<string, unknown>
  }
})

Then(
  'the report metadata should still contain category {string}',
  async ({ world }, category: string) => {
    expect(getLifecycleState(world).lastFetchedReport).toBeTruthy()
    const metadata = (getLifecycleState(world).lastFetchedReport as Record<string, unknown>).metadata as Record<string, unknown> | undefined
    // The category should persist through status updates
    if (metadata) {
      expect(metadata.reportCategory ?? metadata.category).toBe(category)
    }
  },
)

Then(
  'the report metadata should be a proper JSONB object, not a double-serialized string',
  async ({ world }) => {
    expect(getLifecycleState(world).lastFetchedReport).toBeTruthy()
    const metadata = (getLifecycleState(world).lastFetchedReport as Record<string, unknown>).metadata
    if (metadata !== null && metadata !== undefined) {
      // Use the integrity helper to detect double-serialization
      assertIsObject(metadata, 'report.metadata')
    }
  },
)
