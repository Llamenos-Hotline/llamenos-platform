import { test, expect } from '@playwright/test'
import { ADMIN_SEED, enterPin, resetTestState, TEST_PIN, Timeouts, completeProfileSetup } from './helpers'
import { TestIds } from './test-ids'
import { expectInitialisedIdentity } from './identity-helpers'

const TEST_RESET_SECRET = process.env.DEV_RESET_SECRET || 'test-reset-secret'
const resetHeaders = { 'X-Test-Secret': TEST_RESET_SECRET }
const STORAGE_DIR = 'tests/storage'

// Tests depend on each other's server-side state (bootstrap creates admin for later tests)
test.describe.configure({ mode: 'serial', timeout: 300_000 })

/**
 * Enter PIN during the admin bootstrap flow.
 * v2 uses a single input field (not per-digit slots).
 */
async function enterBootstrapPin(page: import('@playwright/test').Page, pin: string) {
  const pinInput = page.getByTestId('pin-input').locator('input')
  await pinInput.waitFor({ state: 'visible', timeout: 15000 })
  await pinInput.fill(pin)
  await pinInput.press('Enter')
}

/**
 * After loading storage state and navigating to /, handle PIN entry.
 * The cached localStorage holds an encrypted key, so the app always shows the
 * PIN screen (decrypting it into memory happens fresh on every page load —
 * see tests/fixtures/auth.ts for the full explanation). Enters PIN, waits for
 * dashboard.
 */
async function unlockAndNavigateToDashboard(page: import('@playwright/test').Page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' })

  const pinInput = page.getByTestId(TestIds.PIN_INPUT).locator('input')
  const pageTitle = page.getByTestId(TestIds.PAGE_TITLE)
  const profileSetupBtn = page.getByRole('button', { name: /complete setup/i })

  const firstVisible = await Promise.race([
    pinInput.waitFor({ state: 'visible', timeout: 45000 }).then(() => 'pin' as const),
    pageTitle.waitFor({ state: 'visible', timeout: 45000 }).then(() => 'dashboard' as const),
    profileSetupBtn.waitFor({ state: 'visible', timeout: 45000 }).then(() => 'profile' as const),
  ])

  if (firstVisible === 'pin') {
    await enterPin(page, TEST_PIN)
    const afterPin = await Promise.race([
      pageTitle.waitFor({ state: 'visible', timeout: 90000 }).then(() => 'dashboard' as const),
      profileSetupBtn.waitFor({ state: 'visible', timeout: 90000 }).then(() => 'profile' as const),
    ])
    if (afterPin === 'profile') {
      await completeProfileSetup(page)
    }
  } else if (firstVisible === 'profile') {
    await completeProfileSetup(page)
  }

  // Ensure sidebar is visible (confirms full auth)
  await page.getByTestId(TestIds.NAV_SIDEBAR).waitFor({ state: 'visible', timeout: Timeouts.AUTH })

}

/**
 * Complete the admin bootstrap flow through the real UI:
 * 1. Navigate to /setup
 * 2. Click "Get Started", create PIN, confirm PIN
 * 3. Wait for keypair generation + recovery key
 * 4. Download backup, acknowledge, continue to setup wizard
 * 5. Complete setup wizard (identity + channels + skip remaining + launch)
 */
