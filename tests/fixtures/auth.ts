/**
 * Per-role Playwright auth fixtures — Playwright's standard session-reuse
 * pattern (see https://playwright.dev/docs/auth): a real login happens exactly
 * once per role, in the "bootstrap" project (tests/bootstrap.spec.ts), which
 * saves storageState (encrypted device key in localStorage) to
 * tests/storage/<role>.json. Every test that just needs to *be* logged in as
 * that role consumes the cache here instead of re-driving the full login UI.
 *
 * This does NOT skip PIN entry: the app is zero-knowledge (device private keys
 * are decrypted in memory only, via Rust/mock CryptoState, and that memory does
 * not survive a fresh page — see docs/KNOWN_FLAKES.md#login-pin-race for the
 * full explanation of why). What it DOES skip is the expensive PBKDF2 (600K
 * iteration) cold-import that a from-scratch login requires — restoring the
 * already-derived encrypted key from cache and unlocking it with the cached PIN
 * is materially faster and removes a whole slow/racy code path. Each fixture
 * still creates a FRESH browser context per test — full test isolation.
 *
 * Usage:
 *   import { test, expect } from '../fixtures/auth'
 *   test('admin does something', async ({ adminPage }) => { ... })
 *   test('volunteer sees limited nav', async ({ volunteerPage }) => { ... })
 */

import { type BrowserContext, type Page } from '@playwright/test'
import { test as base, settleConsoleWatch, watchConsole, type ConsoleWatch } from '../console-guard'
import { enterPin, TEST_PIN, Timeouts, completeProfileSetup } from '../helpers'
import { TestIds } from '../test-ids'

const STORAGE_DIR = 'tests/storage'

/** Storage state file paths for each role */
export const STORAGE_PATHS = {
  admin: `${STORAGE_DIR}/admin.json`,
  'hub-admin': `${STORAGE_DIR}/hub-admin.json`,
  volunteer: `${STORAGE_DIR}/volunteer.json`,
  reviewer: `${STORAGE_DIR}/reviewer.json`,
  reporter: `${STORAGE_DIR}/reporter.json`,
} as const

export type RoleName = keyof typeof STORAGE_PATHS

/**
 * Create an authenticated page for a role.
 * Loads cached storageState → navigates to / → enters PIN → waits for dashboard.
 * Each call creates a NEW browser context — full test isolation.
 */
async function createAuthenticatedPage(
  browser: import('@playwright/test').Browser,
  role: RoleName
): Promise<{ context: BrowserContext; page: Page; watch: ConsoleWatch }> {
  const context = await browser.newContext({
    storageState: STORAGE_PATHS[role],
  })
  // Watched from the first request: a context made here is not the default
  // `context` fixture, so the guard in console-guard.ts would not see it.
  const watch = watchConsole(context)
  const page = await context.newPage()

  await page.goto('/', { waitUntil: 'domcontentloaded' })

  const pinInput = page.getByTestId(TestIds.PIN_INPUT).locator('input')
  const pageTitle = page.getByTestId(TestIds.PAGE_TITLE)
  const profileSetupBtn = page.getByRole('button', { name: /complete setup/i })
  const sidebar = page.getByTestId(TestIds.NAV_SIDEBAR)

  // The cached localStorage always contains an *encrypted* key, so the app
  // always needs a PIN to decrypt it into memory — there is no code path where
  // it lands straight on the dashboard without one. Race pin/dashboard/profile
  // anyway rather than assuming 'pin', so a genuine app regression (e.g. the
  // cached key being rejected outright) surfaces as a clear state name instead
  // of a raw locator timeout.
  const firstState = await Promise.race([
    pinInput.waitFor({ state: 'visible', timeout: 45000 }).then(() => 'pin' as const),
    pageTitle.waitFor({ state: 'visible', timeout: 45000 }).then(() => 'dashboard' as const),
    profileSetupBtn.waitFor({ state: 'visible', timeout: 45000 }).then(() => 'profile' as const),
    sidebar.waitFor({ state: 'visible', timeout: 45000 }).then(() => 'dashboard' as const),
  ])

  if (firstState === 'pin') {
    await enterPin(page, TEST_PIN)
    const afterPin = await Promise.race([
      pageTitle.waitFor({ state: 'visible', timeout: Timeouts.AUTH }).then(() => 'dashboard' as const),
      profileSetupBtn.waitFor({ state: 'visible', timeout: Timeouts.AUTH }).then(() => 'profile' as const),
    ])
    if (afterPin === 'profile') {
      await completeProfileSetup(page)
    }
  } else if (firstState === 'profile') {
    await completeProfileSetup(page)
  }

  // Wait for the sidebar to confirm full auth is complete
  await sidebar.waitFor({ state: 'visible', timeout: Timeouts.AUTH })

  return { context, page, watch }
}

