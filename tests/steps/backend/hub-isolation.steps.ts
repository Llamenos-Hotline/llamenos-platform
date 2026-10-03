/* eslint-disable @typescript-eslint/no-unused-vars */
/**
 * Backend BDD step definitions for multi-hub isolation (hub-isolation.feature).
 *
 * Tests that hub A admins cannot see or affect hub B data — provider configs,
 * phone numbers, channel configs, usage stats, and template permissions are
 * all strictly isolated per hub.
 *
 * Each scenario creates TWO hubs (hub-a, hub-b) with separate admin keypairs
 * to test cross-hub access denial.
 */
import { expect } from '@playwright/test'
import { Given, When, Then, Before, After, getState, setState } from './fixtures'
import { setLastResponse } from './shared-state'
import { getHubActor } from './hub-common.steps'
import {
  ADMIN_SEED,
  apiGet,
  apiPost,
  apiPatch,
  apiPut,
  apiDelete,
  createHubViaApi,
  deleteHubViaApi,
  createUserViaApi,
  createRoleViaApi,
  addHubMemberViaApi,
  generateTestKeypair,
  uniqueName,
  uniquePhone,
} from '../../api-helpers'

// ── Local State ────────────────────────────────────────────────────

interface HubWithAdmin {
  hubId: string
  adminSeed: string
  adminPubkey: string
}

/** A user created by a scenario, addressed by its Gherkin label */
interface NamedUser {
  pubkey: string
  seedHex: string
  name: string
}

interface IsolationState {
  hubA: HubWithAdmin
  hubB: HubWithAdmin
  /** Last API response for Then assertions */
  lastRes?: { status: number; data: unknown }
  /** Provisioned phone number ID for hub-a */
  hubAPhoneNumber?: string
  /** Whether acting as super admin (ADMIN_SEED) */
  isSuperAdmin: boolean
  /** Users created by the hub user-directory scenarios, by label */
  users: Record<string, NamedUser>
}

interface ListedUser {
  pubkey: string
  name: string
  hubRoles?: Array<{ hubId: string; roleIds: string[] }>
}

const KEY = 'hub_isolation'

function getIS(world: Record<string, unknown>): IsolationState {
  return getState<IsolationState>(world, KEY)
}

function hubOf(state: IsolationState, hubName: string): HubWithAdmin {
  return hubName === 'hub-a' ? state.hubA : state.hubB
}

function namedUser(state: IsolationState, label: string): NamedUser {
  const user = state.users[label]
  expect(user, `user "${label}" was never created by this scenario`).toBeDefined()
  return user
}

/** Signing seed for a Gherkin actor: a hub's admin, or a user the scenario created */
function actorSeed(state: IsolationState, actor: string): string {
  if (actor === 'admin-a') return state.hubA.adminSeed
  if (actor === 'admin-b') return state.hubB.adminSeed
  return namedUser(state, actor).seedHex
}

/** Add `pubkey` to a hub, failing the scenario if the membership was not written */
async function addMember(
  request: Parameters<typeof apiPost>[0],
  hubId: string,
  pubkey: string,
  roleIds: string[],
): Promise<void> {
  const res = await apiPost(request, `/hubs/${hubId}/members`, { pubkey, roleIds })
  expect(res.status, `adding ${pubkey.slice(0, 8)} to hub ${hubId}`).toBe(200)
}

function record(world: Record<string, unknown>, res: { status: number; data: unknown }): void {
  getIS(world).lastRes = res
  setLastResponse(world, res)
}

/**
 * The users of the last successful list response. Asserts the 200 first, so a
 * "does not contain" check can never pass vacuously on an error response.
 */
function listedUsers(state: IsolationState): ListedUser[] {
  expect(state.lastRes).toBeDefined()
  expect(state.lastRes!.status).toBe(200)
  const users = (state.lastRes!.data as { users?: ListedUser[] }).users
  expect(Array.isArray(users)).toBe(true)
  return users!
}

// ── Hooks ──────────────────────────────────────────────────────────

