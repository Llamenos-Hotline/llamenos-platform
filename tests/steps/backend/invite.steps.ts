/**
 * Invite lifecycle step definitions.
 * Tests invite creation, validation, redemption, revocation, and rate limiting.
 */
import { expect } from '@playwright/test'
import { Given, When, Then, Before, getState, setState } from './fixtures'
import { setLastResponse, getSharedState } from './shared-state'
import {
  apiGet,
  apiPost,
  apiDelete,
  createUserViaApi,
  generateTestKeypair,
  redeemInviteViaApi,
  seedHexToPubkey,
  simulatedClientIp,
  ADMIN_SEED,
} from '../../api-helpers'
import { harnessClientHeaders } from '../../dev-surface-secret'

// ── State ──────────────────────────────────────────────────────────���

interface InviteTestState {
  inviteCode?: string
  rateLimitResponses: number[]
  /** Body of the last page fetched from /onboarding. */
  pageHtml?: string
  /** Where the page's Open in app link redirected to. */
  deepLink?: string
  volunteerDeviceKey?: string
  /** Seed of the user who redeemed an invite earlier in the scenario. */
  redeemerSeedHex?: string
  /**
   * Unique per-scenario client address. Invite validation AND redemption are
   * rate limited per client; without this every scenario in every Playwright
   * worker shares one bucket and the suite 429s itself (#1480). Presented
   * through `harnessClientHeaders`, so it also survives the proxy on a
   * deployed target (#1625).
   */
  scenarioIp: string
}

const STATE_KEY = 'invite_test'

function getS(world: Record<string, unknown>): InviteTestState {
  return getState<InviteTestState>(world, STATE_KEY)
}

const BASE_URL = process.env.TEST_HUB_URL || 'http://localhost:3000'

Before(async ({ world }) => {
  // Assign a unique client address per scenario so validation and redemption
  // calls each use an isolated rate limit bucket instead of the shared one for
  // the real remote address (which fills up across scenarios and answers 429
  // to scenarios that are not about rate limiting). The limiter still enforces
  // its production threshold inside this scenario's bucket — nothing is exempt.
  setState<InviteTestState>(world, STATE_KEY, {
    rateLimitResponses: [],
    scenarioIp: simulatedClientIp(),
  })
})
// ── Helpers ─────────────────────────────────────────────────────────

// ── Given ───────────────────────────────────��───────────────────────

Given('an invite exists for {string} with phone {string}', async ({ request, world, workerHub }, name: string, phone: string) => {
  const s = getS(world)
  const res = await apiPost<{ invite: { code: string } }>(request, '/invites', {
    hubId: workerHub,
    name, phone, roleIds: ['role-volunteer'],
  }, ADMIN_SEED)
  expect(res.status).toBe(201)
  s.inviteCode = res.data.invite.code
})

Given('the invite has been redeemed by a user', async ({ request, world }) => {
  const s = getS(world)
  expect(s.inviteCode).toBeDefined()
  const kp = generateTestKeypair()
  const res = await redeemInviteViaApi(request, s.inviteCode!, kp.seedHex, s.scenarioIp)
  expect(res.status).toBe(200)
  s.redeemerSeedHex = kp.seedHex
})

Given('a registered volunteer user', async ({ request, world }) => {
  const vol = await createUserViaApi(request, { name: `Invite Vol ${Date.now()}` })
  getS(world).volunteerDeviceKey = vol.deviceKey
})

// ── When ────────────────────────────────────────────────────────────

When('the admin creates an invite for {string} with phone {string}', async ({ request, world, workerHub }, name: string, phone: string) => {
  const s = getS(world)
  const res = await apiPost<{ invite: { code: string } }>(request, '/invites', {
    hubId: workerHub,
    name, phone, roleIds: ['role-volunteer'],
  }, ADMIN_SEED)
  setLastResponse(world, res)
  if (res.status === 201 && (res.data as Record<string, unknown>)?.invite) {
    s.inviteCode = (res.data as { invite: { code: string } }).invite.code
  }
})

When('the invite code is validated', async ({ request, world }) => {
  const s = getS(world)
  expect(s.inviteCode).toBeDefined()
  const res = await request.get(`${BASE_URL}/api/invites/validate/${s.inviteCode}`, {
    headers: { 'Content-Type': 'application/json', ...harnessClientHeaders(s.scenarioIp) },
  })
  const data = res.ok() ? await res.json().catch(() => null) : null
  setLastResponse(world, { status: res.status(), data })
})

When('a random UUID is validated as an invite', async ({ request, world }) => {
  const s = getS(world)
  const res = await request.get(`${BASE_URL}/api/invites/validate/${crypto.randomUUID()}`, {
    headers: { 'Content-Type': 'application/json', ...harnessClientHeaders(s.scenarioIp) },
  })
  const data = res.ok() ? await res.json().catch(() => null) : null
  setLastResponse(world, { status: res.status(), data })
})

