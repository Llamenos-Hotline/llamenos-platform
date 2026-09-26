/**
 * Recovery Group step definitions (EP09-P2).
 *
 * Tests recovery group enrollment, session lifecycle, share contributions,
 * user envelopes, liveness proofs, and permission enforcement.
 */
import { SIGCHAIN_GENESIS_SEQ } from '@protocol/schemas/sigchain'
import { expect } from '@playwright/test'
import { Given, When, Then, Before, After, getState, setState } from './fixtures'
import { setLastResponse } from './shared-state'
import {
  encryptContent,
  generateContentKey,
  wrapKeyForRecipient,
  unwrapKey,
  x25519PubkeyFromSeed,
} from '../../crypto-helpers'
import {
  apiGet,
  apiPost,
  devPost,
  createUserViaApi,
  createRoleViaApi,
  createHubViaApi,
  deleteHubViaApi,
  addHubMemberViaApi,
  generateTestKeypair,
  ADMIN_SEED,
  seedHexToPubkey,
} from '../../api-helpers'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@shared/encoding'
import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { LABEL_RECOVERY_PUK_SEED_WRAP, LABEL_RECOVERY_SHARE_CONTRIBUTE } from '@shared/crypto-labels'

// Admin pubkey derived from ADMIN_SEED — used to enroll admin as a share holder
// so liveness proof tests can authenticate correctly.
const ADMIN_PUBKEY = seedHexToPubkey(ADMIN_SEED)

// ── State ──────────────────────────────────────────────────────────

interface RecoveryGroupState {
  hubId?: string
  adminSeed: string
  limitedUserSeed?: string
  limitedUserPubkey?: string
  holderSeeds: string[]
  holderPubkeys: string[]
  enrolledShareHolderPubkeys?: string[]
  sessionId?: string
  lastStatus?: number
  lastBody?: Record<string, unknown>

  // -- Cross-hub scoping (issue #847) --
  secondHubId?: string
  secondHubSessionId?: string
  crossHubViewerSeed?: string
  crossHubViewerPubkey?: string

  // -- Rotation / departed-member-exclusion (real HPKE round-trip) --
  rotation?: {
    recoveringUserPubkey: string
    recoveringUserSeed: string
    groupV1: { pubkeyHex: string; skHex: string }
    groupV2: { pubkeyHex: string; skHex: string }
    pukSeedHex: string
    departedHolderPubkey: string
    survivingHolderPubkeys: string[]
    replacementHolderPubkey: string
  }

  // -- Full ceremony: contribute -> complete -> sigchain -> decrypt --
  ceremony?: {
    recoveringUserPubkey: string
    contributingHolders: Array<{ seedHex: string; pubkey: string }>
    threshold: number
    group: { pubkeyHex: string; skHex: string }
    pukSeedHex: string
    newDeviceSeedHex: string
    newDeviceEdPubkey: string
    newDeviceX25519Pubkey: string
    sessionId: string
    reconstructedGroupSkHex?: string
    decryptedPukSeedHex?: string
    sigchainLink?: Record<string, unknown>
  }
}

const STATE_KEY = 'recovery_group'

function getS(world: Record<string, unknown>): RecoveryGroupState {
  return getState<RecoveryGroupState>(world, STATE_KEY)
}

const BASE_URL = process.env.TEST_HUB_URL ?? 'http://localhost:3000'

Before({ tags: '@backend' }, async ({ world }) => {
  setState<RecoveryGroupState>(world, STATE_KEY, {
    adminSeed: ADMIN_SEED,
    holderSeeds: [],
    holderPubkeys: [],
  })
})

// Cross-hub scoping scenarios (issue #847) provision a second hub on demand —
// clean it up here rather than in `workerHub`'s teardown, which only owns the
// single per-scenario hub. A no-op for every scenario that never sets it.
After({ tags: '@backend' }, async ({ request, world }) => {
  const s = getS(world)
  if (s.secondHubId) {
    await deleteHubViaApi(request, s.secondHubId).catch(() => {})
  }
})

// ── Helpers ────────────────────────────────────────────────────────

function makeShareEnvelopes(count: number, pubkeys: string[] = []): Array<{ holderPubkey: string; shareEnvelope: string }> {
  return Array.from({ length: count }, (_, i) => ({
    holderPubkey: pubkeys[i] ?? `deadbeef${String(i).padStart(56, '0')}`,
    shareEnvelope: encryptContent(`hpke-share-envelope-${i}`, generateContentKey(), 'llamenos:recovery'),
  }))
}

function makeCommitments(count: number): string[] {
  return Array.from({ length: count }, (_, i) =>
    `${'a'.repeat(63)}${i}`,
  )
}

async function enrollRecoveryGroup(
  request: import('@playwright/test').APIRequestContext,
  hubId: string,
  seedHex: string,
  opts: {
    threshold?: number
    totalShares?: number
    shareHolderPubkeys?: string[]
    delayHours?: number
    groupPublicKey?: string
  } = {},
): Promise<{ status: number; data: Record<string, unknown> }> {
  const threshold = opts.threshold ?? 2
  const totalShares = opts.totalShares ?? 3
  const envelopes = makeShareEnvelopes(totalShares, opts.shareHolderPubkeys)
  const commitments = makeCommitments(totalShares)

  return apiPost(request, '/recovery-group/enroll', {
    hubId,
    threshold,
    totalShares,
    groupPublicKey: opts.groupPublicKey ?? 'a'.repeat(64),
    shareEnvelopes: envelopes,
    shareCommitments: commitments,
    sigchainLinkHash: 'b'.repeat(64),
    delayHours: opts.delayHours ?? 24,
    emergencyFloorHours: 4,
  }, seedHex)
}

// -- Real-crypto helpers (rotation + ceremony scenarios) -------------
// `encryptedShare`/`envelope` columns are opaque strings to the server —
// pack the HPKE {enc, ct} pair produced by wrapKeyForRecipient into one
// string so it round-trips through the wire schema, and unpack it again
// client-side before calling unwrapKey.

