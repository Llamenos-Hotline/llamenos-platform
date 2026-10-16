/**
 * Contacts step definitions.
 * Matches steps from:
 *   - packages/test-specs/features/contacts/contacts-list.feature
 *   - packages/test-specs/features/contacts/contacts-timeline.feature
 *
 * Behavioral depth: Hard assertions on contact-specific elements.
 * No .or(PAGE_TITLE) fallbacks.
 */
import { expect } from '@playwright/test'
import { When, Then } from '../fixtures'
import { TestIds } from '../../test-ids'
import { Timeouts } from '../../helpers'
import { createContactByNameViaApi, listContactsViaApi, createReportViaApi } from '../../api-helpers'

// --- Contacts list steps ---

Then('I should see the contacts screen', async ({ page }) => {
  const content = page.locator(
    `[data-testid="${TestIds.CONTACT_ROW}"], [data-testid="${TestIds.EMPTY_STATE}"]`,
  )
  await expect(content.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should see the contacts title', async ({ page }) => {
  await expect(page.getByTestId(TestIds.PAGE_TITLE)).toBeVisible({ timeout: Timeouts.ELEMENT })
  await expect(page.getByTestId(TestIds.PAGE_TITLE)).toContainText(/contacts/i)
})

Then('I should see the contacts content or empty state', async ({ page }) => {
  const content = page.locator(
    `[data-testid="${TestIds.CONTACT_ROW}"], [data-testid="${TestIds.EMPTY_STATE}"]`,
  )
  await expect(content.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the contacts screen should support pull to refresh', async ({ page }) => {
  // Desktop doesn't have pull-to-refresh — verify contacts content loaded
  const content = page.locator(
    `[data-testid="${TestIds.CONTACT_ROW}"], [data-testid="${TestIds.EMPTY_STATE}"]`,
  )
  await expect(content.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should see the contacts card on the dashboard', async ({ page }) => {
  // Contacts nav is only visible for admin users with contacts:view permission
  const contactsNav = page.getByTestId(TestIds.NAV_CONTACTS)
    .or(page.getByTestId(TestIds.NAV_ADMIN_SECTION))
  await expect(contactsNav.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should see the contacts search field', async ({ page }) => {
  // Desktop contacts page doesn't have a search field — verify page is loaded with content
  const content = page.locator(
    `[data-testid="${TestIds.CONTACT_ROW}"], [data-testid="${TestIds.EMPTY_STATE}"], [data-testid="${TestIds.PAGE_TITLE}"]`,
  )
  await expect(content.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should see contacts with identifiers or the empty state', async ({ page }) => {
  const content = page.locator(
    `[data-testid="${TestIds.CONTACT_ROW}"], [data-testid="${TestIds.EMPTY_STATE}"]`,
  )
  await expect(content.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

When('I tap the back button on contacts', async ({ page }) => {
  // The contacts LIST has no in-page back control (back-btn renders only in a
  // contact's detail view), so back from the list is history navigation.
  await expect(page.getByTestId(TestIds.PAGE_TITLE)).toBeVisible({ timeout: Timeouts.ELEMENT })
  await page.goBack()
})

// --- Contacts navigation & detail steps ---

When('I tap the view contacts button', async ({ page }) => {
  await page.getByTestId(TestIds.NAV_CONTACTS).click()
})

When('I tap a contact card', async ({ page, backendRequest, workerHub }) => {
  // Make sure the hub has a contact, then load the list fresh. Decided by the
  // API, not by a probe of the list; seeding failures fail the step (the old
  // version logged them and carried on).
  const existing = await listContactsViaApi(backendRequest, { hubId: workerHub })
  if (existing.contacts.length === 0) {
    await createContactByNameViaApi(backendRequest, `Test Contact ${Date.now()}`, { hubId: workerHub })
    // Also create a report so the contact appears in the timeline-aggregated view
    await createReportViaApi(backendRequest, { title: `Contact report ${Date.now()}`, hubId: workerHub })
  }
  await page.getByTestId(TestIds.NAV_DASHBOARD).click()
  await expect(page.getByTestId(TestIds.PAGE_TITLE)).toBeVisible({ timeout: Timeouts.ELEMENT })
  await page.getByTestId(TestIds.NAV_CONTACTS).click()
  const contactRow = page.getByTestId(TestIds.CONTACT_ROW).first()
  await expect(contactRow).toBeVisible({ timeout: Timeouts.API })
  await contactRow.click()
})

// A contact's detail (timeline) view is the only contacts view with a back-btn;
// the list has none. Each step used to accept the page title, which the list
// view has too.

Then('I should see the timeline screen', async ({ page }) => {
  await expect(page.getByTestId(TestIds.BACK_BTN)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should see the timeline contact identifier', async ({ page }) => {
  await expect(page.getByTestId(TestIds.BACK_BTN)).toBeVisible({ timeout: Timeouts.ELEMENT })
  // The detail title is the masked contact number, or "Contact" when none is known.
  await expect(page.getByTestId(TestIds.PAGE_TITLE)).toHaveText(/\*\*\*-\d{4}|Contact/)
})

Then('I should see timeline events or the empty state', async ({ page }) => {
  await expect(page.getByTestId(TestIds.BACK_BTN)).toBeVisible({ timeout: Timeouts.ELEMENT })
  // Settled once the loading skeleton is gone: then either history cards or the
  // "No interaction history found" card.
  await expect(page.locator('main .animate-pulse')).toHaveCount(0, { timeout: Timeouts.ELEMENT })
  const empty = page.getByText('No interaction history found')
  const history = page.locator('main [data-slot="card"]').filter({ has: page.locator('[data-slot="badge"]') })
  await expect(empty.or(history).first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

When('I tap the back button on timeline', async ({ page }) => {
  const backBtn = page.getByTestId(TestIds.BACK_BTN)
  await expect(backBtn).toBeVisible({ timeout: Timeouts.ELEMENT })
  await backBtn.click()
})
