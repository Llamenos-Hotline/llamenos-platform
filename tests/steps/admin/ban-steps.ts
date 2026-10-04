/**
 * Ban management step definitions.
 * Matches steps from: packages/test-specs/features/bans/ban-management.feature
 *
 * Behavioral depth: All CRUD operations verify state via API, not just UI presence.
 *
 * Note: Phone numbers are masked server-side (HIGH-W3 security fix). The API
 * stores only `***XXXX` (last 4 digits) for admin display. UI and API
 * assertions use the masked format.
 */
import { expect } from '@playwright/test'
import { Given, When, Then } from '../fixtures'
import { TestIds } from '../../test-ids'
import { Timeouts } from '../../helpers'
import { listBansViaApi } from '../../api-helpers'

/** Convert a full E.164 phone to the server's masked format: `***` + last 4 digits */
function maskPhone(phone: string): string {
  return phone.length >= 4 ? `***${phone.slice(-4)}` : '***'
}

Then('I should see bans or the {string} message', async ({ page }, emptyMsg: string) => {
  // bans.tsx renders exactly one of: skeleton (loading) | empty-state | ban-list. Wait for
  // the fetch to settle into one of the two terminal states, then assert that state's
  // content. The old three-way isVisible/catch chain ignored its own timeouts, never read
  // the message it was given, and fell back to "page title visible" as a pass.
  const banList = page.getByTestId(TestIds.BAN_LIST)
  const emptyState = page.getByTestId(TestIds.EMPTY_STATE)
  await expect(banList.or(emptyState)).toBeVisible({ timeout: Timeouts.API })

  if (await emptyState.count() > 0) {
    await expect(emptyState).toContainText(emptyMsg)
  } else {
    await expect(banList.getByTestId(TestIds.BAN_ROW).first()).toBeVisible({ timeout: Timeouts.ELEMENT })
  }
})

When('I fill in the phone number', async ({ page }) => {
  const phone = `+1212${Date.now().toString().slice(-7)}`
  await page.getByLabel(/phone/i).fill(phone)
  await page.getByLabel(/phone/i).blur()
  await page.evaluate((p) => {
    (window as unknown as Record<string, unknown>).__test_ban_phone = p
  }, phone)
})

When('I fill in the phone number with {string}', async ({ page }, phone: string) => {
  await page.getByLabel(/phone/i).fill(phone)
  await page.getByLabel(/phone/i).blur()
})

Then('the phone number should appear in the ban list', async ({ page, backendRequest: request, workerHub }) => {
  const phone = (await page.evaluate(() => (window as unknown as Record<string, unknown>).__test_ban_phone)) as string
  expect(phone).toBeTruthy()
  const masked = maskPhone(phone)

  // UI verification — phone is displayed in masked format (HIGH-W3)
  await expect(
    page.getByTestId(TestIds.BAN_LIST).getByText(masked),
  ).toBeVisible({ timeout: Timeouts.ELEMENT })

  // API verification: ban exists in backend (phone field is masked)
  const bans = await listBansViaApi(request, workerHub)
  const found = bans.find(b => b.phone === masked)
  expect(found).toBeTruthy()
})

When('I add a ban with reason {string}', async ({ page }, reason: string) => {
  await page.getByTestId(TestIds.BAN_ADD_BTN).click()
  const phone = `+1212${Date.now().toString().slice(-7)}`
  await page.getByLabel(/phone/i).fill(phone)
  await page.getByLabel(/phone/i).blur()
  await page.getByLabel(/reason/i).fill(reason)
  await page.getByTestId(TestIds.FORM_SAVE_BTN).click()
  await page.evaluate((p) => {
    (window as unknown as Record<string, unknown>).__test_ban_phone = p
  }, phone)
})