/**
 * Generate a real X25519 keypair for HPKE recovery-group operations.
 *
 * Deliberately does NOT use crypto-helpers.ts's `generateHpkeKeypair()` —
 * that helper calls `hpkeSuite.generateKeyPair()` then `crypto.subtle.exportKey`,
 * which throws under Bun's WebCrypto ("2nd argument is not of type CryptoKey";
 * reproduces standalone via `bun tests/crypto-helpers.ts`, its own self-test —
 * a pre-existing bug unrelated to this PR, out of scope since crypto-helpers.ts
 * is outside apps/worker's ownership). `wrapKeyForRecipient`/`unwrapKey` are
 * unaffected — they go through `hpkeSuite.importKey('raw', ...)`, a different
 * code path — so deriving the raw 32-byte X25519 secret ourselves (the same
 * way `x25519PubkeyFromSeed` already does for device keys) and feeding it
 * through the existing wrap/unwrap helpers gives a fully real HPKE round trip.
 */
function generateX25519Keypair(): { skHex: string; pubkeyHex: string } {
  const skBytes = crypto.getRandomValues(new Uint8Array(32))
  const pkBytes = x25519.getPublicKey(skBytes)
  return { skHex: bytesToHex(skBytes), pubkeyHex: bytesToHex(pkBytes) }
}

function packWrap(w: { enc: string; ct: string }): string {
  return `${w.enc}.${w.ct}`
}

function unpackWrap(s: string): { enc: string; ct: string } {
  const [enc, ct] = s.split('.')
  return { enc, ct }
}

/**
 * Recompute the canonical sigchain entry hash — matches
 * apps/worker/services/crypto-keys.ts:computeEntryHash exactly (duplicated
 * client-side here the same way tests/steps/backend/sigchain.steps.ts does).
 */
function canonicalizeJson(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map(canonicalizeJson)
  if (typeof value === 'object') {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalizeJson((value as Record<string, unknown>)[key])
    }
    return sorted
  }
  return value
}

function computeSigchainLinkHash(
  seqNo: number,
  prevHash: string,
  payload: unknown,
  signerDeviceId: string,
  signerPubkey: string,
  timestamp: string,
): string {
  const canonical = canonicalizeJson({
    payload,
    prevHash: prevHash === '' ? null : prevHash,
    seq: seqNo,
    signerDeviceId,
    signerPubkey,
    timestamp,
  })
  return bytesToHex(sha256(utf8ToBytes(JSON.stringify(canonical))))
}

// ── Background ─────────────────────────────────────────────────────

Given('a registered admin user with {string} permission', async ({ world }, _permission: string) => {
  getS(world).adminSeed = ADMIN_SEED
})

Given('a hub is available for recovery group tests', async ({ workerHub, world }) => {
  getS(world).hubId = workerHub
})

// ── Enrollment steps ───────────────────────────────────────────────

When('the admin enrolls a 2-of-3 recovery group for the hub', async ({ request, world }) => {
  const s = getS(world)
  expect(s.hubId).toBeDefined()
  const { status, data } = await enrollRecoveryGroup(request, s.hubId!, s.adminSeed)
  s.lastStatus = status
  s.lastBody = data as Record<string, unknown>
  setLastResponse(world, { status, data })
})

When('the admin enrolls a recovery group with threshold {int} and totalShares {int}', async ({ request, world }, threshold: number, totalShares: number) => {
  const s = getS(world)
  expect(s.hubId).toBeDefined()

  // For invalid combinations (threshold > totalShares), pass as-is to test server validation
  const envelopes = makeShareEnvelopes(totalShares)
  const commitments = makeCommitments(totalShares)

  const { status, data } = await apiPost(request, '/recovery-group/enroll', {
    hubId: s.hubId!,
    threshold,
    totalShares,
    groupPublicKey: 'a'.repeat(64),
    shareEnvelopes: envelopes,
    shareCommitments: commitments,
    sigchainLinkHash: 'b'.repeat(64),
    delayHours: 24,
    emergencyFloorHours: 4,
  }, s.adminSeed)
  s.lastStatus = status
  s.lastBody = data as Record<string, unknown>
  setLastResponse(world, { status, data })
})

When('the admin enrolls a recovery group with mismatched envelope count', async ({ request, world }) => {
  const s = getS(world)
  expect(s.hubId).toBeDefined()

  const { status, data } = await apiPost(request, '/recovery-group/enroll', {
    hubId: s.hubId!,
    threshold: 2,
    totalShares: 3,
    groupPublicKey: 'a'.repeat(64),
    shareEnvelopes: makeShareEnvelopes(2), // mismatch: 2 instead of 3
    shareCommitments: makeCommitments(3),
    sigchainLinkHash: 'b'.repeat(64),
    delayHours: 24,
    emergencyFloorHours: 4,
  }, s.adminSeed)

  s.lastStatus = status
  s.lastBody = data as Record<string, unknown>
  setLastResponse(world, { status, data })
})

When('the admin fetches the recovery group for the hub', async ({ request, world }) => {
  const s = getS(world)
  expect(s.hubId).toBeDefined()
  const { status, data } = await apiGet<Record<string, unknown>>(request, `/recovery-group/${s.hubId!}`, s.adminSeed)
  s.lastStatus = status
  s.lastBody = data
  setLastResponse(world, { status, data })
})

When('the admin enrolls a new 2-of-3 recovery group with different share holders', async ({ request, world }) => {
  const s = getS(world)
  expect(s.hubId).toBeDefined()

  const newHolderPubkeys = [
    'c'.repeat(64),
    'd'.repeat(64),
    'e'.repeat(64),
  ]
  s.enrolledShareHolderPubkeys = newHolderPubkeys

  const { status, data } = await enrollRecoveryGroup(request, s.hubId!, s.adminSeed, {
    threshold: 2,
    totalShares: 3,
    shareHolderPubkeys: newHolderPubkeys,
  })
  s.lastStatus = status
  s.lastBody = data as Record<string, unknown>
  setLastResponse(world, { status, data })
})

Given('a recovery group is enrolled for the hub', async ({ request, world }) => {
  const s = getS(world)
  expect(s.hubId).toBeDefined()

  // Include admin pubkey as first holder so liveness proof tests can authenticate
  // as admin (who has '*' permission and is a registered holder in the DB).
  const holderPubkeys = [
    ADMIN_PUBKEY,
    '0'.repeat(63) + '1',
    '0'.repeat(63) + '2',
  ]
  s.holderPubkeys = holderPubkeys
  s.holderSeeds = [s.adminSeed]

  const { status } = await enrollRecoveryGroup(request, s.hubId!, s.adminSeed, {
    shareHolderPubkeys: holderPubkeys,
  })
  expect(status).toBe(200)
})

