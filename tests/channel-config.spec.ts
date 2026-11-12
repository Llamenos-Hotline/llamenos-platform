import { test, expect } from './console-guard'
import { loginAsAdmin, Timeouts } from './helpers'
import { mockAdminSettingsApi } from './admin-settings-api-mock'

// Channel-config tests need longer timeout for auth PBKDF2 + settings page load
test.setTimeout(90_000)

test.describe('Channel Configuration', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page)
    await mockAdminSettingsApi(page)
    // Use client-side navigation to avoid full page reload and re-PIN
    await page.getByTestId('nav-admin-settings').click()
    await page.getByTestId('page-title').waitFor({ state: 'visible', timeout: Timeouts.ELEMENT })
  })

  test('shows all five channel sections', async ({ page }) => {
    await expect(page.getByTestId('sms-channel')).toBeVisible({ timeout: Timeouts.ELEMENT })
    await expect(page.getByTestId('whatsapp-channel')).toBeVisible()
    await expect(page.getByTestId('signal-channel')).toBeVisible()
    await expect(page.getByTestId('telegram-channel')).toBeVisible()
    await expect(page.getByTestId('rcs-channel')).toBeVisible()
  })

  test('SMS section shows content mode selector', async ({ page }) => {
    await page.getByTestId('sms-channel-trigger').click()
    await expect(page.getByTestId('sms-content-mode')).toBeVisible({ timeout: Timeouts.ELEMENT })
    await expect(page.getByTestId('sms-enabled-toggle')).toBeVisible()
  })

  test('SMS section shows A2P registration panel', async ({ page }) => {
    await page.getByTestId('sms-channel-trigger').click()
    await expect(page.getByRole('heading', { name: 'A2P 10DLC Registration' })).toBeVisible({ timeout: Timeouts.ELEMENT })
  })

  test('WhatsApp section shows integration mode toggle', async ({ page }) => {
    await page.getByTestId('whatsapp-channel-trigger').click()
    await expect(page.getByTestId('whatsapp-integration-mode')).toBeVisible({ timeout: Timeouts.ELEMENT })
  })

  test('WhatsApp direct mode shows credential fields', async ({ page }) => {
    await page.getByTestId('whatsapp-channel-trigger').click()
    // Open the integration mode dropdown and select "Direct Meta API"
    await page.getByTestId('whatsapp-integration-mode').click()
    await page.getByText('Direct Meta API', { exact: true }).click()
    await expect(page.getByTestId('whatsapp-phone-number-id')).toBeVisible({ timeout: Timeouts.ELEMENT })
    await expect(page.getByTestId('whatsapp-access-token')).toBeVisible()
  })

  test('Telegram section shows bot token field', async ({ page }) => {
    await page.getByTestId('telegram-channel-trigger').click()
    await expect(page.getByTestId('telegram-bot-token')).toBeVisible({ timeout: Timeouts.ELEMENT })
    await expect(page.getByTestId('telegram-bot-username')).toBeVisible()
  })

  test('connection test button shows result badge', async ({ page }) => {
    await page.getByTestId('sms-channel-trigger').click()
    // Enable SMS first so the test button is not disabled
    await page.getByTestId('sms-enabled-toggle').click()
    await page.getByTestId('test-sms-btn').click()
    // Wait for the result badge (Badge component uses data-slot="badge")
    await expect(page.getByTestId('test-sms-btn').locator('..').locator('[data-slot="badge"]')).toBeVisible({ timeout: Timeouts.ELEMENT })
  })

  test('auto-response fields are present in each channel', async ({ page }) => {
    await page.getByTestId('sms-channel-trigger').click()
    await expect(page.getByTestId('sms-auto-response')).toBeVisible({ timeout: Timeouts.ELEMENT })
    await expect(page.getByTestId('sms-after-hours')).toBeVisible()
  })

  test('save button persists channel config', async ({ page }) => {
    await page.getByTestId('telegram-channel-trigger').click()
    await page.getByTestId('telegram-bot-token').fill('123456:ABC-TEST')
    await page.getByTestId('telegram-bot-username').fill('@TestBot')
    await page.getByTestId('telegram-save-btn').click()
    await expect(page.getByText('Success')).toBeVisible({ timeout: Timeouts.ELEMENT })
  })
})
