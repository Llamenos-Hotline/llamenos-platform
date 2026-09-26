import { type Page, type APIRequestContext, expect } from '@playwright/test'
import { TestIds } from './test-ids'

export const ADMIN_SEED = 'f54a5851e9372b87810a8e60cdd2e7cfd80b6e31c7af18188f7db106ceda8be7'
/** @deprecated Use ADMIN_SEED */
export const ADMIN_NSEC = ADMIN_SEED
export const TEST_PIN = '12345678'

/**
 * Default timeout values for common operations.
 * Centralized here for easy tuning during test optimization.
 */
export const Timeouts = {
  /** Time to wait for page navigation */
  NAVIGATION: 10000,
  /** Time to wait for API responses */
  API: 15000,
  /** Time to wait for elements to appear */
  ELEMENT: 10000,
  /** Time to wait for auth-related operations (includes PBKDF2 600K iterations).
   *  CI containers have limited CPU which makes PBKDF2 significantly slower. */
  AUTH: 55000,
  /** Time to wait for message content that depends on client-side HPKE/AES-GCM
   *  decryption completing and a subsequent React re-render (e.g. an outbound
   *  message's plaintext appearing in ConversationThread after a fresh fetch).
   *  Individually fast, but the shared self-hosted CI runners are frequently
   *  under contention from concurrent jobs, and ELEMENT's 10s has been observed
   *  to occasionally not be enough for fetch + decrypt + render to land. */
  DECRYPT: 20000,
} as const

// Re-export TestIds for convenience
export { TestIds, navTestIdMap } from './test-ids'

// Re-export page object utilities
export * from './pages/index'

/**
 * Enter a PIN into the PinInput component.
 * The PinInput is a single password input field.
 *
 * Uses clear + type() instead of fill() to ensure React processes each keystroke
 * and updates component state before we press Enter. With fill(), React may not
 * have committed the state update by the time Enter fires, causing the
 * handleKeyDown closure to see the old (empty) value and skip onComplete.
 *
 * After typing, we verify the input value matches expectations before pressing
 * Enter to trigger onComplete.
 *
 * Failure reporting: this is the single most common login-adjacent flake in the
 * suite (30+ call sites, each an independent chance for a CI-load timing race to
 * fire). A raw Playwright timeout here surfaces as a generic locator error
 * attributed to whatever *feature* spec happened to call this first — the true
 * fault (login) gets misdiagnosed as a regression in the feature under test. Each
 * step below is wrapped so the thrown error names the login step that failed,
 * not just "timeout", matching the pattern already used by #872/#929.
 *
 * Deliberately does NOT assert what happens after Enter (navigation, error
 * message, dialog close, etc.) — callers intentionally submit wrong PINs
 * expecting to stay in place (see pin-challenge-steps.ts, pin-lockout-steps.ts),
 * so "no navigation" is not a universal failure signal here. Callers own that
 * postcondition with their own, correctly-scoped assertion.
 */
