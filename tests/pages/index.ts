/**
 * Page Object utilities for Playwright tests.
 *
 * These helpers encapsulate common page interactions and make tests more
 * readable and maintainable. Changes to the UI only need updates here,
 * not across all test files.
 */

import { type Page, type Locator, expect } from '@playwright/test'
import { TestIds } from '../test-ids'
import { Timeouts } from '../helpers'

// ============ Base Page Helpers ============

/**
 * Wait for API response and UI to settle after an action.
 * Prefer this over arbitrary waitForTimeout when waiting for state updates.
 */
export async function waitForApiAndUi(page: Page, timeout = 2000): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout }).catch(() => {})
}

/**
 * Click a button and wait for API response pattern.
 * Useful for save/submit actions that trigger API calls.
 */
export async function clickAndWaitForApi(
  page: Page,
  buttonLocator: Locator,
  apiPattern: string | RegExp,
): Promise<void> {
  await Promise.all([
    page.waitForResponse(r => {
      const url = r.url()
      return typeof apiPattern === 'string' ? url.includes(apiPattern) : apiPattern.test(url)
    }),
    buttonLocator.click(),
  ])
}

// ============ Navigation Helpers ============

export const Navigation = {
  async goToDashboard(page: Page): Promise<void> {
    await page.getByTestId(TestIds.NAV_DASHBOARD).click()
    await expect(page.getByTestId(TestIds.PAGE_TITLE)).toBeVisible({ timeout: Timeouts.ELEMENT })
  },

  async goToVolunteers(page: Page): Promise<void> {
    await page.getByTestId(TestIds.NAV_VOLUNTEERS).click()
    await expect(page.getByTestId(TestIds.PAGE_TITLE)).toBeVisible({ timeout: Timeouts.ELEMENT })
  },

  async goToShifts(page: Page): Promise<void> {
    await page.getByTestId(TestIds.NAV_SHIFTS).click()
    await expect(page.getByTestId(TestIds.PAGE_TITLE)).toBeVisible({ timeout: Timeouts.ELEMENT })
    // Wait for page data to finish loading so button click targets don't get detached
    // during in-flight API re-renders (shifts + users + fallback group are loaded in parallel)
    await waitForApiAndUi(page)
  },

  async goToBanList(page: Page): Promise<void> {
    await page.getByTestId(TestIds.NAV_BANS).click()
    await expect(page.getByTestId(TestIds.PAGE_TITLE)).toBeVisible({ timeout: Timeouts.ELEMENT })
  },

  async goToNotes(page: Page): Promise<void> {
    await page.getByTestId(TestIds.NAV_NOTES).click()
    await expect(page.getByTestId(TestIds.PAGE_TITLE)).toBeVisible({ timeout: Timeouts.ELEMENT })
  },

  async goToCallHistory(page: Page): Promise<void> {
    await page.getByTestId(TestIds.NAV_CALLS).click()
    await expect(page.getByTestId(TestIds.PAGE_TITLE)).toBeVisible({ timeout: Timeouts.ELEMENT })
  },

  async goToAuditLog(page: Page): Promise<void> {
    await page.getByTestId(TestIds.NAV_AUDIT).click()
    await expect(page.getByTestId(TestIds.PAGE_TITLE)).toBeVisible({ timeout: Timeouts.ELEMENT })
  },

  async goToSettings(page: Page): Promise<void> {
    const navSettings = page.getByTestId(TestIds.NAV_SETTINGS)
    const isVisible = await navSettings.isVisible({ timeout: 3000 }).catch(() => false)
    if (!isVisible) {
      // Not authenticated yet — login first
      const { loginAsAdmin } = await import('../helpers')
      await loginAsAdmin(page)
    }
    await page.getByTestId(TestIds.NAV_SETTINGS).click()
    await expect(page.getByTestId(TestIds.PAGE_TITLE)).toBeVisible({ timeout: Timeouts.ELEMENT })
  },

  async goToHubSettings(page: Page): Promise<void> {
    const navLink = page.getByTestId(TestIds.NAV_ADMIN_SETTINGS)
    const isLink = await navLink.isVisible({ timeout: Timeouts.ELEMENT }).catch(() => false)
    if (isLink) {
      await navLink.click()
    } else {
      // Nav link may not be visible (sidebar collapsed, or not admin) — try direct URL navigation
      await page.goto('/admin')
      await page.waitForLoadState('domcontentloaded')
    }
    await expect(page.getByTestId(TestIds.PAGE_TITLE).or(page.getByTestId('admin-section-heading'))).toBeVisible({ timeout: Timeouts.ELEMENT })
  },

  async goToReports(page: Page): Promise<void> {
    await page.getByTestId(TestIds.NAV_REPORTS).click()
    await expect(page.getByTestId(TestIds.PAGE_TITLE)).toBeVisible({ timeout: Timeouts.ELEMENT })
  },

  async goToConversations(page: Page): Promise<void> {
    await page.getByTestId(TestIds.NAV_CONVERSATIONS).click()
    await expect(page.getByTestId(TestIds.PAGE_TITLE)).toBeVisible({ timeout: Timeouts.ELEMENT })
  },

  async goToBlasts(page: Page): Promise<void> {
    await page.getByTestId(TestIds.NAV_BLASTS).click()
    await expect(page.getByTestId(TestIds.PAGE_TITLE)).toBeVisible({ timeout: Timeouts.ELEMENT })
  },

  async goToContacts(page: Page): Promise<void> {
    await page.getByTestId(TestIds.NAV_CONTACTS).click()
    await expect(page.getByTestId(TestIds.PAGE_TITLE)).toBeVisible({ timeout: Timeouts.ELEMENT })
  },
}

