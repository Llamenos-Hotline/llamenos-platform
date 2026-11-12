import { test, expect } from './console-guard'
import { loginAsAdmin, reenterPinAfterReload, Timeouts } from './helpers'
import type { MockUpdateConfig } from './mocks/tauri-updater'

/**
 * Helper to reload, set mock update, and re-enter PIN to get back to authenticated state.
 * The __MOCK_UPDATE must be set BEFORE the UpdateChecker's 5s startup delay fires.
 */
async function reloadWithMockUpdate(page: import('@playwright/test').Page, mockUpdate: MockUpdateConfig) {
  // Set mock before reload so it's ready when JS evaluates (won't survive reload though)
  await page.reload()
  await page.waitForLoadState('domcontentloaded')

  // Set mock update immediately after reload, before the 5s scheduler delay
  await page.evaluate((update) => {
    window.__MOCK_UPDATE = update
  }, mockUpdate)

  // Re-enter PIN to get back to authenticated state
  await reenterPinAfterReload(page)

  // Wait for sidebar to confirm we're authenticated
  await page.waitForSelector('[data-testid="nav-sidebar"]', { timeout: Timeouts.AUTH })

  // Re-set mock update after auth (in case auth navigation cleared it)
  await page.evaluate((update) => {
    window.__MOCK_UPDATE = update
  }, mockUpdate)
}

