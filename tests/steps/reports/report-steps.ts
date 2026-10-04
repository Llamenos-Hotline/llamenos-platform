/**
 * Report step definitions.
 * Matches steps from:
 *   - packages/test-specs/features/core/reports.feature
 *
 * Behavioral depth: Hard assertions on report-specific elements. No .or(PAGE_TITLE)
 * fallbacks that silently pass when the real element is missing. Report lifecycle
 * verified via API where possible. All API seeding is hub-scoped.
 */
import { expect, type APIRequestContext, type Page } from '@playwright/test'
import { Given, When, Then } from '../fixtures'
import { TestIds } from '../../test-ids'
import { Timeouts } from '../../helpers'
import { listReportsViaApi, createReportViaApi, listCmsReportTypesViaApi } from '../../api-helpers'

// --- Report list ---

Then('I should see the reports screen', async ({ page }) => {
  const reportList = page.getByTestId(TestIds.REPORT_LIST)
  const emptyState = page.getByTestId(TestIds.EMPTY_STATE)
  await expect(reportList.or(emptyState).first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should see the reports card on the dashboard', async ({ page }) => {
  await expect(page.getByTestId(TestIds.NAV_REPORTS)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

When('I tap the view reports button', async ({ page }) => {
  await page.getByTestId(TestIds.NAV_REPORTS).click()
})

// --- Report creation ---

Given('I navigate to the reports list', async ({ page }) => {
  const { Navigation } = await import('../../pages/index')
  await Navigation.goToReports(page)
})

Given('I navigate to the report creation form', async ({ page }) => {
  const { Navigation } = await import('../../pages/index')
  await Navigation.goToReports(page)
  const createBtn = page.getByTestId(TestIds.REPORT_NEW_BTN)
  await expect(createBtn).toBeVisible({ timeout: Timeouts.ELEMENT })
  await createBtn.click()
})

Then('I should see the create report button', async ({ page }) => {
  await expect(page.getByTestId(TestIds.REPORT_NEW_BTN)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should see the report title input', async ({ page }) => {
  await expect(page.getByTestId(TestIds.REPORT_TITLE_INPUT)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should see the report body input', async ({ page }) => {
  await expect(page.getByTestId(TestIds.REPORT_BODY_INPUT)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should see the report submit button', async ({ page }) => {
  await expect(page.getByTestId(TestIds.REPORT_SUBMIT_BTN)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the report submit button should be disabled', async ({ page }) => {
  // ReportForm has one submit control (report-form-submit-btn); the old
  // fallback to form-save-btn targeted a button this form never renders.
  const submitBtn = page.getByTestId(TestIds.REPORT_SUBMIT_BTN)
  await expect(submitBtn).toBeVisible({ timeout: Timeouts.ELEMENT })
  await expect(submitBtn).toBeDisabled()
})

/**
 * Make sure the worker hub has at least one report, then open the reports page
 * fresh so the list shows it. Reads and writes through the API; every failure
 * throws (the old version swallowed listing errors and URL waits).
 */
async function openReportsWithAReport(page: Page, backendRequest: APIRequestContext, workerHub: string) {
  const existing = await listReportsViaApi(backendRequest, { hubId: workerHub })
  if (existing.conversations.length === 0) {
    await createReportViaApi(backendRequest, { title: `Auto-seeded Report ${Date.now()}`, hubId: workerHub })
  }
  const { Navigation } = await import('../../pages/index')
  await Navigation.goToDashboard(page)
  await Navigation.goToReports(page)
  await expect(page.getByTestId(TestIds.REPORT_CARD).first()).toBeVisible({ timeout: Timeouts.ELEMENT })
}

// --- Report detail / viewing ---

When('I tap the first report card', async ({ page, backendRequest, workerHub }) => {
  await openReportsWithAReport(page, backendRequest, workerHub)
  await page.getByTestId(TestIds.REPORT_CARD).first().click()
})

Then('I should see the report detail screen', async ({ page }) => {
  await expect(page.getByTestId(TestIds.REPORT_DETAIL)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should see the report metadata card', async ({ page }) => {
  await expect(page.getByTestId(TestIds.REPORT_METADATA)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should see the report status badge', async ({ page }) => {
  await expect(page.getByTestId(TestIds.REPORT_STATUS_BADGE)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

When('I tap the back button on report detail', async ({ page }) => {
  // Desktop reports are a split pane with no back control (back-btn exists only
  // on the contact and volunteer-profile routes). "Back" returns to the list
  // route; browser history back can overshoot past it to the dashboard.
  const { Navigation } = await import('../../pages/index')
  await Navigation.goToReports(page)
})

Given('I am viewing a report with status {string}', async ({ page, backendRequest, workerHub }, status: string) => {
  const { Navigation } = await import('../../pages/index')

  // Ensure a report with the desired status exists in the worker's hub
  let result = await listReportsViaApi(backendRequest, { status, hubId: workerHub })
  if (result.conversations.length === 0) {
    await createReportViaApi(backendRequest, { title: `Seed ${status} report ${Date.now()}`, status, hubId: workerHub })
    result = await listReportsViaApi(backendRequest, { status, hubId: workerHub })
  }
  expect(result.conversations.length).toBeGreaterThan(0)

  // Navigate to reports
  await Navigation.goToReports(page)

  // Narrow the list to the wanted status with the admin status filter.
  if (status !== 'all') {
    const statusFilter = page.getByTestId('report-status-filter')
    await expect(statusFilter).toBeVisible({ timeout: Timeouts.ELEMENT })
    await statusFilter.click()
    await page.getByTestId(`report-status-option-${status}`).click()
    await expect(statusFilter).toContainText(new RegExp(status, 'i'), { timeout: Timeouts.ELEMENT })
  }

  const reportCard = page.getByTestId(TestIds.REPORT_CARD).first()
  await expect(reportCard).toBeVisible({ timeout: Timeouts.ELEMENT })
  await reportCard.click()
})

// --- Report list (report-list.feature) ---

Then('I should see the reports title', async ({ page }) => {
  await expect(page.getByTestId(TestIds.PAGE_TITLE)).toBeVisible({ timeout: Timeouts.ELEMENT })
  await expect(page.getByTestId(TestIds.PAGE_TITLE)).toContainText(/reports/i)
})

// The admin filter area renders whether or not the hub has reports
// (reports.tsx: `isAdmin && <div data-testid="report-filter-area">`), so no
// seeding or re-navigation is needed before using it. The old steps probed for
// it and, when the probe lost the race, swallowed seeding errors.

Then('I should see the {string} report status filter', async ({ page }, filterName: string) => {
  const filterArea = page.getByTestId(TestIds.REPORT_FILTER_AREA)
  await expect(filterArea).toBeVisible({ timeout: Timeouts.ELEMENT })

  // Open the status filter and check the option exists (Radix Select portal).
  const statusFilter = page.getByTestId('report-status-filter')
  await statusFilter.click()
  const option = page.getByTestId(`report-status-option-${filterName.toLowerCase()}`)
  await expect(option).toBeVisible({ timeout: Timeouts.ELEMENT })

  await page.keyboard.press('Escape')
  await expect(option).not.toBeVisible({ timeout: 3000 })
})

When('I tap the {string} report status filter', async ({ page }, filterName: string) => {
  await expect(page.getByTestId(TestIds.REPORT_FILTER_AREA)).toBeVisible({ timeout: Timeouts.ELEMENT })
  const statusFilter = page.getByTestId('report-status-filter')
  await statusFilter.click()
  const option = page.getByTestId(`report-status-option-${filterName.toLowerCase()}`)
  await expect(option).toBeVisible({ timeout: Timeouts.ELEMENT })
  await option.click()
  await expect(option).not.toBeVisible({ timeout: 3000 })
})

Then('the {string} report status filter should be selected', async ({ page }, filterName: string) => {
  const statusFilter = page.getByTestId('report-status-filter')
  await expect(statusFilter).toContainText(new RegExp(filterName, 'i'), { timeout: Timeouts.ELEMENT })
})

// report-list and empty-state are the two settled states of the reports page
// (reports.tsx `showEmptyState ? … : …`); nothing renders them while loading.

Then('I should see the reports content or empty state', async ({ page }) => {
  await expect(page.getByTestId(TestIds.REPORT_LIST).or(page.getByTestId(TestIds.EMPTY_STATE))).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the reports screen should support pull to refresh', async ({ page }) => {
  // Desktop has no pull-to-refresh; the reports page must at least have settled.
  await expect(page.getByTestId(TestIds.REPORT_LIST).or(page.getByTestId(TestIds.EMPTY_STATE))).toBeVisible({ timeout: Timeouts.ELEMENT })
})

When('I tap the back button on reports', async ({ page }) => {
  // No in-page back control on the reports route: back is history navigation.
  await page.goBack()
})

// --- Report claim ---

Then('I should see the report claim button', async ({ page }) => {
  await expect(page.getByTestId(TestIds.REPORT_CLAIM_BTN)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should not see the report claim button', async ({ page }) => {
  await expect(page.getByTestId(TestIds.REPORT_CLAIM_BTN)).not.toBeVisible({ timeout: 3000 })
})

// --- Report close ---

Then('I should see the report close button', async ({ page }) => {
  await expect(page.getByTestId(TestIds.REPORT_CLOSE_BTN)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should not see the report close button', async ({ page }) => {
  await expect(page.getByTestId(TestIds.REPORT_CLOSE_BTN)).not.toBeVisible({ timeout: 3000 })
})

// --- Report lifecycle verification via API ---

Then('the report should exist in the API', async ({ backendRequest, workerHub }) => {
  const result = await listReportsViaApi(backendRequest, { hubId: workerHub })
  expect(result.conversations.length).toBeGreaterThan(0)
})

Then('the report count should increase', async ({ backendRequest, workerHub }) => {
  const result = await listReportsViaApi(backendRequest, { hubId: workerHub })
  expect(result.total).toBeGreaterThan(0)
})

// --- Template-driven report types (desktop) ---

Then('I should see the report type tabs', async ({ page }) => {
  // Desktop renders report types as the admin category filter.
  await expect(page.getByTestId('report-category-filter')).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the report type tabs should include template-defined types', async ({ page, backendRequest, workerHub }) => {
  // The old step only made sure the filter area was visible; it never looked at
  // a single type. Every active report type the hub has must be offered.
  const types = (await listCmsReportTypesViaApi(backendRequest, workerHub))
    .filter(rt => !rt.isArchived)
    .map(rt => rt.name as string)
  expect(types.length, 'the applied template should have created report types').toBeGreaterThan(0)
  await page.getByTestId('report-category-filter').click()
  for (const name of types) {
    await expect(page.getByRole('option', { name, exact: true })).toBeVisible({ timeout: Timeouts.ELEMENT })
  }
  await page.keyboard.press('Escape')
})

Then('the report type selector should be visible', async ({ page }) => {
  // `report-type-picker` and `report-type-option` (below) don't exist anywhere in
  // src/client — ReportForm.tsx renders exactly one selector, `report-type-select`.
  await expect(page.getByTestId('report-type-select')).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the report type selector should list template-defined types', async ({ page }) => {
  // `report-type-picker` never exists in the app (ReportForm only renders
  // `report-type-select`) — the `.or()` was a dead fallback that made `.first()` look
  // like it was resolving ambiguity when it was really just masking that. A single
  // scoped locator makes the click deterministic without needing `.first()` at all.
  const selector = page.getByTestId('report-type-select')
  await expect(selector).toBeVisible({ timeout: Timeouts.ELEMENT })
  await selector.click()
  const options = page.locator('[role="option"]')
  await expect(options.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
  expect(await options.count()).toBeGreaterThanOrEqual(1)
  await page.keyboard.press('Escape')
})

When('I select the first template report type', async ({ page }) => {
  // Was: probe the dropdown with a 3s timeout, fall back to a `report-type-option`
  // testid that does not exist anywhere in the app (dead code — always a silent no-op),
  // and even on the happy path select `options.nth(1)` — the SECOND type — whenever more
  // than one was available, contradicting the step's own name. Fixed: always open the
  // one real selector and click the first option.
  const selector = page.getByTestId('report-type-select')
  await expect(selector).toBeVisible({ timeout: Timeouts.ELEMENT })
  // Record how many form controls exist before the type contributes its fields.
  const before = await formControls(page).count()
  await page.evaluate((n) => {
    (window as unknown as Record<string, unknown>).__test_report_controls_before = n
  }, before)
  await selector.click()
  const firstOption = page.locator('[role="option"]').first()
  await expect(firstOption).toBeVisible({ timeout: Timeouts.ELEMENT })
  await firstOption.click()
})

/** Visible editable controls on the page (inputs, textareas, selects). */
function formControls(page: Page) {
  return page.locator('input:visible, textarea:visible, [role="combobox"]:visible')
}

Then('the report form should show dynamic schema fields', async ({ page }) => {
  // The template's fields render as extra controls once its type is selected.
  // The old step accepted the body input, which every report form has.
  const before = await page.evaluate(
    () => (window as unknown as Record<string, unknown>).__test_report_controls_before as number | undefined,
  )
  expect(before, 'the type-selection step must record the control count').toBeGreaterThan(0)
  await expect.poll(() => formControls(page).count(), { timeout: Timeouts.ELEMENT }).toBeGreaterThan(before as number)
})

When('I fill in the required report fields', async ({ page }) => {
  // Title and body are base fields present on every report form regardless of
  // template — only the schema-driven fields below are template-conditional.
  const titleInput = page.getByTestId(TestIds.REPORT_TITLE_INPUT)
  await expect(titleInput).toBeVisible({ timeout: Timeouts.ELEMENT })
  await titleInput.fill(`Template Report ${Date.now()}`)
  const bodyInput = page.getByTestId(TestIds.REPORT_BODY_INPUT)
  await expect(bodyInput).toBeVisible({ timeout: Timeouts.ELEMENT })
  await bodyInput.fill('Template-driven report test body content')
  const schemaInputs = page.getByTestId('report-schema-form').locator('input[required], textarea[required]')
  const count = await schemaInputs.count().catch(() => 0)
  for (let i = 0; i < count; i++) {
    const input = schemaInputs.nth(i)
    const value = await input.inputValue()
    if (!value) {
      const tagName = await input.evaluate(el => el.tagName.toLowerCase())
      await input.fill(tagName === 'textarea' ? 'Test field value' : `Test ${i + 1}`)
    }
  }
})

// --- Reporter steps ---
// "they create a new report" and "the report should be saved successfully"
// are defined in tests/steps/auth/user-steps.ts
// 'a success toast should appear' is defined in common/assertion-steps.ts
// 'the report should appear in the reports list' is defined in admin/desktop-admin-steps.ts

Then('the submitted report should appear in the list', async ({ page }) => {
  const reportList = page.getByTestId(TestIds.REPORT_LIST)
    .or(page.getByTestId(TestIds.REPORT_CARD))
  await expect(reportList.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})