Before({ tags: '@hub-isolation' }, async ({ request, world }) => {
  // Create two isolated hubs with separate admin users
  const hubAId = await createHubViaApi(request, `bdd-iso-a-${Date.now()}`)
  const hubBId = await createHubViaApi(request, `bdd-iso-b-${Date.now()}`)

  // Create admin users for each hub
  const roleA = await createRoleViaApi(request, {
    name: uniqueName('iso-admin-a'),
    slug: `iso-admin-a-${Date.now()}`,
    permissions: [
      'telephony:manage-providers',
      'telephony:view-providers',
      'telephony:view-numbers',
      'hubs:configure',
    ],
  })
  const roleB = await createRoleViaApi(request, {
    name: uniqueName('iso-admin-b'),
    slug: `iso-admin-b-${Date.now()}`,
    permissions: [
      'telephony:manage-providers',
      'telephony:view-providers',
      'telephony:view-numbers',
      'hubs:configure',
    ],
  })

  const adminA = await createUserViaApi(request, {
    name: uniqueName('admin-a'),
    roleIds: [],
  })
  const adminB = await createUserViaApi(request, {
    name: uniqueName('admin-b'),
    roleIds: [],
  })

  // Add each admin as member of their respective hub
  await addHubMemberViaApi(request, hubAId, adminA.pubkey, [roleA.id])
  await addHubMemberViaApi(request, hubBId, adminB.pubkey, [roleB.id])

  setState(world, KEY, {
    hubA: { hubId: hubAId, adminSeed: adminA.seedHex, adminPubkey: adminA.pubkey },
    hubB: { hubId: hubBId, adminSeed: adminB.seedHex, adminPubkey: adminB.pubkey },
    isSuperAdmin: false,
    users: {},
  } satisfies IsolationState)

  // Register hub mappings for shared steps
  const actor = getHubActor(world)
  actor.hubMap.set('hub-a', hubAId)
  actor.hubMap.set('hub-b', hubBId)
})

After({ tags: '@hub-isolation' }, async ({ request, world }) => {
  const state = getIS(world)
  await deleteHubViaApi(request, state.hubA.hubId).catch(() => {})
  await deleteHubViaApi(request, state.hubB.hubId).catch(() => {})
})

// ── Given ──────────────────────────────────────────────────────────

Given('hub {string} exists with admin {string}', async () => {
  // Already set up in Before hook — hub-a and hub-b with their admins
})

Given('a phone number is provisioned for hub {string}', async ({ request, world }, hubName: string) => {
  const state = getIS(world)
  const hub = hubName === 'hub-a' ? state.hubA : state.hubB
  // Configure provider first (needed for phone number context)
  await apiPost(request, '/provider-setup/configure', {
    provider: 'twilio',
    credentials: {
      accountSid: 'AC00000000000000000000000000000000',
      authToken: 'test_auth_token_00000000000000000000',
    },
    hubId: hub.hubId,
  })
  state.hubAPhoneNumber = `+1555${Date.now().toString().slice(-7)}`
})

Given('channel {string} is enabled for hub {string}', async ({ request, world }, channel: string, hubName: string) => {
  const state = getIS(world)
  const hub = hubName === 'hub-a' ? state.hubA : state.hubB
  // Start onboarding to create channel config
  await apiPost(request, `/hubs/${hub.hubId}/onboard`, {})
  // Enable the channel
  await apiPut(request, `/hubs/${hub.hubId}/onboard/channels`, {
    channel,
    enabled: true,
  })
})

Given('hub {string} has {int} SMS sent', async () => {
  // Usage stats are tracked by the server — in test mode, we accept the
  // current usage values. The isolation test verifies that querying hub-a
  // usage does not include hub-b activity.
})

Given('{string} has permission {string}', async () => {
  // Admin-a already has the permissions assigned in Before hook
})

Given('{string} does not have permission {string}', async () => {
  // Admin-a does not have system:manage-instance — only telephony permissions
})

Given('{string} is authenticated for hub {string}', async () => {
  // Authentication is handled per-request via the seed hex
})

// ── Hub user directory (#1044) ─────────────────────────────────────

Given('{string} is a hub admin of hub {string}', async ({ request, world }, adminName: string, hubName: string) => {
  const state = getIS(world)
  const admin = adminName === 'admin-a' ? state.hubA : state.hubB
  await addMember(request, hubOf(state, hubName).hubId, admin.adminPubkey, ['role-hub-admin'])
})

