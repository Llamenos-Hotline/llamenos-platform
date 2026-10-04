/**
 * Race condition prevention step definitions (Epic G).
 * Tests concurrent access patterns to verify atomic database operations.
 */
import { expect } from '@playwright/test'
import { Given, When, Then, Before, getState, setState } from './fixtures'
import {
  apiGet,
  apiPost,
  createUserViaApi,
  generateTestKeypair,
  redeemInviteViaApi,
  ADMIN_SEED,
} from '../../api-helpers'
import { bytesToHex } from '@shared/encoding'

// ── State ────────────────────────────────────────────────────────────

interface RaceTestState {
  inviteCode?: string
  redeemResults?: Array<{ status: number; data: unknown }>
  mlsDeviceId?: string
  mlsHubId?: string
  mlsMessageCount?: number
  mlsFetchResults?: Array<{ status: number; data: { messages: Array<{ id: string }> } }>
  provisionRoomId?: string
  provisionToken?: string
  provisionPollResults?: Array<{ status: number; data: unknown }>
  blastId?: string
  blastSendResults?: Array<{ status: number; data: unknown }>
  userPubkey?: string
  userSeedHex?: string
  deviceRegResults?: Array<{ status: number }>
  challengeId?: string
  challengeConsumeResults?: Array<{ status: number; data: unknown }>
  hubId?: string
  existingSubscriberIds?: string[]
  importResults?: Array<{ status: number; data: unknown }>
}

const STATE_KEY = 'race_test'
const BASE_URL = process.env.TEST_HUB_URL || 'http://localhost:3000'

function getS(world: Record<string, unknown>): RaceTestState {
  return getState<RaceTestState>(world, STATE_KEY)
}

Before(async ({ world }) => {
  setState<RaceTestState>(world, STATE_KEY, {})
})

// ── Helpers ──────────────────────────────────────────────────────────

// ── RACE-01: Concurrent invite redemption ────────────────────────────

Given('an admin creates an invite code for race testing', async ({ request, world, workerHub }) => {
  const s = getS(world)
  const res = await apiPost<{ invite: { code: string } }>(request, '/invites', {
    hubId: workerHub,
    name: `Race Test ${Date.now()}`,
    phone: `+1555${Date.now().toString().slice(-7)}`,
    roleIds: ['role-volunteer'],
  }, ADMIN_SEED)
  expect(res.status).toBe(201)
  s.inviteCode = res.data.invite.code
})

When('two users simultaneously redeem the same invite code', async ({ request, world }) => {
  const s = getS(world)
  expect(s.inviteCode).toBeDefined()

  // Two users, so two distinct clients: redeemInviteViaApi gives each its own
  // simulated address. Sending both from one address would put them in the
  // same per-client rate-limit bucket, where the control under test is the
  // 5/min limiter rather than the single-use claim (#1480).
  const kp1 = generateTestKeypair()
  const kp2 = generateTestKeypair()

  s.redeemResults = await Promise.all([
    redeemInviteViaApi(request, s.inviteCode!, kp1.seedHex),
    redeemInviteViaApi(request, s.inviteCode!, kp2.seedHex),
  ])
})

Then('exactly one redemption succeeds', async ({ world }) => {
  const s = getS(world)
  expect(s.redeemResults).toBeDefined()
  // The statuses are in the message because the bare length told us nothing:
  // "expected 1, received 0" looked like a broken single-use claim when both
  // redemptions had in fact been rate limited (#1480).
  const statuses = s.redeemResults!.map(r => r.status)
  const successes = s.redeemResults!.filter(r => r.status === 200)
  expect(successes, `redemption statuses: ${statuses.join(', ')}`).toHaveLength(1)
})

Then('one redemption returns an error', async ({ world }) => {
  const s = getS(world)
  expect(s.redeemResults).toBeDefined()
  const failures = s.redeemResults!.filter(r => r.status !== 200)
  expect(failures).toHaveLength(1)
  // A clean client error, not a 500 from an unhandled unique-key violation.
  expect(failures[0].status).toBeGreaterThanOrEqual(400)
  expect(failures[0].status).toBeLessThan(500)
})

// ── RACE-02: Concurrent MLS message fetch ────────────────────────────