Then('the ban entry should contain the current year', async ({ page }) => {
  const year = new Date().getFullYear().toString()
  const banRow = page.getByTestId(TestIds.BAN_ROW).filter({ hasText: year })
  await expect(banRow.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Given('a ban exists', async ({ page, backendRequest: request, workerHub }) => {
  await page.getByTestId(TestIds.BAN_ADD_BTN).click()
  const phone = `+1212${Date.now().toString().slice(-7)}`
  await page.getByLabel(/phone/i).fill(phone)
  await page.getByLabel(/phone/i).blur()
  await page.getByLabel(/reason/i).fill('Test ban')
  await page.getByTestId(TestIds.FORM_SAVE_BTN).click()
  const masked = maskPhone(phone)

  // Wait for UI to show the ban (masked format)
  await expect(
    page.getByTestId(TestIds.BAN_ROW).filter({ hasText: masked }).first(),
  ).toBeVisible({ timeout: Timeouts.ELEMENT })

  // Verify it was persisted to backend
  const bans = await listBansViaApi(request, workerHub)
  const found = bans.find(b => b.phone === masked)
  expect(found).toBeTruthy()

  // Store the phone for later steps — retry if context was destroyed
  await page.evaluate((p) => {
    (window as unknown as Record<string, unknown>).__test_ban_phone = p
  }, phone).catch(async () => {
    // Context destroyed due to navigation — wait for page to settle and retry
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate((p) => {
      (window as unknown as Record<string, unknown>).__test_ban_phone = p
    }, phone)
  })
})

When('I click {string} on the ban', async ({ page }, buttonText: string) => {
  const phone = (await page.evaluate(() => (window as unknown as Record<string, unknown>).__test_ban_phone)) as string
  expect(phone).toBeTruthy()
  const masked = maskPhone(phone)
  const row = page.getByTestId(TestIds.BAN_ROW).filter({ hasText: masked })
  if (buttonText.toLowerCase() === 'remove' || buttonText.toLowerCase() === 'delete') {
    await row.getByTestId(TestIds.BAN_REMOVE_BTN).click()
  } else {
    await row.getByRole('button', { name: new RegExp(buttonText, 'i') }).click()
  }
})

When('I click {string} in the dialog', async ({ page }, buttonText: string) => {
  const lower = buttonText.toLowerCase()
  if (lower === 'confirm' || lower === 'ok' || lower === 'yes' || lower === 'unban') {
    await page.getByTestId(TestIds.CONFIRM_DIALOG_OK).click()
  } else if (lower === 'cancel') {
    await page.getByTestId(TestIds.CONFIRM_DIALOG_CANCEL).click()
  } else {
    await page.getByTestId(TestIds.CONFIRM_DIALOG).getByRole('button', { name: new RegExp(buttonText, 'i') }).click()
  }
})

Then('the dialog should close', async ({ page }) => {
  await expect(page.getByTestId(TestIds.CONFIRM_DIALOG)).not.toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the ban should no longer appear in the list', async ({ page, backendRequest: request, workerHub }) => {
  const phone = (await page.evaluate(() => (window as unknown as Record<string, unknown>).__test_ban_phone)) as string
  expect(phone).toBeTruthy()
  const masked = maskPhone(phone)

  // UI verification
  await expect(
    page.getByTestId(TestIds.BAN_ROW).filter({ hasText: masked }),
  ).not.toBeVisible({ timeout: Timeouts.ELEMENT })

  // API verification: ban is gone from backend
  const bans = await listBansViaApi(request, workerHub)
  const found = bans.find(b => b.phone === masked)
  expect(found).toBeUndefined()
})

Then('the ban should still appear in the list', async ({ page, backendRequest: request, workerHub }) => {
  const phone = (await page.evaluate(() => (window as unknown as Record<string, unknown>).__test_ban_phone)) as string
  expect(phone).toBeTruthy()
  const masked = maskPhone(phone)

  // UI verification
  await expect(
    page.getByTestId(TestIds.BAN_ROW).filter({ hasText: masked }),
  ).toBeVisible({ timeout: Timeouts.ELEMENT })

  // API verification: ban still exists
  const bans = await listBansViaApi(request, workerHub)
  const found = bans.find(b => b.phone === masked)
  expect(found).toBeTruthy()
})

Then('the phone number input should be visible', async ({ page }) => {
  await expect(page.getByLabel(/phone/i)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the phone number input should not be visible', async ({ page }) => {
  await expect(page.getByLabel(/phone/i)).not.toBeVisible({ timeout: 3000 })
})

When('I add two bans with different phone numbers', async ({ page }) => {
  const phone1 = `+1212${Date.now().toString().slice(-7)}`
  // Small delay to ensure unique timestamp
  const phone2 = `+1212${(Date.now() + 1).toString().slice(-7)}`
  const masked1 = maskPhone(phone1)
  const masked2 = maskPhone(phone2)

  await page.getByTestId(TestIds.BAN_ADD_BTN).click()
  await page.getByLabel(/phone/i).fill(phone1)
  await page.getByLabel(/phone/i).blur()
  await page.getByLabel(/reason/i).fill('Reason 1')
  await page.getByTestId(TestIds.FORM_SAVE_BTN).click()
  await expect(
    page.getByTestId(TestIds.BAN_ROW).filter({ hasText: masked1 }),
  ).toBeVisible({ timeout: Timeouts.ELEMENT })

  await page.getByTestId(TestIds.BAN_ADD_BTN).click()
  await page.getByLabel(/phone/i).fill(phone2)
  await page.getByLabel(/phone/i).blur()
  await page.getByLabel(/reason/i).fill('Reason 2')
  await page.getByTestId(TestIds.FORM_SAVE_BTN).click()
  await expect(
    page.getByTestId(TestIds.BAN_ROW).filter({ hasText: masked2 }),
  ).toBeVisible({ timeout: Timeouts.ELEMENT })

  await page.evaluate(
    ({ p1, p2 }) => {
      (window as unknown as Record<string, unknown>).__test_ban_phones = [p1, p2]
    },
    { p1: phone1, p2: phone2 },
  )
})

Then('both phone numbers should appear in the ban list', async ({ page, backendRequest: request, workerHub }) => {
  const recorded = (await page.evaluate(() => (window as unknown as Record<string, unknown>).__test_ban_phones)) as string[] | undefined
  // The import step records the two numbers it banned. If it did not, there is
  // nothing to verify and the scenario must fail (the old branch fell back to
  // "the ban page loaded").
  const phones = recorded ?? []
  expect(phones, 'the bulk-import step must record the phones it banned').toHaveLength(2)

  // UI verification (masked format)
  for (const phone of phones) {
    const masked = maskPhone(phone)
    await expect(
      page.getByTestId(TestIds.BAN_ROW).filter({ hasText: masked }),
    ).toBeVisible({ timeout: Timeouts.ELEMENT })
  }

  // API verification (phone field is masked)
  const bans = await listBansViaApi(request, workerHub)
  for (const phone of phones) {
    const masked = maskPhone(phone)
    const found = bans.find(b => b.phone === masked)
    expect(found).toBeTruthy()
  }
})

Then('both ban reasons should be visible', async ({ page }) => {
  await expect(
    page.getByTestId(TestIds.BAN_ROW).filter({ hasText: 'Reason 1' }).first(),
  ).toBeVisible({ timeout: Timeouts.ELEMENT })
  await expect(
    page.getByTestId(TestIds.BAN_ROW).filter({ hasText: 'Reason 2' }).first(),
  ).toBeVisible({ timeout: Timeouts.ELEMENT })
})
