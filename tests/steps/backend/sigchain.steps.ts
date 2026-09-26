/**
 * Sigchain integrity step definitions.
 *
 * Links are hashed and signed with tests/mocks/sigchain-mock.ts (pinned
 * byte-for-byte against packages/crypto), and chains read back from the server
 * are verified with its `verify_sigchain` mirror — so "the chain verifies"
 * means what it means on a real client.
 */
import { expect } from '@playwright/test'
import { Given, When, Then, Before, getState, setState } from './fixtures'
import { setLastResponse, getSharedState } from './shared-state'
import { apiGet, apiPost, createUserViaApi, ADMIN_NSEC } from '../../api-helpers'
import {
  buildSigchainLink,
  deviceAddPayload,
  genesisPayload,
  getSigchainViaApi,
  initializeIdentityViaApi,
  randomTestDevice,
  testDevice,
  toMockSigchainLink,
  type InitializedIdentity,
  type TestDevice,
} from '../../identity-helpers'
import { derivePukSubkeysMock, pukWrapAad, verifySigchainMock } from '../../mocks/sigchain-mock'
import { hpkeOpenMock } from '../../mocks/hpke-mock'
import { LABEL_PUK_WRAP_TO_DEVICE } from '@shared/crypto-labels'
import {
  sigchainPukEpochPayloadSchema,
  type AppendSigchainLinkBody,
  type PukEnvelopeResponse,
  type SigchainLinkRecord,
  type SigchainLinkType,
} from '@protocol/schemas/sigchain'
import { bytesToHex } from '@shared/encoding'

// ── State ───────────────────────────────────────────────────────────

interface SigchainUser {
  deviceKey: string
  pubkey: string
  device: TestDevice
}

interface SigchainTestState {
  user?: SigchainUser
  secondUser?: SigchainUser
  head?: Pick<SigchainLinkRecord, 'seqNo' | 'hash'>
  identity?: InitializedIdentity
}

const STATE_KEY = 'sigchain_test'

function getS(world: Record<string, unknown>): SigchainTestState {
  return getState<SigchainTestState>(world, STATE_KEY)
}

function requireUser(s: SigchainTestState): SigchainUser {
  expect(s.user).toBeDefined()
  return s.user!
}

Before(async ({ world }) => {
  setState<SigchainTestState>(world, STATE_KEY, {})
})

// ── Helpers ─────────────────────────────────────────────────────────

/** A payload of the right shape for `linkType` (the server validates payload.type and shape). */
function payloadFor(linkType: SigchainLinkType, device: TestDevice): Record<string, unknown> {
  switch (linkType) {
    case 'genesis':
      return genesisPayload(device)
    case 'device_add':
      return deviceAddPayload(randomTestDevice(`added-${crypto.randomUUID()}`))
    case 'device_remove': {
      const removed = randomTestDevice(`removed-${crypto.randomUUID()}`)
      return { type: 'device_remove', deviceId: removed.deviceId, devicePubkey: removed.signingPubkeyHex }
    }
    case 'puk_epoch': {
      const puk = derivePukSubkeysMock(crypto.getRandomValues(new Uint8Array(32)), 1)
      return { type: 'puk_epoch', generation: puk.generation, signPubkey: puk.signPubkeyHex, dhPubkey: puk.dhPubkeyHex }
    }
    case 'key_rotate':
      return { type: 'key_rotate' }
  }
}

async function postLink(
  request: import('@playwright/test').APIRequestContext,
  authSeed: string,
  targetPubkey: string,
  body: AppendSigchainLinkBody,
) {
  return apiPost<SigchainLinkRecord>(request, `/users/${targetPubkey}/sigchain`, { ...body }, authSeed)
}

async function appendAndTrack(
  request: import('@playwright/test').APIRequestContext,
  world: Record<string, unknown>,
  body: AppendSigchainLinkBody,
) {
  const s = getS(world)
  const user = requireUser(s)
  const res = await postLink(request, user.deviceKey, user.pubkey, body)
  setLastResponse(world, res)
  if (res.status === 201) s.head = { seqNo: res.data.seqNo, hash: res.data.hash }
  return res
}

// ── Given ───────────────────────────────────────────────────────────

