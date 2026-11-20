/**
 * The desktop heartbeat sender against the real backend (#1142).
 *
 * The server stops ringing a clock-in whose heartbeat goes quiet, so the sender must
 * (a) keep a clock-in alive and (b) not nag hubs the user holds no clock-in in: a
 * heartbeat to such a hub is a 404, which Chromium logs as a console error on every
 * tick for as long as the app is open. These specs run the real client against the
 * real routes — nothing here is mocked, so neither half can be silenced.
 */
import { test, expect } from './console-guard'
import { useScenarioHub, TestIds, Timeouts } from './helpers'

const isHeartbeat = (url: string, hubId: string) => url.endsWith(`/api/hubs/${hubId}/shifts/heartbeat`)
const isMyStatus = (url: string, hubId: string) => url.endsWith(`/api/hubs/${hubId}/shifts/my-status`)

test.describe('Shift heartbeat sender', () => {
  test('a user who is not clocked in sends no heartbeat', async ({ page, request }) => {
    const heartbeats: string[] = []
    const statusReads: string[] = []
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().includes('/shifts/heartbeat')) heartbeats.push(req.url())
    })
    page.on('response', (res) => {
      if (res.request().method() === 'GET' && res.url().includes('/shifts/my-status')) statusReads.push(res.url())
    })

    const hubId = await useScenarioHub(page, request, 'heartbeat-off-shift')

    // The sender decides from the server's answer; once that answer is in, a heartbeat
    // would already have gone out (it runs on mount).
    await expect.poll(() => statusReads.some(u => isMyStatus(u, hubId)), { timeout: Timeouts.AUTH }).toBe(true)
    expect(heartbeats).toEqual([])
  })

  test('clocking in starts heartbeats to that hub and the server accepts them', async ({ page, request }) => {
    const hubId = await useScenarioHub(page, request, 'heartbeat-clocked-in')

    const accepted = page.waitForResponse(
      (res) => res.request().method() === 'POST' && isHeartbeat(res.url(), hubId),
      { timeout: Timeouts.AUTH },
    )
    await page.getByTestId(TestIds.CLOCK_TOGGLE_BTN).click()

    const res = await accepted
    expect(res.status()).toBe(200)
  })
})
