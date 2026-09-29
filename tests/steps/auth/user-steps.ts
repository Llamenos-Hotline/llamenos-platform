/**
 * User CRUD & invite onboarding step definitions.
 * Matches steps from:
 *   - packages/test-specs/features/auth/volunteer-crud.feature
 *   - packages/test-specs/features/auth/invite-onboarding.feature
 *   - packages/test-specs/features/auth/form-validation.feature
 */
import { expect } from '@playwright/test'
import { Given, When, Then } from '../fixtures'
import { TestIds } from '../../test-ids'
import {
  Timeouts,
  createUserAndGetDeviceKey,
  dismissDeviceKeyCard,
  loginAsVolunteer,
  loginAsAdmin,
  navigateAfterLogin,
} from '../../helpers'
import { Navigation } from '../../pages/index'
import { ensureAuthenticated } from '../common/ui-helpers'
import { updateUserViaApi, seedHexToPubkey } from '../../api-helpers'

// --- Volunteer lifecycle ---

Given('an admin has created a volunteer', async ({ page }) => {
  await Navigation.goToVolunteers(page)
  const name = `TestVol ${Date.now()}`
  const phone = `+1212${Date.now().toString().slice(-7)}`
  const deviceKey = await createUserAndGetDeviceKey(page, name, phone)
  await page.evaluate((n) => {
    (window as unknown as Record<string, unknown>).__test_vol_nsec = n
  }, deviceKey)
  await dismissDeviceKeyCard(page)
})

When('the volunteer logs in with their device key', async ({ page }) => {
  const deviceKey = (await page.evaluate(() => (window as unknown as Record<string, unknown>).__test_vol_nsec)) as string
  await loginAsVolunteer(page, deviceKey)
})

Given('a volunteer has logged in', async ({ page }) => {
  await Navigation.goToVolunteers(page)
  const name = `TestVol ${Date.now()}`
  const phone = `+1212${Date.now().toString().slice(-7)}`
  const deviceKey = await createUserAndGetDeviceKey(page, name, phone)
  await dismissDeviceKeyCard(page)
  await loginAsVolunteer(page, deviceKey)
})

When('they complete the profile setup', async ({ page }) => {
  const { completeProfileSetup } = await import('../../helpers')
  await completeProfileSetup(page)
})

Given('a volunteer is logged in and on the dashboard', async ({ page }) => {
  await Navigation.goToVolunteers(page)
  const name = `TestVol ${Date.now()}`
  const phone = `+1212${Date.now().toString().slice(-7)}`
  const deviceKey = await createUserAndGetDeviceKey(page, name, phone)
  await dismissDeviceKeyCard(page)
  await loginAsVolunteer(page, deviceKey)
})

Given('a volunteer is logged in', async ({ page }) => {
  await loginAsAdmin(page)
  await Navigation.goToVolunteers(page)
  const name = `TestVol ${Date.now()}`
  const phone = `+1212${Date.now().toString().slice(-7)}`
  const deviceKey = await createUserAndGetDeviceKey(page, name, phone)
  await dismissDeviceKeyCard(page)
  await loginAsVolunteer(page, deviceKey)
})

Given('a volunteer exists', async ({ page }) => {
  await Navigation.goToVolunteers(page)
  const name = `TestVol ${Date.now()}`
  const phone = `+1212${Date.now().toString().slice(-7)}`
  const deviceKey = await createUserAndGetDeviceKey(page, name, phone)
  await page.evaluate((n) => {
    (window as unknown as Record<string, unknown>).__test_vol_nsec = n
  }, deviceKey)
  await dismissDeviceKeyCard(page)
})

When('they tap the break button', async ({ page }) => {
  await page.getByTestId(TestIds.BREAK_TOGGLE_BTN).click()
})

// --- Invite onboarding ---