async function bootstrapAdmin(page: import('@playwright/test').Page) {
  await page.goto('/setup', { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => {
    localStorage.clear()
    sessionStorage.clear()
  })
  await page.reload({ waitUntil: 'domcontentloaded' })

  // Wait for bootstrap UI — "Create Admin Account"
  const bootstrapTitle = page.getByText('Create Admin Account')
  await expect(bootstrapTitle).toBeVisible({ timeout: 30000 })

  // Click "Get Started"
  await page.getByRole('button', { name: /get started/i }).click()

  // Create PIN
  await enterBootstrapPin(page, TEST_PIN)

  // Wait for confirm step to render
  await page.getByRole('heading', { name: /confirm your pin/i }).waitFor({ state: 'visible', timeout: 10000 })

  // Confirm PIN
  await enterBootstrapPin(page, TEST_PIN)

  // Wait for keypair generation + recovery key display (PBKDF2 600K — slow)
  const recoveryKey = page.getByTestId('recovery-key')
  await expect(recoveryKey).toBeVisible({ timeout: 90000 })

  // Download backup (required before continuing)
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: /download.*backup/i }).click()
  const download = await downloadPromise
  console.log(`[SETUP] Backup downloaded: ${download.suggestedFilename()}`)

  // Acknowledge backup saved
  await page.getByText(/saved my recovery key/i).click()
  console.log('[SETUP] Backup acknowledged')

  // Continue to setup wizard
  const continueBtn = page.getByRole('button', { name: /continue to setup/i })
  await expect(continueBtn).toBeEnabled({ timeout: 5000 })
  await continueBtn.click()
  console.log('[SETUP] Continue clicked, waiting for Setup Wizard...')

  // Wait for setup wizard to load (importKey + signIn can take 30s+ on CI)
  await expect(page.getByText('Setup Wizard')).toBeVisible({ timeout: 120000 })

  // If wizard prompts for PIN after load (reload-during-setup edge case), enter it
  const wizardPinInput = page.getByTestId(TestIds.PIN_INPUT).locator('input')
  const wizardPinVisible = await wizardPinInput.isVisible({ timeout: 3000 }).catch(() => false)
  if (wizardPinVisible) {
    await enterPin(page, TEST_PIN)
    await expect(page.getByText('Setup Wizard')).toBeVisible({ timeout: 30000 })
  }

  // Identity step — fill minimum required fields
  await expect(page.getByText('Identity', { exact: true })).toBeVisible({ timeout: 10000 })
  await page.locator('#hotline-name').fill(`Test Hotline ${Date.now()}`)
  await page.locator('#org-name').fill('Test Organization')
  await page.getByTestId(TestIds.SETUP_NEXT_BTN).click()

  // Channels step — select Reports channel (lightweight, no provider needed)
  await page.getByTestId('channel-card-reports').waitFor({ state: 'visible', timeout: 10000 })
  await page.getByTestId('channel-card-reports').click()
  await page.getByTestId(TestIds.SETUP_NEXT_BTN).click()

  // Skip remaining wizard steps (providers, settings, invite)
  for (let i = 0; i < 3; i++) {
    const skipBtn = page.getByTestId(TestIds.SETUP_SKIP_BTN)
    const nextBtn = page.getByTestId(TestIds.SETUP_NEXT_BTN)
    // Both may be visible — prefer Skip when available
    await nextBtn.waitFor({ state: 'visible', timeout: 10000 })
    if (await skipBtn.isVisible().catch(() => false)) {
      await skipBtn.click()
    } else {
      await nextBtn.click()
    }
    await page.waitForTimeout(500)
  }

  // Summary step — click "Launch"
  const launchBtn = page.getByTestId('setup-complete-btn')
  await launchBtn.waitFor({ state: 'visible', timeout: 10000 })
  await launchBtn.click()

  // After launch, the wizard calls completeSetup() then navigates to /.
  // The root auth guard may show: dashboard, profile-setup, or login/PIN screen.
  const sidebar = page.getByTestId(TestIds.NAV_SIDEBAR)
  const profileSetupBtn = page.getByRole('button', { name: /complete setup/i })
  const pinInput = page.getByTestId(TestIds.PIN_INPUT).locator('input')
  const loginPage = page.getByText(/sign in/i)

  const destination = await Promise.race([
    sidebar.waitFor({ state: 'visible', timeout: 60000 }).then(() => 'dashboard' as const),
    profileSetupBtn.waitFor({ state: 'visible', timeout: 60000 }).then(() => 'profile-setup' as const),
    pinInput.waitFor({ state: 'visible', timeout: 60000 }).then(() => 'pin' as const),
    loginPage.waitFor({ state: 'visible', timeout: 60000 }).then(() => 'login' as const),
  ])
  console.log(`[SETUP] After launch: landed on ${destination} (URL: ${page.url()})`)

  if (destination === 'pin') {
    await enterPin(page, TEST_PIN)
    // Wait for dashboard or profile-setup after PIN
    const afterPin = await Promise.race([
      sidebar.waitFor({ state: 'visible', timeout: Timeouts.AUTH }).then(() => 'dashboard' as const),
      profileSetupBtn.waitFor({ state: 'visible', timeout: Timeouts.AUTH }).then(() => 'profile-setup' as const),
    ])
    if (afterPin === 'profile-setup') {
      await completeProfileSetup(page)
    }
  } else if (destination === 'profile-setup') {
    await completeProfileSetup(page)
  } else if (destination === 'login') {
    // Key was lost — need to re-enter PIN after login redirect
    const pinVisibleAfterLogin = await pinInput.isVisible({ timeout: 5000 }).catch(() => false)
    if (pinVisibleAfterLogin) {
      await enterPin(page, TEST_PIN)
    }
    await sidebar.waitFor({ state: 'visible', timeout: Timeouts.AUTH })
  }

  // Confirm we're on the authenticated dashboard
  await sidebar.waitFor({ state: 'visible', timeout: Timeouts.AUTH })
}