test.describe('Auto-Update (Epic 289)', () => {
  // Tests in this suite do multiple reload+PIN cycles (loginAsAdmin + reloadWithMockUpdate),
  // so they need more time than the default 30s test timeout.
  test.setTimeout(90_000)

  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page)
    // Wait for dashboard to load
    await page.waitForSelector('[data-testid="nav-sidebar"]', { timeout: 30000 })
  })

  test('no update banner shown when no update available', async ({ page }) => {
    // By default, __MOCK_UPDATE is not set, so no update
    // Wait a bit to ensure the checker has run (startup delay is 5s, but in tests it should be fast)
    await expect(page.locator('[data-testid="update-banner"]')).not.toBeVisible()
  })

  test('shows update banner when update is available', async ({ page }) => {
    const mockUpdate = {
      version: '99.0.0',
      body: 'Important security fixes and performance improvements',
      date: '2026-03-08T00:00:00Z',
    }

    await reloadWithMockUpdate(page, mockUpdate)

    // Wait for the update banner (checker runs after 5s delay)
    const banner = page.locator('[data-testid="update-banner"]')
    await expect(banner).toBeVisible({ timeout: 15000 })

    // Verify version is shown
    await expect(banner).toContainText('99.0.0')
  })

  test('can dismiss update banner', async ({ page }) => {
    const mockUpdate = {
      version: '99.0.0',
      body: 'Test release',
    }

    await reloadWithMockUpdate(page, mockUpdate)

    const banner = page.locator('[data-testid="update-banner"]')
    await expect(banner).toBeVisible({ timeout: 15000 })

    // Click dismiss
    await page.locator('[data-testid="update-dismiss-btn"]').click()
    await expect(banner).not.toBeVisible()
  })

  test('shows update dialog with release notes', async ({ page }) => {
    const mockUpdate = {
      version: '99.0.0',
      body: 'Detailed release notes for testing the dialog view',
      date: '2026-03-08T00:00:00Z',
    }

    await reloadWithMockUpdate(page, mockUpdate)

    const banner = page.locator('[data-testid="update-banner"]')
    await expect(banner).toBeVisible({ timeout: 15000 })

    // Open details dialog
    await page.locator('[data-testid="update-details-btn"]').click()

    const dialog = page.locator('[data-testid="update-dialog"]')
    await expect(dialog).toBeVisible()

    // Verify dialog content
    await expect(dialog).toContainText('99.0.0')
    await expect(dialog).toContainText('Detailed release notes for testing the dialog view')
    await expect(dialog.locator('[data-testid="update-skip-btn"]')).toBeVisible()
    await expect(dialog.locator('[data-testid="update-install-btn"]')).toBeVisible()
  })

  test('download progress shows in banner', async ({ page }) => {
    const mockUpdate = {
      version: '99.0.0',
      body: 'Test',
      downloadSize: 1024 * 1024, // 1MB for faster simulation
    }

    await reloadWithMockUpdate(page, mockUpdate)

    const banner = page.locator('[data-testid="update-banner"]')
    await expect(banner).toBeVisible({ timeout: 15000 })

    // Click download
    await page.locator('[data-testid="update-download-btn"]').click()

    // Should show restart button when done
    await expect(page.locator('[data-testid="update-restart-btn"]')).toBeVisible({ timeout: 10000 })
  })

  test('clicking restart relaunch calls platformRelaunch', async ({ page }) => {
    const mockUpdate = {
      version: '99.0.0',
      body: 'Test',
      downloadSize: 512 * 1024,
    }

    await reloadWithMockUpdate(page, mockUpdate)

    const banner = page.locator('[data-testid="update-banner"]')
    await expect(banner).toBeVisible({ timeout: 15000 })

    // Trigger download
    await page.locator('[data-testid="update-download-btn"]').click()
    await expect(page.locator('[data-testid="update-restart-btn"]')).toBeVisible({ timeout: 10000 })

    // Clear any previous relaunch flag
    await page.evaluate(() => {
      delete (window as unknown as Record<string, unknown>).__RELAUNCH_CALLED__
    })

    // Click restart
    await page.locator('[data-testid="update-restart-btn"]').click()

    // platform.ts sets __RELAUNCH_CALLED__ = true in test builds
    const relaunched = await page.evaluate(() =>
      (window as unknown as Record<string, unknown>).__RELAUNCH_CALLED__ === true,
    )
    expect(relaunched).toBe(true)
  })

  test('failed download reverts banner to "available" state', async ({ page }) => {
    const mockUpdate = {
      version: '99.0.0',
      body: 'Test release',
      failDownload: true,
    }

    await reloadWithMockUpdate(page, mockUpdate)

    const banner = page.locator('[data-testid="update-banner"]')
    await expect(banner).toBeVisible({ timeout: 15000 })

    // Trigger download (will fail)
    await page.locator('[data-testid="update-download-btn"]').click()

    // After failure, banner should revert — download button should reappear
    await expect(page.locator('[data-testid="update-download-btn"]')).toBeVisible({ timeout: 10000 })

    // Restart button must NOT appear after a failed download
    await expect(page.locator('[data-testid="update-restart-btn"]')).not.toBeVisible()
  })

  test('skipped version is not shown again after reload', async ({ page }) => {
    const mockUpdate = {
      version: '99.0.0',
      body: 'Security release',
    }

    await reloadWithMockUpdate(page, mockUpdate)

    const banner = page.locator('[data-testid="update-banner"]')
    await expect(banner).toBeVisible({ timeout: 15000 })

    // Open dialog and skip
    await page.locator('[data-testid="update-details-btn"]').click()
    await page.locator('[data-testid="update-skip-btn"]').click()
    await expect(banner).not.toBeVisible()

    // Reload with same version — should NOT reappear
    await reloadWithMockUpdate(page, mockUpdate)

    // Wait for the startup delay + check to run, then assert banner absent
    await page.waitForTimeout(8000)
    await expect(page.locator('[data-testid="update-banner"]')).not.toBeVisible()
  })

  test('update below version floor is silently rejected', async ({ page }) => {
    // Set a version far below the current app version — should be rejected by floor check
    const mockUpdate = {
      version: '0.0.1',
      body: 'Rollback attempt',
    }

    await reloadWithMockUpdate(page, mockUpdate)

    // Wait longer than the startup delay + one check interval
    await page.waitForTimeout(8000)

    // Banner must NOT appear — floor check rejected the downgrade
    await expect(page.locator('[data-testid="update-banner"]')).not.toBeVisible()
  })
})
