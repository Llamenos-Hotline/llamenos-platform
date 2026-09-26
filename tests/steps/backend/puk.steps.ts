/**
 * PUK (Per-User Key) step definitions.
 *
 * PUK envelopes are addressed by SIGCHAIN device ID — the ID the envelope's
 * HPKE AAD binds (`<LABEL_PUK_WRAP_TO_DEVICE>:<deviceId>`) — and the server
 * only accepts addresses the user's own sigchain authorises. Envelopes are
 * real mock-HPKE seals of a PUK seed, so a fetched envelope must open.
 *
 * "the user has a registered device" registers a push-registry device (MLS
 * delivery addresses); it lives here for historical reasons and is shared with
 * mls.steps.ts via shared state.
 */
import { expect } from '@playwright/test'
import { Given, When, Then, Before, getState, setState } from './fixtures'
import { setLastResponse, getSharedState } from './shared-state'
import { apiGet, apiPost } from '../../api-helpers'
import {
  buildSigchainLink,
  deviceAddPayload,
  genesisPayload,
  randomTestDevice,
  sealPukSeed,
  testDevice,
  type TestDevice,
} from '../../identity-helpers'
import { pukWrapAad } from '../../mocks/sigchain-mock'
import { hpkeOpenMock } from '../../mocks/hpke-mock'
import { LABEL_PUK_WRAP_TO_DEVICE } from '@shared/crypto-labels'
import type { PukEnvelopeResponse, SigchainLinkRecord } from '@protocol/schemas/sigchain'
import { bytesToHex } from '@shared/encoding'

// ── State ───────────────────────────────────────────────────────────

interface PukTestState {
  user?: { deviceKey: string; pubkey: string }
  /** Push-registry device IDs (MLS). */
  deviceIds: string[]
  /** Sigchain-authorised devices, by feature label. */
  sigchainDevices: Record<string, TestDevice>
  sigchainHead?: Pick<SigchainLinkRecord, 'seqNo' | 'hash'>
  /** Seed sealed in the most recently distributed generation. */
  lastSeed?: Uint8Array
}

const STATE_KEY = 'puk_test'

function getS(world: Record<string, unknown>): PukTestState {
  const s = getState<PukTestState>(world, STATE_KEY)
  // Fall back to shared user set by "a registered user with a known keypair" step
  if (!s.user) {
    const sharedUser = getSharedState(world).sharedUser
    if (sharedUser) s.user = sharedUser
  }
  return s
}

function requireUser(s: PukTestState) {
  expect(s.user).toBeDefined()
  return s.user!
}

Before(async ({ world }) => {
  setState<PukTestState>(world, STATE_KEY, { deviceIds: [], sigchainDevices: {} })
})

// ── Helpers ─────────────────────────────────────────────────────────

async function registerDevice(
  request: import('@playwright/test').APIRequestContext,
  deviceKey: string,
) {
  const wakeKey = bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
  const pushToken = bytesToHex(crypto.getRandomValues(new Uint8Array(16)))
  return apiPost(request, '/devices/register', { platform: 'ios', pushToken, wakeKeyPublic: wakeKey }, deviceKey)
}

/** One freshly sealed envelope of a new seed per sigchain device, at `generation`. */
function sealForAllDevices(s: PukTestState, generation: number) {
  const seed = crypto.getRandomValues(new Uint8Array(32))
  s.lastSeed = seed
  return Object.values(s.sigchainDevices).map(device => ({
    deviceId: device.deviceId,
    generation,
    envelope: sealPukSeed(seed, device),
  }))
}

function deviceIdFor(s: PukTestState, label: string): string {
  return s.sigchainDevices[label]?.deviceId ?? label
}

// ── Given ───────────────────────────────────────────────────────────

Given('the user has a registered device {string}', async ({ request, world }, label: string) => {
  const s = getS(world)
  const user = requireUser(s)
  const regRes = await registerDevice(request, user.deviceKey)
  expect(regRes.status).toBe(204)
  const listRes = await apiGet<{ devices: Array<{ id: string }> }>(request, '/devices', user.deviceKey)
  expect(listRes.status).toBe(200)
  const latestDevice = listRes.data.devices[listRes.data.devices.length - 1]
  expect(latestDevice).toBeDefined()
  s.deviceIds.push(latestDevice.id)
  // Also write to shared state so MLS step namespace can access device IDs
  const shared = getSharedState(world)
  shared.sharedDeviceIds.push(latestDevice.id)
  shared.sharedDeviceLabels[label] = latestDevice.id
})

