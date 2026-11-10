/**
 * Auth guard step definitions.
 * Matches steps from: packages/test-specs/features/desktop/auth/auth-guards.feature
 * Covers route protection, PIN re-entry after reload, logout clearing session, and API 401.
 *
 * Behavioral depth: Unauthenticated API call uses real request (no auth headers)
 * to verify 401 enforcement. PIN re-entry uses real enterPin flow.
 */
import { expect } from '@playwright/test'
import { Given, When, Then } from '../fixtures'
import { enterPin, TEST_PIN } from '../../helpers'

Given('I am not authenticated', async ({ page }) => {
  await page.goto('/login')
  await page.evaluate(() => {
    localStorage.clear()
    sessionStorage.clear()
  })
})

When('I reload the page', async ({ page }) => {
  await page.reload()
})

When('I re-enter the correct PIN', async ({ page }) => {
  await enterPin(page, TEST_PIN)
})

When('I make an unauthenticated API request to {string}', async ({ page, apiWorld }, endpoint: string) => {
  // Intentionally NO auth headers — verifying the server rejects unauthenticated requests
  const response = await page.request.get(endpoint)
  apiWorld.responseStatus = response.status()
})

Then('the response status should be {int}', async ({ apiWorld }, expectedStatus: number) => {
  expect(apiWorld.responseStatus).toBe(expectedStatus)
})
