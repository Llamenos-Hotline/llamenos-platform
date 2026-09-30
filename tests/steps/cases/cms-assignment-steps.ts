/**
 * Smart Case Assignment step definitions (Epic 342).
 * Matches steps from:
 *   - packages/test-specs/features/platform/desktop/cases/cms-assignment.feature
 */
import { expect, type APIRequestContext, type Page } from '@playwright/test'
import { Given, When, Then } from '../fixtures'
import { Timeouts, navigateAfterLogin } from '../../helpers'
import {
  ADMIN_NSEC,
  apiGet,
  createRecordViaApi,
  createShiftViaApi,
  createUserViaApi,
  getRecordViaApi,
  listEntityTypesViaApi,
  uniqueName,
} from '../../api-helpers'

// State is now in casesWorld fixture (casesWorld.lastRecordId)

// --- Preconditions ---

/** The hub's arrest_case entity type (created by the jail-support template). */
async function arrestCaseTypeId(request: APIRequestContext, hubId: string): Promise<string> {
  const entityTypes = await listEntityTypesViaApi(request, hubId)
  const arrestType = entityTypes.find(et => (et as { name?: string }).name === 'arrest_case')
  // A missing type means the template precondition did not hold. The old Givens
  // returned early here, so every later step ran against no case at all.
  expect(arrestType, 'arrest_case entity type (jail-support template)').toBeTruthy()
  return (arrestType as { id: string }).id
}

/**
 * Two volunteers on an all-week shift in the worker hub, so the suggestion
 * engine has on-shift candidates. The old Background step was empty ("accept
 * current state"), so the assignment dialog could only ever show its empty state.
 */
async function seedOnShiftVolunteers(request: APIRequestContext, hubId: string) {
  const vol1 = await createUserViaApi(request, { name: uniqueName('AssignVol1') })
  const vol2 = await createUserViaApi(request, { name: uniqueName('AssignVol2') })
  await createShiftViaApi(request, {
    name: uniqueName('AssignShift'),
    startTime: '00:00',
    endTime: '23:59',
    days: [0, 1, 2, 3, 4, 5, 6],
    userPubkeys: [vol1.pubkey, vol2.pubkey],
    hubId,
  })
}

Given('volunteers with different profiles exist', async ({ backendRequest: request, workerHub }) => {
  await seedOnShiftVolunteers(request, workerHub)
})

Given('an unassigned arrest case exists', async ({ backendRequest: request, casesWorld, workerHub }) => {
  const etId = await arrestCaseTypeId(request, workerHub)
  const record = await createRecordViaApi(request, etId, { statusHash: 'reported', hubId: workerHub })
  casesWorld.lastRecordId = (record as { id: string }).id
})

Given('on-shift volunteers with capacity exist', async ({ backendRequest: request, workerHub }) => {
  await seedOnShiftVolunteers(request, workerHub)
})

Given('a case assigned to a volunteer exists', async ({ backendRequest: request, casesWorld, workerHub }) => {
  const { assignRecordViaApi } = await import('../../api-helpers')
  const etId = await arrestCaseTypeId(request, workerHub)
  // Create a new case and assign the admin to it so the Unassign button appears
  const adminPubkey = process.env.ADMIN_PUBKEY || '79215a4c04f08fcd817c6f820c87169beb8cddf96dfa590a1315556b78af9183'
  const record = await createRecordViaApi(request, etId, {
    statusHash: 'reported',
    assignedTo: [adminPubkey],
    hubId: workerHub,
  })
  casesWorld.lastRecordId = (record as { id: string }).id
  await assignRecordViaApi(request, casesWorld.lastRecordId, [adminPubkey], ADMIN_NSEC, workerHub)
})

/** Turn the Cases page's auto-assignment toggle on, from whichever state it is in. */
async function ensureAutoAssignOn(page: Page) {
  const toggle = page.getByTestId('auto-assignment-toggle')
  await expect(toggle).toHaveText(/Auto-assign/, { timeout: Timeouts.ELEMENT })
  if (!(await toggle.textContent())?.includes('Auto-assign on')) {
    await toggle.click()
  }
  await expect(page.getByTestId('auto-assignment-indicator')).toBeVisible({ timeout: Timeouts.ELEMENT })
}

Given('auto-assignment is enabled', async ({ page }) => {
  await navigateAfterLogin(page, '/cases')
  await ensureAutoAssignOn(page)
})

// --- Suggest assignees API ---
// The on-break / at-capacity / language / workload API scenarios are @wip on
// desktop (#1298): their step bodies were empty. The backend suite covers them.

When('I request assignment suggestions for the case', async ({ backendRequest: request, casesWorld, workerHub }) => {
  expect(casesWorld.lastRecordId, 'a case must exist first').toBeTruthy()
  const { status, data } = await apiGet<{ suggestions?: Array<Record<string, unknown>> }>(
    request,
    `/hubs/${workerHub}/records/${casesWorld.lastRecordId}/suggest-assignees`,
  )
  expect(status).toBe(200)
  casesWorld.lastSuggestions = data.suggestions ?? []
})

Then('the response should contain suggested volunteers', async ({ casesWorld }) => {
  expect(casesWorld.lastSuggestions.length).toBeGreaterThan(0)
})