// ============ Volunteer Page ============

export const VolunteerPage = {
  /**
   * Get a volunteer row by name.
   */
  getRow(page: Page, name: string): Locator {
    return page.getByTestId(TestIds.VOLUNTEER_ROW).filter({ hasText: name })
  },

  /**
   * Get a volunteer row by pubkey using the data-volunteer-id attribute.
   */
  getRowById(page: Page, pubkey: string): Locator {
    return page.locator(`[data-testid="volunteer-row"][data-volunteer-id="${pubkey.slice(0, 8)}"]`)
  },

  /**
   * Change a volunteer's primary role through the row's role Select, and wait for the
   * PATCH to succeed and the row badge to reflect it. Fails loudly at every stage — never
   * silently skips the write.
   */
  async changeRole(page: Page, row: Locator, pubkey: string, role: { id: string; name: string }): Promise<void> {
    const trigger = row.getByTestId(TestIds.VOLUNTEER_ROW_ROLE_SELECT)
    await expect(trigger).toBeVisible({ timeout: Timeouts.ELEMENT })
    await trigger.click()
    const option = page.locator(`[data-testid="${TestIds.VOLUNTEER_ROW_ROLE_OPTION}"][data-role-id="${role.id}"]`)
    await expect(option).toBeVisible({ timeout: Timeouts.ELEMENT })
    const patchResponse = page.waitForResponse(
      res => res.url().includes(`/users/${pubkey}`) && res.request().method() === 'PATCH',
      { timeout: Timeouts.API },
    )
    await option.click()
    expect((await patchResponse).ok(), `PATCH /users/${pubkey.slice(0, 8)} role change failed`).toBe(true)
    await expect(row.getByTestId(TestIds.VOLUNTEER_ROW_ROLE_BADGE)).toContainText(role.name, { timeout: Timeouts.ELEMENT })
  },

  /**
   * Open the add volunteer form.
   */
  async openAddForm(page: Page): Promise<void> {
    await page.getByTestId(TestIds.VOLUNTEER_ADD_BTN).click()
    await expect(page.getByLabel('Name')).toBeVisible()
  },

  /**
   * Fill and submit the add volunteer form.
   */
  async addVolunteer(page: Page, name: string, phone: string): Promise<void> {
    await page.getByLabel('Name').fill(name)
    await page.getByLabel('Phone Number').fill(phone)
    await page.getByLabel('Phone Number').blur()
    await page.getByTestId(TestIds.FORM_SAVE_BTN).click()
    await expect(page.getByTestId(TestIds.VOLUNTEER_DEVICE_KEY_CODE)).toBeVisible({ timeout: 15000 })
  },

  /**
   * Get the generated nsec from the nsec card.
   */
  async getNsec(page: Page): Promise<string> {
    const nsecCode = page.getByTestId(TestIds.VOLUNTEER_DEVICE_KEY_CODE)
    await expect(nsecCode).toBeVisible({ timeout: 15000 })
    const nsec = await nsecCode.textContent()
    if (!nsec) throw new Error('Failed to get nsec')
    return nsec
  },

  /**
   * Dismiss the nsec card.
   */
  async dismissDeviceKeyCard(page: Page): Promise<void> {
    await page.getByTestId(TestIds.DISMISS_DEVICE_KEY).click()
    await expect(page.getByTestId(TestIds.DISMISS_DEVICE_KEY)).not.toBeVisible()
  },

  /**
   * Delete a volunteer by name.
   */
  async deleteVolunteer(page: Page, name: string): Promise<void> {
    const row = this.getRow(page, name)
    await row.getByTestId(TestIds.VOLUNTEER_DELETE_BTN).click()
    await page.getByTestId(TestIds.CONFIRM_DIALOG_OK).click()
    await expect(page.getByRole('dialog')).toBeHidden()
  },
}