export async function enterPin(page: Page, pin: string) {
  const pinInput = page.getByTestId('pin-input').locator('input')

  // CI evidence (fleet PR #934, e2e shard 2, 3 consecutive runs: 4/2/3 failures)
  // shows this exact waitFor timing out under CI load — the PIN screen simply
  // hadn't rendered yet, not the state-commit race described below. CI containers
  // share the box with other workers/shards; 10s was tuned for an idle machine.
  // Use the same AUTH budget as every other CI-load-sensitive wait in this file.
  try {
    await pinInput.waitFor({ state: 'visible', timeout: Timeouts.AUTH })
  } catch (cause) {
    throw new Error(
      `[enterPin] login: PIN input never appeared within ${Timeouts.AUTH}ms. ` +
        `The app never reached the PIN screen — this is a login/navigation failure, ` +
        `not a bug in whatever scenario called enterPin().`,
      { cause: cause as Error },
    )
  }

  // Playwright's pressSequentially() already waits for the element to be visible,
  // enabled and stable before each keystroke (standard actionability checks) — no
  // separate "wait for enabled" is needed on top of that. What we must verify
  // ourselves is React state, which Playwright's actionability model knows
  // nothing about: PinInput is a controlled input, and handleKeyDown's
  // `value.length >= minLength` check reads the `value` *prop* captured in its
  // closure at render time. If Enter fires before React re-renders with the
  // final keystroke, handleKeyDown sees a stale (too-short) value and silently
  // skips onComplete — no error, no visible symptom, just a PIN screen that
  // appears to do nothing. Blocking on toHaveValue (which polls the live DOM,
  // itself only updated by the same render pass that updates the closure)
  // guarantees the render has landed before Enter is pressed.
  try {
    await pinInput.clear()
    await pinInput.pressSequentially(pin, { delay: 10 })
    await expect(pinInput).toHaveValue(pin, { timeout: Timeouts.ELEMENT })
  } catch (cause) {
    throw new Error(
      `[enterPin] login: typed PIN value never committed to the input (expected ` +
        `${pin.length} characters to settle within ${Timeouts.ELEMENT}ms). Either the ` +
        `input never became interactive, or React never re-rendered with the final ` +
        `keystroke — pressing Enter now would hit the known stale-closure race.`,
      { cause: cause as Error },
    )
  }

  await pinInput.press('Enter')
}

/**
 * Navigate to a URL after the user has already logged in.
 * If already authenticated (sidebar visible), does SPA navigation directly.
 * Otherwise, re-authenticates via PIN entry first.
 *
 * @param expectAccessDenied - Pass true when the destination is a restricted page
 *   that should render "Access Denied" for the current user (no page-title testid).
 *   By default, the helper asserts that page-title is visible — which catches bugs
 *   where a page silently renders an access-denied response it shouldn't.
 */
export async function navigateAfterLogin(page: Page, url: string, expectAccessDenied = false): Promise<void> {
  // Check if we're already authenticated (sidebar visible)
  const sidebar = page.getByTestId(TestIds.NAV_SIDEBAR)
  const isAuthenticated = await sidebar.isVisible({ timeout: 1000 }).catch(() => false)

  if (!isAuthenticated) {
    // Need to re-authenticate — full page load clears in-memory keyManager
    await page.goto('/login')
    await page.waitForLoadState('domcontentloaded')

    const pinInput = page.getByTestId('pin-input').locator('input')
    const pinVisible = await pinInput.isVisible({ timeout: 5000 }).catch(() => false)

    if (pinVisible) {
      await enterPin(page, TEST_PIN)
    }

    // Wait for the authenticated layout
    await sidebar.waitFor({ state: 'visible', timeout: Timeouts.AUTH })
  }

  // Wait for ConfigProvider to set the active hub — prevents race condition where
  // page components fire data-fetching useEffects before activeHubId is set.
  // In CI with Docker backend, getConfig() takes longer, making this race likely.
  await page.waitForFunction(() => {
    const getHub = window.__TEST_GET_ACTIVE_HUB
    return getHub ? !!getHub() : false
  }, { timeout: Timeouts.AUTH }).catch(() => {
    // If __TEST_GET_ACTIVE_HUB isn't available, continue — will work locally
  })

  // SPA navigation via TanStack Router (no page reload, keeps auth state)
  const parsed = new URL(url, 'http://localhost')
  const searchParams = Object.fromEntries(parsed.searchParams.entries())

  // Wait for the router to be available (may take a moment after login in CI)
  await page.waitForFunction(() => !!window.__TEST_ROUTER, { timeout: 10000 })

  await page.evaluate(({ pathname, search }) => {
    const router = window.__TEST_ROUTER
    if (!router) return
    if (Object.keys(search).length > 0) {
      router.navigate({ to: pathname, search })
    } else {
      router.navigate({ to: pathname })
    }
  }, { pathname: parsed.pathname, search: searchParams })
  await page.waitForURL(u => u.toString().includes(parsed.pathname), { timeout: Timeouts.NAVIGATION })

  // Wait for route component to mount.
  if (expectAccessDenied) {
    // Restricted page — assert "Access Denied" is shown (no page-title testid on these pages).
    await expect(page.getByText('Access Denied', { exact: true })).toBeVisible({ timeout: Timeouts.ELEMENT })
  } else {
    // Normal page — assert a heading is visible. Admin section pages use
    // 'admin-section-heading' instead of 'page-title', so check both.
    await expect(
      page.getByTestId(TestIds.PAGE_TITLE).or(page.getByTestId('admin-section-heading'))
    ).toBeVisible({ timeout: Timeouts.ELEMENT })
  }
}

