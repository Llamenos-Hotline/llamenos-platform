/**
 * Invite redemption on a fresh desktop install (#1128).
 * Matches steps from: packages/test-specs/features/platform/desktop/auth/invite-redemption.feature
 *
 * The scenario must prove a volunteer can get from the first screen of a fresh
 * install to a redeemed invite through the UI alone, so nothing here shortcuts
 * the app: the server address is typed into the first-run form (the packaged
 * build simulation starts with none configured — see tests/steps/config/), the
 * entry point is clicked on the login screen, and the code is pasted from the
 * clipboard into the code-entry screen — never injected via `?code=`. A clicked
 * `llamenos://hub-invite` link is delivered the way the OS would deliver it: at
 * the IPC boundary, through the mock's mirror of apps/desktop/src/deep_link.rs
 * (`__TEST_OPEN_DEEP_LINK__` / `__TEST_LAUNCH_DEEP_LINK__`, tests/mocks/tauri-core.ts).
 *
 * Only the Given (the admin creating the invite) and the final server-side
 * assertions use the API directly, as the admin would.
 */
import { expect, type Page, type Request } from '@playwright/test'
import { Given, When, Then } from '../fixtures'
import { TestIds } from '../../test-ids'
import { Timeouts, enterPin, TEST_PIN } from '../../helpers'
import { apiPost, getUserViaApi, listUsersViaApi, simulatedClientIp, uniqueName, uniquePhone } from '../../api-helpers'
import { harnessClientHeaders } from '../../dev-surface-secret'

interface InviteWorld {
  code: string
  name: string
  /** The hub the invite admits the volunteer to. */
  hubId: string
  /**
   * The volunteer's machine, as the per-client rate limiters see it. Each
   * scenario's volunteer is a different person on a different machine; one
   * shared bucket would make the suite's sixth code check answer 429.
   */
  clientHeaders: Record<string, string>
  /** `/api/invites/validate/*` requests the page sent after the code-entry screen opened. */
  validateRequests: string[]
}

// Scenario-scoped, keyed by the `page` fixture (fresh per scenario) — the same
// pattern tests/steps/config/server-address-steps.ts uses, so no new fixture
// has to be added to the shared tests/steps/fixtures.ts.
const invitesByPage = new WeakMap<Page, InviteWorld>()

// data-testids of the invite entry point and code-entry/onboarding screens
// (src/client/routes/login.tsx, src/client/routes/onboarding.tsx).
const Ids = {
  HAVE_INVITE_CODE_BTN: 'have-invite-code-btn',
  INVITE_CODE_INPUT: 'invite-code-input',
  INVITE_CODE_SUBMIT: 'invite-code-submit',
  INVITE_CODE_ERROR: 'invite-code-error',
  INVITE_CODE_SERVER: 'invite-code-server',
  ONBOARDING_WELCOME: 'onboarding-welcome',
  ONBOARDING_GET_STARTED_BTN: 'onboarding-get-started',
  ONBOARDING_PIN_CONFIRM: 'onboarding-pin-confirm',
  ONBOARDING_DOWNLOAD_BACKUP_BTN: 'onboarding-download-backup',
  ONBOARDING_BACKUP_ACK: 'onboarding-backup-acknowledge',
  ONBOARDING_CONTINUE_BTN: 'onboarding-continue',
} as const

function inviteFor(page: Page): InviteWorld {
  const invite = invitesByPage.get(page)
  if (!invite) throw new Error('No invite has been created for this scenario')
  return invite
}

/** Put `text` on the real clipboard and paste it into the focused code field. */
async function pasteIntoCodeField(page: Page, text: string): Promise<void> {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.evaluate(value => navigator.clipboard.writeText(value), text)
  const input = page.getByTestId(Ids.INVITE_CODE_INPUT)
  await input.click()
  await page.keyboard.press('ControlOrMeta+V')
}

async function validateInviteOnServer(page: Page, backendRequest: import('@playwright/test').APIRequestContext) {
  const invite = inviteFor(page)
  const res = await backendRequest.get(`/api/invites/validate/${invite.code}`, { headers: invite.clientHeaders })
  expect(res.status()).toBe(200)
  return (await res.json()) as { valid: boolean; error?: string }
}

Given('an admin has created an invite for a new volunteer', async ({ page, backendRequest, workerHub }) => {
  const name = uniqueName('InviteVol')
  // Named explicitly: with more than one hub on the server an invite that names
  // none is refused (400), and the suite's workers each create their own.
  const res = await apiPost<{ invite: { code: string } }>(backendRequest, '/invites', {
    name, phone: uniquePhone(), roleIds: ['role-volunteer'], hubId: workerHub,
  })
  expect(res.status).toBe(201)
  const clientHeaders = harnessClientHeaders(simulatedClientIp())
  // The app's own requests come from the same machine as the volunteer.
  await page.setExtraHTTPHeaders(clientHeaders)
  invitesByPage.set(page, { code: res.data.invite.code, name, hubId: workerHub, clientHeaders, validateRequests: [] })
})

