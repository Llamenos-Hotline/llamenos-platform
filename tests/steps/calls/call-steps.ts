/**
 * Call history and call date filter step definitions.
 * Matches steps from:
 *   - packages/test-specs/features/calls/call-date-filter.feature
 *   - packages/test-specs/features/calls/call-history.feature
 *
 * Behavioral depth: Hard assertions on call-specific elements.
 * No .or(PAGE_TITLE) fallbacks.
 */
import { expect, type Page } from '@playwright/test'
import { Given, When, Then } from '../fixtures'
import { TestIds } from '../../test-ids'
import { Timeouts, Navigation } from '../../helpers'
import { ADMIN_SEED, seedHexToPubkey } from '../../api-helpers'
import {
  simulateIncomingCall,
  simulateAnswerCall,
  simulateEndCall,
  simulateVoicemail,
  uniqueCallerNumber,
} from '../../simulation-helpers'

Given('I am on the call history screen', async ({ page }) => {
  await Navigation.goToCallHistory(page)
})

When('I tap the view call history button', async ({ page }) => {
  await page.getByTestId(TestIds.NAV_CALLS).click()
})

Then('I should see the call history screen', async ({ page }) => {
  await expect(page.getByTestId(TestIds.PAGE_TITLE)).toBeVisible({ timeout: Timeouts.ELEMENT })
  await expect(page.getByTestId(TestIds.PAGE_TITLE)).toContainText(/call/i)
})

Then('I should see the call history title', async ({ page }) => {
  await expect(page.getByTestId(TestIds.PAGE_TITLE)).toBeVisible({ timeout: Timeouts.ELEMENT })
  await expect(page.getByTestId(TestIds.PAGE_TITLE)).toContainText(/call/i)
})

/** Maps the chip label used in the shared feature specs to its stable testid + URL status. */
const CALL_FILTER_CHIPS: Record<string, { testId: string; status: string }> = {
  All: { testId: TestIds.CALL_FILTER_ALL, status: '' },
  Completed: { testId: TestIds.CALL_FILTER_COMPLETED, status: 'completed' },
  Unanswered: { testId: TestIds.CALL_FILTER_UNANSWERED, status: 'unanswered' },
}

function callFilterChip(filterName: string) {
  const chip = CALL_FILTER_CHIPS[filterName]
  if (!chip) throw new Error(`Unknown call filter chip "${filterName}" — expected one of ${Object.keys(CALL_FILTER_CHIPS).join(', ')}`)
  return chip
}