/**
 * Navigate via SPA without asserting page-title or access-denied.
 * Useful for steps that navigate to a page and then assert the result
 * in a subsequent step (e.g., volunteer navigating to a restricted page).
 */
export async function navigateViaSpa(page: Page, url: string): Promise<void> {
  // Check if we're already authenticated (sidebar visible)
  const sidebar = page.getByTestId(TestIds.NAV_SIDEBAR)
  const isAuthenticated = await sidebar.isVisible({ timeout: 1000 }).catch(() => false)

  if (!isAuthenticated) {
    await page.goto('/login')
    await page.waitForLoadState('domcontentloaded')

    const pinInput = page.getByTestId('pin-input').locator('input')
    const pinVisible = await pinInput.isVisible({ timeout: 5000 }).catch(() => false)

    if (pinVisible) {
      await enterPin(page, TEST_PIN)
    }

    await sidebar.waitFor({ state: 'visible', timeout: Timeouts.AUTH })
  }

  // Wait for ConfigProvider to set the active hub — prevents race condition where
  // page components fire data-fetching useEffects before activeHubId is set.
  // In CI with Docker backend, getConfig() takes longer, making this race likely.
  await page.waitForFunction(() => {
    const getHub = window.__TEST_GET_ACTIVE_HUB
    return getHub ? !!getHub() : false
  }, { timeout: Timeouts.AUTH }).catch(() => {
    // If __TEST_GET_ACTIVE_HUB isn't available, continue — will work locally
  })

  // SPA navigation via TanStack Router
  const parsed = new URL(url, 'http://localhost')
  const searchParams = Object.fromEntries(parsed.searchParams.entries())

  // Wait for the router to be available (may take a moment after login in CI)
  await page.waitForFunction(() => !!window.__TEST_ROUTER, { timeout: 10000 })

  await page.evaluate(({ pathname, search }) => {
    const router = window.__TEST_ROUTER
    if (!router) return
    if (Object.keys(search).length > 0) {
      router.navigate({ to: pathname, search })
    } else {
      router.navigate({ to: pathname })
    }
  }, { pathname: parsed.pathname, search: searchParams })
  await page.waitForURL(u => u.toString().includes(parsed.pathname), { timeout: Timeouts.NAVIGATION })

  // Wait briefly for route component to mount without asserting specific content
  await page.waitForLoadState('domcontentloaded')
}

/**
 * Re-enter PIN after a page.reload() when user is already authenticated.
 * The reload clears keyManager, so the encrypted key in localStorage triggers
 * the PIN screen. After entering PIN the app redirects to /.
 * If currentPath is provided, the helper then navigates back to that path
 * via the sidebar or page.goto as appropriate.
 */
export async function reenterPinAfterReload(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded')
  const pinInput = page.getByTestId('pin-input').locator('input')
  // Use waitFor to actually wait for the PIN input to render after reload.
  // isVisible() is an instant snapshot and returns false if DOM hasn't rendered yet.
  try {
    await pinInput.waitFor({ state: 'visible', timeout: Timeouts.ELEMENT })
    await enterPin(page, TEST_PIN)
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: Timeouts.AUTH })
  } catch {
    // PIN screen didn't appear — may already be authenticated
  }
}

