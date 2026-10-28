/**
 * Ban management step definitions.
 * Matches steps from: packages/test-specs/features/bans/ban-management.feature
 *
 * Behavioral depth: All CRUD operations verify state via API, not just UI presence.
 *
 * The server keeps no number for a ban — not masked, not as last digits — so a
 * ban row shows only its reason and date. Rows are therefore found by reason,
 * which each scenario sets and which is unique within the scenario's own hub,
 * and the assertions include that the number is NOT on the page or in the API.
 */
import { expect, type Page } from '@playwright/test'
import { Given, When, Then } from '../fixtures'
import { TestIds } from '../../test-ids'
import { Timeouts } from '../../helpers'
import { listBansViaApi } from '../../api-helpers'

type TestWindow = Record<string, unknown>

/** Remember the ban reason / numbers a scenario used; rows are located by reason. */
async function remember(page: Page, key: string, value: unknown): Promise<void> {
  await page.evaluate(([k, v]) => { (window as unknown as TestWindow)[k as string] = v }, [key, value] as const)
    .catch(async () => {
      // Context destroyed due to navigation — wait for page to settle and retry
      await page.waitForLoadState('domcontentloaded')
      await page.evaluate(([k, v]) => { (window as unknown as TestWindow)[k as string] = v }, [key, value] as const)
    })
}

async function recalled<T>(page: Page, key: string): Promise<T> {
  const value = (await page.evaluate((k) => (window as unknown as TestWindow)[k], key)) as T | undefined
  expect(value, `scenario did not record ${key}`).toBeTruthy()
  return value as T
}

const banRow = (page: Page, reason: string) => page.getByTestId(TestIds.BAN_ROW).filter({ hasText: reason })

/** The ban list shows a reason and a date and none of the banned number's digits. */
async function expectRowShowsNoNumber(page: Page, reason: string, phone: string): Promise<void> {
  const text = (await banRow(page, reason).first().innerText()).replace(/\D/g, '')
  expect(text).not.toContain(phone.replace(/\D/g, '').slice(-7))
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
  await remember(page, '__test_ban_phone', phone)
})

When('I fill in the phone number with {string}', async ({ page }, phone: string) => {
  await page.getByLabel(/phone/i).fill(phone)
  await page.getByLabel(/phone/i).blur()
})

Then('the phone number should appear in the ban list', async ({ page, backendRequest: request, workerHub }) => {
  const phone = await recalled<string>(page, '__test_ban_phone')
  const reason = await recalled<string>(page, '__test_ban_reason')

  // UI: the ban is listed by its reason, and the number is nowhere on the row.
  await expect(banRow(page, reason).first()).toBeVisible({ timeout: Timeouts.ELEMENT })
  await expectRowShowsNoNumber(page, reason, phone)

  // API: the ban exists, and carries no number of any kind.
  const bans = await listBansViaApi(request, workerHub)
  const found = bans.find(b => b.reason === reason)
  expect(found).toBeTruthy()
  expect(found).not.toHaveProperty('phone')
})

When('I add a ban with reason {string}', async ({ page }, reason: string) => {
  await page.getByTestId(TestIds.BAN_ADD_BTN).click()
  const phone = `+1212${Date.now().toString().slice(-7)}`
  await page.getByLabel(/phone/i).fill(phone)
  await page.getByLabel(/phone/i).blur()
  await page.getByLabel(/reason/i).fill(reason)
  await page.getByTestId(TestIds.FORM_SAVE_BTN).click()
  await remember(page, '__test_ban_phone', phone)
  await remember(page, '__test_ban_reason', reason)
})