// ============ Shift Page ============

export const ShiftPage = {
  /**
   * Get a shift card by name.
   */
  getCard(page: Page, name: string): Locator {
    return page.getByTestId(TestIds.SHIFT_CARD).filter({ hasText: name })
  },

  /**
   * Open the create shift form.
   */
  async openCreateForm(page: Page): Promise<void> {
    await page.getByTestId(TestIds.SHIFT_CREATE_BTN).click()
    await expect(page.getByTestId(TestIds.SHIFT_FORM)).toBeVisible()
  },

  /**
   * Fill and submit the shift form.
   */
  async createShift(
    page: Page,
    name: string,
    options?: { startTime?: string; endTime?: string },
  ): Promise<void> {
    await page.getByTestId(TestIds.SHIFT_NAME_INPUT).fill(name)
    if (options?.startTime) {
      await page.getByTestId(TestIds.SHIFT_START_TIME).fill(options.startTime)
    }
    if (options?.endTime) {
      await page.getByTestId(TestIds.SHIFT_END_TIME).fill(options.endTime)
    }
    await page.getByTestId(TestIds.FORM_SAVE_BTN).click()
    await expect(page.getByText(name)).toBeVisible({ timeout: 10000 })
  },

  /**
   * Edit a shift by name.
   */
  async openEditForm(page: Page, name: string): Promise<void> {
    const card = this.getCard(page, name)
    await card.getByTestId(TestIds.SHIFT_EDIT_BTN).click()
    await expect(page.getByTestId(TestIds.SHIFT_FORM)).toBeVisible()
  },

  /**
   * Delete a shift by name.
   */
  async deleteShift(page: Page, name: string): Promise<void> {
    const card = this.getCard(page, name)
    await card.getByTestId(TestIds.SHIFT_DELETE_BTN).click()
    await expect(page.getByText(name)).not.toBeVisible()
  },

  /**
   * Get the fallback group card.
   */
  getFallbackCard(page: Page): Locator {
    return page.getByTestId(TestIds.FALLBACK_GROUP_CARD)
  },
}

// ============ Ban List Page ============