/**
 * Login as admin: restores the admin's encrypted device key from the
 * `tests/storage/admin.json` session cache and enters PIN to unlock.
 *
 * Session reuse (fleet flake fix, see docs/KNOWN_FLAKES.md#login-pin-race): this
 * cache is written exactly once per full test run, by the "bootstrap" Playwright
 * project (tests/bootstrap.spec.ts), which is a hard `dependencies: ["bootstrap"]`
 * of every project that calls this function. Playwright always runs a project's
 * dependencies to completion first — including when filtering to a single spec
 * file — so the cache is guaranteed present by the time this runs. Consuming it
 * means every loginAsAdmin() call restores a pre-derived key (fast, deterministic)
 * instead of re-running a full PBKDF2 (600K iteration) import (slow, and CI
 * containers make PBKDF2 significantly slower — see Timeouts.AUTH above).
 *
 * This function used to also contain a "legacy" fallback that re-derived the key
 * from ADMIN_SEED via a second, slower reload+enterPin path whenever the cache
 * looked stale. That fallback never actually fires: `/api/test-reset` (the only
 * reset endpoint called anywhere between bootstrap and a loginAsAdmin() call — see
 * tests/screenshots.spec.ts) re-seeds the SAME admin identity by the SAME fixed
 * ADMIN_PUBKEY (apps/worker/routes/dev.ts `ensureInit`), so the cached key stays
 * valid. Keeping a silent, untested fallback path was itself a flake risk — a
 * second, divergent code path through enterPin() that only real breakage would
 * ever exercise, at exactly the worst time to discover it doesn't work. If the
 * cache genuinely is missing or the admin identity it encodes is rejected, this
 * now fails loudly with an actionable message instead.
 */