// ── Permission steps ───────────────────────────────────────────────

Given('a user without {string} permission', async ({ request, world }, _permission: string) => {
  const s = getS(world)

  const roleSlug = `no-recovery-${Date.now()}`
  await createRoleViaApi(request, {
    name: `No Recovery ${Date.now()}`,
    slug: roleSlug,
    permissions: ['calls:view'],
  })

  const user = await createUserViaApi(request, {
    name: `No Perm User ${Date.now()}`,
    roleIds: [`role-${roleSlug}`],
  })

  s.limitedUserSeed = user.seedHex
  s.limitedUserPubkey = user.pubkey
})

When('that user attempts to enroll a recovery group', async ({ request, world }) => {
  const s = getS(world)
  expect(s.hubId).toBeDefined()
  expect(s.limitedUserSeed).toBeDefined()

  const { status, data } = await enrollRecoveryGroup(request, s.hubId!, s.limitedUserSeed!)
  s.lastStatus = status
  s.lastBody = data as Record<string, unknown>
  setLastResponse(world, { status, data })
})

When('that user fetches the recovery group for the hub', async ({ request, world }) => {
  const s = getS(world)
  expect(s.hubId).toBeDefined()
  expect(s.limitedUserSeed).toBeDefined()

  const { status, data } = await apiGet<Record<string, unknown>>(request, `/recovery-group/${s.hubId!}`, s.limitedUserSeed!)
  s.lastStatus = status
  s.lastBody = data
  setLastResponse(world, { status, data })
})

// ── Anti-enumeration steps ─────────────────────────────────────────

When('an unauthenticated client initiates recovery for a nonexistent user in the hub', async ({ request, world }) => {
  const s = getS(world)
  expect(s.hubId).toBeDefined()

  const res = await request.post(`${BASE_URL}/api/recovery-group/initiate`, {
    data: {
      hubId: s.hubId!,
      userIdentifier: `nonexistent-user-${Date.now()}@nowhere.invalid`,
      newDevicePubkey: 'a'.repeat(64),
    },
    headers: { 'Content-Type': 'application/json' },
  })

  const body = await res.json().catch(() => ({})) as Record<string, unknown>
  s.lastStatus = res.status()
  s.lastBody = body
  if (res.status() === 200 && typeof body.sessionId === 'string') {
    s.sessionId = body.sessionId
  }
  setLastResponse(world, { status: res.status(), data: body })
})

When('an authenticated user contributes a share to session {string}', async ({ request, world }, sessionId: string) => {
  const s = getS(world)
  const { status, data } = await apiPost(request, `/recovery-group/session/${sessionId}/contribute`, {
    encryptedShare: encryptContent('fake-share', generateContentKey(), 'llamenos:recovery'),
    contributorSignature: 'a'.repeat(128),
  }, s.adminSeed)
  s.lastStatus = status
  s.lastBody = data as Record<string, unknown>
  setLastResponse(world, { status, data })
})

// ── User envelope steps ────────────────────────────────────────────

When('an authenticated user stores a recovery envelope for the hub', async ({ request, world }) => {
  const s = getS(world)
  expect(s.hubId).toBeDefined()

  const { status, data } = await apiPost(request, '/recovery-group/user-envelope', {
    hubId: s.hubId!,
    envelope: encryptContent(`puk-seed-envelope-${Date.now()}`, generateContentKey(), 'llamenos:recovery'),
  }, s.adminSeed)
  s.lastStatus = status
  s.lastBody = data as Record<string, unknown>
  setLastResponse(world, { status, data })
})

When('the user stores a different envelope for the same hub', async ({ request, world }) => {
  const s = getS(world)
  expect(s.hubId).toBeDefined()

  const { status, data } = await apiPost(request, '/recovery-group/user-envelope', {
    hubId: s.hubId!,
    envelope: encryptContent(`puk-seed-envelope-v2-${Date.now()}`, generateContentKey(), 'llamenos:recovery'),
  }, s.adminSeed)
  s.lastStatus = status
  s.lastBody = data as Record<string, unknown>
  setLastResponse(world, { status, data })
})

// ── Liveness proof steps ───────────────────────────────────────────

When('a share holder submits a liveness proof for the hub', async ({ request, world }) => {
  const s = getS(world)
  expect(s.hubId).toBeDefined()

  // Use the first enrolled holder's seed (admin, who is also a registered holder)
  const holderSeed = s.holderSeeds[0] ?? s.adminSeed
  const { status, data } = await apiPost(request, '/recovery-group/shares/liveness', {
    hubId: s.hubId!,
    proof: 'a'.repeat(128),
  }, holderSeed)

  s.lastStatus = status
  s.lastBody = data as Record<string, unknown>
  setLastResponse(world, { status, data })
})

When('a non-holder submits a liveness proof for the hub', async ({ request, world }) => {
  const s = getS(world)
  expect(s.hubId).toBeDefined()

  const nonHolder = await createUserViaApi(request, { name: `Non Holder ${Date.now()}` })

  const { status, data } = await apiPost(request, '/recovery-group/shares/liveness', {
    hubId: s.hubId!,
    proof: 'a'.repeat(128),
  }, nonHolder.seedHex)

  s.lastStatus = status
  s.lastBody = data as Record<string, unknown>
  setLastResponse(world, { status, data })
})

// ── Recovery-group-specific assertion steps ────────────────────────
// Note: 'the response status is {int}' lives in assertions.steps.ts (reads shared state)

Then('the response body has {string} equal to true', async ({ world }, key: string) => {
  const s = getS(world)
  expect(s.lastBody?.[key]).toBe(true)
})

Then('the response body has {string} equal to {string}', async ({ world }, key: string, value: string) => {
  const s = getS(world)
  expect(s.lastBody?.[key]).toBe(value)
})

Then('the response body has error containing {string}', async ({ world }, substring: string) => {
  const s = getS(world)
  const error = s.lastBody?.['error']
  expect(typeof error).toBe('string')
  expect(error as string).toContain(substring)
})

Then('the recovery group has threshold {int} and totalShares {int}', async ({ world }, threshold: number, totalShares: number) => {
  const s = getS(world)
  expect(s.lastBody?.['threshold']).toBe(threshold)
  expect(s.lastBody?.['totalShares']).toBe(totalShares)
})