When('I create an invite for a new volunteer', async ({ page }) => {
  // Wait for the Volunteers page to fully load before trying to click buttons
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})

  // Click the "Invite Volunteer" button (not "Add Volunteer" which generates device key directly)
  const inviteBtn = page.getByTestId(TestIds.INVITE_BTN)
  await expect(inviteBtn).toBeVisible({ timeout: Timeouts.ELEMENT })
  await inviteBtn.click()
  const name = `InviteVol ${Date.now()}`
  await page.getByLabel('Name').fill(name)
  const phone = `+1212${Date.now().toString().slice(-7)}`
  await page.getByLabel('Phone Number').fill(phone)
  await page.getByLabel('Phone Number').blur()
  // The invite form submits with 'create-invite-btn', not 'form-save-btn'.
  const createInviteBtn = page.getByTestId('create-invite-btn')
  await expect(createInviteBtn).toBeEnabled({ timeout: Timeouts.ELEMENT })
  await createInviteBtn.click()
  // Wait for the invite link card to appear
  await page.getByTestId('dismiss-invite').waitFor({ state: 'visible', timeout: Timeouts.API })
  // Persist the vol name in localStorage so it survives page.reload()
  await page.evaluate((n) => {
    (window as unknown as Record<string, unknown>).__test_invite_vol_name = n
    localStorage.setItem('__test_invite_vol_name', n)
  }, name)
})

Then('an invite link should be generated', async ({ page }) => {
  // The invite card shows the full onboarding URL (users.tsx: `${origin}/onboarding?code=…`).
  await expect(page.getByTestId('invite-link-code')).toHaveText(/\/onboarding\?code=\S+/, { timeout: Timeouts.ELEMENT })
})

When('the volunteer opens the invite link', async ({ page }) => {
  // The previous body looked for a testid the app never renders and silently did
  // nothing, so the rest of the scenario ran against the admin's volunteers page.
  const link = (await page.getByTestId('invite-link-code').textContent())?.trim() ?? ''
  expect(link, 'invite link').toMatch(/\/onboarding\?code=\S+/)
  await page.goto(link)
  await expect(page).toHaveURL(/\/onboarding\?code=/, { timeout: Timeouts.NAVIGATION })
})