export const BanListPage = {
  /**
   * Get a ban row by its reason. The list shows a reason and a date and no
   * number: the server keeps none for a ban.
   */
  getRow(page: Page, reason: string): Locator {
    return page.getByTestId(TestIds.BAN_ROW).filter({ hasText: reason })
  },

  /**
   * Open the add ban form.
   */
  async openAddForm(page: Page): Promise<void> {
    await page.getByTestId(TestIds.BAN_ADD_BTN).click()
    await expect(page.getByTestId(TestIds.BAN_FORM)).toBeVisible()
  },

  /**
   * Add a ban.
   */
  async addBan(page: Page, phone: string, reason: string): Promise<void> {
    await page.getByLabel(/phone number/i).fill(phone)
    await page.getByLabel(/phone number/i).blur()
    await page.getByLabel(/reason/i).fill(reason)
    await page.getByTestId(TestIds.FORM_SAVE_BTN).click()
    await expect(this.getRow(page, reason).first()).toBeVisible({ timeout: 10000 })
  },

  /**
   * Remove a ban by its reason.
   */
  async removeBan(page: Page, reason: string): Promise<void> {
    const row = this.getRow(page, reason)
    await row.getByTestId(TestIds.BAN_REMOVE_BTN).click()
    await page.getByTestId(TestIds.CONFIRM_DIALOG_OK).click()
    await expect(page.getByRole('dialog')).toBeHidden()
    await expect(this.getRow(page, reason)).toHaveCount(0)
  },

  /**
   * Open bulk import form.
   */
  async openBulkImport(page: Page): Promise<void> {
    await page.getByTestId(TestIds.BAN_IMPORT_BTN).click()
    await expect(page.getByTestId(TestIds.BAN_BULK_FORM)).toBeVisible()
  },
}

// ============ Notes Page ============

export const NotesPage = {
  /**
   * Open the new note form.
   */
  async openNewForm(page: Page): Promise<void> {
    await page.getByTestId(TestIds.NOTE_NEW_BTN).click()
    await expect(page.getByTestId(TestIds.NOTE_FORM)).toBeVisible()
  },

  /**
   * Create a note.
   */
  async createNote(page: Page, callId: string, content: string): Promise<void> {
    await page.getByTestId(TestIds.NOTE_CALL_ID).fill(callId)
    await page.getByTestId(TestIds.NOTE_CONTENT).fill(content)
    await page.getByTestId(TestIds.FORM_SAVE_BTN).click()
    await expect(page.locator('p').filter({ hasText: content })).toBeVisible()
  },

  /**
   * Get a note card.
   */
  getCard(page: Page, content: string): Locator {
    return page.getByTestId(TestIds.NOTE_CARD).filter({ hasText: content })
  },
}

// ============ Call History Page ============

export const CallHistoryPage = {
  /**
   * Search for calls.
   */
  async search(page: Page, query: string): Promise<void> {
    await page.getByTestId(TestIds.CALL_SEARCH).fill(query)
    await page.getByTestId(TestIds.CALL_SEARCH_BTN).click()
    await expect(page.getByTestId(TestIds.CALL_CLEAR_FILTERS)).toBeVisible()
  },

  /**
   * Clear search filters.
   */
  async clearFilters(page: Page): Promise<void> {
    await page.getByTestId(TestIds.CALL_CLEAR_FILTERS).click()
  },
}

// ============ Dialog Helpers ============

export const Dialogs = {
  /**
   * Confirm a dialog.
   */
  async confirm(page: Page): Promise<void> {
    await page.getByTestId(TestIds.CONFIRM_DIALOG_OK).click()
    await expect(page.getByRole('dialog')).toBeHidden()
  },

  /**
   * Cancel a dialog.
   */
  async cancel(page: Page): Promise<void> {
    await page.getByTestId(TestIds.CONFIRM_DIALOG_CANCEL).click()
    await expect(page.getByRole('dialog')).toBeHidden()
  },

  /**
   * Wait for a dialog to appear.
   */
  async waitForDialog(page: Page): Promise<void> {
    await expect(page.getByRole('dialog')).toBeVisible()
  },
}

// ============ Form Helpers ============

export const Forms = {
  /**
   * Save a form.
   */
  async save(page: Page): Promise<void> {
    await page.getByTestId(TestIds.FORM_SAVE_BTN).click()
  },

  /**
   * Cancel a form.
   */
  async cancel(page: Page): Promise<void> {
    await page.getByTestId(TestIds.FORM_CANCEL_BTN).click()
  },

  /**
   * Submit a form.
   */
  async submit(page: Page): Promise<void> {
    await page.getByTestId(TestIds.FORM_SUBMIT_BTN).click()
  },
}