Then('the recovery group has {int} share holders', async ({ world }, count: number) => {
  const s = getS(world)
  const holders = s.lastBody?.['shareHolderLiveness']
  expect(Array.isArray(holders)).toBe(true)
  expect((holders as unknown[]).length).toBe(count)
})

Then('the recovery group has the new share holders', async ({ world }) => {
  const s = getS(world)
  const holders = s.lastBody?.['shareHolderLiveness'] as Array<{ holderPubkey: string }> | undefined
  expect(Array.isArray(holders)).toBe(true)
  expect(holders!.length).toBe(3)
  if (s.enrolledShareHolderPubkeys) {
    const holderPubkeys = holders!.map(h => h.holderPubkey)
    for (const expected of s.enrolledShareHolderPubkeys) {
      expect(holderPubkeys).toContain(expected)
    }
  }
})

Then('the response body has a {string} UUID field', async ({ world }, key: string) => {
  const s = getS(world)
  const value = s.lastBody?.[key]
  expect(typeof value).toBe('string')
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  expect(uuidRegex.test(value as string)).toBe(true)
})

// ══════════════════════════════════════════════════════════════════
// Errata #1 — GET /recovery-group/sessions (issue #729)
// ══════════════════════════════════════════════════════════════════

Given('a recovery session exists for the hub', async ({ request, world }) => {
  const s = getS(world)
  expect(s.hubId).toBeDefined()

  const recoveringUser = await createUserViaApi(request, { name: `Recovering User ${Date.now()}` })
  const { pubkey: newDevicePubkey } = generateTestKeypair()

  const { status, data } = await devPost<{ sessionId: string }>(request, '/test-recovery-seed-session', {
    hubId: s.hubId!,
    userPubkey: recoveringUser.pubkey,
    newDevicePubkey,
    status: 'pending',
  })
  expect(status).toBe(200)
  s.sessionId = data.sessionId
})

When('the admin lists recovery sessions for the hub', async ({ request, world }) => {
  const s = getS(world)
  expect(s.hubId).toBeDefined()
  const { status, data } = await apiGet<Array<Record<string, unknown>>>(request, `/recovery-group/sessions?hubId=${s.hubId!}`, s.adminSeed)
  s.lastStatus = status
  s.lastBody = { sessions: data } as unknown as Record<string, unknown>
  setLastResponse(world, { status, data })
})

When('that user lists recovery sessions for the hub', async ({ request, world }) => {
  const s = getS(world)
  expect(s.hubId).toBeDefined()
  expect(s.limitedUserSeed).toBeDefined()
  const { status, data } = await apiGet<Array<Record<string, unknown>>>(request, `/recovery-group/sessions?hubId=${s.hubId!}`, s.limitedUserSeed!)
  s.lastStatus = status
  s.lastBody = { sessions: data } as unknown as Record<string, unknown>
  setLastResponse(world, { status, data })
})

Then('the listed sessions include the seeded session', async ({ world }) => {
  const s = getS(world)
  const sessions = (s.lastBody?.sessions as Array<{ sessionId: string }>) ?? []
  expect(sessions.some(sess => sess.sessionId === s.sessionId)).toBe(true)
})

// ══════════════════════════════════════════════════════════════════
// Cross-hub scoping (issue #847) — GET /recovery-group/sessions omitted
// the hub-scoping check present on the adjacent GET /session/:id route,
// letting a hub-scoped recovery:view holder enumerate another hub's
// recovery sessions (including new-device pubkeys).
// ══════════════════════════════════════════════════════════════════

Given('a second hub with a seeded recovery session', async ({ request, world }) => {
  const s = getS(world)

  const secondHubId = await createHubViaApi(request, `recovery-second-hub-${Date.now()}`)
  s.secondHubId = secondHubId

  const recoveringUser = await createUserViaApi(request, { name: `Second Hub Recovering User ${Date.now()}` })
  const { pubkey: newDevicePubkey } = generateTestKeypair()

  const { status, data } = await devPost<{ sessionId: string }>(request, '/test-recovery-seed-session', {
    hubId: secondHubId,
    userPubkey: recoveringUser.pubkey,
    newDevicePubkey,
    status: 'pending',
  })
  expect(status).toBe(200)
  s.secondHubSessionId = data.sessionId
})

Given('a user with global {string} permission who is only a member of the first hub', async ({ request, world }, permission: string) => {
  const s = getS(world)
  expect(s.hubId).toBeDefined()

  const roleSlug = `recovery-view-global-${Date.now()}`
  const role = await createRoleViaApi(request, {
    name: `Recovery Viewer ${Date.now()}`,
    slug: roleSlug,
    permissions: [permission],
  })

  // The role is granted globally (roleIds on the user, not a hub-scoped
  // assignment) — recovery-group routes are mounted outside `hubContext`,
  // so `requirePermission` only ever consults global roles here. Hub
  // membership below is a SEPARATE axis: it populates `user.hubRoles`,
  // which is what the route's hub-scoping check keys off of.
  const user = await createUserViaApi(request, {
    name: `Recovery Viewer User ${Date.now()}`,
    roleIds: [role.id],
  })
  s.crossHubViewerSeed = user.seedHex
  s.crossHubViewerPubkey = user.pubkey

  await addHubMemberViaApi(request, s.hubId!, user.pubkey, ['role-volunteer'])
})

Given('the cross-hub viewer is also added as a member of the second hub', async ({ request, world }) => {
  const s = getS(world)
  expect(s.secondHubId).toBeDefined()
  expect(s.crossHubViewerPubkey).toBeDefined()

  await addHubMemberViaApi(request, s.secondHubId!, s.crossHubViewerPubkey!, ['role-volunteer'])
})

When('the cross-hub viewer lists recovery sessions for the second hub', async ({ request, world }) => {
  const s = getS(world)
  expect(s.secondHubId).toBeDefined()
  expect(s.crossHubViewerSeed).toBeDefined()

  const { status, data } = await apiGet<Array<Record<string, unknown>>>(
    request, `/recovery-group/sessions?hubId=${s.secondHubId!}`, s.crossHubViewerSeed!,
  )
  s.lastStatus = status
  s.lastBody = { sessions: data } as unknown as Record<string, unknown>
  setLastResponse(world, { status, data })
})

