import { devices } from '@playwright/test'
import { test, expect } from './console-guard'
import { loginAsAdmin } from './helpers'

test.use(devices['Pixel 7'])

test('mobile viewport shows hamburger menu', async ({ page }) => {
  await loginAsAdmin(page)

  // Hamburger button should be visible on mobile
  await expect(page.getByRole('button', { name: /open menu/i })).toBeVisible()

  // Sidebar links should be hidden (sidebar is invisible via CSS)
  await expect(page.getByRole('link', { name: 'Dashboard' })).toBeHidden()

  // Open the menu
  await page.getByRole('button', { name: /open menu/i }).click()

  // Now sidebar links should be visible
  await expect(page.getByRole('link', { name: 'Dashboard' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Notes' })).toBeVisible()

  // Close button should be visible
  await expect(page.getByRole('button', { name: /close sidebar/i })).toBeVisible()
  await page.getByRole('button', { name: /close sidebar/i }).click()

  // Links should be hidden again
  await expect(page.getByRole('link', { name: 'Dashboard' })).toBeHidden()
})

test('mobile page has no horizontal overflow', async ({ page }) => {
  await loginAsAdmin(page)

  // Check body doesn't overflow
  const bodyWidth = await page.evaluate(() => document.body.scrollWidth)
  const viewportWidth = await page.evaluate(() => window.innerWidth)
  expect(bodyWidth).toBeLessThanOrEqual(viewportWidth + 1) // +1 for rounding
})