export async function loginAsAdmin(page: Page) {
  const storagePath = 'tests/storage/admin.json'
  let storageState: { origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }> } | null = null

  try {
    const fs = await import('fs/promises')
    const content = await fs.readFile(storagePath, 'utf-8')
    storageState = JSON.parse(content)
  } catch (cause) {
    throw new Error(
      `[loginAsAdmin] ${storagePath} is missing or unreadable. This file is written ` +
        `once by the "bootstrap" Playwright project (tests/bootstrap.spec.ts) and is a ` +
        `hard dependency of every project that calls loginAsAdmin() — Playwright runs ` +
        `project dependencies automatically unless invoked with --no-deps. If you ran ` +
        `with --no-deps, or ran this file in isolation some other way, include ` +
        `--project=bootstrap so the cache gets created first.`,
      { cause: cause as Error },
    )
  }

  await page.goto('/login')
  await page.waitForLoadState('domcontentloaded')

  // Reset PIN lockout counter to prevent accumulation across serial tests.
  // In serial mode the browser context is reused, so failed PIN attempts from
  // stale cached storage compound across tests. Without this reset, the mock's
  // escalating lockout triggers a 10-minute lockout after ~9 loginAsAdmin calls.
  await page.evaluate(() => {
    localStorage.removeItem('__test_pin_lockout_state')
  })

  await page.evaluate((state) => {
    sessionStorage.clear()
    localStorage.clear()
    // `state` is null when no saved session exists (first run, or the cache
    // file was cleared) — clearing storage is then the whole job.
    if (!state) return
    for (const origin of state.origins || []) {
      for (const item of origin.localStorage || []) {
        localStorage.setItem(item.name, item.value)
      }
    }
  }, storageState)

  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await enterPin(page, TEST_PIN)

  // enterPin() only confirms Enter was pressed — the actual unlock + login API
  // round trip that moves the app off /login happens asynchronously afterward.
  // The code this replaced checked `page.url()` synchronously right here, with
  // no wait at all: a real race, not a staleness check, and very likely the
  // actual root cause of the CI evidence this PR is fixing (see
  // docs/KNOWN_FLAKES.md#login-pin-race) — it would only ever "detect
  // staleness" faster than the login round trip could complete under load,
  // and the (now-removed) legacy ADMIN_SEED fallback silently absorbed every
  // false positive by being slow enough for the real login to have caught up.
  // A proper wait replaces both that synchronous check and the wait that used
  // to follow it.
  try {
    await page.waitForURL(url => !url.toString().includes('/login'), { timeout: Timeouts.AUTH })
  } catch (cause) {
    throw new Error(
      `[loginAsAdmin] Entering the cached PIN did not leave /login within ` +
        `${Timeouts.AUTH}ms. Either the identity encoded in ${storagePath} was ` +
        `rejected by the server (ADMIN_PUBKEY changed, or the admin was deleted by ` +
        `test-reset-no-admin after bootstrap wrote this cache -- delete ` +
        `${storagePath} and re-run with --project=bootstrap so it regenerates), or ` +
        `the login request itself is hanging (check the backend is reachable and ` +
        `healthy).`,
      { cause: cause as Error },
    )
  }
  // Ensure hub context is ready before asserting page content — prevents race
  // where components fetch data before ConfigProvider sets activeHubId.
  await page.waitForFunction(() => {
    const getHub = window.__TEST_GET_ACTIVE_HUB
    return getHub ? !!getHub() : false
  }, { timeout: 15000 }).catch(() => {})
  // Wait for the authenticated layout — use longer timeout for CI (PBKDF2 + Docker overhead)
  await expect(page.getByTestId(TestIds.PAGE_TITLE)).toBeVisible({ timeout: Timeouts.AUTH })
  // Wait for admin section in sidebar or hamburger button (mobile) — confirms getMe() completed.
  const viewport = page.viewportSize()
  const isMobile = viewport ? viewport.width < 768 : false
  if (isMobile) {
    await page.getByRole('button', { name: /open menu/i }).waitFor({ state: 'visible', timeout: Timeouts.AUTH })
  } else {
    await page.getByTestId(TestIds.NAV_ADMIN_SECTION).waitFor({ state: 'visible', timeout: Timeouts.AUTH })
  }
  // Ensure network has settled so subsequent navigation doesn't race with auth API calls
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
}

/**
 * Login as user (volunteer): imports key material via IPC mock,
 * persists to store, then enters PIN to unlock.
 *
 * Accepts a raw Ed25519 signing seed hex string (as returned by createUserViaApi).
 */
export async function loginAsVolunteer(page: Page, seedHex: string) {
  const secretHex = seedHex

  await page.goto('/login')
  await page.evaluate(() => {
    sessionStorage.clear()
    localStorage.removeItem('llamenos:llamenos-encrypted-device-keys')
    localStorage.removeItem('llamenos:llamenos-encrypted-key')
    localStorage.removeItem('llamenos-encrypted-key')
    // Reset PIN lockout counter to prevent accumulation across serial tests
    localStorage.removeItem('__test_pin_lockout_state')
  })
  await page.reload()
  await page.waitForLoadState('domcontentloaded')

  // Wait for __TEST_PLATFORM to be loaded
  await page.waitForFunction(() => !!window.__TEST_PLATFORM, { timeout: Timeouts.AUTH })

  // Import Ed25519 seed
  await page.evaluate(async ({ secretHex, pin }) => {
    const platform = window.__TEST_PLATFORM
    if (!platform) throw new Error('__TEST_PLATFORM not available')
    const encrypted = await platform.deviceImportAndLoad(secretHex, pin, crypto.randomUUID())
    await platform.persistAndUnlockDeviceKeys(encrypted, pin)
    await platform.lockCrypto()
  }, { secretHex, pin: TEST_PIN })

  // Reload to trigger PIN screen
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await enterPin(page, TEST_PIN)
  await page.waitForURL(url => !url.toString().includes('/login'), { timeout: Timeouts.AUTH })
  // Ensure hub context is ready before asserting page content — prevents race
  // where components fetch data before ConfigProvider sets activeHubId.
  await page.waitForFunction(() => {
    const getHub = window.__TEST_GET_ACTIVE_HUB
    return getHub ? !!getHub() : false
  }, { timeout: 15000 }).catch(() => {})

  // New users land on /profile-setup — detect and handle
  const profileSetupBtn = page.getByRole('button', { name: /complete setup/i })
  const sidebar = page.getByTestId(TestIds.NAV_SIDEBAR)
  const landedOnProfileSetup = await Promise.race([
    profileSetupBtn.waitFor({ state: 'visible', timeout: 5000 }).then(() => true),
    sidebar.waitFor({ state: 'visible', timeout: 5000 }).then(() => false),
  ]).catch(() => false)

  if (landedOnProfileSetup) {
    await completeProfileSetup(page)
  }

  // Wait for the authenticated layout to be visible
  await page.getByTestId(TestIds.NAV_SIDEBAR).waitFor({ state: 'visible', timeout: Timeouts.AUTH })
}

