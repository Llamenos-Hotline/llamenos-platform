/**
 * Backend BDD steps for per-hub spam / call settings (#1051).
 *
 * `workerHub` is "the first hub". A second hub is created per scenario and torn
 * down in an After hook. Only hub-level overrides are ever written — the
 * instance-wide system_settings row is shared by every concurrent scenario.
 */
import { expect } from '@playwright/test'
import { Given, When, Then, After, getState, setState } from './fixtures'
import { setLastResponse } from './shared-state'
import {
  apiGet,
  apiPatch,
  createHubViaApi,
  deleteHubViaApiIfPresent,
  createRoleViaApi,
  createUserViaApi,
  addHubMemberViaApi,
  uniqueName,
} from '../../api-helpers'

interface State {
  secondHubId?: string
  adminSeed?: string
}

const KEY = 'hubScopedCallSettings'

function getS(world: Record<string, unknown>): State {
  return getState<State | undefined>(world, KEY) ?? {}
}

function setS(world: Record<string, unknown>, updates: Partial<State>): void {
  setState(world, KEY, { ...getS(world), ...updates })
}

function secondHub(world: Record<string, unknown>): string {
  const id = getS(world).secondHubId
  if (!id) throw new Error('second hub has not been created')
  return id
}

function adminSeed(world: Record<string, unknown>): string {
  const seed = getS(world).adminSeed
  if (!seed) throw new Error('hub admin has not been created')
  return seed
}

interface SpamSettings { rateLimitEnabled: boolean; voiceCaptchaEnabled: boolean }
interface CallSettings { queueTimeoutSeconds: number }

After({ tags: '@hub-scoped-call-settings' }, async ({ request, world }) => {
  const id = getS(world).secondHubId
  if (id) await deleteHubViaApiIfPresent(request, id)
})

Given('a second hub exists', async ({ request, world }) => {
  const id = await createHubViaApi(request, `bdd-scoped-b-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  setS(world, { secondHubId: id })
})

Given(
  'the second hub\'s spam settings are set to rate limiting on and CAPTCHA off',
  async ({ request, world }) => {
    const { status } = await apiPatch(request, `/hubs/${secondHub(world)}/settings/spam`, {
      rateLimitEnabled: true,
      voiceCaptchaEnabled: false,
    })
    expect(status).toBe(200)
  },
)

Given('the second hub\'s queue timeout is set to {int} seconds', async ({ request, world }, seconds: number) => {
  const { status } = await apiPatch(request, `/hubs/${secondHub(world)}/settings/call`, {
    queueTimeoutSeconds: seconds,
  })
  expect(status).toBe(200)
})

Given('a hub admin who administers only the first hub', async ({ request, world, workerHub }) => {
  const role = await createRoleViaApi(request, {
    name: uniqueName('scoped-settings-admin'),
    slug: `scoped-settings-admin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    permissions: ['settings:manage-spam', 'settings:manage-calls'],
  })
  // No global roles — every permission comes from membership of the first hub.
  const user = await createUserViaApi(request, { name: uniqueName('scoped-admin'), roleIds: [] })
  await addHubMemberViaApi(request, workerHub, user.pubkey, [role.id])
  setS(world, { adminSeed: user.seedHex })
})

When(
  'the hub admin sets the first hub\'s spam settings to rate limiting off and CAPTCHA on',
  async ({ request, world, workerHub }) => {
    const res = await apiPatch(
      request,
      `/hubs/${workerHub}/settings/spam`,
      { rateLimitEnabled: false, voiceCaptchaEnabled: true },
      adminSeed(world),
    )
    setLastResponse(world, res)
  },
)

When('the hub admin sets the first hub\'s queue timeout to {int} seconds', async ({ request, world, workerHub }, seconds: number) => {
  const res = await apiPatch(
    request,
    `/hubs/${workerHub}/settings/call`,
    { queueTimeoutSeconds: seconds },
    adminSeed(world),
  )
  setLastResponse(world, res)
})

When('the hub admin sets the platform-wide spam settings to rate limiting off', async ({ request, world }) => {
  const res = await apiPatch(request, '/settings/spam', { rateLimitEnabled: false }, adminSeed(world))
  setLastResponse(world, res)
})

When(
  'the hub admin sets the first hub\'s spam settings to rate limiting off through the second hub\'s query parameter',
  async ({ request, world, workerHub }) => {
    const res = await apiPatch(
      request,
      `/hubs/${workerHub}/settings/spam?hubId=${secondHub(world)}`,
      { rateLimitEnabled: false },
      adminSeed(world),
    )
    setLastResponse(world, res)
  },
)

async function readSpam(
  request: Parameters<typeof apiGet>[0],
  hubId: string,
): Promise<SpamSettings> {
  const { status, data } = await apiGet<SpamSettings>(request, `/hubs/${hubId}/settings/spam`)
  expect(status).toBe(200)
  return data
}

Then(
  'the first hub\'s spam settings should show rate limiting off and CAPTCHA on',
  async ({ request, workerHub }) => {
    const s = await readSpam(request, workerHub)
    expect(s.rateLimitEnabled).toBe(false)
    expect(s.voiceCaptchaEnabled).toBe(true)
  },
)

Then(
  'the second hub\'s spam settings should show rate limiting on and CAPTCHA off',
  async ({ request, world }) => {
    const s = await readSpam(request, secondHub(world))
    expect(s.rateLimitEnabled).toBe(true)
    expect(s.voiceCaptchaEnabled).toBe(false)
  },
)

async function readQueueTimeout(request: Parameters<typeof apiGet>[0], hubId: string): Promise<number> {
  const { status, data } = await apiGet<CallSettings>(request, `/hubs/${hubId}/settings/call`)
  expect(status).toBe(200)
  return data.queueTimeoutSeconds
}

Then('the first hub\'s queue timeout should be {int} seconds', async ({ request, workerHub }, seconds: number) => {
  expect(await readQueueTimeout(request, workerHub)).toBe(seconds)
})

Then('the second hub\'s queue timeout should be {int} seconds', async ({ request, world }, seconds: number) => {
  expect(await readQueueTimeout(request, secondHub(world))).toBe(seconds)
})