Given('a registered user with a known keypair', async ({ request, world }) => {
  const user = await createUserViaApi(request, { name: `Sigchain User ${Date.now()}` })
  getS(world).user = { deviceKey: user.deviceKey, pubkey: user.pubkey, device: testDevice(user.deviceKey) }
  // Also write to shared state so PUK/WebAuthn step namespaces can access it
  getSharedState(world).sharedUser = { deviceKey: user.deviceKey, pubkey: user.pubkey }
})

Given('the user has a genesis sigchain link', async ({ request, world }) => {
  const user = requireUser(getS(world))
  const res = await appendAndTrack(request, world, buildSigchainLink(user.device, null, 'genesis', genesisPayload(user.device)))
  expect(res.status).toBe(201)
})

Given('a second registered user', async ({ request, world }) => {
  const user = await createUserViaApi(request, { name: `Second User ${Date.now()}` })
  getS(world).secondUser = { deviceKey: user.deviceKey, pubkey: user.pubkey, device: testDevice(user.deviceKey) }
})

// ── When ────────────────────────────────────────────────────────────

When('the user appends a genesis sigchain link', async ({ request, world }) => {
  const user = requireUser(getS(world))
  await appendAndTrack(request, world, buildSigchainLink(user.device, null, 'genesis', genesisPayload(user.device)))
})

When('the user appends a {string} link with valid prevHash', async ({ request, world }, linkType: string) => {
  const s = getS(world)
  const user = requireUser(s)
  expect(s.head).toBeDefined()
  const type = linkType as SigchainLinkType
  await appendAndTrack(request, world, buildSigchainLink(user.device, s.head!, type, payloadFor(type, user.device)))
})

When('the user appends a link with an invalid Ed25519 signature', async ({ request, world }) => {
  const s = getS(world)
  const user = requireUser(s)
  expect(s.head).toBeDefined()
  const body = buildSigchainLink(user.device, s.head!, 'device_add', payloadFor('device_add', user.device))
  await appendAndTrack(request, world, { ...body, signature: 'badbad' }) // doesn't match 128-char hex regex
})

When('the user appends a link with wrong prevHash', async ({ request, world }) => {
  const s = getS(world)
  const user = requireUser(s)
  expect(s.head).toBeDefined()
  const wrongHead = { seqNo: s.head!.seqNo, hash: bytesToHex(crypto.getRandomValues(new Uint8Array(32))) }
  await appendAndTrack(request, world, buildSigchainLink(user.device, wrongHead, 'device_add', payloadFor('device_add', user.device)))
})

When('the user appends a link with duplicate seqNo {int}', async ({ request, world }, seqNo: number) => {
  const user = requireUser(getS(world))
  const head = seqNo > 1 ? { seqNo: seqNo - 1, hash: bytesToHex(crypto.getRandomValues(new Uint8Array(32))) } : null
  const linkType: SigchainLinkType = seqNo === 1 ? 'genesis' : 'device_add'
  await appendAndTrack(request, world, buildSigchainLink(user.device, head, linkType, payloadFor(linkType, user.device)))
})

When('the second user tries to append to the first user\'s sigchain', async ({ request, world }) => {
  const s = getS(world)
  const user = requireUser(s)
  expect(s.secondUser).toBeDefined()
  const body = buildSigchainLink(s.secondUser!.device, null, 'genesis', genesisPayload(s.secondUser!.device))
  setLastResponse(world, await postLink(request, s.secondUser!.deviceKey, user.pubkey, body))
})

When('the user appends a genesis link signed by a key other than their identity key', async ({ request, world }) => {
  const other = randomTestDevice(`other-${crypto.randomUUID()}`)
  await appendAndTrack(request, world, buildSigchainLink(other, null, 'genesis', genesisPayload(other)))
})

When('the user appends a device_add link as the first link of their sigchain', async ({ request, world }) => {
  const user = requireUser(getS(world))
  await appendAndTrack(request, world, buildSigchainLink(user.device, null, 'device_add', payloadFor('device_add', user.device)))
})

When('the admin reads the user\'s sigchain', async ({ request, world }) => {
  const user = requireUser(getS(world))
  setLastResponse(world, await apiGet(request, `/users/${user.pubkey}/sigchain`, ADMIN_NSEC))
})