export async function logout(page: Page) {
  await page.getByTestId(TestIds.LOGOUT_BTN).click()
}

/**
 * Create a volunteer via UI and return the raw Ed25519 seed hex for login.
 *
 * The displayed device key is only for user display. Internally,
 * the volunteer was created with an Ed25519 keypair. We return the raw seedHex
 * so that `loginAsVolunteer` uses `deviceImportAndLoad`.
 *
 * The seedHex is stored in `window.__last_vol_seed_hex` by users.tsx after
 * calling generateEphemeralKeypair().
 */
export async function createUserAndGetDeviceKey(page: Page, name: string, phone: string): Promise<string> {
  await page.getByTestId(TestIds.NAV_VOLUNTEERS).click()
  await expect(page.getByTestId(TestIds.PAGE_TITLE)).toBeVisible()

  await page.getByTestId(TestIds.VOLUNTEER_ADD_BTN).click()
  await page.getByLabel('Name').fill(name)
  await page.getByLabel('Phone Number').fill(phone)
  await page.getByLabel('Phone Number').blur()
  await page.getByTestId(TestIds.FORM_SAVE_BTN).click()

  const keyCode = page.getByTestId(TestIds.VOLUNTEER_DEVICE_KEY_CODE)
  await expect(keyCode).toBeVisible({ timeout: Timeouts.API })

  // Try to get the raw Ed25519 seedHex from window state (set by users.tsx).
  // If available, return it so loginAsVolunteer uses deviceImportAndLoad (Ed25519).
  // If not available (e.g., pre-test reload), fall back to displayed key from DOM.
  const seedHex = await page.evaluate(
    () => (window as unknown as Record<string, unknown>).__last_vol_seed_hex as string | undefined,
  )
  if (seedHex && /^[0-9a-f]{64}$/.test(seedHex)) {
    return seedHex
  }

  const key = await keyCode.textContent()
  if (!key) throw new Error('Failed to get device key')
  return key
}

/** Dismiss the device key card shown after volunteer creation. */
export async function dismissDeviceKeyCard(page: Page): Promise<void> {
  await page.getByTestId('dismiss-device-key').click()
  await expect(page.getByTestId('dismiss-device-key')).not.toBeVisible()
}

export async function completeProfileSetup(page: Page) {
  if (page.url().includes('profile-setup')) {
    const completeBtn = page.getByRole('button', { name: /complete setup/i })
    await completeBtn.waitFor({ state: 'visible', timeout: Timeouts.ELEMENT })
    await completeBtn.click()
    await page.waitForURL(u => !u.toString().includes('profile-setup'), { timeout: Timeouts.AUTH })
  }
  await expect(page.getByTestId(TestIds.PAGE_TITLE)).toBeVisible({ timeout: Timeouts.ELEMENT })
}