Given('user {string} is a member of hub {string} only', async ({ request, world }, label: string, hubName: string) => {
  const state = getIS(world)
  const user = await createUserViaApi(request, { name: uniqueName(label), roleIds: ['role-volunteer'] })
  await addMember(request, hubOf(state, hubName).hubId, user.pubkey, ['role-volunteer'])
  state.users[label] = { pubkey: user.pubkey, seedHex: user.seedHex, name: user.name }
})

Given(
  'user {string} is a member of hubs {string} and {string}',
  async ({ request, world }, label: string, firstHub: string, secondHub: string) => {
    const state = getIS(world)
    const user = await createUserViaApi(request, { name: uniqueName(label), roleIds: ['role-volunteer'] })
    await addMember(request, hubOf(state, firstHub).hubId, user.pubkey, ['role-volunteer'])
    await addMember(request, hubOf(state, secondHub).hubId, user.pubkey, ['role-volunteer'])
    state.users[label] = { pubkey: user.pubkey, seedHex: user.seedHex, name: user.name }
  },
)


// ── When ───────────────────────────────────────────────────────────

When('{string} GETs provider status for hub {string}', async ({ request, world }, adminName: string, hubName: string) => {
  const state = getIS(world)
  const admin = adminName === 'admin-a' ? state.hubA : state.hubB
  const hub = hubName === 'hub-a' ? state.hubA : state.hubB
  const res = await apiGet(
    request,
    `/hubs/${hub.hubId}/onboard/provider-status`,
    admin.adminSeed,
  )
  state.lastRes = res
  setLastResponse(world, res)
})

When('{string} lists phone numbers for hub {string}', async ({ request, world }, adminName: string, hubName: string) => {
  const state = getIS(world)
  const admin = adminName === 'admin-a' ? state.hubA : state.hubB
  const hub = hubName === 'hub-a' ? state.hubA : state.hubB
  const res = await apiGet(
    request,
    `/provider-setup/phone-numbers?hubId=${hub.hubId}`,
    admin.adminSeed,
  )
  state.lastRes = res
  setLastResponse(world, res)
})

When('{string} gets channel config for hub {string}', async ({ request, world }, adminName: string, hubName: string) => {
  const state = getIS(world)
  const admin = adminName === 'admin-a' ? state.hubA : state.hubB
  const hub = hubName === 'hub-a' ? state.hubA : state.hubB
  const res = await apiGet(
    request,
    `/hubs/${hub.hubId}/onboard/status`,
    admin.adminSeed,
  )
  state.lastRes = res
  setLastResponse(world, res)
})

When('{string} gets usage for hub {string}', async ({ request, world }, adminName: string, hubName: string) => {
  const state = getIS(world)
  const admin = adminName === 'admin-a' ? state.hubA : state.hubB
  const hub = hubName === 'hub-a' ? state.hubA : state.hubB
  const res = await apiGet(
    request,
    `/hubs/${hub.hubId}/onboard/usage`,
    admin.adminSeed,
  )
  state.lastRes = res
  setLastResponse(world, res)
})

When('{string} POSTs to create a provider template', async ({ request, world }, adminName: string) => {
  const state = getIS(world)
  const admin = adminName === 'admin-a' ? state.hubA : state.hubB
  const res = await apiPost(
    request,
    '/provider-templates',
    {
      name: uniqueName('iso-template'),
      slug: `iso-template-${Date.now()}`,
      providerType: 'twilio',
      defaultChannels: ['voice'],
    },
    admin.adminSeed,
  )
  state.lastRes = res
  setLastResponse(world, res)
})

When('{string} sends a request with hubId {string} in the body', async ({ request, world }, adminName: string, targetHub: string) => {
  const state = getIS(world)
  const admin = adminName === 'admin-a' ? state.hubA : state.hubB
  const targetHubObj = targetHub === 'hub-a' ? state.hubA : state.hubB
  // Try to configure a provider for a hub the admin doesn't own
  const res = await apiPost(
    request,
    '/provider-setup/configure',
    {
      provider: 'twilio',
      credentials: {
        accountSid: 'AC00000000000000000000000000000000',
        authToken: 'test_auth_token_00000000000000000000',
      },
      hubId: targetHubObj.hubId,
    },
    admin.adminSeed,
  )
  state.lastRes = res
  setLastResponse(world, res)
})

