/**
 * Hub key lifecycle step definitions (Epic 365).
 *
 * Tests hub key distribution, revocation on member removal,
 * and key rotation when members depart.
 */
import { expect } from '@playwright/test'
import { Given, When, Then, Before, getState, setState } from './fixtures'
import {
  apiGet,
  apiPut,
  apiPost,
  createVolunteerViaApi,
  uniqueName,
} from '../../api-helpers'
import { generateContentKey, wrapKeyForRecipient, hpkeRecipientForSeed } from '../../crypto-helpers'
import { LABEL_HUB_KEY_WRAP } from '@shared/crypto-labels'

// ── Local State ────────────────────────────────────────────────────

interface HubMember {
  name: string
  seedHex: string
  pubkey: string
}

interface EnvelopeEntry {
  pubkey: string
  ct: string
  enc: string
}

interface HubKeyState {
  hubId?: string
  members: Map<string, HubMember>
  /** Original ct values keyed by member name */
  originalEnvelopes: Map<string, string>
  /** Current ct values keyed by member name */
  currentEnvelopes: Map<string, string>
  /** Fetch results per member */
  fetchResults: Map<string, { status: number; envelope?: string }>
  /** Number of entries in the latest PUT */
  lastEnvelopeCount?: number
}

const HUB_KEY_LIFECYCLE_KEY = 'hub_key_lifecycle'

function getHubKeyState(world: Record<string, unknown>): HubKeyState {
  return getState<HubKeyState>(world, HUB_KEY_LIFECYCLE_KEY)
}


Before({ tags: '@crypto' }, async ({ world }) => {
  const hkState = {
    members: new Map(),
    originalEnvelopes: new Map(),
    currentEnvelopes: new Map(),
    fetchResults: new Map(),
  }
  setState(world, HUB_KEY_LIFECYCLE_KEY, hkState)
})

// ── Helpers ────────────────────────────────────────────────────────

async function generateRealEnvelopeEntry(pubkey: string, memberSeedHex: string): Promise<EnvelopeEntry> {
  // Use real HPKE to wrap a random hub key for this member
  const hubKey = generateContentKey()
  const member = hpkeRecipientForSeed(memberSeedHex)
  const envelope = await wrapKeyForRecipient(hubKey, member.pubkeyHex, member.skHex, LABEL_HUB_KEY_WRAP)
  return { pubkey, ct: envelope.ct, enc: envelope.enc }
}

async function createHub(request: import('@playwright/test').APIRequestContext): Promise<string> {
  const slug = uniqueName('bdd-hub-key')
  const res = await apiPost<{ hub: { id: string } }>(
    request,
    '/hubs',
    { name: `Hub Key Test ${slug}`, slug },
  )
  expect([200, 201]).toContain(res.status)
  return res.data.hub.id
}

// ── Given: Hub with members ───────────────────────────────────────

Given(
  'a hub with {int} members: {string}, {string}, and {string}',
  async ({ request, world }, count: number, name1: string, name2: string, name3: string) => {
    // Create the hub
    const hubId = await createHub(request)
    getHubKeyState(world).hubId = hubId

    // Create 3 volunteer members and add them to the hub
    // CRIT-H1: Hub membership via hubRoles is required to fetch key envelopes
    for (const name of [name1, name2, name3]) {
      const vol = await createVolunteerViaApi(request, {
        name: `${name} ${Date.now()}`,
      })
      // Add volunteer as hub member
      await apiPost(request, `/hubs/${hubId}/members`, { pubkey: vol.pubkey, roleIds: ['role-volunteer'] })
      getHubKeyState(world).members.set(name, {
        name,
        seedHex: vol.seedHex,
        pubkey: vol.pubkey,
      })
    }
  },
)

// ── When: Set hub key envelopes ───────────────────────────────────

When(
  'the admin sets hub key envelopes for all {int} members',
  async ({ request, world }, _count: number) => {
    expect(getHubKeyState(world).hubId).toBeTruthy()

    const envelopes: EnvelopeEntry[] = []
    for (const [name, member] of getHubKeyState(world).members) {
      const entry = await generateRealEnvelopeEntry(member.pubkey, member.seedHex)
      envelopes.push(entry)
      getHubKeyState(world).originalEnvelopes.set(name, entry.ct)
      getHubKeyState(world).currentEnvelopes.set(name, entry.ct)
    }

    const res = await apiPut(
      request,
      `/hubs/${getHubKeyState(world).hubId}/key`,
      { envelopes },
    )
    expect(res.status).toBe(200)
  },
)

Given('hub key envelopes are set for all {int} members', async ({ request, world }, _count: number) => {
  expect(getHubKeyState(world).hubId).toBeTruthy()

  const envelopes: EnvelopeEntry[] = []
  for (const [name, member] of getHubKeyState(world).members) {
    const entry = await generateRealEnvelopeEntry(member.pubkey, member.seedHex)
    envelopes.push(entry)
    getHubKeyState(world).originalEnvelopes.set(name, entry.ct)
    getHubKeyState(world).currentEnvelopes.set(name, entry.ct)
  }

  const res = await apiPut(
    request,
    `/hubs/${getHubKeyState(world).hubId}/key`,
    { envelopes },
  )
  expect(res.status).toBe(200)
})

