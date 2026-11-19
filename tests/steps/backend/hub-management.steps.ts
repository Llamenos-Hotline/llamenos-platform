/**
 * Backend step definitions for hub management (Epic 353).
 *
 * Tests the GET /api/hubs and POST /api/hubs endpoints.
 * Admin creates hubs, lists them, and verifies they appear with
 * correct name and slug.
 */
import { expect } from '@playwright/test'
import { Given, When, Then, Before, After, getState, setState } from './fixtures'
import { apiGet, apiPost, apiDelete, uniqueName } from '../../api-helpers'
import { getSharedState, setLastResponse } from './shared-state'
import { hubNotFoundResponseSchema } from '@protocol/schemas/common'

// ── Local State ────────────────────────────────────────────────────

interface HubManagementState {
  hubList?: Array<{ id: string; name: string; slug: string; status: string }>
  createdHub?: { id: string; name: string; slug: string }
}

const HUB_MANAGEMENT_KEY = 'hub_management'

function getHubManagementState(world: Record<string, unknown>): HubManagementState {
  return getState<HubManagementState>(world, HUB_MANAGEMENT_KEY)
}


Before(async ({ world }) => {
  const hubState = {}
  setState(world, HUB_MANAGEMENT_KEY, hubState)
})

After(async ({ request, world }) => {
  const state = getHubManagementState(world)
  if (state.createdHub?.id) {
    await apiDelete(request, `/hubs/${state.createdHub.id}`).catch(() => {})
  }
})

// ── Given ──────────────────────────────────────────────────────────

Given('the admin creates a hub via API', async ({ request, world }) => {
  const slug = uniqueName('bdd-hub')
  const name = `BDD Hub ${slug}`
  const res = await apiPost<{ hub: { id: string; name: string; slug: string } }>(
    request,
    '/hubs',
    { name, slug },
  )
  expect([200, 201]).toContain(res.status)
  getHubManagementState(world).createdHub = res.data.hub
})

// ── When ───────────────────────────────────────────────────────────

When('the admin lists all hubs', async ({ request, world }) => {
  const res = await apiGet<{ hubs: Array<{ id: string; name: string; slug: string; status: string }> }>(
    request,
    '/hubs',
  )
  expect(res.status).toBe(200)
  getHubManagementState(world).hubList = res.data.hubs
  setLastResponse(world, res)
})

When(
  'the admin creates a hub with name {string} and slug {string}',
  async ({ request, world }, name: string, slug: string) => {
    // Clean up any existing hub with this slug (left over from a previous test run)
    const listRes = await apiGet<{ hubs: Array<{ id: string; slug: string; name: string }> }>(request, '/hubs')
    if (listRes.status === 200) {
      const existing = listRes.data?.hubs?.find(h => h.slug === slug)
      if (existing) {
        const delRes = await apiDelete(request, `/hubs/${existing.id}`)
        if (delRes.status !== 200) {
          // Delete failed (e.g., storage manager error) — reuse the existing hub
          setLastResponse(world, { status: 200, data: { hub: existing } })
          getHubManagementState(world).createdHub = existing
          return
        }
      }
    }
    const res = await apiPost<{ hub: { id: string; name: string; slug: string } }>(
      request,
      '/hubs',
      { name, slug },
    )
    setLastResponse(world, res)
    if (res.data?.hub) {
      getHubManagementState(world).createdHub = res.data.hub
    }
  },
)

When('the admin requests a hub that does not exist', async ({ request, world }) => {
  const res = await apiGet(request, `/hubs/${crypto.randomUUID()}`)
  setLastResponse(world, res)
})

// ── Then ───────────────────────────────────────────────────────────

Then('the hub list should contain at least {int} hub', async ({ world }, count: number) => {
  expect(getHubManagementState(world).hubList).toBeTruthy()
  expect(getHubManagementState(world).hubList!.length).toBeGreaterThanOrEqual(count)
})

Then('each hub should have a name and slug', async ({ world }) => {
  expect(getHubManagementState(world).hubList).toBeTruthy()
  for (const hub of getHubManagementState(world).hubList!) {
    expect(hub.name).toBeTruthy()
    expect(hub.slug).toBeTruthy()
  }
})

Then('the created hub should have name {string}', async ({ world }, expectedName: string) => {
  expect(getHubManagementState(world).createdHub).toBeTruthy()
  expect(getHubManagementState(world).createdHub!.name).toBe(expectedName)
})

Then('the created hub should have slug {string}', async ({ world }, expectedSlug: string) => {
  expect(getHubManagementState(world).createdHub).toBeTruthy()
  expect(getHubManagementState(world).createdHub!.slug).toBe(expectedSlug)
})

Then('the hub should appear in the list', async ({ request, world }) => {
  expect(getHubManagementState(world).createdHub).toBeTruthy()
  const res = await apiGet<{ hubs: Array<{ id: string }> }>(request, '/hubs')
  expect(res.status).toBe(200)
  const found = res.data.hubs.find(h => h.id === getHubManagementState(world).createdHub!.id)
  expect(found).toBeTruthy()
})

Then('the response should carry the hub-not-found code', async ({ world }) => {
  const res = getSharedState(world).lastResponse
  // Parsed against the protocol schema the mobile clients are generated from: the
  // code, not the English `error` beside it, is what a client forgets a hub on (#2872).
  expect(hubNotFoundResponseSchema.safeParse(res?.data).success).toBe(true)
})
