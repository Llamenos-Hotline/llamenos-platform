import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import {
  createHubViaApi,
  createUserViaApi,
  createShiftViaApi,
  listNotesViaApi,
  apiGet,
} from './api-helpers'
import { loginAsVolunteer, navigateAfterLogin, Timeouts } from './helpers'
import { TestIds } from './test-ids'

/**
 * The active hub comes from the signed-in user's own memberships (#1708).
 *
 * This spec is the one place in the desktop suite that evaluates the UNPINNED
 * hub-resolution path. Every BDD scenario injects `window.__TEST_WORKER_HUB`
 * (tests/steps/common/before-hooks.ts) so each worker gets an isolated hub, and
 * `ConfigProvider` treats that as a pin — which means the suite's entire
 * desktop tier short-circuits the expression this spec is about, and could not
 * observe the defect by construction (#1126 tracks closing that).
 *
 * So: no pin here, deliberately. The premise is the deployment shape the bug
 * needs and the harness never built —
 *
 *   - the server has more than one hub, and the first one the server lists is
 *     NOT the volunteer's (on the shared E2E backend, which accumulates a hub
 *     per worker, that is the default state rather than something to arrange);
 *   - the volunteer is a member of exactly one hub, created for this spec;
 *   - the volunteer is on a shift in that hub.
 *
 * and the assertions are on the wire and in the database, not on the DOM:
 * before the fix the UI reported "Off Shift" and "No notes yet" with a clean
 * console, because every hub-scoped request went to a hub the volunteer is not
 * in and 403'd into an empty state.
 */

type Volunteer = { pubkey: string; nsec: string }

/** Every /api/ response the page received, for after-the-fact assertions. */
function recordApiTraffic(page: Page): Array<{ path: string; status: number }> {
  const seen: Array<{ path: string; status: number }> = []
  page.on('response', (res) => {
    const url = res.url()
    if (!url.includes('/api/')) return
    seen.push({ path: url.replace(/^https?:\/\/[^/]+/, ''), status: res.status() })
  })
  return seen
}

function hubRequests(traffic: Array<{ path: string; status: number }>, hubId: string) {
  return traffic.filter(r => r.path.includes(`/api/hubs/${hubId}/`))
}