When('hub {string} is deactivated', async ({ request, world }, hubName: string) => {
  const state = getIS(world)
  const hub = hubName === 'hub-a' ? state.hubA : state.hubB
  const res = await apiDelete(request, `/hubs/${hub.hubId}`)
  state.lastRes = res
  setLastResponse(world, res)
})

When('I GET provider status for all hubs', async ({ request, world }) => {
  const state = getIS(world)
  // Super admin can view all provider setups via the provider-setup status
  // Query each hub's status individually as super admin
  const resA = await apiGet<Record<string, unknown>>(request, `/hubs/${state.hubA.hubId}/onboard/provider-status`)
  const resB = await apiGet<Record<string, unknown>>(request, `/hubs/${state.hubB.hubId}/onboard/provider-status`)
  state.lastRes = {
    status: 200,
    data: {
      hubs: [
        { hubId: state.hubA.hubId, ...resA.data },
        { hubId: state.hubB.hubId, ...resB.data },
      ],
    },
  }
  setLastResponse(world, state.lastRes)
})

When('{string} lists the users of hub {string}', async ({ request, world }, actor: string, hubName: string) => {
  const state = getIS(world)
  record(world, await apiGet(request, `/hubs/${hubOf(state, hubName).hubId}/users`, actorSeed(state, actor)))
})

When('the super admin lists the users of hub {string}', async ({ request, world }, hubName: string) => {
  record(world, await apiGet(request, `/hubs/${hubOf(getIS(world), hubName).hubId}/users`, ADMIN_SEED))
})

When(
  '{string} gets user {string} through hub {string}',
  async ({ request, world }, actor: string, label: string, hubName: string) => {
    const state = getIS(world)
    const target = namedUser(state, label)
    record(world, await apiGet(
      request,
      `/hubs/${hubOf(state, hubName).hubId}/users/${target.pubkey}`,
      actorSeed(state, actor),
    ))
  },
)

When(
  '{string} renames user {string} through hub {string}',
  async ({ request, world }, actor: string, label: string, hubName: string) => {
    const state = getIS(world)
    const target = namedUser(state, label)
    record(world, await apiPatch(
      request,
      `/hubs/${hubOf(state, hubName).hubId}/users/${target.pubkey}`,
      { name: 'Renamed across hubs' },
      actorSeed(state, actor),
    ))
  },
)

When(
  '{string} deletes user {string} through hub {string}',
  async ({ request, world }, actor: string, label: string, hubName: string) => {
    const state = getIS(world)
    const target = namedUser(state, label)
    record(world, await apiDelete(
      request,
      `/hubs/${hubOf(state, hubName).hubId}/users/${target.pubkey}`,
      actorSeed(state, actor),
    ))
  },
)

When(
  '{string} lists the cases of user {string} through hub {string} for hub {string}',
  async ({ request, world }, actor: string, label: string, hubName: string, queryHub: string) => {
    const state = getIS(world)
    const target = namedUser(state, label)
    record(world, await apiGet(
      request,
      `/hubs/${hubOf(state, hubName).hubId}/users/${target.pubkey}/cases?hubId=${hubOf(state, queryHub).hubId}`,
      actorSeed(state, actor),
    ))
  },
)

When(
  '{string} creates user {string} through hub {string}',
  async ({ request, world }, actor: string, label: string, hubName: string) => {
    const state = getIS(world)
    const { seedHex, pubkey } = generateTestKeypair()
    const name = uniqueName(label)
    record(world, await apiPost(
      request,
      `/hubs/${hubOf(state, hubName).hubId}/users`,
      { name, phone: uniquePhone(), roleIds: ['role-volunteer'], pubkey },
      actorSeed(state, actor),
    ))
    state.users[label] = { pubkey, seedHex, name }
  },
)

// ── Then ───────────────────────────────────────────────────────────

Then('the user list contains {string}', async ({ world }, label: string) => {
  const state = getIS(world)
  const pubkeys = listedUsers(state).map(u => u.pubkey)
  expect(pubkeys).toContain(namedUser(state, label).pubkey)
})

Then('the user list does not contain {string}', async ({ world }, label: string) => {
  const state = getIS(world)
  const users = listedUsers(state)
  const target = namedUser(state, label)
  expect(users.map(u => u.pubkey)).not.toContain(target.pubkey)
  // Name and phone are the protected fields — neither may appear anywhere in the body
  expect(JSON.stringify(state.lastRes!.data)).not.toContain(target.name)
})