Given('MLS messages are queued for a test device', async ({ request, world, workerHub }) => {
  const s = getS(world)
  s.mlsHubId = workerHub

  // Register a real device for the admin user so it passes getHubMemberDeviceIds() validation
  const wakeKey = bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
  const pushToken = bytesToHex(crypto.getRandomValues(new Uint8Array(16)))
  const regRes = await apiPost(request, '/devices/register', {
    platform: 'ios', pushToken, wakeKeyPublic: wakeKey,
  }, ADMIN_SEED)
  expect(regRes.status).toBe(204)
  const listRes = await apiGet<{ devices: Array<{ id: string }> }>(request, '/devices', ADMIN_SEED)
  expect(listRes.status).toBe(200)
  const latestDevice = listRes.data.devices[listRes.data.devices.length - 1]
  expect(latestDevice).toBeDefined()
  s.mlsDeviceId = latestDevice.id

  // Enqueue several MLS messages for this device via the commit endpoint
  const messageCount = 5
  for (let i = 0; i < messageCount; i++) {
    const res = await apiPost(request, `/hubs/${workerHub}/mls/commit`, {
      recipientDeviceIds: [s.mlsDeviceId],
      payload: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
    }, ADMIN_SEED)
    expect(res.status).toBe(204)
  }
  s.mlsMessageCount = messageCount
})

When('two requests simultaneously fetch MLS messages for that device', async ({ request, world }) => {
  const s = getS(world)
  expect(s.mlsHubId).toBeDefined()
  expect(s.mlsDeviceId).toBeDefined()

  const fetchMessages = () =>
    apiGet<{ messages: Array<{ id: string }> }>(
      request,
      `/hubs/${s.mlsHubId}/mls/messages?deviceId=${s.mlsDeviceId}`,
      ADMIN_SEED,
    )

  s.mlsFetchResults = await Promise.all([fetchMessages(), fetchMessages()])
})

Then('the combined message count across both responses equals the original count', async ({ world }) => {
  const s = getS(world)
  expect(s.mlsFetchResults).toBeDefined()
  const totalMessages = s.mlsFetchResults!.reduce(
    (sum, r) => sum + (r.data?.messages?.length ?? 0),
    0,
  )
  expect(totalMessages).toBe(s.mlsMessageCount)
})

Then('no messages are duplicated between responses', async ({ world }) => {
  const s = getS(world)
  expect(s.mlsFetchResults).toBeDefined()
  const allIds = s.mlsFetchResults!.flatMap(r => (r.data?.messages ?? []).map(m => m.id))
  const uniqueIds = new Set(allIds)
  expect(uniqueIds.size).toBe(allIds.length)
})

// ── RACE-03: Concurrent provision room consumption ───────────────────

Given('a provision room has an encrypted payload', async ({ request, world }) => {
  const s = getS(world)

  // Create a provision room (public endpoint — mounted at /api/provision)
  const ephemeralPubkey = bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
  const createRes = await request.post(`${BASE_URL}/api/provision/rooms`, {
    headers: { 'Content-Type': 'application/json' },
    data: { ephemeralPubkey },
  })
  expect(createRes.status()).toBe(200)
  const createData = await createRes.json() as { roomId: string; token: string }
  s.provisionRoomId = createData.roomId
  s.provisionToken = createData.token

  // Send payload (authenticated endpoint).
  // Schema requires: token, encryptedNsec, primaryPubkey.
  // primaryPubkey is the primary device's X25519 public key (32 bytes hex).
  const primaryPubkey = bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
  const payloadRes = await apiPost(request, `/provision/rooms/${createData.roomId}/payload`, {
    token: createData.token,
    encryptedNsec: bytesToHex(crypto.getRandomValues(new Uint8Array(64))),
    primaryPubkey,
  }, ADMIN_SEED)
  expect(payloadRes.status).toBe(200)
})

When('two requests simultaneously poll the provision room', async ({ request, world }) => {
  const s = getS(world)
  expect(s.provisionRoomId).toBeDefined()
  expect(s.provisionToken).toBeDefined()

  const poll = () =>
    request.get(
      `${BASE_URL}/api/provision/rooms/${s.provisionRoomId}?token=${s.provisionToken}`,
      { headers: { 'Content-Type': 'application/json' } },
    ).then(async (res) => ({
      status: res.status(),
      data: await res.json().catch(() => null),
    }))

  s.provisionPollResults = await Promise.all([poll(), poll()])
})

Then('exactly one response contains the encrypted payload', async ({ world }) => {
  const s = getS(world)
  expect(s.provisionPollResults).toBeDefined()
  // The atomic DELETE...RETURNING means only one concurrent poll can consume the payload.
  // That poll returns { status: 'ready', encryptedNsec: '...' }.
  // The other poll finds the row gone and gets a 404 from the service.
  const withPayload = s.provisionPollResults!.filter(
    r => r.status === 200 && (r.data as Record<string, unknown>)?.encryptedNsec,
  )
  expect(withPayload).toHaveLength(1)
})

// ── RACE-04: Concurrent blast send ───────────────────────────────────

