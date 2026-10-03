/**
 * Desktop step definitions for in-call UI actions (Epic 351).
 *
 * Tests the ActiveCallPanel component: visibility during calls,
 * ban dialog with custom reason, and panel dismissal on call end.
 */
import { expect } from '@playwright/test'
import { Given, When, Then } from '../fixtures'
import { TestIds } from '../../test-ids'
import { Timeouts } from '../../helpers'

// ── Given ──────────────────────────────────────────────────────────

// These scenarios are @requires-live-calls (excluded from the default desktop
// run). They used to record "backend not available" on window and then pass
// every later step on the page title; now a call that cannot be established
// fails the scenario, and every step asserts the call UI it names.

Given('I have an active call', async ({ page, backendRequest }) => {
  const { simulateIncomingCall, simulateAnswerCall } = await import('../../simulation-helpers')
  const callResult = await simulateIncomingCall(backendRequest, { callerNumber: '+15551234567' })
  expect(callResult?.callId, 'simulated incoming call').toBeTruthy()
  const pubkey = await page.evaluate(async () => {
    const p = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as { getDevicePubkeys(): Promise<{ signingPubkeyHex: string }> }
    return (await p.getDevicePubkeys()).signingPubkeyHex
  })
  await simulateAnswerCall(backendRequest, callResult.callId, pubkey)
  await page.evaluate((id) => {
    (window as unknown as Record<string, unknown>).__test_active_call_id = id
  }, callResult.callId)
})

// ── When ───────────────────────────────────────────────────────────

When('I view the dashboard', async ({ page }) => {
  const dashboardNav = page.getByTestId(TestIds.NAV_DASHBOARD)
  await expect(dashboardNav).toBeVisible({ timeout: Timeouts.ELEMENT })
  await dashboardNav.click()
})

When('I click the ban button on the active call panel', async ({ page }) => {
  const panel = page.getByTestId(TestIds.ACTIVE_CALL_PANEL)
  await expect(panel).toBeVisible({ timeout: Timeouts.ELEMENT })
  await panel.getByTestId(TestIds.BAN_BTN).click()
})

When('I enter ban reason {string}', async ({ page }, reason: string) => {
  const input = page.getByTestId(TestIds.BAN_REASON_INPUT)
  await expect(input).toBeVisible({ timeout: Timeouts.ELEMENT })
  await input.fill(reason)
})

When('I confirm the ban', async ({ page }) => {
  const confirmBtn = page.getByTestId(TestIds.BAN_CONFIRM_BTN)
  await expect(confirmBtn).toBeVisible({ timeout: Timeouts.ELEMENT })
  await confirmBtn.click()
})

When('the call ends', async ({ page, backendRequest }) => {
  const { simulateEndCall } = await import('../../simulation-helpers')
  const callId = await page.evaluate(
    () => (window as unknown as Record<string, unknown>).__test_active_call_id as string | undefined,
  )
  expect(callId, 'an active call must have been established').toBeTruthy()
  await simulateEndCall(backendRequest, callId as string)
})

// ── Then ───────────────────────────────────────────────────────────

Then('the active call panel should be visible', async ({ page }) => {
  await expect(page.getByTestId(TestIds.ACTIVE_CALL_PANEL)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the call timer should be visible', async ({ page }) => {
  const panel = page.getByTestId(TestIds.ACTIVE_CALL_PANEL)
  await expect(panel.getByTestId(TestIds.CALL_TIMER)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the ban reason input should be visible', async ({ page }) => {
  await expect(page.getByTestId(TestIds.BAN_REASON_INPUT)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the active call panel should not be visible', async ({ page }) => {
  // Anchor on the dashboard first so the absence is observed on a rendered page.
  await expect(page.getByTestId(TestIds.PAGE_TITLE)).toBeVisible({ timeout: Timeouts.ELEMENT })
  await expect(page.getByTestId(TestIds.ACTIVE_CALL_PANEL)).not.toBeVisible({ timeout: Timeouts.ELEMENT })
})