Then('the server address field is pre-filled with the hosted default', async ({ page }) => {
  // Read the constant through the app's own module rather than restating it
  // here, so correcting the default stays a one-line edit in api-config.ts.
  const hostedDefault = await page.evaluate(() =>
    (window as unknown as { __TEST_API_CONFIG: { HOSTED_SERVER_ADDRESS: string } }).__TEST_API_CONFIG.HOSTED_SERVER_ADDRESS,
  )
  expect(hostedDefault).toMatch(/^https:\/\/[^/]+$/)
  await expect(page.getByTestId(TestIds.SERVER_ADDRESS_INPUT)).toHaveValue(hostedDefault, { timeout: Timeouts.ELEMENT })
})

When("I replace the server address with this app's backend and connect", async ({ page }) => {
  // The preview server proxies /api to the test backend, so this origin is a
  // real, reachable server: the first-run form health-probes it through the
  // IPC network layer, persists it via api_config_set, and reloads the app.
  const origin = new URL(page.url()).origin
  const input = page.getByTestId(TestIds.SERVER_ADDRESS_INPUT)
  await input.fill(origin)
  await page.getByTestId(TestIds.SERVER_ADDRESS_SUBMIT).click()
  await page.waitForURL(/\/login/, { timeout: Timeouts.AUTH })
})