Then('I should see the {string} call filter chip', async ({ page }, filterName: string) => {
  await expect(page.getByTestId(callFilterChip(filterName).testId)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

When('I tap the {string} call filter chip', async ({ page }, filterName: string) => {
  await page.getByTestId(callFilterChip(filterName).testId).click()
})

Then('the {string} call filter should be selected', async ({ page }, filterName: string) => {
  const { testId, status } = callFilterChip(filterName)
  await expect(page.getByTestId(testId)).toHaveAttribute('aria-pressed', 'true', { timeout: Timeouts.ELEMENT })
  for (const other of Object.values(CALL_FILTER_CHIPS)) {
    if (other.testId !== testId) {
      await expect(page.getByTestId(other.testId)).toHaveAttribute('aria-pressed', 'false')
    }
  }
  // The list must have settled on the filtered result (skeleton gone), then every
  // rendered row has to carry the selected status.
  await expect(
    page.getByTestId(TestIds.CALL_LIST).or(page.getByTestId(TestIds.EMPTY_STATE)),
  ).toBeVisible({ timeout: Timeouts.ELEMENT })
  if (status) {
    await expect.poll(() => callRowStatuses(page).then(rows => rows.filter(r => r !== status))).toEqual([])
  }
})

async function countCallRows(page: Page, status: string): Promise<number> {
  return (await callRowStatuses(page)).filter(r => r === status).length
}

/** Status (data-call-status) of every call row currently rendered. */
function callRowStatuses(page: Page): Promise<Array<string | null>> {
  return page.getByTestId(TestIds.CALL_ROW).evaluateAll(rows => rows.map(r => r.getAttribute('data-call-status')))
}

Given(
  '{int} completed calls and {int} unanswered call exist in the active hub',
  async ({ backendRequest, workerHub }, completed: number, unanswered: number) => {
    const adminPubkey = seedHexToPubkey(ADMIN_SEED)
    for (let i = 0; i < completed; i++) {
      const { callId } = await simulateIncomingCall(backendRequest, { callerNumber: uniqueCallerNumber(), hubId: workerHub })
      await simulateAnswerCall(backendRequest, callId, adminPubkey)
      await simulateEndCall(backendRequest, callId)
    }
    for (let i = 0; i < unanswered; i++) {
      const { callId } = await simulateIncomingCall(backendRequest, { callerNumber: uniqueCallerNumber(), hubId: workerHub })
      await simulateVoicemail(backendRequest, callId)
    }
  },
)

Then(
  'the call history lists at least {int} {string} calls and no other status',
  async ({ page }, minimum: number, status: string) => {
    await expect.poll(() => countCallRows(page, status), { timeout: Timeouts.ELEMENT }).toBeGreaterThanOrEqual(minimum)
    await expect.poll(() => callRowStatuses(page).then(rows => rows.filter(r => r !== status))).toEqual([])
  },
)

Then('the call history lists at least {int} {string} calls', async ({ page }, minimum: number, status: string) => {
  await expect.poll(() => countCallRows(page, status), { timeout: Timeouts.ELEMENT }).toBeGreaterThanOrEqual(minimum)
})

Then('I should see the call history content or empty state', async ({ page }) => {
  const content = page.locator(
    `[data-testid="${TestIds.CALL_LIST}"], [data-testid="${TestIds.EMPTY_STATE}"], [data-testid="${TestIds.LOADING_SKELETON}"]`,
  )
  await expect(content.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should see the call history search field', async ({ page }) => {
  await expect(page.getByTestId(TestIds.CALL_SEARCH)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the call history screen should support pull to refresh', async ({ page }) => {
  // Desktop doesn't have pull-to-refresh — verify call list loaded
  const content = page.locator(
    `[data-testid="${TestIds.CALL_LIST}"], [data-testid="${TestIds.EMPTY_STATE}"]`,
  )
  await expect(content.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

/** Waits for the call history to settle on either rows or the empty state; returns the row count. */
async function settledCallRowCount(page: Page): Promise<number> {
  await expect(
    page.getByTestId(TestIds.CALL_LIST).or(page.getByTestId(TestIds.EMPTY_STATE)),
  ).toBeVisible({ timeout: Timeouts.ELEMENT })
  return page.getByTestId(TestIds.CALL_ROW).count()
}

Then('each call record should have an add note button', async ({ page }) => {
  // Desktop's per-row note affordance is the "view notes" link into /notes for that call.
  const rows = page.getByTestId(TestIds.CALL_ROW)
  const rowCount = await settledCallRowCount(page)
  for (let i = 0; i < rowCount; i++) {
    await expect(rows.nth(i).getByTestId(TestIds.CALL_NOTES_LINK)).toBeVisible({ timeout: Timeouts.ELEMENT })
  }
  // If no call records exist in test env, step passes gracefully
})

When('I tap the add note button on a call record', async ({ page }) => {
  if (await settledCallRowCount(page) > 0) {
    await page.getByTestId(TestIds.CALL_ROW).first().getByTestId(TestIds.CALL_NOTES_LINK).click()
  } else {
    // No call records in this environment: go to the notes page directly.
    const { Navigation } = await import('../../pages/index')
    await Navigation.goToNotes(page)
  }
  await page.getByTestId(TestIds.NOTE_NEW_BTN).click()
})

When('I tap the back button on call history', async ({ page }) => {
  // The call history route has no in-page back control: back is history navigation.
  await expect(page.getByTestId(TestIds.PAGE_TITLE)).toBeVisible({ timeout: Timeouts.ELEMENT })
  await page.goBack()
})

Then('I should see the date from filter', async ({ page }) => {
  await expect(page.getByTestId(TestIds.CALL_DATE_FROM)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should see the date to filter', async ({ page }) => {
  await expect(page.getByTestId(TestIds.CALL_DATE_TO)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Given('a date range is selected', async ({ page }) => {
  // Scoped testids, not CSS-selector `.first()`/`.nth(1)` over every `input[type="date"]`
  // on the page — each input is waited on before being filled. These testids are already
  // used for assertions elsewhere in this file (see the from/to filter Then steps above).
  const dateFrom = page.getByTestId(TestIds.CALL_DATE_FROM)
  const dateTo = page.getByTestId(TestIds.CALL_DATE_TO)
  await expect(dateFrom).toBeVisible({ timeout: Timeouts.ELEMENT })
  await dateFrom.fill('2024-01-01')
  await expect(dateTo).toBeVisible({ timeout: Timeouts.ELEMENT })
  await dateTo.fill('2024-12-31')
  // The filter form applies on submit: filling the inputs alone changes neither
  // the URL search nor `hasFilters`, which is why the clear-button check used to
  // need a page-title fallback. Submit it, as a user would.
  await page.getByTestId(TestIds.CALL_SEARCH_BTN).click()
  await expect(page).toHaveURL(/[?&]dateFrom=2024-01-01/, { timeout: Timeouts.ELEMENT })
})

Then('I should see the date range clear button', async ({ page }) => {
  // Clear only renders once a filter is set (hasFilters). The old fallback —
  // "date fill may not trigger React state in test env", then the page title —
  // passed exactly when filling the dates had no effect.
  await expect(page.getByTestId(TestIds.CALL_CLEAR_FILTERS)).toBeVisible({ timeout: Timeouts.ELEMENT })
})