test.describe('Active hub resolution on a multi-hub server', () => {
  test.describe.configure({ mode: 'serial' })

  let otherHubId: string
  let volunteerHubId: string
  let volunteer: Volunteer
  let callId: string

  test.beforeAll(async ({ playwright, baseURL }) => {
    const request = await playwright.request.newContext({
      baseURL: process.env.TEST_HUB_URL || 'http://localhost:3000',
    })
    try {
      // A hub the volunteer is NOT in. Named so it is visibly the foreign one
      // in any failure output; what makes it dangerous is only that the server
      // lists it, not its name.
      otherHubId = await createHubViaApi(request, `OtherHub-${Date.now()}`)
      volunteerHubId = await createHubViaApi(request, `VolunteerHub-${Date.now()}`)

      // Membership in exactly one hub — granted at creation, which is the only
      // thing that puts an entry in `hubRoles` and therefore the only thing
      // `GET /api/hubs` and `hubContext` both read (#1037).
      volunteer = await createUserViaApi(request, { hubId: volunteerHubId })

      // On shift, all day, every day, in the hub they are actually in.
      await createShiftViaApi(request, {
        name: `ActiveHubShift-${Date.now()}`,
        startTime: '00:00',
        endTime: '23:59',
        days: [0, 1, 2, 3, 4, 5, 6],
        userPubkeys: [volunteer.pubkey],
        hubId: volunteerHubId,
      })

      // The server must genuinely list a hub the volunteer is not in BEFORE
      // theirs, or this spec proves nothing. Asserted, not assumed.
      const { data } = await apiGet<{ hubs?: Array<{ id: string; status: string }> }>(request, '/hubs')
      const serverOrder = (data.hubs ?? []).filter(h => h.status === 'active').map(h => h.id)
      expect(
        serverOrder.indexOf(volunteerHubId),
        'the premise requires the volunteer\'s hub not to be first in the server\'s own hub order',
      ).toBeGreaterThan(0)

      expect(baseURL, 'a Vite preview base URL is required').toBeTruthy()
      callId = `active-hub-${Date.now()}`
    } finally {
      await request.dispose()
    }
  })

  test('the volunteer browses their own hub, not the first hub the server lists', async ({ page }) => {
    const traffic = recordApiTraffic(page)

    await loginAsVolunteer(page, volunteer.nsec)

    await expect
      .poll(() => page.evaluate(() => window.__TEST_GET_ACTIVE_HUB?.() ?? null), { timeout: Timeouts.AUTH })
      .toBe(volunteerHubId)

    // Not one request may have been scoped to a hub the volunteer is not in.
    // This is the assertion that fails on the unfixed client: it sent sixteen.
    expect(
      hubRequests(traffic, otherHubId),
      'requests were scoped to a hub the volunteer is not a member of',
    ).toEqual([])

    // And every request to their own hub was authorised.
    const own = hubRequests(traffic, volunteerHubId)
    expect(own.length, 'no hub-scoped request was made at all').toBeGreaterThan(0)
    expect(
      own.filter(r => r.status === 401 || r.status === 403),
      'hub-scoped requests to the volunteer\'s own hub were refused',
    ).toEqual([])
  })

  test('a volunteer who is on shift is shown as on shift', async ({ page }) => {
    const traffic = recordApiTraffic(page)

    await loginAsVolunteer(page, volunteer.nsec)
    await expect
      .poll(() => page.evaluate(() => window.__TEST_GET_ACTIVE_HUB?.() ?? null), { timeout: Timeouts.AUTH })
      .toBe(volunteerHubId)

    // The server's answer first — the UI can only be right if this is.
    await expect.poll(
      () => traffic.filter(r => r.path.includes('/shifts/my-status')).map(r => `${r.status} ${r.path}`),
      { timeout: Timeouts.ELEMENT },
    ).not.toEqual([])
    const shiftPolls = traffic.filter(r => r.path.includes('/shifts/my-status'))
    expect(
      shiftPolls.every(r => r.status === 200 && r.path.includes(volunteerHubId)),
      `shift status was polled against the wrong hub or refused: ${shiftPolls.map(r => `${r.status} ${r.path}`).join(', ')}`,
    ).toBe(true)

    // Then the dashboard. "Off Shift" here is the user-visible half of the
    // defect: a volunteer who is on shift being told they are not.
    const card = page.getByTestId(TestIds.DASHBOARD_SHIFT_STATUS)
    await expect(card).toBeVisible({ timeout: Timeouts.ELEMENT })
    await expect(card).not.toContainText(/off shift/i, { timeout: Timeouts.ELEMENT })
  })

  test('a note written through the UI is stored in the volunteer\'s hub', async ({ page, playwright }) => {
    const traffic = recordApiTraffic(page)
    const noteText = `active-hub-note-${Date.now()}`

    await loginAsVolunteer(page, volunteer.nsec)
    await expect
      .poll(() => page.evaluate(() => window.__TEST_GET_ACTIVE_HUB?.() ?? null), { timeout: Timeouts.AUTH })
      .toBe(volunteerHubId)

    await navigateAfterLogin(page, '/notes')
    await page.getByTestId(TestIds.NOTE_NEW_BTN).click()
    await expect(page.getByTestId(TestIds.NOTE_FORM)).toBeVisible({ timeout: Timeouts.ELEMENT })
    await page.getByTestId(TestIds.NOTE_CALL_ID).fill(callId)
    await page.getByTestId(TestIds.NOTE_CONTENT).fill(noteText)
    await page.getByTestId(TestIds.FORM_SAVE_BTN).click()

    // The POST itself. Before the fix this was a 403 the UI swallowed: no
    // toast, no error, the form simply stayed open and the note was lost.
    await expect.poll(
      () => traffic.filter(r => r.path.includes('/notes') && r.path.includes(volunteerHubId) && r.status === 200),
      { timeout: Timeouts.ELEMENT },
    ).not.toEqual([])
    expect(
      traffic.filter(r => r.path.includes('/notes') && (r.status === 401 || r.status === 403)),
      'the note write or the note list was refused',
    ).toEqual([])

    // And the row. A toast is not evidence that anything was stored.
    const request: APIRequestContext = await playwright.request.newContext({
      baseURL: process.env.TEST_HUB_URL || 'http://localhost:3000',
    })
    try {
      await expect.poll(
        async () => {
          const { notes } = await listNotesViaApi(request, { hubId: volunteerHubId, callId, limit: 50 })
          return notes.length
        },
        { timeout: Timeouts.ELEMENT },
      ).toBeGreaterThan(0)

      // Nothing landed in the foreign hub either.
      const { notes: strayNotes } = await listNotesViaApi(request, { hubId: otherHubId, callId, limit: 50 })
      expect(strayNotes, 'a note reached a hub the author is not a member of').toEqual([])
    } finally {
      await request.dispose()
    }
  })
})

test.describe('The unauthenticated public config', () => {
  /**
   * `/api/hubs` has always required authentication; `/api/config` served the
   * same hub objects — name, slug, description, `createdBy`, timestamps — to
   * anybody who could reach the host (#1710). Asserted over real HTTP with no
   * credentials of any kind, which is how it was found.
   */
  test('does not publish the hub roster', async ({ playwright }) => {
    const request = await playwright.request.newContext({
      baseURL: process.env.TEST_HUB_URL || 'http://localhost:3000',
    })
    try {
      const res = await request.get('/api/config')
      expect(res.status()).toBe(200)
      const body = await res.json() as Record<string, unknown>

      expect(body, 'the anonymous config must carry no hub objects').not.toHaveProperty('hubs')
      expect(body, 'the anonymous config must not name a hub').not.toHaveProperty('defaultHubId')

      const refused = await request.get('/api/hubs', { failOnStatusCode: false })
      expect(refused.status(), 'GET /api/hubs must still require authentication').toBe(401)
    } finally {
      await request.dispose()
    }
  })
})