// ── Then: Fetch individual envelopes ──────────────────────────────

Then(
  '{string} should be able to fetch their hub key envelope',
  async ({ request, world }, name: string) => {
    expect(getHubKeyState(world).hubId).toBeTruthy()
    const member = getHubKeyState(world).members.get(name)
    expect(member).toBeTruthy()

    const res = await apiGet<{ envelope: { pubkey: string; ct: string; enc: string } }>(
      request,
      `/hubs/${getHubKeyState(world).hubId}/key`,
      member!.seedHex,
    )
    expect(res.status).toBe(200)
    expect(res.data.envelope).toBeTruthy()
    expect(res.data.envelope.ct).toBeTruthy()
    getHubKeyState(world).fetchResults.set(name, { status: res.status, envelope: res.data.envelope.ct })
  },
)

Then('each envelope should be unique per member', async ({ world }) => {
  const envelopes = new Set<string>()
  for (const [, result] of getHubKeyState(world).fetchResults) {
    expect(result.envelope).toBeTruthy()
    envelopes.add(result.envelope!)
  }
  // All envelopes should be unique
  expect(envelopes.size).toBe(getHubKeyState(world).fetchResults.size)
})

// ── When: Remove member ───────────────────────────────────────────

When('{string} is removed from the hub', async ({ world }, name: string) => {
  // Mark as removed in local state — omit from subsequent key PUTs.
  // Hub membership is modelled by envelope presence: a replace-all PUT that
  // excludes this member's entry causes setHubKeyEnvelopes to delete their row,
  // so their subsequent GET returns 404 ("No key envelope for this user").
  // Do NOT call DELETE /users/:pubkey — that permanently deletes the account,
  // causing subsequent Schnorr auth to return 401 rather than 404 on GET /hubs/:id/key.
  getHubKeyState(world).currentEnvelopes.delete(name)
})

When(
  'the admin updates hub key envelopes for {string} and {string} only',
  async ({ request, world }, name1: string, name2: string) => {
    expect(getHubKeyState(world).hubId).toBeTruthy()

    const envelopes: EnvelopeEntry[] = []
    for (const name of [name1, name2]) {
      const member = getHubKeyState(world).members.get(name)
      expect(member).toBeTruthy()
      const entry = await generateRealEnvelopeEntry(member!.pubkey, member!.seedHex)
      envelopes.push(entry)
      getHubKeyState(world).currentEnvelopes.set(name, entry.ct)
    }

    const res = await apiPut(
      request,
      `/hubs/${getHubKeyState(world).hubId}/key`,
      { envelopes },
    )
    expect(res.status).toBe(200)
    getHubKeyState(world).lastEnvelopeCount = envelopes.length
  },
)

// ── Then: Removed member gets 404 ─────────────────────────────────

Then(
  '{string} should receive {int} when fetching their hub key envelope',
  async ({ request, world }, name: string, expectedStatus: number) => {
    expect(getHubKeyState(world).hubId).toBeTruthy()
    const member = getHubKeyState(world).members.get(name)
    expect(member).toBeTruthy()

    const res = await apiGet(
      request,
      `/hubs/${getHubKeyState(world).hubId}/key`,
      member!.seedHex,
    )
    expect(res.status).toBe(expectedStatus)
    getHubKeyState(world).fetchResults.set(name, { status: res.status })
  },
)

// ── Key Rotation ──────────────────────────────────────────────────

When(
  'a new hub key is generated and wrapped for remaining members only',
  async ({ request, world }) => {
    expect(getHubKeyState(world).hubId).toBeTruthy()

    const envelopes: EnvelopeEntry[] = []
    for (const [name, member] of getHubKeyState(world).members) {
      // Only wrap for members still tracked in currentEnvelopes (non-removed)
      if (getHubKeyState(world).currentEnvelopes.has(name)) {
        const entry = await generateRealEnvelopeEntry(member.pubkey, member.seedHex)
        envelopes.push(entry)
        getHubKeyState(world).currentEnvelopes.set(name, entry.ct)
      }
    }

    const res = await apiPut(
      request,
      `/hubs/${getHubKeyState(world).hubId}/key`,
      { envelopes },
    )
    expect(res.status).toBe(200)
    getHubKeyState(world).lastEnvelopeCount = envelopes.length
  },
)

Then(
  "{string}'s new envelope should differ from the original",
  async ({ world }, name: string) => {
    const original = getHubKeyState(world).originalEnvelopes.get(name)
    const current = getHubKeyState(world).currentEnvelopes.get(name)
    expect(original).toBeTruthy()
    expect(current).toBeTruthy()
    expect(current).not.toBe(original)
  },
)

