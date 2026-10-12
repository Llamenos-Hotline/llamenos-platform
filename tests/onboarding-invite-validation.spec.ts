import { test, expect } from '@playwright/test'

/**
 * Regression specs for #1712: validateInvite used to ignore the HTTP status,
 * so a 429 (or any non-2xx, or a network failure) was presented to the
 * invitee as a terminal "Invalid invite code" verdict with no way back.
 * These specs stub `/api/invites/validate/:code` at the network layer and
 * assert the retryable outcome is distinguishable from a real verdict.
 */

const CODE = '1712-test-invite-code'

function fulfillJson(route: import('@playwright/test').Route, status: number, body: unknown, headers: Record<string, string> = {}) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers,
    body: JSON.stringify(body),
  })
}

test.describe('onboarding invite validation (#1712)', () => {
  test('429 rate limit shows a retryable message with the wait hint, never "Invalid invite code", and Try again recovers', async ({ page }) => {
    let calls = 0
    await page.route('**/api/invites/validate/*', async (route) => {
      calls += 1
      if (calls === 1) {
        await fulfillJson(route, 429, { error: 'Rate limit exceeded', retryAfterSeconds: 27 })
      } else {
        await fulfillJson(route, 200, { valid: true, name: 'Test Volunteer', roleIds: ['role-volunteer'] })
      }
    })

    await page.goto(`/onboarding?code=${CODE}`)

    const errorMsg = page.getByTestId('onboarding-error-message')
    await expect(errorMsg).toBeVisible()
    await expect(errorMsg).toContainText('Too many attempts')
    await expect(errorMsg).toContainText('27')
    await expect(errorMsg).not.toContainText('Invalid invite code')

    // The screen is not terminal: retry re-validates and the valid invite proceeds
    await page.getByTestId('onboarding-retry').click()
    await expect(page.getByTestId('onboarding-welcome-title')).toBeVisible()
    expect(calls).toBe(2)
  })

  test('a genuine invalid verdict (200 valid:false) stays terminal and offers no retry', async ({ page }) => {
    await page.route('**/api/invites/validate/*', (route) =>
      fulfillJson(route, 200, { valid: false }),
    )

    await page.goto(`/onboarding?code=${CODE}`)

    const errorMsg = page.getByTestId('onboarding-error-message')
    await expect(errorMsg).toBeVisible()
    await expect(errorMsg).toContainText('Invalid invite code')
    await expect(page.getByTestId('onboarding-retry')).toHaveCount(0)
    await expect(page.getByTestId('onboarding-go-to-login')).toBeVisible()
  })

  test('a network failure shows the connection message and offers retry', async ({ page }) => {
    let calls = 0
    await page.route('**/api/invites/validate/*', async (route) => {
      calls += 1
      if (calls === 1) {
        await route.abort('connectionfailed')
      } else {
        await fulfillJson(route, 200, { valid: true, name: 'Test Volunteer' })
      }
    })

    await page.goto(`/onboarding?code=${CODE}`)

    const errorMsg = page.getByTestId('onboarding-error-message')
    await expect(errorMsg).toBeVisible()
    await expect(errorMsg).toContainText("Couldn't validate your invite")
    await expect(errorMsg).not.toContainText('Invalid invite code')

    await page.getByTestId('onboarding-retry').click()
    await expect(page.getByTestId('onboarding-welcome-title')).toBeVisible()
  })

  test('a non-JSON proxy error page (502) is retryable, not a verdict', async ({ page }) => {
    await page.route('**/api/invites/validate/*', (route) =>
      route.fulfill({ status: 502, contentType: 'text/html', body: '<html><body>Bad Gateway</body></html>' }),
    )

    await page.goto(`/onboarding?code=${CODE}`)

    const errorMsg = page.getByTestId('onboarding-error-message')
    await expect(errorMsg).toBeVisible()
    await expect(errorMsg).toContainText("Couldn't validate your invite")
    await expect(errorMsg).not.toContainText('Invalid invite code')
    await expect(page.getByTestId('onboarding-retry')).toBeVisible()
  })
})