When('the cross-hub viewer lists recovery sessions for the hub', async ({ request, world }) => {
  const s = getS(world)
  expect(s.hubId).toBeDefined()
  expect(s.crossHubViewerSeed).toBeDefined()

  const { status, data } = await apiGet<Array<Record<string, unknown>>>(
    request, `/recovery-group/sessions?hubId=${s.hubId!}`, s.crossHubViewerSeed!,
  )
  s.lastStatus = status
  s.lastBody = { sessions: data } as unknown as Record<string, unknown>
  setLastResponse(world, { status, data })
})

Then('the listed sessions include the seeded session for the second hub', async ({ world }) => {
  const s = getS(world)
  const sessions = (s.lastBody?.sessions as Array<{ sessionId: string }>) ?? []
  expect(sessions.some(sess => sess.sessionId === s.secondHubSessionId)).toBe(true)
})

// ══════════════════════════════════════════════════════════════════
// Cross-hub scoping, round 2 (issue #847 review round 2) — POST /rotate,
// POST /enroll, GET /:hubId, POST /session/:id/emergency, and
// POST /session/:id/cancel all omitted the hub-membership check present on
// the (already fixed) GET /sessions, letting a holder of the GLOBAL
// recovery:manage / recovery:view / recovery:approve permission, scoped to
// only one hub, act on another hub's recovery group entirely — for
// /rotate and /enroll, destructively.
// ══════════════════════════════════════════════════════════════════

Given('a second hub with a recovery group enrolled', async ({ request, world }) => {
  const s = getS(world)

  if (!s.secondHubId) {
    s.secondHubId = await createHubViaApi(request, `recovery-second-hub-${Date.now()}`)
  }

  const { status } = await enrollRecoveryGroup(request, s.secondHubId!, s.adminSeed)
  expect(status).toBe(200)
})

When('the cross-hub viewer rotates the second hub\'s recovery group', async ({ request, world }) => {
  const s = getS(world)
  expect(s.secondHubId).toBeDefined()
  expect(s.crossHubViewerSeed).toBeDefined()

  const newHolderPubkeys = [`${'1'.repeat(63)}1`, `${'1'.repeat(63)}2`, `${'1'.repeat(63)}3`]
  const { status, data } = await apiPost(request, '/recovery-group/rotate', {
    hubId: s.secondHubId!,
    threshold: 2,
    totalShares: 3,
    groupPublicKey: 'b'.repeat(64),
    shareEnvelopes: makeShareEnvelopes(3, newHolderPubkeys),
    shareCommitments: makeCommitments(3),
    sigchainLinkHash: 'c'.repeat(64),
    delayHours: 24,
    emergencyFloorHours: 4,
    rewrappedUserEnvelopes: [],
  }, s.crossHubViewerSeed!)
  s.lastStatus = status
  s.lastBody = data as Record<string, unknown>
  setLastResponse(world, { status, data })
})

When('the cross-hub viewer rotates the hub\'s recovery group', async ({ request, world }) => {
  const s = getS(world)
  expect(s.hubId).toBeDefined()
  expect(s.crossHubViewerSeed).toBeDefined()

  const newHolderPubkeys = [`${'2'.repeat(63)}1`, `${'2'.repeat(63)}2`, `${'2'.repeat(63)}3`]
  const { status, data } = await apiPost(request, '/recovery-group/rotate', {
    hubId: s.hubId!,
    threshold: 2,
    totalShares: 3,
    groupPublicKey: 'c'.repeat(64),
    shareEnvelopes: makeShareEnvelopes(3, newHolderPubkeys),
    shareCommitments: makeCommitments(3),
    sigchainLinkHash: 'd'.repeat(64),
    delayHours: 24,
    emergencyFloorHours: 4,
    rewrappedUserEnvelopes: [],
  }, s.crossHubViewerSeed!)
  s.lastStatus = status
  s.lastBody = data as Record<string, unknown>
  setLastResponse(world, { status, data })
})

When('the cross-hub viewer enrolls a recovery group for the second hub', async ({ request, world }) => {
  const s = getS(world)
  expect(s.secondHubId).toBeDefined()
  expect(s.crossHubViewerSeed).toBeDefined()

  const { status, data } = await enrollRecoveryGroup(request, s.secondHubId!, s.crossHubViewerSeed!)
  s.lastStatus = status
  s.lastBody = data as Record<string, unknown>
  setLastResponse(world, { status, data })
})

When('the cross-hub viewer enrolls a recovery group for the hub', async ({ request, world }) => {
  const s = getS(world)
  expect(s.hubId).toBeDefined()
  expect(s.crossHubViewerSeed).toBeDefined()

  const { status, data } = await enrollRecoveryGroup(request, s.hubId!, s.crossHubViewerSeed!)
  s.lastStatus = status
  s.lastBody = data as Record<string, unknown>
  setLastResponse(world, { status, data })
})

When('the cross-hub viewer fetches the recovery group for the second hub', async ({ request, world }) => {
  const s = getS(world)
  expect(s.secondHubId).toBeDefined()
  expect(s.crossHubViewerSeed).toBeDefined()

  const { status, data } = await apiGet<Record<string, unknown>>(request, `/recovery-group/${s.secondHubId!}`, s.crossHubViewerSeed!)
  s.lastStatus = status
  s.lastBody = data
  setLastResponse(world, { status, data })
})

When('the cross-hub viewer fetches the recovery group for the hub', async ({ request, world }) => {
  const s = getS(world)
  expect(s.hubId).toBeDefined()
  expect(s.crossHubViewerSeed).toBeDefined()

  const { status, data } = await apiGet<Record<string, unknown>>(request, `/recovery-group/${s.hubId!}`, s.crossHubViewerSeed!)
  s.lastStatus = status
  s.lastBody = data
  setLastResponse(world, { status, data })
})

Given('a verified recovery session exists for the hub', async ({ request, world }) => {
  const s = getS(world)
  expect(s.hubId).toBeDefined()

  const recoveringUser = await createUserViaApi(request, { name: `Verified Session User ${Date.now()}` })
  const { pubkey: newDevicePubkey } = generateTestKeypair()

  const { status, data } = await devPost<{ sessionId: string }>(request, '/test-recovery-seed-session', {
    hubId: s.hubId!,
    userPubkey: recoveringUser.pubkey,
    newDevicePubkey,
    status: 'verified',
  })
  expect(status).toBe(200)
  s.sessionId = data.sessionId
})

