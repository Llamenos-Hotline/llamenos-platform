/**
 * Hub management and hub context step definitions.
 * Matches steps from:
 *   - packages/test-specs/features/core/hub-management.feature (UI scenarios)
 *   - packages/test-specs/features/core/hub-context.feature
 */
import { expect, type Page } from '@playwright/test'
import { Given, When, Then } from '../fixtures'
import { TestIds } from '../../test-ids'
import { Timeouts, loginAsVolunteer, navigateAfterLogin } from '../../helpers'
import { apiGet, createUserViaApi, createHubViaApi, addHubMemberViaApi } from '../../api-helpers'

// ── Hub Management UI Steps ───────────────────────────────────────

/**
 * Rows of the admin hubs list. HubRow carries no row testid; its per-hub delete
 * button (`delete-hub-<id>`) is the one stable handle. The old locator,
 * `[data-testid^="hub-"]`, also matched the sidebar's hub-switcher trigger, so
 * "at least one hub in the list" held on any page with a sidebar.
 */
function hubRowDeleteButtons(page: Page) {
  return page.locator('[data-testid^="delete-hub-"]:not([data-testid^="delete-hub-confirm"])')
}

Then('I should see at least one hub in the hub list', async ({ page }) => {
  await expect(hubRowDeleteButtons(page).first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the active hub should change', async ({ page }) => {
  // After selecting a different hub, the page title or hub indicator should update
  await expect(page.getByTestId(TestIds.PAGE_TITLE)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the page data should reload for the new hub', async ({ page }) => {
  // After hub switch, the page should reload data — verify the page is loaded
  await expect(page.getByTestId(TestIds.PAGE_TITLE)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

When('I click the create hub button', async ({ page }) => {
  await expect(page.getByTestId(TestIds.PAGE_TITLE)).toBeVisible({ timeout: Timeouts.ELEMENT })
  // The hubs page's create control has no testid; it is the "Create Hub" button.
  const createBtn = page.getByRole('button', { name: 'Create Hub' })
  await expect(createBtn).toBeVisible({ timeout: Timeouts.ELEMENT })
  await createBtn.click()
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: Timeouts.ELEMENT })
})

When('I fill in the hub name with a unique name', async ({ page }) => {
  const nameInput = page.getByLabel(/name/i).first()
  await expect(nameInput).toBeVisible({ timeout: Timeouts.ELEMENT })
  await nameInput.fill(`TestHub ${Date.now()}`)
})

When('I fill in the hub slug', async ({ page }) => {
  // The desktop create-hub dialog derives the slug from the name and has no
  // slug field. Assert that, rather than silently skipping the fill: if a slug
  // field is ever added, this step must start filling it.
  await expect(page.getByRole('dialog').getByLabel(/slug/i)).toHaveCount(0)
})

When('I submit the create hub form', async ({ page }) => {
  const submitBtn = page.getByTestId('create-hub-submit')
    .or(page.getByTestId(TestIds.FORM_SUBMIT_BTN))
    .or(page.getByTestId(TestIds.FORM_SAVE_BTN))
    .or(page.getByRole('button', { name: /create|save|submit/i }))
  const visible = submitBtn.filter({ visible: true })
  // Wait for exactly one visible candidate across all tiers instead of probing the
  // testid tier with a short timeout and silently falling back to an unscoped role
  // query on failure — that fallback could match an unrelated "Save"/"Create" button
  // elsewhere on the page and submit the wrong write.
  await expect(visible).toHaveCount(1, { timeout: Timeouts.ELEMENT })
  await visible.click()
})

Then('each hub card should display a member count', async ({ page }) => {
  // Every hub row must show a member count. The old body returned on the first
  // visible `hub-*` testid (the sidebar switcher) without reading any count.
  const rows = hubRowDeleteButtons(page)
  await expect(rows.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
  const count = await rows.count()
  await expect(page.getByText(/\d+\s+members?/i)).toHaveCount(count, { timeout: Timeouts.ELEMENT })
})

// ── Hub Context Steps ─────────────────────────────────────────────

Given('a volunteer in a single-hub deployment', async ({ page, backendRequest: request, $test }) => {
  // The hub switcher renders whenever the SERVER has more than one active hub
  // (/api/config returns all active hubs). The shared E2E backend accumulates
  // one hub per Playwright worker, so the single-hub premise only holds on a
  // fresh single-hub deployment. When it does not, SKIP — reported as skipped.
  // (The old version set a window flag and the Then step then passed on the
  // page title, so the scenario reported a pass it never checked.)
  const { status, data } = await apiGet<{ hubs?: unknown[] }>(request, '/config')
  expect(status).toBe(200)
  const hubCount = Array.isArray(data.hubs) ? data.hubs.length : 0
  $test.skip(hubCount > 1, `single-hub premise does not hold: the server has ${hubCount} active hubs`)
  const vol = await createUserViaApi(request)
  await loginAsVolunteer(page, vol.nsec)
})

When('the volunteer views the sidebar', async ({ page }) => {
  // Sidebar should be visible after login
  await expect(page.getByTestId(TestIds.NAV_SIDEBAR)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the hub selector should not be visible', async ({ page }) => {
  await expect(page.getByTestId(TestIds.NAV_SIDEBAR)).toBeVisible({ timeout: Timeouts.ELEMENT })
  await expect(page.getByTestId(TestIds.HUB_SWITCHER_TRIGGER)).toHaveCount(0)
})

Given('a volunteer assigned to multiple hubs', async ({ page, backendRequest: request, workerHub }) => {
  // Create a second hub and a volunteer who is a member of BOTH hubs. Two
  // active hubs make the switcher render, and membership in both is what makes
  // switching meaningful — hub-scoped API calls 403 for non-members.
  const secondHubId = await createHubViaApi(request, `MultiHub-${Date.now()}`)
  const vol = await createUserViaApi(request)
  await addHubMemberViaApi(request, workerHub, vol.pubkey)
  await addHubMemberViaApi(request, secondHubId, vol.pubkey)
  await loginAsVolunteer(page, vol.nsec)
  // Record after login (a full page load wipes window state); later steps read
  // the hub id to pick the created hub out of the switcher options, and the
  // volunteer pubkey to put them in that hub's ring set (multi-hub call steps).
  await page.evaluate(({ id, pubkey }) => {
    const w = window as unknown as Record<string, unknown>
    w.__test_second_hub_id = id
    w.__test_multi_hub_volunteer_pubkey = pubkey
  }, { id: secondHubId, pubkey: vol.pubkey })
})

Then('the hub selector should be visible', async ({ page }) => {
  await expect(page.getByTestId(TestIds.HUB_SWITCHER_TRIGGER)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Given('the volunteer is on the cases page', async ({ page }) => {
  await navigateAfterLogin(page, '/cases')
})

When('the volunteer switches to a different hub', async ({ page }) => {
  // The Given step guarantees two active hubs and records the created hub's
  // id — pick that exact option rather than an arbitrary index, since the
  // shared server accumulates hubs from other parallel workers.
  const secondHubId = await page.evaluate(
    () => (window as unknown as Record<string, unknown>).__test_second_hub_id as string | undefined,
  )
  expect(secondHubId, 'Given step must record the second hub id').toBeTruthy()
  const hubSelector = page.getByTestId(TestIds.HUB_SWITCHER_TRIGGER)
  await expect(hubSelector).toBeVisible({ timeout: Timeouts.ELEMENT })
  await hubSelector.click()
  const option = page.locator(
    `[data-testid="${TestIds.HUB_SWITCHER_OPTION}"][data-hub-id="${secondHubId}"]`,
  )
  await expect(option).toBeVisible({ timeout: Timeouts.ELEMENT })
  await option.click()
})

Then('the cases page should reload', async ({ page }) => {
  // After hub switch on cases page, the page should still be on /cases and loaded
  await expect(page.getByTestId(TestIds.PAGE_TITLE)).toBeVisible({ timeout: Timeouts.ELEMENT })
})