/**
 * Create an invite for a role and complete onboarding in a new browser context.
 * Returns after saving the new user's storage state.
 */
async function createRoleAccount(
  adminPage: import('@playwright/test').Page,
  browser: import('@playwright/test').Browser,
  opts: {
    name: string
    phone: string
    roleId: string
    storageFile: string
  }
) {
  // Navigate to Users page — wait for invite-btn (users-page-specific) rather than
  // generic page-title which may match the departing route during transition.
  await adminPage.getByTestId(TestIds.NAV_VOLUNTEERS).click()
  const inviteBtn = adminPage.getByTestId('invite-btn')
  await inviteBtn.waitFor({ state: 'visible', timeout: 20000 })
  await inviteBtn.click()

  // Fill invite form
  await adminPage.locator('#invite-name').fill(opts.name)
  const phoneInput = adminPage.locator('#invite-phone')
  await phoneInput.waitFor({ state: 'visible', timeout: 5000 })
  // PhoneInput might be a custom component - fill directly
  await phoneInput.fill(opts.phone)
  await phoneInput.blur()
  await adminPage.waitForTimeout(500)

  // Select role from dropdown if not default (role-volunteer)
  if (opts.roleId !== 'role-volunteer') {
    const roleTrigger = adminPage.locator('#invite-role')
    if (await roleTrigger.isVisible({ timeout: 2000 }).catch(() => false)) {
      await roleTrigger.click()
      await adminPage.waitForTimeout(300)
      // Role names are human-readable (e.g., "Hub Admin", "Reviewer", "Reporter")
      const roleName = opts.roleId
        .replace('role-', '')
        .split('-')
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ')
      await adminPage.locator(`[role="option"]`).filter({ hasText: roleName }).click()
    }
  }

  // Create invite
  await adminPage.getByTestId('create-invite-btn').click()

  // Wait for invite link to appear (green card with the link)
  const inviteLinkCard = adminPage.getByTestId('invite-link-code')
  await expect(inviteLinkCard).toBeVisible({ timeout: 15000 })
  const inviteLink = await inviteLinkCard.textContent()
  if (!inviteLink) throw new Error(`Failed to get invite link for ${opts.name}`)
  console.log(`[SETUP] ${opts.name}: invite link = ${inviteLink}`)

  // Dismiss invite link card
  const dismissBtn = adminPage.getByTestId('dismiss-invite')
  if (await dismissBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
    await dismissBtn.click()
    await adminPage.waitForTimeout(300)
  }

  // Open new browser context for the invited user
  const userContext = await browser.newContext()
  const userPage = await userContext.newPage()

  try {
    await userPage.goto(inviteLink, { waitUntil: 'domcontentloaded' })
    console.log(`[SETUP] ${opts.name}: landed on ${userPage.url()}`)

    // Wait for welcome page
    const welcomeOrError = await Promise.race([
      userPage.getByRole('button', { name: /get started/i }).waitFor({ state: 'visible', timeout: 20000 }).then(() => 'welcome' as const),
      userPage.getByText(/invalid/i).waitFor({ state: 'visible', timeout: 20000 }).then(() => 'invalid' as const),
      userPage.getByText(/expired/i).waitFor({ state: 'visible', timeout: 20000 }).then(() => 'expired' as const),
    ])
    if (welcomeOrError !== 'welcome') {
      throw new Error(`Invite for ${opts.name} failed: ${welcomeOrError} (link: ${inviteLink})`)
    }

    // Click "Get Started"
    await userPage.getByRole('button', { name: /get started/i }).click()

    // Create PIN
    await enterBootstrapPin(userPage, TEST_PIN)

    // Wait for confirm step
    await userPage.getByRole('heading', { name: /confirm your pin/i }).waitFor({ state: 'visible', timeout: 10000 })

    // Confirm PIN
    await enterBootstrapPin(userPage, TEST_PIN)

    // Wait for keypair generation + recovery key (PBKDF2 600K — slow)
    const recoveryKey = userPage.getByTestId('recovery-key')
    await expect(recoveryKey).toBeVisible({ timeout: 90000 })

    // Download backup
    const userDownload = userPage.waitForEvent('download', { timeout: 15000 })
    await userPage.getByRole('button', { name: /download.*backup/i }).click()
    await userDownload

    // Acknowledge backup
    await userPage.getByText(/saved my recovery key/i).click()

    // Continue (complete onboarding)
    const continueBtn = userPage.getByRole('button', { name: /continue/i }).last()
    await expect(continueBtn).toBeEnabled({ timeout: 5000 })
    await continueBtn.click()

    // Wait for redirect to profile-setup or dashboard
    await userPage.waitForURL(
      (url) => {
        const path = new URL(url.toString()).pathname
        return path.includes('profile-setup') || path === '/'
      },
      { timeout: 60000 }
    )

    // Complete profile setup if redirected there
    if (userPage.url().includes('profile-setup')) {
      const completeBtn = userPage.getByRole('button', { name: /complete setup/i })
      await completeBtn.waitFor({ state: 'visible', timeout: 15000 })
      await completeBtn.click()
      await userPage.waitForURL((u) => !u.toString().includes('profile-setup'), { timeout: 15000 })
    }

    // Wait for authenticated state — sidebar visible
    await userPage.getByTestId(TestIds.NAV_SIDEBAR).waitFor({ state: 'visible', timeout: 30000 })

    // Invite onboarding created a verifying sigchain genesis + PUK for this device (#1050)
    await expectInitialisedIdentity(userPage)

    // Save storage state
    await userContext.storageState({ path: opts.storageFile })
    console.log(`[SETUP] ${opts.name}: storage state saved to ${opts.storageFile}`)
  } finally {
    await userContext.close()
  }
}