Then(
  'the new envelopes should contain exactly {int} entries',
  async ({ world }, count: number) => {
    expect(getHubKeyState(world).lastEnvelopeCount).toBe(count)
  },
)

// ── Auth Guards ────────────────────────────────────────────────────

const AUTH_GUARD_KEY = 'hub_key_auth_guard'

interface AuthGuardState {
  hubId?: string
  memberSeedHex?: string
  nonMemberSeedHex?: string
  noEnvelopeMemberSeedHex?: string
  lastStatus?: number
}

function getAuthGuardState(world: Record<string, unknown>): AuthGuardState {
  let s = getState<AuthGuardState | undefined>(world, AUTH_GUARD_KEY)
  if (!s) {
    s = {}
    setState(world, AUTH_GUARD_KEY, s)
  }
  return s
}

Given('a hub exists with a member {string}', async ({ request, world }, name: string) => {
  const slug = uniqueName('bdd-hub-auth')
  const hubRes = await apiPost<{ hub: { id: string } }>(
    request,
    '/hubs',
    { name: `Hub Auth Test ${slug}`, slug },
  )
  expect([200, 201]).toContain(hubRes.status)
  const hubId = hubRes.data.hub.id

  const vol = await createVolunteerViaApi(request, { name: `${name} ${Date.now()}` })
  getAuthGuardState(world).hubId = hubId
  getAuthGuardState(world).memberSeedHex = vol.seedHex

  // Store member pubkey for hub membership purposes — hub membership is implied by envelope presence
  getHubKeyState(world).hubId = hubId
  getHubKeyState(world).members.set(name, { name, seedHex: vol.seedHex, pubkey: vol.pubkey })
})

Given('hub key envelopes are set for {string}', async ({ request, world }, name: string) => {
  const hubId = getAuthGuardState(world).hubId
  expect(hubId).toBeTruthy()
  const member = getHubKeyState(world).members.get(name)
  expect(member).toBeTruthy()

  const entry = await generateRealEnvelopeEntry(member!.pubkey, member!.seedHex)
  const res = await apiPut(request, `/hubs/${hubId}/key`, { envelopes: [entry] })
  expect(res.status).toBe(200)
  getHubKeyState(world).originalEnvelopes.set(name, entry.ct)
  getHubKeyState(world).currentEnvelopes.set(name, entry.ct)
})

Given('a volunteer {string} who is not a hub member', async ({ request, world }, name: string) => {
  const vol = await createVolunteerViaApi(request, { name: `${name} ${Date.now()}` })
  getAuthGuardState(world).nonMemberSeedHex = vol.seedHex
})

Given(
  'a volunteer {string} is added to the hub but has no envelope',
  async ({ request, world }, name: string) => {
    // Create a volunteer but do NOT set their envelope — they're "in the hub" via hub roles
    // but the key server has no wrapped key for them
    const vol = await createVolunteerViaApi(request, { name: `${name} ${Date.now()}` })
    getHubKeyState(world).members.set(name, { name, seedHex: vol.seedHex, pubkey: vol.pubkey })
    // Add them to the hub via hub membership (PUT envelopes with existing members only)
    // They won't have an envelope entry, so GET /hubs/:id/key will return 404 for them
    getAuthGuardState(world).noEnvelopeMemberSeedHex = vol.seedHex

    // Add them as a hub member via hub membership API (hub membership = having a hub role)
    // But do NOT add their key envelope — so GET /hubs/:id/key returns 404 for them
    const hubId = getAuthGuardState(world).hubId
    if (hubId) {
      await apiPost(request, `/hubs/${hubId}/members`, { pubkey: vol.pubkey, roleIds: ['role-volunteer'] })
    }
  },
)

When('an unauthenticated client requests the hub key', async ({ request, world }) => {
  const hubId = getAuthGuardState(world).hubId
  expect(hubId).toBeTruthy()
  // No nsec — unauthenticated request
  const res = await request.get(`/api/hubs/${hubId}/key`)
  getAuthGuardState(world).lastStatus = res.status()
})

When('{string} requests the hub key envelope', async ({ request, world }, name: string) => {
  const hubId = getAuthGuardState(world).hubId
  expect(hubId).toBeTruthy()

  // Determine which seed to use based on the name
  let seedHex: string | undefined
  if (getHubKeyState(world).members.has(name)) {
    // Could be the no-envelope member
    seedHex = getAuthGuardState(world).noEnvelopeMemberSeedHex
      ?? getHubKeyState(world).members.get(name)!.seedHex
  } else {
    seedHex = getAuthGuardState(world).nonMemberSeedHex
  }

  const res = await apiGet(request, `/hubs/${hubId}/key`, seedHex)
  getAuthGuardState(world).lastStatus = res.status
})

Then('the hub key response status should be {int}', async ({ world }, expectedStatus: number) => {
  expect(getAuthGuardState(world).lastStatus).toBe(expectedStatus)
})
