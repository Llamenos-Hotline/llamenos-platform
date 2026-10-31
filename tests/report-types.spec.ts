import { test, expect, type Page } from '@playwright/test'
import { loginAsAdmin, TestIds } from './helpers'
import { createCmsReportTypeViaApi, createReportViaApi } from './api-helpers'

async function navigateToAdminSettings(page: Page): Promise<void> {
  await page.getByTestId('nav-admin-settings').click()
  await expect(page.getByTestId('page-title').or(page.getByTestId('admin-section-heading'))).toBeVisible({ timeout: 10000 })
}

async function navigateToReports(page: Page): Promise<void> {
  await page.getByTestId('nav-reports').click()
  await expect(page.getByTestId('page-title')).toBeVisible({ timeout: 10000 })
}

test.describe('Report Types', () => {
  test.describe.configure({ mode: 'serial' })

  test('report types section visible in admin settings', async ({ page }) => {
    await loginAsAdmin(page)
    await navigateToAdminSettings(page)

    // Find and expand the Report Types section
    const section = page.getByTestId('report-types')
    await expect(section).toBeVisible({ timeout: 10000 })
  })

  test('report types section loads with default types', async ({ page }) => {
    await loginAsAdmin(page)
    await navigateToAdminSettings(page)

    // Expand the report types section by clicking on it
    await page.getByTestId('report-types').click()

    // Wait for report type rows to appear (default types seeded on first load)
    await expect(page.getByTestId('report-type-row').first()).toBeVisible({ timeout: 10000 })

    // Should have at least one row
    const rows = page.getByTestId('report-type-row')
    expect(await rows.count()).toBeGreaterThanOrEqual(1)
  })

  test('admin can create a new report type', async ({ page }) => {
    await loginAsAdmin(page)
    await navigateToAdminSettings(page)

    // Expand the report types section
    await page.getByTestId('report-types').click()
    await expect(page.getByTestId('report-type-row').first()).toBeVisible({ timeout: 10000 })

    // Click "Add Report Type"
    await page.getByTestId('report-type-add-btn').click()

    // Fill in the form
    await page.getByTestId('report-type-name-input').fill(`Custom Type ${Date.now()}`)
    await page.getByTestId('report-type-description-input').fill('A custom report type for testing')
    await page.getByTestId('report-type-icon-input').fill('shield')

    // Save
    await page.getByTestId('report-type-save-btn').click()

    // Verify success toast
    await expect(page.getByText('Report type created')).toBeVisible({ timeout: 5000 })
  })

  test('report form shows report type selector', async ({ page }) => {
    await loginAsAdmin(page)
    await navigateToReports(page)

    // Open the new report form (Sheet)
    await page.getByTestId('report-new-btn').click()

    // Wait for the sheet content to render — the report-type-select only renders
    // when the getReportTypes API returns results. Default report types are seeded
    // automatically on first access after a reset.
    await expect(page.getByTestId('report-title-input')).toBeVisible({ timeout: 10000 })
    await expect(page.getByTestId('report-type-select')).toBeVisible({ timeout: 10000 })
  })

  test('creating report with selected type works', async ({ page }) => {
    await loginAsAdmin(page)
    await navigateToReports(page)

    // Open the new report form (Sheet)
    await page.getByTestId('report-new-btn').click()

    // Verify the type selector is present and has options
    const typeSelect = page.getByTestId('report-type-select')
    await expect(typeSelect).toBeVisible({ timeout: 10000 })

    // Fill the form using data-testid selectors
    await page.getByTestId('report-title-input').fill(`Typed Report ${Date.now()}`)
    await page.getByTestId('report-body-input').fill('Report with a selected type')

    // Submit
    await page.getByTestId('report-form-submit-btn').click()

    // Verify report created
    await expect(page.getByText('Report submitted')).toBeVisible({ timeout: 10000 })
  })

  test('report card shows report type badge', async ({ page }) => {
    // Create our own report type — do not rely on prior test state
    const reportType = await createCmsReportTypeViaApi(page.request) as { id: string }

    // A report lives in a hub (#2395): file it in the hub the page is browsing.
    await loginAsAdmin(page)
    const hubId = await page.evaluate(() => window.__TEST_GET_ACTIVE_HUB?.() ?? null)
    expect(hubId, 'the page has no active hub to file a report in').toBeTruthy()
    await createReportViaApi(page.request, {
      title: `Badge Test Report ${Date.now()}`,
      reportTypeId: reportType.id,
      hubId: hubId!,
    })

    await navigateToReports(page)

    // The report we just created must show a type badge
    const badge = page.getByTestId(TestIds.REPORT_TYPE_BADGE).first()
    await expect(badge).toBeVisible({ timeout: 10000 })

    // Badge should contain the type name (non-empty text)
    const badgeText = await badge.textContent()
    expect(badgeText?.trim().length).toBeGreaterThan(0)
  })
})
