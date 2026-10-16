/**
 * Common navigation step definitions shared across features.
 * Uses page objects from tests/pages/index.ts and test IDs for robust selectors.
 */
import { expect } from '@playwright/test'
import { Given, When, Then } from '../fixtures'
import { Navigation } from '../../pages/index'
import { TestIds, navTestIdMap } from '../../test-ids'
import { Timeouts, navigateAfterLogin } from '../../helpers'
import { collapseSettingsSection, ensureAuthenticated, expectRoute } from './ui-helpers'

// --- Parameterised navigation (covers most "navigate to X page" steps) ---

Given('I navigate to the {string} page', async ({ page }, pageName: string) => {
  const navMap: Record<string, (p: typeof page) => Promise<void>> = {
    Dashboard: (p) => Navigation.goToDashboard(p),
    Volunteers: (p) => Navigation.goToVolunteers(p),
    Shifts: (p) => Navigation.goToShifts(p),
    'Ban List': (p) => Navigation.goToBanList(p),
    Notes: (p) => Navigation.goToNotes(p),
    'Call History': (p) => Navigation.goToCallHistory(p),
    Calls: (p) => Navigation.goToCallHistory(p),
    'Audit Log': (p) => Navigation.goToAuditLog(p),
    Settings: (p) => Navigation.goToSettings(p),
    'Hub Settings': (p) => Navigation.goToHubSettings(p),
    Reports: (p) => Navigation.goToReports(p),
    Conversations: (p) => Navigation.goToConversations(p),
    Blasts: (p) => Navigation.goToBlasts(p),
    Contacts: (p) => Navigation.goToContacts(p),
    // CMS pages
    Cases: (p) => navigateAfterLogin(p, '/cases'),
    'Contact Directory': (p) => navigateAfterLogin(p, '/contacts-directory'),
    Events: (p) => navigateAfterLogin(p, '/events'),
    'Case Management': (p) => navigateAfterLogin(p, '/admin/case-management'),
    'Case Management Settings': (p) => navigateAfterLogin(p, '/admin/case-management'),
    Hubs: (p) => navigateAfterLogin(p, '/admin/hubs'),
  }
  const navFn = navMap[pageName]
  if (navFn) {
    await navFn(page)
  } else {
    // Fallback: try test ID map, then text click
    const testId = navTestIdMap[pageName]
    if (testId) {
      await page.getByTestId(testId).click()
    } else {
      await page.getByTestId(TestIds.NAV_SIDEBAR).getByText(pageName, { exact: true }).click()
    }
  }
})

When('I navigate to {string}', async ({ page }, path: string) => {
  // Public routes (onboarding, login, link-device, setup) don't need authentication
  const publicPaths = ['/onboarding', '/login', '/link-device', '/setup']
  const isPublic = publicPaths.some(p => path.startsWith(p))
  if (isPublic) {
    await page.goto(path)
    await page.waitForLoadState('domcontentloaded')
  } else {
    await navigateAfterLogin(page, path)
  }
})

// --- Given navigation steps ---

