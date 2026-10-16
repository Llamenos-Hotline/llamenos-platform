/**
 * Records Architecture E2E Tests (Epic 124)
 *
 * Tests the unified records architecture features from Epics 119-123:
 * - Note threading (create notes, reply to notes)
 * - Conversation notes (add note from conversation detail)
 * - Contact view (admin-only, unified timeline)
 * - Custom field context filtering (call-notes, conversation-notes, reports)
 */
import { test, expect } from '@playwright/test'
import { loginAsAdmin, loginAsVolunteer, createUserAndGetDeviceKey, dismissDeviceKeyCard, navigateAfterLogin, TestIds, Navigation, uniquePhone, Timeouts, fillCallId } from './helpers'

test.describe('Records Architecture', () => {
  test.describe.configure({ mode: 'serial' })

  let volunteerNsec: string

  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page)
  })

  // ============ Note Threading ============

  test('admin can create a note and see reply button', async ({ page }) => {
    await Navigation.goToNotes(page)

    // Create a note
    await page.getByTestId(TestIds.NOTE_NEW_BTN).click()
    await expect(page.getByTestId(TestIds.NOTE_FORM)).toBeVisible()
    const callId = 'thread-test-' + Date.now()
    await fillCallId(page, callId)
    await page.getByTestId(TestIds.NOTE_CONTENT).fill('Note for threading test')
    await page.getByTestId(TestIds.FORM_SAVE_BTN).click()

    // Note should appear
    await expect(page.getByTestId(TestIds.NOTE_DETAIL_TEXT).filter({ hasText: 'Note for threading test' }).first()).toBeVisible({ timeout: 10000 })

    // Reply button should be visible
    await expect(page.getByTestId(TestIds.NOTE_REPLY_BTN).first()).toBeVisible()
  })

  test('admin can expand reply thread and send a reply', async ({ page }) => {
    await Navigation.goToNotes(page)

    // Create a note first
    await page.getByTestId(TestIds.NOTE_NEW_BTN).click()
    await expect(page.getByTestId(TestIds.NOTE_FORM)).toBeVisible()
    const callId = 'reply-test-' + Date.now()
    await fillCallId(page, callId)
    await page.getByTestId(TestIds.NOTE_CONTENT).fill('Note with reply')
    await page.getByTestId(TestIds.FORM_SAVE_BTN).click()
    await expect(page.getByTestId(TestIds.NOTE_DETAIL_TEXT).filter({ hasText: 'Note with reply' }).first()).toBeVisible({ timeout: 10000 })

    // Click reply button
    await page.getByTestId(TestIds.NOTE_REPLY_BTN).first().click()

    // Thread area should appear
    await expect(page.getByTestId(TestIds.NOTE_THREAD)).toBeVisible({ timeout: 5000 })

    // Reply text area should be visible
    const replyTextarea = page.getByTestId(TestIds.NOTE_REPLY_TEXT)
    await expect(replyTextarea).toBeVisible({ timeout: 5000 })

    // Type a reply
    await replyTextarea.fill('This is a threaded reply')

    // Send the reply
    await page.getByTestId(TestIds.NOTE_REPLY_SEND).click()

    // After sending, the reply count should update
    // Wait for the reply to be sent

    // The reply button text should now show "1 replies"
    // Wait for the async send (encrypt → API → state update) to complete
    const replyBtn = page.getByTestId(TestIds.NOTE_REPLY_BTN).first()
    await expect(replyBtn).toContainText(/1 repl/i, { timeout: Timeouts.API })
  })

  test('reply button shows count after collapse and re-expand', async ({ page }) => {
    await Navigation.goToNotes(page)

    // Create a note and add a reply
    await page.getByTestId(TestIds.NOTE_NEW_BTN).click()
    await expect(page.getByTestId(TestIds.NOTE_FORM)).toBeVisible()
    const callId = 'collapse-test-' + Date.now()
    await fillCallId(page, callId)
    await page.getByTestId(TestIds.NOTE_CONTENT).fill('Note for collapse test')
    await page.getByTestId(TestIds.FORM_SAVE_BTN).click()
    await expect(page.getByTestId(TestIds.NOTE_DETAIL_TEXT).filter({ hasText: 'Note for collapse test' }).first()).toBeVisible({ timeout: 10000 })

    // Expand thread and send reply
    await page.getByTestId(TestIds.NOTE_REPLY_BTN).first().click()
    await expect(page.getByTestId(TestIds.NOTE_THREAD)).toBeVisible({ timeout: 5000 })
    const replyTextarea = page.getByTestId(TestIds.NOTE_REPLY_TEXT)
    await expect(replyTextarea).toBeVisible({ timeout: 5000 })
    await replyTextarea.fill('Reply to collapse test')
    await page.getByTestId(TestIds.NOTE_REPLY_SEND).click()

    // Wait for the reply to be registered before collapsing
    await expect(page.getByTestId(TestIds.NOTE_REPLY_BTN).first()).toContainText(/1 repl/i, { timeout: Timeouts.API })

    // Collapse thread
    await page.getByTestId(TestIds.NOTE_REPLY_BTN).first().click()
    await expect(page.getByTestId(TestIds.NOTE_THREAD)).not.toBeVisible()

    // Re-expand — reply count should persist
    const replyBtn = page.getByTestId(TestIds.NOTE_REPLY_BTN).first()
    await expect(replyBtn).toContainText(/1 repl/i)
  })

  // ============ Note Sheet — Conversation Notes ============

  test('conversations page renders correctly', async ({ page }) => {
    // Navigate directly (Conversations link may not be in nav if channels are not configured)
    await navigateAfterLogin(page, '/conversations')

    // The conversations page should render its content — either the conversation list,
    // an empty state, or a "no channels configured" notice. Report cards must NOT appear.
    const content = page.getByTestId(TestIds.CONVERSATION_LIST)
      .or(page.getByTestId(TestIds.CONVERSATION_ITEM).first())
      .or(page.getByTestId(TestIds.EMPTY_STATE))
      .or(page.getByText(/no channels configured|conversations/i).first())
    await expect(content.first()).toBeVisible({ timeout: 10000 })

    // Report cards must NOT appear on the conversations page
    await expect(page.getByTestId(TestIds.REPORT_CARD).first()).not.toBeVisible()
  })

  // ============ Contact View Tests ============

  test('admin can navigate to contacts page', async ({ page }) => {
    await Navigation.goToContacts(page)
    await expect(page.getByRole('heading', { name: /contacts/i })).toBeVisible()
    // Should show description text
    await expect(page.getByText(/unified interaction history/i)).toBeVisible()
  })

  test('contacts page shows contact rows or empty state', async ({ page }) => {
    await Navigation.goToContacts(page)
    // After loading, the page must show either contact rows or an empty state — never blank
    const content = page.getByTestId(TestIds.CONTACT_ROW).first()
      .or(page.getByTestId(TestIds.EMPTY_STATE))
    await expect(content).toBeVisible({ timeout: 10000 })
  })

  test('volunteer cannot see contacts nav link', async ({ page }) => {
    // Create a volunteer first
    volunteerNsec = await createUserAndGetDeviceKey(page, `Vol-${Date.now()}`, uniquePhone())
    await dismissDeviceKeyCard(page)

    // Login as volunteer
    await loginAsVolunteer(page, volunteerNsec)

    // Contacts link should not be visible in nav
    const contactsLink = page.getByRole('link', { name: 'Contacts' })
    await expect(contactsLink).not.toBeVisible()
  })

  test('volunteer without contacts:view cannot see contacts nav', async ({ page }) => {
    test.skip(!volunteerNsec, 'Volunteer nsec not available from previous test')
    await loginAsVolunteer(page, volunteerNsec)

    // Wait for the app to fully load

    // The contacts nav link should not be visible for a default volunteer role
    const contactsLink = page.getByRole('link', { name: 'Contacts' })
    await expect(contactsLink).not.toBeVisible()
  })

  // ============ Custom Fields Context Filtering ============

  test('custom fields section supports context selection', async ({ page }) => {
    await page.getByTestId('nav-admin-settings').click()
    await expect(page.getByTestId('page-title').or(page.getByTestId('admin-section-heading'))).toBeVisible()

    // Expand custom fields section by clicking its trigger
    const customFieldsTrigger = page.getByTestId(`${TestIds.SETTINGS_CUSTOM_FIELDS}-trigger`)
    await customFieldsTrigger.scrollIntoViewIfNeeded()
    await customFieldsTrigger.click()

    const addFieldBtn = page.getByRole('button', { name: /add field/i })
    await expect(addFieldBtn).toBeVisible({ timeout: 10000 })

    // Click Add Field
    await addFieldBtn.click()

    // Should see context selector (labelled "Context" in en.json)
    const contextSelect = page.getByTestId('field-context-select')
    await expect(contextSelect).toBeVisible({ timeout: 5000 })
  })

  // ============ Notes Page Structure ============

  test('notes page shows note list or empty state, not conversation cards', async ({ page }) => {
    await Navigation.goToNotes(page)

    // The notes page must show the note list, an individual note card, or empty state
    const content = page.getByTestId(TestIds.NOTE_LIST)
      .or(page.getByTestId(TestIds.NOTE_CARD).first())
      .or(page.getByTestId(TestIds.NOTE_NEW_BTN))
      .or(page.getByTestId(TestIds.EMPTY_STATE))
    await expect(content.first()).toBeVisible({ timeout: 10000 })

    // Conversation list elements must NOT appear on the notes page
    await expect(page.getByTestId(TestIds.CONVERSATION_LIST)).not.toBeVisible()
    await expect(page.getByTestId(TestIds.CONVERSATION_ITEM).first()).not.toBeVisible()
  })

  test('notes grouped by call or conversation', async ({ page }) => {
    await Navigation.goToNotes(page)

    // Create two notes for the same call
    const callId = 'group-' + Date.now()

    await page.getByTestId(TestIds.NOTE_NEW_BTN).click()
    await expect(page.getByTestId(TestIds.NOTE_FORM)).toBeVisible()
    await fillCallId(page, callId)
    await page.getByTestId(TestIds.NOTE_CONTENT).fill('Grouped note A')
    await page.getByTestId(TestIds.FORM_SAVE_BTN).click()
    await expect(page.getByTestId(TestIds.NOTE_DETAIL_TEXT).filter({ hasText: 'Grouped note A' }).first()).toBeVisible({ timeout: 10000 })

    await page.getByTestId(TestIds.NOTE_NEW_BTN).click()
    await expect(page.getByTestId(TestIds.NOTE_FORM)).toBeVisible()
    await fillCallId(page, callId)
    await page.getByTestId(TestIds.NOTE_CONTENT).fill('Grouped note B')
    await page.getByTestId(TestIds.FORM_SAVE_BTN).click()
    await expect(page.getByTestId(TestIds.NOTE_DETAIL_TEXT).filter({ hasText: 'Grouped note B' }).first()).toBeVisible({ timeout: 10000 })

    // Both should be grouped under the same card
    const callCard = page.locator('div').filter({ hasText: callId.slice(0, 12) }).first()
    await expect(callCard).toBeVisible()
  })

  // ============ Report Isolation ============

  test('reports page shows reports and new-report button, not conversation cards', async ({ page }) => {
    // Seed a report via API so the page has content.
    // Use the active hub from the browser session so the report lands in the same hub
    // the UI is browsing — otherwise the report appears in the wrong hub and the page
    // shows empty state despite the API call succeeding.
    const { createReportViaApi } = await import('./api-helpers')
    const activeHubId = await page.evaluate(() => {
      const getHub = (window as unknown as Record<string, unknown>).__TEST_GET_ACTIVE_HUB as (() => string) | undefined
      return getHub ? getHub() : undefined
    }).catch(() => undefined)
    await createReportViaApi(page.request, { title: `Isolation Report ${Date.now()}`, hubId: activeHubId })

    await Navigation.goToReports(page)

    // At least one report card or the new-report button should be visible
    await expect(page.getByTestId(TestIds.REPORT_CARD).first()).toBeVisible({ timeout: 10000 })

    // Conversation list element must NOT appear on the reports page
    await expect(page.getByTestId(TestIds.CONVERSATION_LIST)).not.toBeVisible()
  })

  test('conversations page does not show report cards', async ({ page }) => {
    // Navigate directly (Conversations link may not be in nav if channels are not configured)
    await navigateAfterLogin(page, '/conversations')

    // Page should render — either conversation list, empty state, or no-channels notice
    const heading = page.locator('h1', { hasText: /conversations/i })
    await expect(heading).toBeVisible({ timeout: 10000 })

    // Report cards must NOT appear on the conversations page
    await expect(page.getByTestId(TestIds.REPORT_CARD).first()).not.toBeVisible()
  })
})