Given('a verified recovery session exists for the second hub', async ({ request, world }) => {
  const s = getS(world)

  if (!s.secondHubId) {
    s.secondHubId = await createHubViaApi(request, `recovery-second-hub-${Date.now()}`)
  }

  const recoveringUser = await createUserViaApi(request, { name: `Second Hub Verified Session User ${Date.now()}` })
  const { pubkey: newDevicePubkey } = generateTestKeypair()

  const { status, data } = await devPost<{ sessionId: string }>(request, '/test-recovery-seed-session', {
    hubId: s.secondHubId!,
    userPubkey: recoveringUser.pubkey,
    newDevicePubkey,
    status: 'verified',
  })
  expect(status).toBe(200)
  s.secondHubSessionId = data.sessionId
})

When('the cross-hub viewer applies emergency override to the second hub\'s session', async ({ request, world }) => {
  const s = getS(world)
  expect(s.secondHubSessionId).toBeDefined()
  expect(s.crossHubViewerSeed).toBeDefined()
  expect(s.crossHubViewerPubkey).toBeDefined()

  const signature = bytesToHex(ed25519.sign(utf8ToBytes(s.secondHubSessionId!), hexToBytes(s.crossHubViewerSeed!)))
  const { status, data } = await apiPost(request, `/recovery-group/session/${s.secondHubSessionId!}/emergency`, {
    approverPubkey: s.crossHubViewerPubkey!,
    justification: 'cross-hub scoping test',
    signature,
  }, s.crossHubViewerSeed!)
  s.lastStatus = status
  s.lastBody = data as Record<string, unknown>
  setLastResponse(world, { status, data })
})

When('the cross-hub viewer applies emergency override to the hub\'s session', async ({ request, world }) => {
  const s = getS(world)
  expect(s.sessionId).toBeDefined()
  expect(s.crossHubViewerSeed).toBeDefined()
  expect(s.crossHubViewerPubkey).toBeDefined()

  const signature = bytesToHex(ed25519.sign(utf8ToBytes(s.sessionId!), hexToBytes(s.crossHubViewerSeed!)))
  const { status, data } = await apiPost(request, `/recovery-group/session/${s.sessionId!}/emergency`, {
    approverPubkey: s.crossHubViewerPubkey!,
    justification: 'cross-hub scoping test',
    signature,
  }, s.crossHubViewerSeed!)
  s.lastStatus = status
  s.lastBody = data as Record<string, unknown>
  setLastResponse(world, { status, data })
})

When('the cross-hub viewer cancels the second hub\'s session', async ({ request, world }) => {
  const s = getS(world)
  expect(s.secondHubSessionId).toBeDefined()
  expect(s.crossHubViewerSeed).toBeDefined()

  const { status, data } = await apiPost(request, `/recovery-group/session/${s.secondHubSessionId!}/cancel`, {}, s.crossHubViewerSeed!)
  s.lastStatus = status
  s.lastBody = data as Record<string, unknown>
  setLastResponse(world, { status, data })
})

When('the cross-hub viewer cancels the hub\'s session', async ({ request, world }) => {
  const s = getS(world)
  expect(s.sessionId).toBeDefined()
  expect(s.crossHubViewerSeed).toBeDefined()

  const { status, data } = await apiPost(request, `/recovery-group/session/${s.sessionId!}/cancel`, {}, s.crossHubViewerSeed!)
  s.lastStatus = status
  s.lastBody = data as Record<string, unknown>
  setLastResponse(world, { status, data })
})

// ══════════════════════════════════════════════════════════════════
// Errata #5 — Atomic group rotation re-wraps user envelopes (D13),
// excludes departed share holders (issue #729)
// ══════════════════════════════════════════════════════════════════

Given('a recovery group with a real HPKE keypair is enrolled for the hub', async ({ request, world }) => {
  const s = getS(world)
  expect(s.hubId).toBeDefined()

  const recoveringUser = await createUserViaApi(request, { name: `Rotation User ${Date.now()}` })
  const groupV1 = generateX25519Keypair()

  const survivingHolderPubkeys = [`${'f'.repeat(63)}1`, `${'f'.repeat(63)}3`]
  const departedHolderPubkey = `${'f'.repeat(63)}2`
  const holderPubkeys = [survivingHolderPubkeys[0], departedHolderPubkey, survivingHolderPubkeys[1]]

  const { status } = await enrollRecoveryGroup(request, s.hubId!, s.adminSeed, {
    threshold: 2,
    totalShares: 3,
    shareHolderPubkeys: holderPubkeys,
    groupPublicKey: groupV1.pubkeyHex,
  })
  expect(status).toBe(200)

  const pukSeed = crypto.getRandomValues(new Uint8Array(32))
  const pukSeedHex = bytesToHex(pukSeed)
  const wrapped = await wrapKeyForRecipient(pukSeed, groupV1.pubkeyHex, '', LABEL_RECOVERY_PUK_SEED_WRAP)

  const { status: envStatus } = await apiPost(request, '/recovery-group/user-envelope', {
    hubId: s.hubId!,
    envelope: packWrap(wrapped),
  }, recoveringUser.seedHex)
  expect(envStatus).toBe(200)

  s.rotation = {
    recoveringUserPubkey: recoveringUser.pubkey,
    recoveringUserSeed: recoveringUser.seedHex,
    groupV1: { pubkeyHex: groupV1.pubkeyHex, skHex: groupV1.skHex },
    groupV2: { pubkeyHex: '', skHex: '' },
    pukSeedHex,
    departedHolderPubkey,
    survivingHolderPubkeys,
    replacementHolderPubkey: `${'f'.repeat(63)}4`,
  }
})