Given('I am authenticated and on the note creation screen', async ({ page }) => {
  const { loginAsAdmin } = await import('../../helpers')
  await loginAsAdmin(page)
  await Navigation.goToNotes(page)
  await page.getByTestId(TestIds.NOTE_NEW_BTN).click()
  await expect(page.getByTestId(TestIds.NOTE_FORM)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Given('I am authenticated and on the conversations screen', async ({ page }) => {
  const { loginAsAdmin } = await import('../../helpers')
  await loginAsAdmin(page)
  await Navigation.goToConversations(page)
})

Given('I am authenticated and on the shifts screen', async ({ page }) => {
  const { loginAsAdmin } = await import('../../helpers')
  await loginAsAdmin(page)
  await Navigation.goToShifts(page)
})

Given('I am on the settings screen', async ({ page }) => {
  await ensureAuthenticated(page)
  await Navigation.goToSettings(page)
})

Given('I am on the dashboard', async ({ page }) => {
  await ensureAuthenticated(page)
  await expect(page.getByTestId(TestIds.PAGE_TITLE)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Given('I navigate to the device link screen from settings', async ({ page }) => {
  await Navigation.goToSettings(page)
  const linkedDevicesSection = page.getByTestId('linked-devices')
  await linkedDevicesSection.scrollIntoViewIfNeeded()
  // SettingsSection uses CollapsibleTrigger asChild on CardHeader — click the trigger to expand
  const isExpanded = await linkedDevicesSection.locator('[data-slot="collapsible-content"][data-state="open"]').count() > 0
  if (!isExpanded) {
    await linkedDevicesSection.getByTestId('linked-devices-trigger').click()
  }
})

Given('I have navigated to the admin panel', async ({ page }) => {
  await Navigation.goToVolunteers(page)
})

// --- When navigation steps ---

When('I tap the {string} tab', async ({ page }, tabName: string) => {
  // The tab must exist. The old version fell back to page.goto() when the nav
  // link was not visible, so a scenario about tapping a hidden tab still passed.
  const testId = navTestIdMap[tabName]
  const navLink = testId
    ? page.getByTestId(testId)
    : page.getByTestId(TestIds.NAV_SIDEBAR).getByText(tabName, { exact: true })
  await expect(navLink).toBeVisible({ timeout: Timeouts.ELEMENT })
  await navLink.click()
})

When('I navigate to the admin panel', async ({ page }) => {
  await Navigation.goToVolunteers(page)
})

When('I scroll to and tap the admin card', async ({ page }) => {
  await Navigation.goToVolunteers(page)
})

When('I tap the back button', async ({ page }) => {
  // Let the current view settle before deciding what "back" means on it.
  await expect(page.getByTestId(TestIds.PAGE_TITLE)).toBeVisible({ timeout: Timeouts.ELEMENT })

  // A route with its own back control (contact detail, volunteer profile).
  const backBtn = page.getByTestId(TestIds.BACK_BTN)
  if (await backBtn.count() > 0) {
    await backBtn.click()
    return
  }
  // An open inline form (note, shift): its cancel button is the way back.
  const cancelBtn = page.getByTestId(TestIds.FORM_CANCEL_BTN)
  if (await cancelBtn.count() > 0) {
    await cancelBtn.click()
    return
  }
  // Desktop settings sections are inline: "back" from the device-link section
  // collapses it, and the page stays on /settings.
  if (new URL(page.url()).pathname === '/settings') {
    await collapseSettingsSection(page, 'linked-devices')
    return
  }
  // Anything else: the window's history back.
  await page.goBack()
})

When('I visit the app root', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
})

When('I visit {string} without authentication', async ({ page }, path: string) => {
  await page.goto('/login')
  await page.waitForLoadState('domcontentloaded')
  await page.evaluate(() => {
    localStorage.clear()
    sessionStorage.clear()
  })
  await page.goto(path)
  await page.waitForLoadState('domcontentloaded')
})

When('I visit the login page', async ({ page }) => {
  await page.goto('/login')
  await page.waitForLoadState('domcontentloaded')
})

When('I check the API health endpoint', async ({ page }) => {
  const response = await page.request.get('/api/health')
  await page.evaluate((status) => {
    (window as unknown as Record<string, unknown>).__test_api_status = status
  }, response.status())
})

When('I check the API config endpoint', async ({ page }) => {
  const response = await page.request.get('/api/config')
  const body = await response.text()
  await page.evaluate((b) => {
    (window as unknown as Record<string, unknown>).__test_api_config = b
  }, body)
})

// --- Then navigation/page assertion steps ---

Then('the page title should contain {string}', async ({ page }, text: string) => {
  const title = await page.title()
  expect(title.toLowerCase()).toContain(text.toLowerCase())
})

Then('the app has a non-empty page title', async ({ page }) => {
  // The page title comes from index.html default ("Hotline") or the configured
  // HOTLINE_NAME (e.g. "Llámenos" in CI). Accept any non-empty title.
  const title = await page.title()
  expect(title.trim().length).toBeGreaterThan(0)
})

Then('I should be redirected to the login page', async ({ page }) => {
  await page.waitForURL(/\/login/, { timeout: Timeouts.NAVIGATION })
})

Then('I should see the nsec input', async ({ page }) => {
  await expect(page.getByTestId(TestIds.DEVICE_KEY_INPUT)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should see a validation error', async ({ page }) => {
  const errorEl = page.getByTestId(TestIds.ERROR_MESSAGE)
    .or(page.locator('[role="alert"]'))
  await expect(errorEl.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the response should be successful', async ({ page }) => {
  const status = await page.evaluate(() => (window as unknown as Record<string, unknown>).__test_api_status)
  expect(status).toBe(200)
})

Then('the response should contain {string}', async ({ page }, text: string) => {
  const body = await page.evaluate(() => (window as unknown as Record<string, unknown>).__test_api_config) as string
  expect(body).toContain(text)
})

Then('I should see the dashboard', async ({ page }) => {
  await expectRoute(page, '/')
})

Then('I should see the notes screen', async ({ page }) => {
  await expectRoute(page, '/notes')
})

Then('I should see the shifts screen', async ({ page }) => {
  await expectRoute(page, '/shifts')
})

Then('I should see the conversations screen', async ({ page }) => {
  await expectRoute(page, '/conversations')
})

Then('I should see the settings screen', async ({ page }) => {
  await expectRoute(page, '/settings')
})

Then('I should return to the settings screen', async ({ page }) => {
  await expectRoute(page, '/settings')
})

Then('I should return to the notes list', async ({ page }) => {
  await expectRoute(page, '/notes')
  await expect(page.getByTestId(TestIds.NOTE_FORM)).toHaveCount(0)
})

Then('I should return to the login screen', async ({ page }) => {
  await page.waitForURL(/\/login/, { timeout: Timeouts.NAVIGATION })
})

Then('the bottom navigation should be visible', async ({ page }) => {
  await expect(page.getByTestId(TestIds.NAV_SIDEBAR)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the bottom navigation should not be visible', async ({ page }) => {
  await expect(page.getByTestId(TestIds.NAV_SIDEBAR)).not.toBeVisible()
})
