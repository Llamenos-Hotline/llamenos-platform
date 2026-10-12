/**
 * MLS group messaging step definitions.
 * Tests MLS message routing: key packages, commits, welcomes, and fetch-and-clear.
 */
import { expect } from '@playwright/test'
import { Given, When, Then, Before, getState, setState } from './fixtures'
import { setLastResponse, getSharedState, resolveDeviceLabel } from './shared-state'
import {
  apiGet,
  apiPost,
  createHubViaApi,
  addHubMemberViaApi,
  createUserViaApi,
  uniqueName,
} from '../../api-helpers'
import { bytesToHex } from '@shared/encoding'

// ─��� State ────────────────────────────────��──────────────────────────

interface MlsTestState {
  user?: { deviceKey: string; pubkey: string }
  hubId?: string
  deviceIds: string[]
  pendingMessageCount?: number
}

const STATE_KEY = 'mls_test'

function getS(world: Record<string, unknown>): MlsTestState {
  const s = getState<MlsTestState>(world, STATE_KEY)
  // Fall back to shared user set by "a registered user with a known keypair" step
  if (!s.user) {
    const sharedUser = getSharedState(world).sharedUser
    if (sharedUser) s.user = sharedUser
  }
  // Fall back to shared device IDs registered by puk step's "the user has a registered device"
  if (s.deviceIds.length === 0) {
    const sharedIds = getSharedState(world).sharedDeviceIds
    if (sharedIds.length > 0) s.deviceIds = [...sharedIds]
  }
  return s
}

Before(async ({ world }) => {
  setState<MlsTestState>(world, STATE_KEY, { deviceIds: [] })
})

// ── Helpers ─────────────────────────────────────────────────────────

function fakePayload(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
}

function _randomPushToken(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16)))
}

// ── Given ───────────────────────────────────────────────────────────

Given('a test hub exists', async ({ request, world }) => {
  const s = getS(world)
  s.hubId = await createHubViaApi(request, uniqueName('mls-hub'))
  // Add the test user as a hub member so their devices pass getHubMemberDeviceIds() checks
  if (s.user) {
    await addHubMemberViaApi(request, s.hubId, s.user.pubkey)
  }
})

Given('another user has a registered device {string}', async ({ request, world }, label: string) => {
  const s = getS(world)
  expect(s.hubId).toBeDefined()
  // Create a separate user, add them to the hub, register a device, and store the label
  const otherUser = await createUserViaApi(request, { name: `OtherUser-${Date.now()}` })
  await addHubMemberViaApi(request, s.hubId!, otherUser.pubkey)
  const wakeKey = bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
  const pushToken = bytesToHex(crypto.getRandomValues(new Uint8Array(16)))
  const regRes = await apiPost(request, '/devices/register', { platform: 'ios', pushToken, wakeKeyPublic: wakeKey }, otherUser.deviceKey)
  expect(regRes.status).toBe(204)
  const listRes = await apiGet<{ devices: Array<{ id: string }> }>(request, '/devices', otherUser.deviceKey)
  expect(listRes.status).toBe(200)
  const latestDevice = listRes.data.devices[listRes.data.devices.length - 1]
  expect(latestDevice).toBeDefined()
  getSharedState(world).sharedDeviceLabels[label] = latestDevice.id
})

Given('{string} is not a device of any hub member', async ({ world }, label: string) => {
  // Store a fake device ID that will never match any registered device
  getSharedState(world).sharedDeviceLabels[label] = `non-member-fake-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
})

// ── When ────────────────────────────────────────────────────────────

When('the user uploads {int} key packages for {string}', async ({ request, world }, count: number, label: string) => {
  const s = getS(world)
  expect(s.user).toBeDefined()
  expect(s.hubId).toBeDefined()
  const deviceId = resolveDeviceLabel(world, label)
  const keyPackages = Array.from({ length: count }, () => fakePayload())
  setLastResponse(world, await apiPost(request, `/hubs/${s.hubId}/mls/key-packages?deviceId=${deviceId}`, { keyPackages }, s.user!.deviceKey))
})

When('the user sends an MLS commit to device {string}', async ({ request, world }, targetLabel: string) => {
  const s = getS(world)
  expect(s.user).toBeDefined()
  expect(s.hubId).toBeDefined()
  const targetDeviceId = resolveDeviceLabel(world, targetLabel)
  setLastResponse(world, await apiPost(request, `/hubs/${s.hubId}/mls/commit`, {
    recipientDeviceIds: [targetDeviceId], payload: fakePayload(),
  }, s.user!.deviceKey))
})

When('the user sends an MLS welcome to device {string}', async ({ request, world }, targetLabel: string) => {
  const s = getS(world)
  expect(s.user).toBeDefined()
  expect(s.hubId).toBeDefined()
  const targetDeviceId = resolveDeviceLabel(world, targetLabel)
  setLastResponse(world, await apiPost(request, `/hubs/${s.hubId}/mls/welcome`, {
    recipientDeviceId: targetDeviceId, payload: fakePayload(),
  }, s.user!.deviceKey))
})

Given('an MLS commit was sent to {string}', async ({ request, world }, label: string) => {
  const s = getS(world)
  expect(s.user).toBeDefined()
  expect(s.hubId).toBeDefined()
  const deviceId = resolveDeviceLabel(world, label)
  const res = await apiPost(request, `/hubs/${s.hubId}/mls/commit`, {
    recipientDeviceIds: [deviceId], payload: fakePayload(),
  }, s.user!.deviceKey)
  expect(res.status).toBe(204)
})

When('the user fetches MLS messages for {string}', async ({ request, world }, label: string) => {
  const s = getS(world)
  expect(s.user).toBeDefined()
  expect(s.hubId).toBeDefined()
  const deviceId = resolveDeviceLabel(world, label)
  const res = await apiGet(request, `/hubs/${s.hubId}/mls/messages?deviceId=${deviceId}`, s.user!.deviceKey)
  setLastResponse(world, res)
  if (res.status === 200) {
    s.pendingMessageCount = (res.data as { messages: unknown[] }).messages.length
  }
})

When('the user fetches MLS messages for {string} again', async ({ request, world }, label: string) => {
  const s = getS(world)
  expect(s.user).toBeDefined()
  expect(s.hubId).toBeDefined()
  const deviceId = resolveDeviceLabel(world, label)
  const res = await apiGet(request, `/hubs/${s.hubId}/mls/messages?deviceId=${deviceId}`, s.user!.deviceKey)
  setLastResponse(world, res)
  if (res.status === 200) {
    s.pendingMessageCount = (res.data as { messages: unknown[] }).messages.length
  }
})

When('the user fetches MLS messages without a deviceId', async ({ request, world }) => {
  const s = getS(world)
  expect(s.user).toBeDefined()
  expect(s.hubId).toBeDefined()
  setLastResponse(world, await apiGet(request, `/hubs/${s.hubId}/mls/messages`, s.user!.deviceKey))
})

// ── Then ─────────────────────���──────────────────────────────────────

Then('{int} MLS message(s) is/are pending', async ({ world }, count: number) => {
  expect(getS(world).pendingMessageCount).toBe(count)
})