When('the admin rotates the recovery group, excluding the departed holder, and re-wraps the user envelope', async ({ request, world }) => {
  const s = getS(world)
  expect(s.rotation).toBeDefined()
  const r = s.rotation!

  const groupV2 = generateX25519Keypair()
  r.groupV2 = { pubkeyHex: groupV2.pubkeyHex, skHex: groupV2.skHex }

  // Client-side re-wrap (D13 step 3c): open under the OLD group key, re-seal
  // under the NEW one. The server never sees plaintext or private key material.
  const pukSeed = hexToBytes(r.pukSeedHex)
  const rewrapped = await wrapKeyForRecipient(pukSeed, groupV2.pubkeyHex, '', LABEL_RECOVERY_PUK_SEED_WRAP)

  const newHolderPubkeys = [r.survivingHolderPubkeys[0], r.survivingHolderPubkeys[1], r.replacementHolderPubkey]

  const { status, data } = await apiPost(request, '/recovery-group/rotate', {
    hubId: s.hubId!,
    threshold: 2,
    totalShares: 3,
    groupPublicKey: groupV2.pubkeyHex,
    shareEnvelopes: makeShareEnvelopes(3, newHolderPubkeys),
    shareCommitments: makeCommitments(3),
    sigchainLinkHash: 'c'.repeat(64),
    delayHours: 24,
    emergencyFloorHours: 4,
    rewrappedUserEnvelopes: [{ userPubkey: r.recoveringUserPubkey, envelope: packWrap(rewrapped) }],
  }, s.adminSeed)

  s.lastStatus = status
  s.lastBody = data as Record<string, unknown>
  setLastResponse(world, { status, data })
})

Then('the rotated recovery group excludes the departed holder', async ({ request, world }) => {
  const s = getS(world)
  const r = s.rotation!

  const { status, data } = await apiGet<Record<string, unknown>>(request, `/recovery-group/${s.hubId!}`, s.adminSeed)
  expect(status).toBe(200)
  const holders = (data.shareHolderLiveness as Array<{ holderPubkey: string }>).map(h => h.holderPubkey)
  expect(holders).not.toContain(r.departedHolderPubkey)
  expect(holders).toContain(r.replacementHolderPubkey)
  expect(data.groupPublicKey).toBe(r.groupV2.pubkeyHex)
})

Then('the departed group key cannot decrypt the rotated envelope, but the new group key can', async ({ request, world }) => {
  const s = getS(world)
  const r = s.rotation!

  // A departed holder retaining their old share gains nothing: the envelope
  // is now wrapped under a private key they never had, since the whole
  // group keypair — not just the share set — was replaced in the rotation.
  const { pubkey: placeholderDevicePubkey } = generateTestKeypair()
  const { status: seedStatus, data: seedData } = await devPost<{ sessionId: string }>(request, '/test-recovery-seed-session', {
    hubId: s.hubId!,
    userPubkey: r.recoveringUserPubkey,
    newDevicePubkey: placeholderDevicePubkey,
    status: 'active',
  })
  expect(seedStatus).toBe(200)

  const { status: envStatus, data: envData } = await apiGet<{ envelope: string | null }>(
    request, `/recovery-group/user-envelope/${s.hubId!}?sessionId=${seedData.sessionId}`, s.adminSeed,
  )
  expect(envStatus).toBe(200)
  expect(envData.envelope).toBeTruthy()

  const { enc, ct } = unpackWrap(envData.envelope!)

  let openedWithDepartedKey = true
  try {
    await unwrapKey(ct, enc, r.groupV1.skHex, LABEL_RECOVERY_PUK_SEED_WRAP)
  } catch {
    openedWithDepartedKey = false
  }
  expect(openedWithDepartedKey).toBe(false)

  const decrypted = await unwrapKey(ct, enc, r.groupV2.skHex, LABEL_RECOVERY_PUK_SEED_WRAP)
  expect(bytesToHex(decrypted)).toBe(r.pukSeedHex)
})

// ══════════════════════════════════════════════════════════════════
// Errata #12 — recovery-device-add sigchain link on completion
// (issue #729): full ceremony from contribution through decrypt
// ══════════════════════════════════════════════════════════════════

Given('a recovery group is enrolled with two real contributing holders', async ({ request, world }) => {
  const s = getS(world)
  expect(s.hubId).toBeDefined()

  const recoveringUser = await createUserViaApi(request, { name: `Ceremony User ${Date.now()}` })

  // POST /session/:id/contribute requires recovery:hold-share, which the
  // default role-volunteer does not grant — create a dedicated role for
  // the two real contributing holders (mirrors the "Given a recovery group
  // is enrolled for the hub" pattern above, which sidesteps this by using
  // the wildcard-permission admin as a holder instead).
  const holderRoleSlug = `recovery-holder-${Date.now()}`
  const holderRole = await createRoleViaApi(request, {
    name: `Recovery Holder ${Date.now()}`,
    slug: holderRoleSlug,
    permissions: ['recovery:hold-share'],
  })
  // Role IDs are server-generated (`role-<uuid>`), NOT derived from the slug —
  // use the id the server actually returned, not a guessed `role-${slug}`.
  const holder1 = await createUserViaApi(request, { name: `Holder One ${Date.now()}`, roleIds: [holderRole.id] })
  const holder2 = await createUserViaApi(request, { name: `Holder Two ${Date.now()}`, roleIds: [holderRole.id] })
  const placeholderHolder = `${'e'.repeat(63)}9`

  const group = generateX25519Keypair()

  const { status } = await enrollRecoveryGroup(request, s.hubId!, s.adminSeed, {
    threshold: 2,
    totalShares: 3,
    shareHolderPubkeys: [holder1.pubkey, holder2.pubkey, placeholderHolder],
    groupPublicKey: group.pubkeyHex,
  })
  expect(status).toBe(200)

  const pukSeed = crypto.getRandomValues(new Uint8Array(32))
  const pukSeedHex = bytesToHex(pukSeed)
  const wrapped = await wrapKeyForRecipient(pukSeed, group.pubkeyHex, '', LABEL_RECOVERY_PUK_SEED_WRAP)

  const { status: envStatus } = await apiPost(request, '/recovery-group/user-envelope', {
    hubId: s.hubId!,
    envelope: packWrap(wrapped),
  }, recoveringUser.seedHex)
  expect(envStatus).toBe(200)

  // The new device's single seed yields two distinct curve representations,
  // exactly like a real device: Ed25519 for signing (sigchain), X25519 for
  // HPKE receipt (share contributions + the PUK seed envelope).
  const { seedHex: newDeviceSeedHex, pubkey: newDeviceEdPubkey } = generateTestKeypair()
  const newDeviceX25519Pubkey = x25519PubkeyFromSeed(newDeviceSeedHex)

  const { status: sessionStatus, data: sessionData } = await devPost<{ sessionId: string }>(request, '/test-recovery-seed-session', {
    hubId: s.hubId!,
    userPubkey: recoveringUser.pubkey,
    newDevicePubkey: newDeviceEdPubkey,
    status: 'verified',
  })
  expect(sessionStatus).toBe(200)

  s.ceremony = {
    recoveringUserPubkey: recoveringUser.pubkey,
    contributingHolders: [
      { seedHex: holder1.seedHex, pubkey: holder1.pubkey },
      { seedHex: holder2.seedHex, pubkey: holder2.pubkey },
    ],
    threshold: 2,
    group: { pubkeyHex: group.pubkeyHex, skHex: group.skHex },
    pukSeedHex,
    newDeviceSeedHex,
    newDeviceEdPubkey,
    newDeviceX25519Pubkey,
    sessionId: sessionData.sessionId,
  }
  s.sessionId = sessionData.sessionId
})