Given('the user\'s sigchain authorises device {string}', async ({ request, world }, label: string) => {
  const s = getS(world)
  const user = requireUser(s)
  // The first device is the user's identity device (genesis); later ones are
  // added by it (device_add), exactly as the sigchain grows on a real client.
  const identityDevice = testDevice(user.deviceKey, `${label}-${user.pubkey.slice(0, 8)}`)
  const isFirst = s.sigchainHead === undefined
  const device = isFirst ? identityDevice : randomTestDevice(`${label}-${crypto.randomUUID()}`)
  const signer = isFirst ? identityDevice : Object.values(s.sigchainDevices)[0]
  const body = isFirst
    ? buildSigchainLink(signer, null, 'genesis', genesisPayload(device))
    : buildSigchainLink(signer, s.sigchainHead!, 'device_add', deviceAddPayload(device))
  const res = await apiPost<SigchainLinkRecord>(request, `/users/${user.pubkey}/sigchain`, { ...body }, user.deviceKey)
  expect(res.status).toBe(201)
  s.sigchainHead = { seqNo: res.data.seqNo, hash: res.data.hash }
  s.sigchainDevices[label] = device
})

Given('PUK envelopes are distributed for generation {int}', async ({ request, world }, generation: number) => {
  const s = getS(world)
  const user = requireUser(s)
  expect(Object.keys(s.sigchainDevices).length).toBeGreaterThan(0)
  const res = await apiPost(request, '/puk/envelopes', { envelopes: sealForAllDevices(s, generation) }, user.deviceKey)
  expect(res.status).toBe(201)
})

// ── When ────────────────────────────────────────────────────────────

When('the user distributes PUK envelopes for generation {int}', async ({ request, world }, generation: number) => {
  const s = getS(world)
  const user = requireUser(s)
  expect(Object.keys(s.sigchainDevices).length).toBeGreaterThan(0)
  setLastResponse(world, await apiPost(request, '/puk/envelopes', { envelopes: sealForAllDevices(s, generation) }, user.deviceKey))
})

When('the user distributes PUK envelopes for generation {int} to all devices', async ({ request, world }, generation: number) => {
  const s = getS(world)
  const user = requireUser(s)
  expect(Object.keys(s.sigchainDevices).length).toBeGreaterThan(1)
  setLastResponse(world, await apiPost(request, '/puk/envelopes', { envelopes: sealForAllDevices(s, generation) }, user.deviceKey))
})

When('the user distributes a PUK envelope to unauthorised device {string}', async ({ request, world }, deviceId: string) => {
  const s = getS(world)
  const user = requireUser(s)
  const rogue = randomTestDevice(deviceId)
  const envelope = sealPukSeed(crypto.getRandomValues(new Uint8Array(32)), rogue)
  setLastResponse(world, await apiPost(request, '/puk/envelopes', {
    envelopes: [{ deviceId, generation: 1, envelope }],
  }, user.deviceKey))
})

When('the user distributes a PUK envelope that is not an HPKE envelope', async ({ request, world }) => {
  const s = getS(world)
  const user = requireUser(s)
  const [label] = Object.keys(s.sigchainDevices)
  expect(label).toBeDefined()
  setLastResponse(world, await apiPost(request, '/puk/envelopes', {
    envelopes: [{ deviceId: deviceIdFor(s, label), generation: 1, envelope: bytesToHex(crypto.getRandomValues(new Uint8Array(64))) }],
  }, user.deviceKey))
})

When('the user fetches the PUK envelope for {string}', async ({ request, world }, deviceLabel: string) => {
  const s = getS(world)
  const user = requireUser(s)
  setLastResponse(world, await apiGet(request, `/puk/envelopes/${encodeURIComponent(deviceIdFor(s, deviceLabel))}`, user.deviceKey))
})

// ── Then ────────────────────────────────────────────────────────────

Then('{int} PUK envelope(s) is/are stored', async ({ world }, count: number) => {
  const resp = getSharedState(world).lastResponse
  expect(resp).toBeDefined()
  const data = resp!.data as { distributed: number }
  expect(data.distributed).toBe(count)
})

Then('the PUK envelope generation is {int}', async ({ world }, generation: number) => {
  const resp = getSharedState(world).lastResponse
  expect(resp).toBeDefined()
  const data = resp!.data as { generation: number }
  expect(data.generation).toBe(generation)
})

Then('the fetched envelope opens on {string} to the latest PUK seed', async ({ world }, label: string) => {
  const s = getS(world)
  const device = s.sigchainDevices[label]
  expect(device).toBeDefined()
  expect(s.lastSeed).toBeDefined()
  const resp = getSharedState(world).lastResponse
  expect(resp?.status).toBe(200)
  const data = resp!.data as PukEnvelopeResponse
  const seed = hpkeOpenMock(data.envelope, bytesToHex(device.encryptionSeed), LABEL_PUK_WRAP_TO_DEVICE, pukWrapAad(device.deviceId))
  expect(bytesToHex(seed)).toBe(bytesToHex(s.lastSeed!))
})
