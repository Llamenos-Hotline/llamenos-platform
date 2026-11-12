import { test, expect } from './console-guard'
import { Timeouts, TestIds } from './helpers'

test.describe('Smoke tests', () => {
  test('app loads with correct title', async ({ page, request }) => {
    // Title is config-driven (HOTLINE_NAME env var). Fetch the real value first.
    const configRes = await request.get('/api/config')
    expect(configRes.ok()).toBeTruthy()
    const { hotlineName } = await configRes.json() as { hotlineName: string }
    await page.goto('/')
    await expect(page).toHaveTitle(hotlineName)
  })

  test('unauthenticated user is redirected to login', async ({ page }) => {
    await page.goto('/notes')
    // The root layout redirects to /login when not authenticated
    await page.waitForURL(/\/login/, { timeout: Timeouts.NAVIGATION })
  })

  test('login page renders with sign-in form', async ({ page }) => {
    await page.goto('/login')
    await page.waitForLoadState('domcontentloaded')
    // Identity is now a PIN-encrypted per-device Ed25519/X25519 key (nsec was removed).
    // With no stored key in a fresh browser context (and an admin already bootstrapped),
    // the login route renders the device-key entry form: a secret-key input plus a
    // submit button. Assert both are present.
    await expect(page.getByTestId(TestIds.DEVICE_KEY_INPUT)).toBeVisible({ timeout: Timeouts.ELEMENT })
    await expect(page.getByTestId(TestIds.LOGIN_SUBMIT_BTN)).toBeVisible({ timeout: Timeouts.ELEMENT })
  })

  test('rejects invalid device key on login', async ({ page }) => {
    await page.goto('/login')
    await page.waitForLoadState('domcontentloaded')
    const keyInput = page.getByTestId(TestIds.DEVICE_KEY_INPUT)
    await expect(keyInput).toBeVisible({ timeout: Timeouts.ELEMENT })
    // A device key must be 64 hex chars — this fails isValidSeedHex validation.
    await keyInput.fill('invalid-key')
    await page.getByTestId(TestIds.LOGIN_SUBMIT_BTN).click()
    // The login route surfaces validation failures via the login-error alert.
    await expect(page.getByTestId(TestIds.LOGIN_ERROR)).toBeVisible({ timeout: Timeouts.ELEMENT })
  })

  test('API health check responds', async ({ request }) => {
    // Use the Kubernetes liveness probe: it returns 200 whenever the server process
    // is alive, independent of optional dependency health. The full /api/health (and
    // /api/health/ready) can legitimately return 503 ('degraded') when an optional
    // dependency (e.g. object storage) is unreachable, which is not what a smoke
    // "is the API responding" check should assert.
    const res = await request.get('/api/health/live')
    expect(res.ok()).toBeTruthy()
    const body = await res.json() as { status: string }
    expect(body.status).toBe('ok')
  })

  test('API config endpoint responds', async ({ request }) => {
    const res = await request.get('/api/config')
    expect(res.ok()).toBeTruthy()
    const data = await res.json()
    expect(data).toHaveProperty('hotlineName')
  })
})