Given('a draft blast exists with subscribers', async ({ request, world, workerHub }) => {
  const s = getS(world)
  s.hubId = workerHub

  // Import a subscriber first
  const importRes = await apiPost(request, `/hubs/${workerHub}/blasts/subscribers/import`, {
    subscribers: [{
      identifier: `+1555${Date.now().toString().slice(-7)}`,
      channel: 'sms',
      tags: ['race-test'],
    }],
  }, ADMIN_SEED)
  expect(importRes.status).toBe(200)

  // Create a draft blast
  const createRes = await apiPost<{ blast: { id: string } }>(request, `/hubs/${workerHub}/blasts`, {
    name: `Race Blast ${Date.now()}`,
    content: { body: 'Race condition test message' },
    channels: ['sms'],
    tags: ['race-test'],
  }, ADMIN_SEED)
  expect(createRes.status).toBe(201)
  s.blastId = createRes.data.blast.id
})

When('two requests simultaneously send the blast', async ({ request, world }) => {
  const s = getS(world)
  expect(s.blastId).toBeDefined()
  expect(s.hubId).toBeDefined()

  const sendBlast = () =>
    apiPost(request, `/hubs/${s.hubId}/blasts/${s.blastId}/send`, {}, ADMIN_SEED)

  s.blastSendResults = await Promise.all([sendBlast(), sendBlast()])
})

Then('exactly one send succeeds', async ({ world }) => {
  const s = getS(world)
  expect(s.blastSendResults).toBeDefined()
  const successes = s.blastSendResults!.filter(r => r.status === 200)
  expect(successes).toHaveLength(1)
})

Then('the other returns an error', async ({ world }) => {
  const s = getS(world)
  expect(s.blastSendResults).toBeDefined()
  const failures = s.blastSendResults!.filter(r => r.status !== 200)
  expect(failures).toHaveLength(1)
  expect(failures[0].status).toBeGreaterThanOrEqual(400)
})

// ── RACE-05: Concurrent device registrations ─────────────────────────

Given('a user has {int} registered devices', async ({ request, world }, count: number) => {
  const s = getS(world)
  const user = await createUserViaApi(request, { name: `Race Device User ${Date.now()}` })
  s.userPubkey = user.pubkey
  s.userSeedHex = user.seedHex

  // Register devices up to count
  for (let i = 0; i < count; i++) {
    const kp = generateTestKeypair()
    const wakeKeyPublic = kp.pubkey
    const res = await apiPost(request, '/devices/register', {
      platform: 'ios',
      pushToken: `push-token-race-${i}-${Date.now()}`,
      wakeKeyPublic,
      ed25519Pubkey: kp.pubkey,
      x25519Pubkey: kp.pubkey, // simplified for test
      deviceName: `Test Device ${i}`,
    }, user.seedHex)
    expect(res.status).toBe(204)
  }
})

When('two new devices register simultaneously for the user', async ({ request, world }) => {
  const s = getS(world)
  expect(s.userSeedHex).toBeDefined()

  const registerDevice = (idx: number) => {
    const kp = generateTestKeypair()
    const wakeKeyPublic = kp.pubkey
    return apiPost(request, '/devices/register', {
      platform: 'ios',
      pushToken: `push-token-race-new-${idx}-${Date.now()}`,
      wakeKeyPublic,
      ed25519Pubkey: kp.pubkey,
      x25519Pubkey: kp.pubkey,
      deviceName: `Race Device New ${idx}`,
    }, s.userSeedHex!)
  }

  s.deviceRegResults = await Promise.all([registerDevice(0), registerDevice(1)])
})

Then('the user has at most {int} devices', async ({ request, world }, maxDevices: number) => {
  const s = getS(world)
  expect(s.userSeedHex).toBeDefined()

  const res = await apiGet<{ devices: Array<{ id: string }> }>(
    request, '/devices', s.userSeedHex!,
  )
  expect(res.status).toBe(200)
  expect(res.data.devices.length).toBeLessThanOrEqual(maxDevices)
})

// ── RACE-08: WebAuthn challenge double-consumption ───────────────────

Given('a WebAuthn challenge is stored', async ({ request, world }) => {
  const s = getS(world)

  // Generate a registration challenge (requires auth)
  const res = await apiPost<{ challengeId: string }>(request, '/webauthn/register/options', {
    label: 'Race Test Passkey',
  }, ADMIN_SEED)
  expect(res.status).toBe(200)
  s.challengeId = res.data.challengeId
})