Then('each suggestion should include a score and reasons', async ({ casesWorld }) => {
  expect(casesWorld.lastSuggestions.length).toBeGreaterThan(0)
  for (const suggestion of casesWorld.lastSuggestions) {
    expect(typeof suggestion.score).toBe('number')
    expect(Array.isArray(suggestion.reasons)).toBe(true)
  }
})

// --- Assignment dialog UI ---
// Note: "I click the {string} button" is handled by common/interaction-steps.ts

Then('the assignment dialog should be visible', async ({ page }) => {
  await expect(page.getByTestId('assignment-dialog')).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('suggested volunteers should appear at the top', async ({ page }) => {
  // The Background seeds on-shift volunteers, so the empty state is a failure
  // here (the old step accepted it).
  await expect(page.getByTestId('suggestion-card').first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('each volunteer should show a workload indicator', async ({ page }) => {
  const cards = page.getByTestId('suggestion-card')
  await expect(cards.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
  await expect(page.getByTestId('workload-indicator')).toHaveCount(await cards.count())
})

When('I open the assignment dialog for the case', async ({ page }) => {
  await navigateAfterLogin(page, '/cases')
  // Each control renders only once the previous click has landed, so wait for
  // it rather than probing — a non-waiting isVisible() skipped these clicks
  // whenever the case list was still loading, leaving nothing selected.
  const card = page.getByTestId('case-card').first()
  await expect(card).toBeVisible({ timeout: Timeouts.ELEMENT })
  await card.click()
  const assignBtn = page.getByTestId('case-assign-dialog-btn')
  await expect(assignBtn).toBeVisible({ timeout: Timeouts.ELEMENT })
  await assignBtn.click()
  await expect(page.getByTestId('assignment-dialog')).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('each suggested volunteer should show match reasons', async ({ page }) => {
  const cards = page.getByTestId('suggestion-card')
  await expect(cards.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
  await expect(page.getByTestId('match-reason')).toHaveCount(await cards.count())
})

Then('reasons should include availability and workload', async ({ page }) => {
  const reasons = page.getByTestId('match-reason')
  await expect(reasons.filter({ hasText: /availab/i }).first()).toBeVisible({ timeout: Timeouts.ELEMENT })
  await expect(reasons.filter({ hasText: /workload/i }).first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

When('I click assign on the first suggested volunteer', async ({ page }) => {
  // On-shift volunteers are seeded, so a suggestion must be offered. The old
  // step fell back to "Assign to me" when none was, which is a different flow.
  await expect(page.getByTestId('suggestion-card').first()).toBeVisible({ timeout: Timeouts.ELEMENT })
  await page.getByTestId('assign-volunteer-btn').first().click()
})

Then('the case should show the volunteer as assigned', async ({ page }) => {
  // The selected case's detail panel stays open after assignment and, once the
  // list state reflects the assignee, offers Unassign.
  await expect(page.getByTestId('case-detail-header')).toBeVisible({ timeout: Timeouts.ELEMENT })
  await expect(page.getByTestId('case-unassign-btn')).toBeVisible({ timeout: Timeouts.ELEMENT })
})

// "I click the {string} button" is already in common/interaction-steps.ts

Then('the assign button should reappear', async ({ page }) => {
  const btn = page.getByTestId('case-assign-btn')
    .or(page.getByTestId('case-assign-dialog-btn'))
  await expect(btn.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
  await expect(page.getByTestId('case-unassign-btn')).toHaveCount(0)
})

// --- Auto-assignment ---

When('I toggle the auto-assignment switch', async ({ page }) => {
  // Auto-assignment is hub state shared by the worker's scenarios. Start from
  // "off" so the toggle under test is the one that turns it on.
  const toggle = page.getByTestId('auto-assignment-toggle')
  await expect(toggle).toHaveText(/Auto-assign/, { timeout: Timeouts.ELEMENT })
  if ((await toggle.textContent())?.includes('Auto-assign on')) {
    await toggle.click()
    await expect(page.getByTestId('auto-assignment-indicator')).toHaveCount(0, { timeout: Timeouts.ELEMENT })
  }
  await toggle.click()
})

Then('the auto-assignment indicator should be visible', async ({ page }) => {
  // Only the indicator counts: the old `.or(toggle)` matched the toggle itself,
  // which is on screen whether auto-assignment is on or off.
  await expect(page.getByTestId('auto-assignment-indicator')).toBeVisible({ timeout: Timeouts.ELEMENT })
})

When('a new arrest case is created via API', async ({ backendRequest: request, casesWorld, workerHub }) => {
  const etId = await arrestCaseTypeId(request, workerHub)
  const record = await createRecordViaApi(request, etId, { statusHash: 'reported', hubId: workerHub })
  casesWorld.lastRecordId = (record as { id: string }).id
})

Then('the new case should have an assignee', async ({ backendRequest: request, casesWorld, workerHub }) => {
  // Read the assignment from the server. The old step only checked that some
  // case card rendered.
  await expect.poll(async () => {
    const record = await getRecordViaApi(request, casesWorld.lastRecordId, workerHub)
    return (record.assignedTo as string[] | undefined)?.length ?? 0
  }, { timeout: Timeouts.API }).toBeGreaterThan(0)
})