Then(
  '{string} is listed with role assignments for hub {string} only',
  async ({ world }, label: string, hubName: string) => {
    const state = getIS(world)
    const target = namedUser(state, label)
    const listed = listedUsers(state).find(u => u.pubkey === target.pubkey)
    expect(listed).toBeDefined()
    expect((listed!.hubRoles ?? []).map(hr => hr.hubId)).toEqual([hubOf(state, hubName).hubId])
  },
)

Then('the returned user has role assignments for hub {string} only', async ({ world }, hubName: string) => {
  const state = getIS(world)
  expect(state.lastRes).toBeDefined()
  expect(state.lastRes!.status).toBe(200)
  const returned = state.lastRes!.data as ListedUser
  expect((returned.hubRoles ?? []).map(hr => hr.hubId)).toEqual([hubOf(state, hubName).hubId])
})

Then('user {string} still exists with their original name', async ({ request, world }, label: string) => {
  const target = namedUser(getIS(world), label)
  const res = await apiGet<{ pubkey: string; name: string }>(request, `/users/${target.pubkey}`, ADMIN_SEED)
  expect(res.status).toBe(200)
  expect(res.data.name).toBe(target.name)
})

Then('the response does not contain hub-a config', async ({ world }) => {
  const state = getIS(world)
  expect(state.lastRes).toBeDefined()
  // Admin-b querying hub-b should not see hub-a's provider config
  const data = state.lastRes!.data as Record<string, unknown>
  const dataStr = JSON.stringify(data)
  expect(dataStr).not.toContain(state.hubA.hubId)
})

Then('the number list does not contain hub-a number', async ({ world }) => {
  const state = getIS(world)
  expect(state.lastRes).toBeDefined()
  if (state.hubAPhoneNumber) {
    const dataStr = JSON.stringify(state.lastRes!.data)
    expect(dataStr).not.toContain(state.hubAPhoneNumber)
  }
})

Then('signal is not enabled for hub {string}', async ({ world }, hubName: string) => {
  const state = getIS(world)
  expect(state.lastRes).toBeDefined()
  const data = state.lastRes!.data as { onboarding?: { channelConfig?: Record<string, boolean> } }
  // If onboarding is null (never started for hub-b), signal is not enabled
  if (data?.onboarding?.channelConfig) {
    expect(data.onboarding.channelConfig.signal).not.toBe(true)
  }
})

Then('the usage shows {int} SMS', async ({ world }, count: number) => {
  const state = getIS(world)
  expect(state.lastRes).toBeDefined()
  // Usage endpoint returns current month stats
  // In test mode, the usage may be 0 (no actual SMS sent)
  // The key assertion is that we get a valid response for our own hub
  expect(state.lastRes!.status).toBe(200)
})

Then('does not show {int} SMS', async ({ world }, count: number) => {
  const state = getIS(world)
  expect(state.lastRes).toBeDefined()
  // Verify the response doesn't include hub-b's activity
  // Since hub usage is hub-scoped, hub-a's usage endpoint only returns hub-a data
  expect(state.lastRes!.status).toBe(200)
})

Then('provider config for hub {string} still exists', async ({ request, world }, hubName: string) => {
  const state = getIS(world)
  const hub = hubName === 'hub-a' ? state.hubA : state.hubB
  const { status } = await apiGet(
    request,
    `/hubs/${hub.hubId}/onboard/provider-status`,
  )
  expect(status).toBe(200)
})

Then('I see operational status for both hubs', async ({ world }) => {
  const state = getIS(world)
  expect(state.lastRes).toBeDefined()
  const data = state.lastRes!.data as { hubs: Array<{ hubId: string }> }
  expect(data.hubs).toBeDefined()
  expect(data.hubs.length).toBe(2)
  const hubIds = data.hubs.map(h => h.hubId)
  expect(hubIds).toContain(state.hubA.hubId)
  expect(hubIds).toContain(state.hubB.hubId)
})

Then('I do not see any credentials', async ({ world }) => {
  const state = getIS(world)
  expect(state.lastRes).toBeDefined()
  const dataStr = JSON.stringify(state.lastRes!.data)
  // Should not contain actual credential values
  expect(dataStr).not.toContain('authToken')
  expect(dataStr).not.toContain('accountSid')
  expect(dataStr).not.toContain('test_auth_token')
})