// =====================================================================
// Global Setup: Provision Test Accounts via Real UI Flows
// =====================================================================

test.describe('Global Setup: Provision Test Accounts', () => {
  // Always restore normal test state after the describe block, even on failure.
  test.afterAll(async ({ request }) => {
    await resetTestState(request)
  })

  test('reset database and bootstrap admin via UI', async ({ page, request }) => {
    // Reset to a fresh state with no admin
    let resetOk = false
    for (let i = 0; i < 10; i++) {
      try {
        const res = await request.post('/api/test-reset-no-admin', { headers: resetHeaders })
        if (res.ok()) {
          resetOk = true
          break
        }
        if (res.status() === 404) {
          throw new Error('test-reset-no-admin returned 404 — ENVIRONMENT must be "development".')
        }
        console.log(`[SETUP] Reset attempt ${i + 1}: status ${res.status()}`)
      } catch (err) {
        if (err instanceof Error && err.message.includes('returned 404')) throw err
        console.log(`[SETUP] Reset attempt ${i + 1}: ${(err as Error).message}`)
      }
      await new Promise((r) => setTimeout(r, 2000))
    }
    if (!resetOk) throw new Error('test-reset-no-admin never returned 200 after 10 retries')

    // Verify config shows needsBootstrap
    const configRes = await request.get('/api/config')
    const config = await configRes.json()
    if (!config.needsBootstrap) {
      console.log('[SETUP] WARNING: config.needsBootstrap is false after reset — retrying')
      await request.post('/api/test-reset-no-admin', { headers: resetHeaders })
      await new Promise((r) => setTimeout(r, 1000))
    }

    // Run real bootstrap flow through the UI
    await bootstrapAdmin(page)

    // The bootstrap device created a verifying sigchain genesis + PUK (#1050)
    await expectInitialisedIdentity(page)

    // Save admin storage state
    await page.context().storageState({ path: `${STORAGE_DIR}/admin.json` })
    console.log('[SETUP] Admin storage state saved')
  })

  test('create hub-admin account via invite', async ({ browser }) => {
    const adminContext = await browser.newContext({
      storageState: `${STORAGE_DIR}/admin.json`,
    })
    const adminPage = await adminContext.newPage()

    try {
      await unlockAndNavigateToDashboard(adminPage)

      await createRoleAccount(adminPage, browser, {
        name: 'Test Hub Admin',
        phone: '+12125551001',
        roleId: 'role-hub-admin',
        storageFile: `${STORAGE_DIR}/hub-admin.json`,
      })
      // Re-save admin storage state (rotated refresh token)
      await adminContext.storageState({ path: `${STORAGE_DIR}/admin.json` })
    } finally {
      await adminContext.close()
    }
  })

  test('create volunteer account via invite', async ({ browser }) => {
    const adminContext = await browser.newContext({
      storageState: `${STORAGE_DIR}/admin.json`,
    })
    const adminPage = await adminContext.newPage()

    try {
      await unlockAndNavigateToDashboard(adminPage)

      await createRoleAccount(adminPage, browser, {
        name: 'Test Volunteer',
        phone: '+12125551002',
        roleId: 'role-volunteer',
        storageFile: `${STORAGE_DIR}/volunteer.json`,
      })
      // Re-save admin storage state (rotated refresh token)
      await adminContext.storageState({ path: `${STORAGE_DIR}/admin.json` })
    } finally {
      await adminContext.close()
    }
  })

  test('create reviewer account via invite', async ({ browser }) => {
    const adminContext = await browser.newContext({
      storageState: `${STORAGE_DIR}/admin.json`,
    })
    const adminPage = await adminContext.newPage()

    try {
      await unlockAndNavigateToDashboard(adminPage)

      await createRoleAccount(adminPage, browser, {
        name: 'Test Reviewer',
        phone: '+12125551003',
        roleId: 'role-reviewer',
        storageFile: `${STORAGE_DIR}/reviewer.json`,
      })
      // Re-save admin storage state (rotated refresh token)
      await adminContext.storageState({ path: `${STORAGE_DIR}/admin.json` })
    } finally {
      await adminContext.close()
    }
  })

  test('create reporter account via invite', async ({ browser }) => {
    const adminContext = await browser.newContext({
      storageState: `${STORAGE_DIR}/admin.json`,
    })
    const adminPage = await adminContext.newPage()

    try {
      await unlockAndNavigateToDashboard(adminPage)

      await createRoleAccount(adminPage, browser, {
        name: 'Test Reporter',
        phone: '+12125551004',
        roleId: 'role-reporter',
        storageFile: `${STORAGE_DIR}/reporter.json`,
      })
    } finally {
      await adminContext.close()
    }
  })

  test('restore normal test state', async ({ request }) => {
    await resetTestState(request)
    // Verify admin exists
    const res = await request.get('/api/config')
    const config = await res.json()
    expect(config.needsBootstrap).toBe(false)
  })

  // ── Session-reuse cache for the FIXED admin identity ──────────────────
  //
  // Every other Playwright project's loginAsAdmin() (tests/helpers.ts) and
  // the "Given I am logged in as an admin" family of BDD steps authenticate
  // as ADMIN_SEED, not as whichever random keypair bootstrapAdmin() generated
  // above. ADMIN_SEED is a FIXED Ed25519 seed whose derived pubkey
  // (79215a4c04f08fcd...af9183) matches CI's TEST_ADMIN_PUBKEY -- the
  // identity every /api/test-reset call re-seeds server-side, for the entire
  // rest of the suite's lifetime.
  //
  // The bootstrap admin created above, by contrast, exists ONLY to exercise
  // the real onboarding UI (AdminBootstrap.tsx) -- that is bootstrapAdmin()'s
  // actual job, unrelated to session caching. `resetTestState()` two tests
  // up wipes it (services.identity.reset() unconditionally deletes the users
  // table) and, when ADMIN_PUBKEY is configured, re-seeds ADMIN_SEED's
  // identity in its place. Saving tests/storage/admin.json from the
  // bootstrap-UI context (as this file used to do, right after
  // bootstrapAdmin() finished) captured an identity guaranteed to be
  // orphaned by the very next test in this file -- every consumer's cache
  // read would then correctly decrypt the key client-side but get a 401 on
  // the very first authenticated API call, surfacing as "Wrong PIN" (see
  // docs/KNOWN_FLAKES.md#login-pin-race for the full trace). This step
  // authenticates as the identity that actually survives, once, for real,
  // through the UI -- and overwrites admin.json with a cache that stays
  // valid for the rest of the run.
  test('cache the fixed admin session for loginAsAdmin() reuse', async ({ page }) => {
    await page.goto('/login')
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!window.__TEST_PLATFORM, { timeout: Timeouts.AUTH })

    await page.evaluate(async ({ secretHex, pin }) => {
      const platform = window.__TEST_PLATFORM
      if (!platform) throw new Error('__TEST_PLATFORM not available')
      const encrypted = await platform.deviceImportAndLoad(secretHex, pin, crypto.randomUUID())
      await platform.persistAndUnlockDeviceKeys(encrypted, pin)
      await platform.lockCrypto()
    }, { secretHex: ADMIN_SEED, pin: TEST_PIN })

    // Real UI PIN entry, once, proving the identity we're about to cache
    // actually authenticates end to end before anything else trusts it.
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await enterPin(page, TEST_PIN)
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: Timeouts.AUTH })
    await page.getByTestId(TestIds.NAV_SIDEBAR).waitFor({ state: 'visible', timeout: Timeouts.AUTH })

    await page.context().storageState({ path: `${STORAGE_DIR}/admin.json` })
    console.log('[SETUP] Fixed admin (ADMIN_SEED) storage state saved — supersedes the bootstrap-UI admin cache')
  })
})
