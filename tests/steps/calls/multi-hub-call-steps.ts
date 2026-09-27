/**
 * Multi-hub incoming call steps (#1014).
 *
 * Matches packages/test-specs/features/platform/desktop/calls/multi-hub-incoming-calls.feature.
 * The volunteer + second hub come from the shared step
 * "a volunteer assigned to multiple hubs" (tests/steps/hub/hub-steps.ts), which
 * records the second hub id on `window.__test_second_hub_id`.
 *
 * The call is created with the real simulation API on the SECOND hub while the
 * worker hub is active in the UI; the UI is then driven with testid selectors only.
 */
import { expect } from '@playwright/test'
import { When, Then } from '../fixtures'
import { TestIds, Timeouts } from '../../helpers'
import { rowTestId } from '../../test-ids'
import { apiGet } from '../../api-helpers'
import { simulateIncomingCall, uniqueCallerNumber } from '../../simulation-helpers'

/**
 * A relayed `call:ring` shows up immediately; the 15s REST poll is the safety net.
 * Wait long enough for the poll so a relay outage degrades to slow, not to a false failure.
 */
const RING_TIMEOUT = 30_000

interface MultiHubCallWindow {
  __test_second_hub_id?: string
  __test_multi_hub_call_id?: string
}

async function recordedIds(page: import('@playwright/test').Page) {
  const ids = await page.evaluate(() => {
    const w = window as unknown as MultiHubCallWindow
    return { hubId: w.__test_second_hub_id, callId: w.__test_multi_hub_call_id }
  })
  return ids
}

When('a call comes in on the volunteer\'s second hub while the first hub is active', async ({ page, backendRequest, $test }) => {
  // Ringing is bounded by the 15s poll fallback, on top of login: budget for it explicitly.
  $test.slow()
  const { hubId } = await recordedIds(page)
  expect(hubId, 'the multi-hub Given step must record the second hub id').toBeTruthy()

  const { callId, status } = await simulateIncomingCall(backendRequest, {
    callerNumber: uniqueCallerNumber(),
    hubId,
  })
  expect(status).toBe('ringing')
  await page.evaluate((id) => {
    ;(window as unknown as MultiHubCallWindow).__test_multi_hub_call_id = id
  }, callId)
})

Then('the volunteer should see that call ringing', async ({ page }) => {
  const { callId } = await recordedIds(page)
  expect(callId, 'the call step must record the call id').toBeTruthy()
  await expect(page.getByTestId(rowTestId(TestIds.INCOMING_CALL_ROW, callId!))).toBeVisible({ timeout: RING_TIMEOUT })
})

When('the volunteer answers that call', async ({ page }) => {
  const { callId } = await recordedIds(page)
  await page.getByTestId(rowTestId(TestIds.ANSWER_CALL_BTN, callId!)).click()
})

Then('the volunteer should be on an active call', async ({ page }) => {
  await expect(page.getByTestId(TestIds.ACTIVE_CALL_PANEL)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('that call should be answered on the second hub', async ({ page, backendRequest }) => {
  const { hubId, callId } = await recordedIds(page)
  // The server is the authority: the answer must have landed on the call's own hub.
  // (Wire rows are keyed `callId`, as in tests/steps/backend/call-actions.steps.ts.)
  await expect.poll(async () => {
    const { status, data } = await apiGet<{ calls: { callId: string; status: string; answeredBy?: string | null }[] }>(
      backendRequest,
      `/hubs/${hubId}/calls/active`,
    )
    expect(status).toBe(200)
    const call = data.calls.find(c => c.callId === callId)
    return call ? { status: call.status, answered: !!call.answeredBy } : null
  }, { timeout: Timeouts.API }).toEqual({ status: 'in-progress', answered: true })
})

When('the volunteer writes a note on the active call panel', async ({ page }) => {
  const text = `dashboard-note-${Date.now()}`
  await page.getByTestId(TestIds.ACTIVE_CALL_NOTE_INPUT).fill(text)
  await page.getByTestId(TestIds.ACTIVE_CALL_NOTE_SAVE_BTN).click()
})

When('the volunteer writes a note about that call through the note sheet', async ({ page }) => {
  const { callId } = await recordedIds(page)
  expect(callId, 'the call step must record the call id').toBeTruthy()
  const text = `sheet-note-${Date.now()}`
  // Alt+N opens the note sheet; focus must not be inside an input for the shortcut to fire.
  await page.locator('body').press('Alt+n')
  await expect(page.getByTestId(TestIds.NOTE_SHEET)).toBeVisible({ timeout: Timeouts.ELEMENT })
  await page.getByTestId(TestIds.SHEET_CALL_ID_INPUT).fill(callId!)
  await page.getByTestId(TestIds.SHEET_NOTE_TEXT).fill(text)
  await page.getByTestId(TestIds.SHEET_SAVE_BTN).click()
  await expect(page.getByTestId(TestIds.NOTE_SHEET)).toBeHidden({ timeout: Timeouts.ELEMENT })
})

Then('that note should be filed under the second hub and not the first', async ({ page, backendRequest, workerHub }) => {
  const { hubId, callId } = await recordedIds(page)
  expect(hubId).toBeTruthy()
  expect(workerHub).not.toBe(hubId)
  // Server-side truth: the note must exist under the call's own hub and never under the active one.
  const countFor = async (hub: string) => {
    const { status, data } = await apiGet<{ notes: { callId?: string }[] }>(
      backendRequest,
      `/hubs/${hub}/notes?callId=${encodeURIComponent(callId!)}`,
    )
    expect(status).toBe(200)
    return data.notes.filter(n => n.callId === callId).length
  }
  await expect.poll(() => countFor(hubId!), { timeout: Timeouts.API }).toBe(1)
  expect(await countFor(workerHub)).toBe(0)
})