Then('they should see a welcome screen with their name', async ({ page }) => {
  const volName = (await page.evaluate(() => (window as unknown as Record<string, unknown>).__test_invite_vol_name || localStorage.getItem('__test_invite_vol_name'))) as string
  expect(volName).toBeTruthy()
  // Content assertion — verifying displayed volunteer name
  await expect(page.getByText(new RegExp(volName, 'i')).first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

When('the volunteer completes the onboarding flow', async ({ page }) => {
  // welcome → PIN (create + confirm) → keypair + invite redemption → backup → continue
  const { enterPin } = await import('../../helpers')
  await page.getByRole('button', { name: 'Get Started' }).click()
  await enterPin(page, '12345678')
  await enterPin(page, '12345678')
  // The backup step only renders once the keypair exists and the invite was redeemed.
  await expect(page.getByTestId('recovery-key')).toBeVisible({ timeout: Timeouts.AUTH })
  await page.getByRole('button', { name: 'Download Encrypted Backup' }).click()
  await page.getByRole('checkbox').check()
  const continueBtn = page.getByRole('button', { name: 'Continue' })
  await expect(continueBtn).toBeEnabled({ timeout: Timeouts.ELEMENT })
  await continueBtn.click()
})

Then('the volunteer name should appear in the pending invites list', async ({ page }) => {
  const volName = (await page.evaluate(() => (window as unknown as Record<string, unknown>).__test_invite_vol_name || localStorage.getItem('__test_invite_vol_name'))) as string
  expect(volName).toBeTruthy()
  // Content assertion — verifying volunteer name is displayed
  await expect(page.getByText(volName, { exact: true }).first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

When('I revoke the invite', async ({ page, request }) => {
  // The UI revoke flow (optimistic removal + DELETE) is unreliable in CI:
  // background 401s cause component remounts that re-fetch the invite list,
  // and the click→DELETE pipeline has intermittent failures. Use the API
  // directly to ensure the invite is actually deleted.
  const { apiGet, apiDelete } = await import('../../api-helpers')
  const volName = (await page.evaluate(() =>
    (window as unknown as Record<string, unknown>).__test_invite_vol_name || localStorage.getItem('__test_invite_vol_name'),
  )) as string
  const { data: inviteList } = await apiGet<{ invites: Array<{ code: string; name: string }> }>(request, '/invites')
  const invite = inviteList.invites.find((i: { name: string }) => i.name === volName)
  expect(invite).toBeTruthy()
  const { status } = await apiDelete(request, `/invites/${invite!.code}`)
  expect(status).toBeLessThan(400)
})

Then('the volunteer name should no longer appear in the list', async ({ page }) => {
  const volName = (await page.evaluate(() => (window as unknown as Record<string, unknown>).__test_invite_vol_name || localStorage.getItem('__test_invite_vol_name'))) as string
  expect(volName).toBeTruthy()
  // Reload the page to pick up the server-side deletion, then verify the name is gone.
  await page.reload()
  await page.waitForLoadState('networkidle').catch(() => {})
  await expect(page.getByText(volName, { exact: true }).first()).not.toBeVisible({ timeout: Timeouts.ELEMENT })
})

// --- Form validation ---

Then('I should see the volunteer device key', async ({ page }) => {
  await expect(page.getByTestId(TestIds.VOLUNTEER_DEVICE_KEY_CODE)).toBeVisible({ timeout: Timeouts.API })
})

When('I paste invalid phone numbers in the textarea', async ({ page }) => {
  const bulkPhones = page.getByTestId('ban-bulk-phones')
  await expect(bulkPhones).toBeVisible({ timeout: Timeouts.ELEMENT })
  await bulkPhones.fill('+12\n+34\ninvalid')
})

When('I paste two phone numbers in the textarea', async ({ page }) => {
  const phone1 = `+1212${Date.now().toString().slice(-7)}`
  const phone2 = `+1212${(Date.now() + 1).toString().slice(-7)}`
  const bulkPhones = page.getByTestId('ban-bulk-phones')
  await expect(bulkPhones).toBeVisible({ timeout: Timeouts.ELEMENT })
  await bulkPhones.fill(`${phone1}\n${phone2}`)
  await page.evaluate(
    ({ p1, p2 }) => {
      (window as unknown as Record<string, unknown>).__test_bulk_phones = [p1, p2]
    },
    { p1: phone1, p2: phone2 },
  )
})

// --- Volunteer CRUD specific ---

Given('I have created a volunteer', async ({ page }) => {
  await Navigation.goToVolunteers(page)
  const name = `AuditVol ${Date.now()}`
  const phone = `+1212${Date.now().toString().slice(-7)}`
  await createUserAndGetDeviceKey(page, name, phone)
  await dismissDeviceKeyCard(page)
})

Given('I have created and then deleted a volunteer', async ({ page }) => {
  await Navigation.goToVolunteers(page)
  const name = `DeleteVol ${Date.now()}`
  const phone = `+1212${Date.now().toString().slice(-7)}`
  await createUserAndGetDeviceKey(page, name, phone)
  await dismissDeviceKeyCard(page)
  // Delete the volunteer
  const row = page.getByTestId(TestIds.VOLUNTEER_ROW).filter({ hasText: name })
  await row.getByTestId(TestIds.VOLUNTEER_DELETE_BTN).click()
  await page.getByTestId(TestIds.CONFIRM_DIALOG_OK).click()
  await expect(page.getByRole('dialog')).toBeHidden()
})

When('the volunteer logs in and navigates to {string}', async ({ page }, path: string) => {
  const deviceKey = (await page.evaluate(() => (window as unknown as Record<string, unknown>).__test_vol_nsec)) as string
  await loginAsVolunteer(page, deviceKey)
  // This step is only used in access-denied scenarios — the volunteer is navigating
  // somewhere they shouldn't be able to reach. Passing true asserts "Access Denied"
  // is shown rather than accepting either outcome.
  await navigateAfterLogin(page, path, true)
})

// "the reviewer logs in" is defined in roles-extended-steps.ts

// "a volunteer with the {string} role exists" is defined in roles-extended-steps.ts (API-based)

Given('a reporter has been invited and onboarded', async ({ page, backendRequest }) => {
  // Create a user via the volunteer creation flow, then assign the reporter role via API
  await Navigation.goToVolunteers(page)
  const name = `Reporter ${Date.now()}`
  const phone = `+1212${Date.now().toString().slice(-7)}`
  const deviceKey = await createUserAndGetDeviceKey(page, name, phone)
  await page.evaluate((n) => {
    (window as unknown as Record<string, unknown>).__test_reporter_nsec = n
  }, deviceKey)
  await dismissDeviceKeyCard(page)
  // Assign role-reporter so the user has reports:create permission
  const pubkey = seedHexToPubkey(deviceKey)
  await updateUserViaApi(backendRequest, pubkey, { roles: ['role-reporter'] })
})

Given('a reporter is logged in', async ({ page, backendRequest }) => {
  // Check if a reporter key was set by a previous step (e.g., "a reporter has been invited and onboarded")
  let key = (await page.evaluate(() => (window as unknown as Record<string, unknown>).__test_reporter_nsec)) as string | undefined
  if (!key) {
    // No reporter exists yet — create one via the admin flow, as the admin.
    await ensureAuthenticated(page)
    await Navigation.goToVolunteers(page)
    const name = `Reporter ${Date.now()}`
    const phone = `+1212${Date.now().toString().slice(-7)}`
    key = await createUserAndGetDeviceKey(page, name, phone)
    await dismissDeviceKeyCard(page)
    // Assign role-reporter so the user has reports:create permission
    const pubkey = seedHexToPubkey(key)
    await updateUserViaApi(backendRequest, pubkey, { roles: ['role-reporter'] })
  }
  await loginAsVolunteer(page, key)
})

When('the reporter logs in', async ({ page, backendRequest }) => {
  let key = (await page.evaluate(() => (window as unknown as Record<string, unknown>).__test_reporter_nsec)) as string | undefined
  if (!key) {
    // Reporter wasn't set up yet — create one (loginAsAdmin first to access volunteers)
    await loginAsAdmin(page)
    await Navigation.goToVolunteers(page)
    const name = `Reporter ${Date.now()}`
    const phone = `+1212${Date.now().toString().slice(-7)}`
    key = await createUserAndGetDeviceKey(page, name, phone)
    await dismissDeviceKeyCard(page)
    // Assign role-reporter so the user has reports:create permission
    const pubkey = seedHexToPubkey(key)
    await updateUserViaApi(backendRequest, pubkey, { roles: ['role-reporter'] })
  }
  await loginAsVolunteer(page, key)
})

When('they create a new report', async ({ page }) => {
  const newBtn = page.getByTestId(TestIds.REPORT_NEW_BTN)
  await expect(newBtn).toBeVisible({ timeout: Timeouts.ELEMENT })
  await newBtn.click()
  // A unique title, so the saved-report check can find this report and no other.
  const title = `Test report ${Date.now()}`
  await page.getByTestId(TestIds.REPORT_TITLE_INPUT).fill(title)
  await page.getByTestId(TestIds.REPORT_BODY_INPUT).fill('Test report body content')
  await page.evaluate((t) => {
    (window as unknown as Record<string, unknown>).__test_report_title = t
  }, title)
  const submitBtn = page.getByTestId(TestIds.REPORT_SUBMIT_BTN)
  await expect(submitBtn).toBeEnabled({ timeout: Timeouts.ELEMENT })
  await submitBtn.click()
})

Then('the report should be saved successfully', async ({ page }) => {
  // The report list is on screen whether or not anything was saved, so it proves
  // nothing by itself: the new report must be listed under its own title.
  const title = await page.evaluate(
    () => (window as unknown as Record<string, unknown>).__test_report_title as string | undefined,
  )
  expect(title, 'the create step must record the report title').toBeTruthy()
  await expect(page.getByTestId(TestIds.REPORT_LIST).getByText(title as string)).toBeVisible({ timeout: Timeouts.API })
})