const INVITE_LINK = (code: string) => `${BASE_URL}/onboarding?code=${code}`

async function fetchInvitePage(
  request: Parameters<typeof apiGet>[0],
  s: InviteTestState,
  code: string,
  headers: Record<string, string> = {},
) {
  const res = await request.get(INVITE_LINK(code), { headers: { ...headers, ...harnessClientHeaders(s.scenarioIp) } })
  s.pageHtml = await res.text()
  return res
}

When('the invite link is opened in a browser', async ({ request, world }) => {
  const s = getS(world)
  expect(s.inviteCode).toBeDefined()
  const res = await fetchInvitePage(request, s, s.inviteCode!)
  setLastResponse(world, { status: res.status(), data: null })
})

When('the Open in app link on the page is followed', async ({ request, world }) => {
  const s = getS(world)
  const href = /href="(\/onboarding\/open\?code=[^"]+)"/.exec(s.pageHtml ?? '')?.[1]
  expect(href, 'the page has an Open in app link').toBeDefined()
  // A browser hands a custom-scheme redirect to the OS rather than following it.
  const res = await request.get(`${BASE_URL}${href}`, { maxRedirects: 0, headers: harnessClientHeaders(s.scenarioIp) })
  expect(res.status()).toBe(302)
  s.deepLink = res.headers()['location']
})

When('a new user redeems the invite from that deep link', async ({ request, world }) => {
  const s = getS(world)
  // What the app does with the link: read the code out of it, nothing else.
  const code = new URL(s.deepLink!).searchParams.get('code')
  expect(code).toBe(s.inviteCode)
  setLastResponse(world, await redeemInviteViaApi(request, code!, generateTestKeypair().seedHex, s.scenarioIp))
})

When('a client opens {int} invite links in a browser', async ({ request, world }, count: number) => {
  const s = getS(world)
  const shared = getSharedState(world)
  shared.floodResponses = []
  for (let i = 0; i < count; i++) {
    const res = await fetchInvitePage(request, s, crypto.randomUUID())
    s.rateLimitResponses.push(res.status())
    shared.floodResponses.push(res.status())
  }
  setLastResponse(world, { status: s.rateLimitResponses[s.rateLimitResponses.length - 1], data: null })
})

When('a new user redeems the invite', async ({ request, world }) => {
  const s = getS(world)
  expect(s.inviteCode).toBeDefined()
  const kp = generateTestKeypair()
  setLastResponse(world, await redeemInviteViaApi(request, s.inviteCode!, kp.seedHex, s.scenarioIp))
})

When('the same user redeems the invite', async ({ request, world }) => {
  const s = getS(world)
  expect(s.inviteCode).toBeDefined()
  expect(s.redeemerSeedHex).toBeDefined()
  // The same person, so deliberately the same client address.
  setLastResponse(world, await redeemInviteViaApi(request, s.inviteCode!, s.redeemerSeedHex!, s.scenarioIp))
})

When('the admin lists invites', async ({ request, world }) => {
  setLastResponse(world, await apiGet(request, '/invites', ADMIN_SEED))
})

When('the admin revokes the invite', async ({ request, world }) => {
  const s = getS(world)
  const crudState = getState<{ inviteCode?: string }>(world, 'crud')
  const inviteCode = s.inviteCode ?? crudState?.inviteCode
  expect(inviteCode).toBeDefined()
  setLastResponse(world, await apiDelete(request, `/invites/${inviteCode}`))
})

When('a client floods invite validation {int} times', async ({ request, world }, count: number) => {
  // One client address for the whole flood — this scenario's own, distinct from
  // every other worker's — so the 5/min invite-validate limiter fires on THIS
  // flood and not on whatever a parallel scenario was doing.
  const s = getS(world)
  const shared = getSharedState(world)
  shared.floodResponses = []
  for (let i = 0; i < count; i++) {
    const res = await request.get(`${BASE_URL}/api/invites/validate/${crypto.randomUUID()}`, {
      headers: { 'Content-Type': 'application/json', ...harnessClientHeaders(s.scenarioIp) },
    })
    s.rateLimitResponses.push(res.status())
    shared.floodResponses.push(res.status())
  }
  setLastResponse(world, { status: s.rateLimitResponses[s.rateLimitResponses.length - 1], data: null })
})

When('the volunteer tries to create an invite', async ({ request, world, workerHub }) => {
  const s = getS(world)
  expect(s.volunteerDeviceKey).toBeDefined()
  setLastResponse(world, await apiPost(request, '/invites', {
    hubId: workerHub,
    name: 'Unauthorized Invite', phone: '+15559999999', roleIds: ['role-volunteer'],
  }, s.volunteerDeviceKey!))
})