When('each contributing holder submits their share to the new device', async ({ request, world }) => {
  const s = getS(world)
  expect(s.ceremony).toBeDefined()
  const cer = s.ceremony!

  const groupSkBytes = hexToBytes(cer.group.skHex)

  for (const holder of cer.contributingHolders) {
    const wrapped = await wrapKeyForRecipient(groupSkBytes, cer.newDeviceX25519Pubkey, '', LABEL_RECOVERY_SHARE_CONTRIBUTE)
    const { status, data } = await apiPost(request, `/recovery-group/session/${cer.sessionId}/contribute`, {
      encryptedShare: packWrap(wrapped),
      contributorSignature: 'a'.repeat(128),
    }, holder.seedHex)
    s.lastStatus = status
    s.lastBody = data as Record<string, unknown>
    setLastResponse(world, { status, data })
    expect(status).toBe(200)
  }
})

Then('the recovering device reconstructs the group key from the released contributions', async ({ request, world }) => {
  const s = getS(world)
  const cer = s.ceremony!

  const { status, data } = await apiGet<{ contributions: Array<{ contributorPubkey: string; encryptedShare: string | null }> }>(
    request, `/recovery-group/session/${cer.sessionId}`, s.adminSeed,
  )
  expect(status).toBe(200)
  expect(data.contributions.length).toBeGreaterThanOrEqual(cer.threshold)

  let reconstructed: string | undefined
  for (const contribution of data.contributions) {
    expect(contribution.encryptedShare).toBeTruthy()
    const { enc, ct } = unpackWrap(contribution.encryptedShare!)
    const opened = await unwrapKey(ct, enc, cer.newDeviceSeedHex, LABEL_RECOVERY_SHARE_CONTRIBUTE)
    const openedHex = bytesToHex(opened)
    if (reconstructed) {
      expect(openedHex).toBe(reconstructed)
    }
    reconstructed = openedHex
  }

  expect(reconstructed).toBe(cer.group.skHex)
  cer.reconstructedGroupSkHex = reconstructed
})

When('the new device completes recovery with a self-authorizing sigchain link', async ({ request, world }) => {
  const s = getS(world)
  const cer = s.ceremony!

  // The recovering user in this scenario never initialised an identity, so
  // the recovery link takes the first slot (SIGCHAIN_GENESIS_SEQ).
  const seqNo = SIGCHAIN_GENESIS_SEQ
  const prevHash = ''
  const timestamp = new Date().toISOString()
  const signerDeviceId = `recovered-device-${cer.newDeviceEdPubkey.slice(0, 8)}`
  const payload = {
    sessionId: cer.sessionId,
    contributingHolderPubkeys: cer.contributingHolders.map(h => h.pubkey),
  }
  const hash = computeSigchainLinkHash(seqNo, prevHash, payload, signerDeviceId, cer.newDeviceEdPubkey, timestamp)
  // Self-authorizing: signed with the NEW device's own key, not the account's
  // (lost) identity key — that's the entire reason recovery was needed.
  const signature = bytesToHex(ed25519.sign(hexToBytes(hash), hexToBytes(cer.newDeviceSeedHex)))

  const { status, data } = await apiPost(request, `/recovery-group/session/${cer.sessionId}/complete`, {
    sigchainSeqNo: seqNo,
    sigchainPayload: payload,
    signature,
    prevHash,
    hash,
    signerDeviceId,
    timestamp,
  })
  s.lastStatus = status
  s.lastBody = data as Record<string, unknown>
  setLastResponse(world, { status, data })
  if (status === 200) {
    cer.sigchainLink = (data as { sigchainLink: Record<string, unknown> }).sigchainLink
  }
})

Then('the recovering user\'s sigchain shows a recovery-device-add link signed by the new device', async ({ request, world }) => {
  const s = getS(world)
  const cer = s.ceremony!

  const { status, data } = await apiGet<{ links: Array<Record<string, unknown>> }>(
    request, `/users/${cer.recoveringUserPubkey}/sigchain`, s.adminSeed,
  )
  expect(status).toBe(200)
  expect(data.links.length).toBe(1)
  const link = data.links[0]
  expect(link.linkType).toBe('recovery-device-add')
  expect(link.signerPubkey).toBe(cer.newDeviceEdPubkey)

  // Independently re-verify the self-authorizing signature client-side —
  // don't just trust that the server said 200.
  const valid = ed25519.verify(
    hexToBytes(link.signature as string),
    hexToBytes(link.hash as string),
    hexToBytes(cer.newDeviceEdPubkey),
  )
  expect(valid).toBe(true)
})

Then('the recovered device decrypts the PUK seed envelope', async ({ request, world }) => {
  const s = getS(world)
  const cer = s.ceremony!
  expect(cer.reconstructedGroupSkHex).toBeDefined()

  const { status, data } = await apiGet<{ envelope: string | null }>(
    request, `/recovery-group/user-envelope/${s.hubId!}?sessionId=${cer.sessionId}`, s.adminSeed,
  )
  expect(status).toBe(200)
  expect(data.envelope).toBeTruthy()

  const { enc, ct } = unpackWrap(data.envelope!)
  const decrypted = await unwrapKey(ct, enc, cer.reconstructedGroupSkHex!, LABEL_RECOVERY_PUK_SEED_WRAP)
  expect(bytesToHex(decrypted)).toBe(cer.pukSeedHex)
})