export function uniquePhone(): string {
  // Use 212 (NYC) area code — 555 numbers fail libphonenumber-js validation
  const suffix = Date.now().toString().slice(-7)
  return `+1212${suffix}`
}

/**
 * Fill in the call ID field in the new note form.
 *
 * The form renders a plain input when the admin has no recent calls and a select
 * (with an "Enter manually" option) when they do. The notes page keeps the form closed
 * until call history has settled, so the mode is fixed once the form exists; it is read
 * from the form's `data-call-id-mode` attribute (an auto-waiting read of app state)
 * rather than guessed from a non-waiting visibility probe.
 */
export async function fillCallId(page: Page, callId: string): Promise<void> {
  const form = page.getByTestId(TestIds.NOTE_FORM)
  const callIdInput = form.getByTestId(TestIds.NOTE_CALL_ID)
  const mode = await form.getAttribute('data-call-id-mode')
  if (mode === 'select') {
    await form.getByTestId(TestIds.CALL_ID_SELECT).click()
    await page.getByTestId(TestIds.CALL_ID_MANUAL_OPTION).click()
  } else if (mode !== 'input') {
    throw new Error(`note-form has unexpected data-call-id-mode: ${String(mode)}`)
  }
  await callIdInput.fill(callId)
}

const TEST_RESET_SECRET = process.env.DEV_RESET_SECRET || 'test-reset-secret'

export async function resetTestState(request: APIRequestContext) {
  const res = await request.post('/api/test-reset', {
    headers: { 'X-Test-Secret': TEST_RESET_SECRET },
  })
  if (!res.ok()) {
    throw new Error(`test-reset failed with status ${res.status()}: ${await res.text()}`)
  }
}

/**
 * Mock /api/config to include a hub, ensuring currentHubId is set in ConfigProvider.
 * Must be called BEFORE loginAsAdmin() since login loads the page which fetches config.
 * Tests that depend on hub-scoped routes (hub-communications, etc.) need this.
 */
export async function mockConfigWithHub(page: Page, hubId = 'test-hub-1'): Promise<void> {
  await page.route('**/api/config', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        hotlineName: 'Test Hotline',
        hotlineNumber: '+15551234567',
        channels: { voice: true, sms: true, whatsapp: false, signal: true, rcs: false, telegram: false, reports: true },
        setupCompleted: true,
        demoMode: false,
        demoResetSchedule: null,
        needsBootstrap: false,
        hubs: [{ id: hubId, name: 'Test Hub', slug: 'test-hub', description: '', status: 'active', createdBy: 'test', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
        defaultHubId: hubId,
        serverPubkey: 'bfaca2c5f99ed9d65db5f522a68820c458ae9ccfe00327c64bc66ccde06e5703',
        wsRelayUrl: '/ws',
        apiVersion: 1,
        minApiVersion: 1,
      }),
    })
  })
}

/**
 * Shared "seed failed" signal for step definitions that create a resource via a
 * backend simulation helper (e.g. simulateIncomingMessage) and then need every
 * downstream step to take one deterministic branch instead of re-probing
 * visibility with isVisible().catch(() => false) at each step. Given steps that
 * seed data should call flagSeedFailed(page) exactly once when seeding did not
 * produce the expected UI element; When/Then steps should check
 * readSeedFailedFlag(page) first and return early (after asserting a safe
 * fallback state) rather than guarding their own click/fill on a fresh probe.
 */
type SeedFlagWindow = Window & { __test_seed_failed?: boolean }

export async function flagSeedFailed(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as SeedFlagWindow).__test_seed_failed = true
  })
}

export async function readSeedFailedFlag(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as unknown as SeedFlagWindow).__test_seed_failed === true).catch(() => false)
}