// ── Then ─────────────────��──────────────────────────────────────────

/**
 * The list the operator actually sees — GET /api/hubs/:hubId/users, which the
 * shift editor and the ring-group picker populate from. A redeemed volunteer
 * missing from it cannot be scheduled and can never be rung (#1037).
 */
Then('the redeemed user is a member of the hub', async ({ request, world, workerHub }) => {
  const s = getS(world)
  expect(s.redeemerSeedHex, 'no user redeemed an invite in this scenario').toBeDefined()
  const pubkey = seedHexToPubkey(s.redeemerSeedHex!)
  const { status, data } = await apiGet<{ users: Array<{ pubkey: string }> }>(
    request, `/hubs/${workerHub}/users`, ADMIN_SEED,
  )
  expect(status).toBe(200)
  expect(
    (data.users ?? []).map(u => u.pubkey),
    'the redeemed volunteer is absent from the hub the invite named',
  ).toContain(pubkey)
})

Then('the invite has a valid UUID code', async ({ world }) => {
  const s = getS(world)
  expect(s.inviteCode).toBeDefined()
  expect(s.inviteCode).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
})

Then('the invite has an expiration date', async ({ world }) => {
  const resp = getSharedState(world).lastResponse
  expect(resp).toBeDefined()
  const data = resp!.data as { invite: { expiresAt: string } }
  expect(data.invite.expiresAt).toBeDefined()
  expect(new Date(data.invite.expiresAt).getTime()).toBeGreaterThan(Date.now())
})

/** Words that would name the service or its product; the per-scenario names are added where known. */
const PRODUCT_NAMES = [/llamenos/i, /llámenos/i, /hotline/i, /crisis/i]

Then('the page offers to open the app', async ({ world }) => {
  const html = getS(world).pageHtml ?? ''
  expect(html).toContain('/onboarding/open?code=')
  expect(html).toContain('<svg')
})

Then('the page says the link cannot be used', async ({ world }) => {
  const html = getS(world).pageHtml ?? ''
  expect(html).toContain('This link cannot be used')
  expect(html).not.toContain('/onboarding/open')
})

Then('the page names no organisation, hub, invitee or product', async ({ request, world, workerHub }) => {
  const html = getS(world).pageHtml ?? ''
  expect(html.length).toBeGreaterThan(0)
  const hub = await apiGet<{ hub?: { name: string }; name?: string }>(request, `/hubs/${workerHub}`, ADMIN_SEED)
  const hubName = hub.data.hub?.name ?? hub.data.name
  expect(hubName, 'the test hub has a name to look for').toBeTruthy()
  for (const needle of [hubName!, 'Browser Visitor', 'Used Visitor', 'Deep Link']) expect(html).not.toContain(needle)
  for (const pattern of PRODUCT_NAMES) expect(html).not.toMatch(pattern)
  // No link-preview metadata and no deep-link scheme in the document itself.
  expect(html).not.toMatch(/<meta[^>]+(property|name)="(og:|twitter:|description)/i)
  expect(html).not.toContain('hub-invite')
})

Then('a link that was never issued renders exactly the same page', async ({ request, world }) => {
  const s = getS(world)
  const issued = s.pageHtml
  const res = await fetchInvitePage(request, s, crypto.randomUUID())
  expect(res.status()).toBe(404)
  expect(s.pageHtml).toBe(issued)
})

Then('the browser is sent to the app deep link for the invite', async ({ world }) => {
  const s = getS(world)
  expect(s.deepLink).toBe(`llamenos://hub-invite?code=${s.inviteCode}`)
})

Then('the invite is valid', async ({ world }) => {
  const resp = getSharedState(world).lastResponse
  expect(resp).toBeDefined()
  expect((resp!.data as { valid: boolean }).valid).toBe(true)
})

Then('the invite is not valid with error {string}', async ({ world }, error: string) => {
  const resp = getSharedState(world).lastResponse
  expect(resp).toBeDefined()
  const data = resp!.data as { valid: boolean; error?: string }
  expect(data.valid).toBe(false)
  expect(data.error).toBe(error)
})

Then('the invite list is not empty', async ({ world }) => {
  const resp = getSharedState(world).lastResponse
  expect(resp).toBeDefined()
  expect((resp!.data as { invites: unknown[] }).invites.length).toBeGreaterThan(0)
})

Then('the invite code is no longer valid', async ({ request, world }) => {
  const s = getS(world)
  expect(s.inviteCode).toBeDefined()
  const res = await request.get(`${BASE_URL}/api/invites/validate/${s.inviteCode}`, {
    headers: { 'Content-Type': 'application/json', ...harnessClientHeaders(s.scenarioIp) },
  })
  const data = await res.json().catch(() => null)
  expect(data?.valid).toBe(false)
})