When('two requests simultaneously consume the challenge', async ({ request, world }) => {
  const s = getS(world)
  expect(s.challengeId).toBeDefined()

  // Attempt to verify registration with the same challenge concurrently.
  // Both will fail verification (invalid attestation), but only one should find the challenge.
  const consume = () =>
    apiPost(request, '/webauthn/register/verify', {
      challengeId: s.challengeId,
      label: 'Race Test Passkey',
      attestation: {
        id: 'fake-cred-id',
        rawId: 'fake-raw-id',
        type: 'public-key',
        response: {
          clientDataJSON: btoa('{}'),
          attestationObject: btoa('{}'),
        },
      },
    }, ADMIN_SEED)

  s.challengeConsumeResults = await Promise.all([consume(), consume()])
})

Then('exactly one consumption succeeds', async ({ world }) => {
  const s = getS(world)
  expect(s.challengeConsumeResults).toBeDefined()
  // "Succeeds" in consuming the challenge means it got past the challenge lookup.
  // The verification itself may fail (400 "Verification failed") but it found the challenge.
  // The other should get 400 "Invalid or expired challenge" because the challenge was already deleted.
  const foundChallenge = s.challengeConsumeResults!.filter(r => {
    const data = r.data as { error?: string } | null
    // If we got a verification error (not a challenge-not-found error), the challenge was consumed
    return r.status === 400 && data?.error === 'Verification failed'
  })
  expect(foundChallenge).toHaveLength(1)
})

Then('the other returns not found', async ({ world }) => {
  const s = getS(world)
  expect(s.challengeConsumeResults).toBeDefined()
  const notFound = s.challengeConsumeResults!.filter(r => {
    const data = r.data as { error?: string } | null
    return r.status === 400 && data?.error === 'Invalid or expired challenge'
  })
  expect(notFound).toHaveLength(1)
})

// ── RACE-09: Concurrent bulk imports ─────────────────────────────────

Given('a hub with existing subscribers', async ({ request, world, workerHub }) => {
  const s = getS(world)
  s.hubId = workerHub

  // Import some initial subscribers
  const initialSubs = [
    { identifier: `+1555${Date.now().toString().slice(-7)}0`, channel: 'sms' as const, tags: ['existing'] },
    { identifier: `+1555${Date.now().toString().slice(-7)}1`, channel: 'sms' as const, tags: ['existing'] },
  ]
  s.existingSubscriberIds = initialSubs.map(sub => sub.identifier)

  const res = await apiPost(request, `/hubs/${workerHub}/blasts/subscribers/import`, {
    subscribers: initialSubs,
  }, ADMIN_SEED)
  expect(res.status).toBe(200)
})

When('two bulk imports with overlapping identifiers run simultaneously', async ({ request, world }) => {
  const s = getS(world)
  expect(s.hubId).toBeDefined()
  expect(s.existingSubscriberIds).toBeDefined()

  const overlappingId = s.existingSubscriberIds![0]
  const newId1 = `+1555${Date.now().toString().slice(-7)}2`
  const newId2 = `+1555${Date.now().toString().slice(-7)}3`

  const import1 = () => apiPost(request, `/hubs/${s.hubId}/blasts/subscribers/import`, {
    subscribers: [
      { identifier: overlappingId, channel: 'sms', tags: ['import1'] },
      { identifier: newId1, channel: 'sms', tags: ['import1'] },
    ],
  }, ADMIN_SEED)

  const import2 = () => apiPost(request, `/hubs/${s.hubId}/blasts/subscribers/import`, {
    subscribers: [
      { identifier: overlappingId, channel: 'sms', tags: ['import2'] },
      { identifier: newId2, channel: 'sms', tags: ['import2'] },
    ],
  }, ADMIN_SEED)

  s.importResults = await Promise.all([import1(), import2()])
})

Then('no duplicate subscribers are created', async ({ request, world }) => {
  const s = getS(world)
  expect(s.importResults).toBeDefined()
  expect(s.hubId).toBeDefined()

  // At least one import should succeed; the other may fail with 500 (constraint violation)
  // due to concurrent overlapping identifiers — this is expected behavior.
  const successes = s.importResults!.filter(r => r.status === 200 || r.status === 201)
  const statuses = s.importResults!.map(r => r.status)
  expect(successes.length, `Expected at least 1 success, got statuses: ${JSON.stringify(statuses)}`).toBeGreaterThanOrEqual(1)

  // Verify no duplicates by listing subscribers
  const listRes = await apiGet<{ subscribers: Array<{ identifierHash: string }> }>(
    request,
    `/hubs/${s.hubId}/blasts/subscribers`,
    ADMIN_SEED,
  )
  expect(listRes.status).toBe(200)

  const identifiers = listRes.data.subscribers.map(sub => sub.identifierHash)
  const uniqueIdentifiers = new Set(identifiers)
  expect(uniqueIdentifiers.size).toBe(identifiers.length)
})