When('I choose to enter an invite code', async ({ page }) => {
  const invite = invitesByPage.get(page)
  page.on('request', (req: Request) => {
    if (req.url().includes('/api/invites/validate/')) invite?.validateRequests.push(req.url())
  })
  await page.getByTestId(Ids.HAVE_INVITE_CODE_BTN).click()
  await expect(page.getByTestId(Ids.INVITE_CODE_INPUT)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the invite code screen names the server the code will be sent to', async ({ page }) => {
  const origin = new URL(page.url()).origin
  await expect(page.getByTestId(Ids.INVITE_CODE_SERVER)).toHaveText(origin)
})

When('I paste the invite code in upper case, wrapped in spaces and line breaks', async ({ page }) => {
  await pasteIntoCodeField(page, `\n  ${inviteFor(page).code.toUpperCase()}  \r\n\t`)
})

When('I paste the invite link for this server', async ({ page }) => {
  // The shape the admin copies (buildInviteLink): the configured server's own
  // address. In this scenario that is this app's origin (see the connect step).
  const origin = new URL(page.url()).origin
  await pasteIntoCodeField(page, `${origin}/onboarding?code=${inviteFor(page).code}\n`)
})

const OTHER_SERVER = 'https://other-hub.example.org'

When('I paste an invite link for a different server', async ({ page }) => {
  await pasteIntoCodeField(page, `${OTHER_SERVER}/onboarding?code=${inviteFor(page).code}`)
})

Then('I should see an invite code error naming the other server', async ({ page }) => {
  const error = page.getByTestId(Ids.INVITE_CODE_ERROR)
  await expect(error).toHaveAttribute('data-reason', 'otherServer', { timeout: Timeouts.ELEMENT })
  await expect(error).toContainText(OTHER_SERVER)
  await expect(page.getByTestId(Ids.INVITE_CODE_INPUT)).toBeEditable()
})

function deepLinkFor(page: Page): string {
  return `llamenos://hub-invite?code=${inviteFor(page).code}`
}

When('the volunteer clicks the invite deep link', async ({ page }) => {
  const accepted = await page.evaluate(
    url => (window as unknown as { __TEST_OPEN_DEEP_LINK__: (u: string) => boolean }).__TEST_OPEN_DEEP_LINK__(url),
    deepLinkFor(page),
  )
  expect(accepted, 'the deep link was refused by the shell').toBe(true)
})

When('the app is relaunched by the invite deep link', async ({ page }) => {
  // The OS starts the app with the link (Rust's `get_current`). One launch only:
  // init scripts re-run on every navigation, the launch argument does not.
  await page.addInitScript((url) => {
    if (sessionStorage.getItem('__test_launched_by_deep_link')) return
    sessionStorage.setItem('__test_launched_by_deep_link', '1')
    ;(window as unknown as Record<string, unknown>).__TEST_LAUNCH_DEEP_LINK__ = url
  }, deepLinkFor(page))
  await page.reload()
})

Then('I should be told to sign out before redeeming the invite', async ({ page }) => {
  await expect(page.getByTestId('toast-error')).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should still be signed in away from the redemption screen', async ({ page }) => {
  await expect(page).not.toHaveURL(/\/onboarding/)
  const unlocked = await page.evaluate(() =>
    (window as unknown as { __TEST_PLATFORM: { isCryptoUnlocked: () => Promise<boolean> } }).__TEST_PLATFORM.isCryptoUnlocked(),
  )
  expect(unlocked, 'the signed-in device key was locked or replaced').toBe(true)
})

When('I paste an invite code the server never issued', async ({ page }) => {
  await pasteIntoCodeField(page, crypto.randomUUID())
})

When('I paste {string} as the invite code', async ({ page }, text: string) => {
  await pasteIntoCodeField(page, text)
})

When('I submit the invite code', async ({ page }) => {
  await page.getByTestId(Ids.INVITE_CODE_SUBMIT).click()
})

Then('I should see the welcome screen for the invited volunteer', async ({ page }) => {
  await expect(page.getByTestId(Ids.ONBOARDING_WELCOME)).toContainText(inviteFor(page).name, { timeout: Timeouts.API })
})

async function createPin(page: Page): Promise<void> {
  await page.getByTestId(Ids.ONBOARDING_GET_STARTED_BTN).click()
  await enterPin(page, TEST_PIN)
  await expect(page.getByTestId(Ids.ONBOARDING_PIN_CONFIRM)).toBeVisible({ timeout: Timeouts.ELEMENT })
  await enterPin(page, TEST_PIN)
  // Key generation + redemption happen here; the recovery key only renders
  // once the server has accepted the redemption.
  await expect(page.getByTestId(TestIds.RECOVERY_KEY)).toBeVisible({ timeout: Timeouts.AUTH })
}

const recoveryKeysByPage = new WeakMap<Page, string>()

When('I create my PIN', async ({ page }) => {
  await createPin(page)
  recoveryKeysByPage.set(page, (await page.getByTestId(TestIds.RECOVERY_KEY).textContent())?.trim() ?? '')
})

When('a deep link for a second invite arrives', async ({ page, backendRequest, workerHub }) => {
  const res = await apiPost<{ invite: { code: string } }>(backendRequest, '/invites', {
    name: uniqueName('SecondInvite'), phone: uniquePhone(), roleIds: ['role-volunteer'], hubId: workerHub,
  })
  expect(res.status).toBe(201)
  const second = res.data.invite.code
  const accepted = await page.evaluate(
    url => (window as unknown as { __TEST_OPEN_DEEP_LINK__: (u: string) => boolean }).__TEST_OPEN_DEEP_LINK__(url),
    `llamenos://hub-invite?code=${second}`,
  )
  expect(accepted, 'the deep link was refused by the shell').toBe(true)
  // The app has acted on it once the address carries the new code.
  await page.waitForURL(url => url.searchParams.get('code') === second, { timeout: Timeouts.NAVIGATION })
})

Then('the recovery key on screen is still the one for my new account', async ({ page }) => {
  const shown = recoveryKeysByPage.get(page)
  expect(shown, 'no recovery key was recorded').toBeTruthy()
  await expect(page.getByTestId(TestIds.RECOVERY_KEY)).toHaveText(shown!)
})

When('I save my recovery key', async ({ page }) => {
  await saveRecoveryKey(page)
})

async function saveRecoveryKey(page: Page): Promise<void> {
  const download = page.waitForEvent('download', { timeout: Timeouts.API })
  await page.getByTestId(Ids.ONBOARDING_DOWNLOAD_BACKUP_BTN).click()
  await download
  await page.getByTestId(Ids.ONBOARDING_BACKUP_ACK).check()
  await page.getByTestId(Ids.ONBOARDING_CONTINUE_BTN).click()
}

When('I create my PIN and save my recovery key', async ({ page }) => {
  await createPin(page)
  await saveRecoveryKey(page)
})

Then('I should reach profile setup', async ({ page }) => {
  await page.waitForURL(/\/profile-setup/, { timeout: Timeouts.AUTH })
})

Then('the server should report the invite as already used', async ({ page, backendRequest }) => {
  expect(await validateInviteOnServer(page, backendRequest)).toEqual({ valid: false, error: 'already_used' })
})

Then('the server should still report the invite as unused', async ({ page, backendRequest }) => {
  expect(await validateInviteOnServer(page, backendRequest)).toMatchObject({ valid: true })
})

Then("the invited volunteer should now be a member of the invite's hub", async ({ page, backendRequest }) => {
  const invite = inviteFor(page)
  const users = await listUsersViaApi(backendRequest)
  const user = users.find(u => u.name === invite.name)
  expect(user, `no user named ${invite.name} after redemption`).toBeTruthy()
  expect(user!.pubkey).toMatch(/^[0-9a-f]{64}$/)
  // Membership, not just existence: redemption grants the invite's roles in
  // the invite's hub (identity.redeemInvite), and nothing else.
  const record = await getUserViaApi(backendRequest, user!.pubkey) as {
    hubRoles?: Array<{ hubId: string; roleIds: string[] }>
  }
  expect(record.hubRoles ?? []).toContainEqual({ hubId: invite.hubId, roleIds: ['role-volunteer'] })
})

Then('I should see an invite code error on the code entry screen', async ({ page }) => {
  await expect(page.getByTestId(Ids.INVITE_CODE_ERROR)).toBeVisible({ timeout: Timeouts.API })
  // Still on the entry screen, with the field available to correct — not a dead end.
  await expect(page.getByTestId(Ids.INVITE_CODE_INPUT)).toBeEditable()
})

Then('no invite code should have been sent to the server', async ({ page }) => {
  expect(inviteFor(page).validateRequests).toEqual([])
})