/**
 * Extended Playwright test with per-role authenticated page fixtures.
 * Each fixture creates a FRESH browser context per test — full isolation.
 */
export const test = base.extend<{
  adminPage: Page
  adminContext: BrowserContext
  hubAdminPage: Page
  hubAdminContext: BrowserContext
  volunteerPage: Page
  volunteerContext: BrowserContext
  reviewerPage: Page
  reviewerContext: BrowserContext
  reporterPage: Page
  reporterContext: BrowserContext
}>({
  adminPage: async ({ browser }, use) => {
    const { context, page, watch } = await createAuthenticatedPage(browser, 'admin')
    try {
      await use(page)
      await settleConsoleWatch(watch)
    } finally {
      await context.close()
    }
  },
  adminContext: async ({ browser }, use) => {
    const { context, watch } = await createAuthenticatedPage(browser, 'admin')
    try {
      await use(context)
      await settleConsoleWatch(watch)
    } finally {
      await context.close()
    }
  },
  hubAdminPage: async ({ browser }, use) => {
    const { context, page, watch } = await createAuthenticatedPage(browser, 'hub-admin')
    try {
      await use(page)
      await settleConsoleWatch(watch)
    } finally {
      await context.close()
    }
  },
  hubAdminContext: async ({ browser }, use) => {
    const { context, watch } = await createAuthenticatedPage(browser, 'hub-admin')
    try {
      await use(context)
      await settleConsoleWatch(watch)
    } finally {
      await context.close()
    }
  },
  volunteerPage: async ({ browser }, use) => {
    const { context, page, watch } = await createAuthenticatedPage(browser, 'volunteer')
    try {
      await use(page)
      await settleConsoleWatch(watch)
    } finally {
      await context.close()
    }
  },
  volunteerContext: async ({ browser }, use) => {
    const { context, watch } = await createAuthenticatedPage(browser, 'volunteer')
    try {
      await use(context)
      await settleConsoleWatch(watch)
    } finally {
      await context.close()
    }
  },
  reviewerPage: async ({ browser }, use) => {
    const { context, page, watch } = await createAuthenticatedPage(browser, 'reviewer')
    try {
      await use(page)
      await settleConsoleWatch(watch)
    } finally {
      await context.close()
    }
  },
  reviewerContext: async ({ browser }, use) => {
    const { context, watch } = await createAuthenticatedPage(browser, 'reviewer')
    try {
      await use(context)
      await settleConsoleWatch(watch)
    } finally {
      await context.close()
    }
  },
  reporterPage: async ({ browser }, use) => {
    const { context, page, watch } = await createAuthenticatedPage(browser, 'reporter')
    try {
      await use(page)
      await settleConsoleWatch(watch)
    } finally {
      await context.close()
    }
  },
  reporterContext: async ({ browser }, use) => {
    const { context, watch } = await createAuthenticatedPage(browser, 'reporter')
    try {
      await use(context)
      await settleConsoleWatch(watch)
    } finally {
      await context.close()
    }
  },
})

export { expect, type Page, type BrowserContext } from '@playwright/test'