When('the second user tries to read the first user\'s sigchain', async ({ request, world }) => {
  const s = getS(world)
  const user = requireUser(s)
  expect(s.secondUser).toBeDefined()
  setLastResponse(world, await apiGet(request, `/users/${user.pubkey}/sigchain`, s.secondUser!.deviceKey))
})

// ── Hash recomputation scenarios ─────────────────────────────────

When('the user appends a genesis sigchain link with correctly computed hash', async ({ request, world }) => {
  const user = requireUser(getS(world))
  await appendAndTrack(request, world, buildSigchainLink(user.device, null, 'genesis', genesisPayload(user.device)))
})

When('the user appends a sigchain link whose payload was modified after hashing', async ({ request, world }) => {
  const user = requireUser(getS(world))
  const body = buildSigchainLink(user.device, null, 'genesis', genesisPayload(user.device))
  // Tamper the payload AFTER hashing and signing (still a well-formed genesis payload).
  const tampered = { ...body.payload, deviceEncryptionPubkey: bytesToHex(crypto.getRandomValues(new Uint8Array(32))) }
  await appendAndTrack(request, world, { ...body, payload: tampered })
})

When('the user appends a sigchain link with a hash that does not match the canonical content', async ({ request, world }) => {
  const user = requireUser(getS(world))
  const body = buildSigchainLink(user.device, null, 'genesis', genesisPayload(user.device))
  await appendAndTrack(request, world, { ...body, hash: bytesToHex(crypto.getRandomValues(new Uint8Array(32))) })
})

// ── Identity initialisation (#1050) ──────────────────────────────

When('the user initialises their identity', async ({ request, world }) => {
  const s = getS(world)
  const user = requireUser(s)
  s.identity = await initializeIdentityViaApi(request, user.pubkey, user.device)
})

Then('the stored sigchain verifies and authorises only the user\'s device', async ({ request, world }) => {
  const user = requireUser(getS(world))
  const links = await getSigchainViaApi(request, user.pubkey, user.deviceKey)
  const verified = verifySigchainMock(links.map(toMockSigchainLink))
  expect(verified.verifiedCount).toBe(links.length)
  expect(verified.headHash).toBe(links[links.length - 1].hash)
  expect(verified.activeDevicePubkeys).toEqual([user.pubkey])
})

Then('the sigchain link types are {string}', async ({ request, world }, types: string) => {
  const user = requireUser(getS(world))
  const links = await getSigchainViaApi(request, user.pubkey, user.deviceKey)
  expect(links.map(l => `${l.seqNo}:${l.linkType}`).join(',')).toBe(types)
})

Then('the user\'s device opens its PUK envelope to the seed the puk_epoch link binds', async ({ request, world }) => {
  const s = getS(world)
  const user = requireUser(s)
  const res = await apiGet<PukEnvelopeResponse>(request, `/puk/envelopes/${encodeURIComponent(user.device.deviceId)}`, user.deviceKey)
  expect(res.status).toBe(200)
  const seed = hpkeOpenMock(
    res.data.envelope,
    bytesToHex(user.device.encryptionSeed),
    LABEL_PUK_WRAP_TO_DEVICE,
    pukWrapAad(user.device.deviceId),
  )
  const derived = derivePukSubkeysMock(seed, res.data.generation)

  const links = await getSigchainViaApi(request, user.pubkey, user.deviceKey)
  const epochLink = links.find(l => l.linkType === 'puk_epoch')
  expect(epochLink).toBeDefined()
  const epoch = sigchainPukEpochPayloadSchema.parse(epochLink!.payload)
  expect({ generation: derived.generation, signPubkey: derived.signPubkeyHex, dhPubkey: derived.dhPubkeyHex })
    .toEqual({ generation: epoch.generation, signPubkey: epoch.signPubkey, dhPubkey: epoch.dhPubkey })
})

// ── Then ────────────────────────────────────────────────────────────

Then('the sigchain has {int} link(s)', async ({ request, world }, count: number) => {
  const user = requireUser(getS(world))
  const links = await getSigchainViaApi(request, user.pubkey, user.deviceKey)
  expect(links).toHaveLength(count)
})

Then('the first link has linkType {string}', async ({ request, world }, linkType: string) => {
  const user = requireUser(getS(world))
  const links = await getSigchainViaApi(request, user.pubkey, user.deviceKey)
  expect(links[0].linkType).toBe(linkType)
})
