/**
 * Multi-hub incoming call steps (#1014).
 *
 * Matches packages/test-specs/features/platform/desktop/calls/multi-hub-incoming-calls.feature.
 * The volunteer + second hub come from the shared step
 * "a volunteer assigned to multiple hubs" (tests/steps/hub/hub-steps.ts), which
 * records the second hub id and the volunteer pubkey on `window`.
 *
 * The call is created with the real simulation API on the SECOND hub while the
 * worker hub is active in the UI; the UI is then driven with testid selectors only.
 *
 * First pickup wins (#1039): only a volunteer in the call's ring set (on shift, or in
 * the hub's fallback group) may answer it — the answer route 403s everyone else. Real
 * routing never registers a ringing call nobody can answer, so the volunteer is put in
 * the second hub's fallback group and the simulation is asked to refuse a call that
 * would ring nobody (`checkVolunteers`), keeping the precondition loud.
 */
import { expect } from '@playwright/test'
import { When, Then } from '../fixtures'
import { TestIds, Timeouts } from '../../helpers'
import { rowTestId } from '../../test-ids'
import { apiGet, setFallbackGroupViaApi } from '../../api-helpers'
import { simulateIncomingCall, uniqueCallerNumber } from '../../simulation-helpers'

/**
 * A relayed `call:ring` shows up immediately; the 15s REST poll is the safety net.
 * Wait long enough for the poll so a relay outage degrades to slow, not to a false failure.
 */
const RING_TIMEOUT = 30_000

interface MultiHubCallWindow {
  __test_second_hub_id?: string
  __test_multi_hub_volunteer_pubkey?: string
  __test_multi_hub_call_id?: string
}

async function recordedIds(page: import('@playwright/test').Page) {
  const ids = await page.evaluate(() => {
    const w = window as unknown as MultiHubCallWindow
    return {
      hubId: w.__test_second_hub_id,
      volunteerPubkey: w.__test_multi_hub_volunteer_pubkey,
      callId: w.__test_multi_hub_call_id,
    }
  })
  return ids
}

When('a call comes in on the volunteer\'s second hub while the first hub is active', async ({ page, backendRequest, $test }) => {
  // Ringing is bounded by the 15s poll fallback, on top of login: budget for it explicitly.
  $test.slow()
  const { hubId, volunteerPubkey } = await recordedIds(page)
  expect(hubId, 'the multi-hub Given step must record the second hub id').toBeTruthy()
  expect(volunteerPubkey, 'the multi-hub Given step must record the volunteer pubkey').toBeTruthy()

  // The call rings the volunteer on the second hub: nobody is on shift there, so the
  // hub's fallback group is its ring set.
  await setFallbackGroupViaApi(backendRequest, [volunteerPubkey!], hubId)

  const { callId, status } = await simulateIncomingCall(backendRequest, {
    callerNumber: uniqueCallerNumber(),
    hubId,
    checkVolunteers: true,
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