Then('the ban entry should contain the current year', async ({ page }) => {
  const year = new Date().getFullYear().toString()
  const row = page.getByTestId(TestIds.BAN_ROW).filter({ hasText: year })
  await expect(row.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Given('a ban exists', async ({ page, backendRequest: request, workerHub }) => {
  const reason = 'Test ban'
  await page.getByTestId(TestIds.BAN_ADD_BTN).click()
  const phone = `+1212${Date.now().toString().slice(-7)}`
  await page.getByLabel(/phone/i).fill(phone)
  await page.getByLabel(/phone/i).blur()
  await page.getByLabel(/reason/i).fill(reason)
  await page.getByTestId(TestIds.FORM_SAVE_BTN).click()

  // Wait for the UI to show the ban
  await expect(banRow(page, reason).first()).toBeVisible({ timeout: Timeouts.ELEMENT })

  // Verify it was persisted to backend
  const bans = await listBansViaApi(request, workerHub)
  expect(bans.find(b => b.reason === reason)).toBeTruthy()

  await remember(page, '__test_ban_phone', phone)
  await remember(page, '__test_ban_reason', reason)
})

When('I click {string} on the ban', async ({ page }, buttonText: string) => {
  const reason = await recalled<string>(page, '__test_ban_reason')
  const row = banRow(page, reason)
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
  const reason = await recalled<string>(page, '__test_ban_reason')

  // UI verification
  await expect(banRow(page, reason)).not.toBeVisible({ timeout: Timeouts.ELEMENT })

  // API verification: ban is gone from backend
  const bans = await listBansViaApi(request, workerHub)
  expect(bans.find(b => b.reason === reason)).toBeUndefined()
})

Then('the ban should still appear in the list', async ({ page, backendRequest: request, workerHub }) => {
  const reason = await recalled<string>(page, '__test_ban_reason')

  // UI verification
  await expect(banRow(page, reason)).toBeVisible({ timeout: Timeouts.ELEMENT })

  // API verification: ban still exists
  const bans = await listBansViaApi(request, workerHub)
  expect(bans.find(b => b.reason === reason)).toBeTruthy()
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

  await page.getByTestId(TestIds.BAN_ADD_BTN).click()
  await page.getByLabel(/phone/i).fill(phone1)
  await page.getByLabel(/phone/i).blur()
  await page.getByLabel(/reason/i).fill('Reason 1')
  await page.getByTestId(TestIds.FORM_SAVE_BTN).click()
  await expect(banRow(page, 'Reason 1')).toBeVisible({ timeout: Timeouts.ELEMENT })

  await page.getByTestId(TestIds.BAN_ADD_BTN).click()
  await page.getByLabel(/phone/i).fill(phone2)
  await page.getByLabel(/phone/i).blur()
  await page.getByLabel(/reason/i).fill('Reason 2')
  await page.getByTestId(TestIds.FORM_SAVE_BTN).click()
  await expect(banRow(page, 'Reason 2')).toBeVisible({ timeout: Timeouts.ELEMENT })

  await remember(page, '__test_ban_phones', [phone1, phone2])
})

Then('both phone numbers should appear in the ban list', async ({ page, backendRequest: request, workerHub }) => {
  const phones = (await page.evaluate(() => (window as unknown as TestWindow).__test_ban_phones)) as string[] | undefined
  // The add/import step records the two numbers it banned. If it did not, there is
  // nothing to verify and the scenario must fail (the old branch fell back to
  // "the ban page loaded").
  expect(phones ?? [], 'the add/import step must record the phones it banned').toHaveLength(2)

  // The two bans were made in this scenario's own hub, so the list holds exactly
  // two, neither carrying a number.
  const bans = await listBansViaApi(request, workerHub)
  expect(bans).toHaveLength(2)
  for (const ban of bans) expect(ban).not.toHaveProperty('phone')

  // UI: two rows, none showing either number's digits.
  const rows = page.getByTestId(TestIds.BAN_ROW)
  await expect(rows).toHaveCount(2, { timeout: Timeouts.ELEMENT })
  const text = (await rows.allInnerTexts()).join(' ').replace(/\D/g, '')
  for (const phone of phones!) expect(text).not.toContain(phone.replace(/\D/g, '').slice(-7))
})

Then('both ban reasons should be visible', async ({ page }) => {
  await expect(banRow(page, 'Reason 1').first()).toBeVisible({ timeout: Timeouts.ELEMENT })
  await expect(banRow(page, 'Reason 2').first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})
