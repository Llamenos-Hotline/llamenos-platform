/**
 * Sigchain integrity step definitions.
 * Tests hash-chain continuity, seqNo ordering, and access controls.
 */
import { expect } from '@playwright/test'
import { Given, When, Then, Before, getState, setState } from './fixtures'
import { setLastResponse, getSharedState } from './shared-state'
import {
  apiGet,
  apiPost,
  createUserViaApi,
  ADMIN_NSEC,
} from '../../api-helpers'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@shared/encoding'
import { ed25519 } from '@noble/curves/ed25519.js'

// ── State ──────────────────────��────────────────────────────────────

interface SigchainTestState {
  user?: { deviceKey: string; pubkey: string }
  secondUser?: { deviceKey: string; pubkey: string }
  genesisHash?: string
  lastHash?: string
  lastSeqNo?: number
}

const STATE_KEY = 'sigchain_test'

function getS(world: Record<string, unknown>): SigchainTestState {
  return getState<SigchainTestState>(world, STATE_KEY)
}

Before(async ({ world }) => {
  setState<SigchainTestState>(world, STATE_KEY, {})
})

// ── Helpers ─────────────���────────────────────��──────────────────────

/**
 * Recursively sort all object keys alphabetically — matches the server's
 * canonicalizeJson (RFC 8785 key-sort subset).
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

/**
 * Compute the canonical SHA-256 entry hash for a sigchain link.
 * Matches apps/worker/services/crypto-keys.ts:computeEntryHash exactly:
 *   SHA-256(JSON.stringify({ payload, prevHash, seq, signerDeviceId, signerPubkey, timestamp }, sorted keys))
 * prevHash is null for genesis (Rust Option<String> serialization).
 */
function computeLinkHash(
  seqNo: number,
  prevHash: string | null,
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

async function appendLink(
  request: import('@playwright/test').APIRequestContext,
  deviceKey: string,
  targetPubkey: string,
  opts: {
    seqNo: number; linkType: string; prevHash: string | null;
    payload?: Record<string, unknown>; signature?: string; hash?: string;
    signerDeviceId?: string; signerPubkey?: string; timestamp?: string;
  },
) {
  const signerPubkey = opts.signerPubkey ?? bytesToHex(ed25519.getPublicKey(hexToBytes(deviceKey)))
  const signerDeviceId = opts.signerDeviceId ?? `test-device-${signerPubkey.slice(0, 8)}`
  const timestamp = opts.timestamp ?? new Date().toISOString()
  const payload = opts.payload ?? { devicePubkey: bytesToHex(crypto.getRandomValues(new Uint8Array(32))) }
  const hash = opts.hash ?? computeLinkHash(opts.seqNo, opts.prevHash, payload, signerDeviceId, signerPubkey, timestamp)
  // Generate a real Ed25519 signature over the link hash — server verifies this
  const signature = opts.signature ?? bytesToHex(ed25519.sign(hexToBytes(hash), hexToBytes(deviceKey)))
  return apiPost(request, `/users/${targetPubkey}/sigchain`, {
    seqNo: opts.seqNo, linkType: opts.linkType, payload, signature,
    prevHash: opts.prevHash, hash, signerDeviceId, signerPubkey, timestamp,
  }, deviceKey)
}

// ── Given ────────────────────���──────────────────────────────────────

Given('a registered user with a known keypair', async ({ request, world }) => {
  const user = await createUserViaApi(request, { name: `Sigchain User ${Date.now()}` })
  const userData = { deviceKey: user.deviceKey, pubkey: user.pubkey }
  getS(world).user = userData
  // Also write to shared state so PUK/WebAuthn step namespaces can access it
  getSharedState(world).sharedUser = userData
})

Given('the user has a genesis sigchain link', async ({ request, world }) => {
  const s = getS(world)
  expect(s.user).toBeDefined()
  const payload = { devicePubkey: bytesToHex(crypto.getRandomValues(new Uint8Array(32))) }
  const res = await appendLink(request, s.user!.deviceKey, s.user!.pubkey, { seqNo: 1, linkType: 'genesis', prevHash: null, payload })
  expect(res.status).toBe(201)
  // Extract the server-accepted hash from the response
  s.genesisHash = (res.data as { hash: string }).hash
  s.lastHash = s.genesisHash
  s.lastSeqNo = 1
})

Given('a second registered user', async ({ request, world }) => {
  const user = await createUserViaApi(request, { name: `Second User ${Date.now()}` })
  getS(world).secondUser = { deviceKey: user.deviceKey, pubkey: user.pubkey }
})

// ── When ──────────────��───────────────────────────────────���─────────

When('the user appends a genesis sigchain link', async ({ request, world }) => {
  const s = getS(world)
  expect(s.user).toBeDefined()
  const payload = { devicePubkey: bytesToHex(crypto.getRandomValues(new Uint8Array(32))) }
  const res = await appendLink(request, s.user!.deviceKey, s.user!.pubkey, { seqNo: 1, linkType: 'genesis', prevHash: null, payload })
  setLastResponse(world, res)
  if (res.status === 201) {
    const hash = (res.data as { hash: string }).hash
    s.genesisHash = hash; s.lastHash = hash; s.lastSeqNo = 1
  }
})

When('the user appends a {string} link with valid prevHash', async ({ request, world }, linkType: string) => {
  const s = getS(world)
  expect(s.user).toBeDefined()
  expect(s.lastHash).toBeDefined()
  const newSeqNo = (s.lastSeqNo ?? 0) + 1
  const payload = { devicePubkey: bytesToHex(crypto.getRandomValues(new Uint8Array(32))) }
  const res = await appendLink(request, s.user!.deviceKey, s.user!.pubkey, { seqNo: newSeqNo, linkType, prevHash: s.lastHash!, payload })
  setLastResponse(world, res)
  if (res.status === 201) { s.lastHash = (res.data as { hash: string }).hash; s.lastSeqNo = newSeqNo }
})

When('the user appends a link with an invalid Ed25519 signature', async ({ request, world }) => {
  const s = getS(world)
  expect(s.user).toBeDefined()
  expect(s.lastHash).toBeDefined()
  const newSeqNo = (s.lastSeqNo ?? 0) + 1
  const signerPubkey = bytesToHex(ed25519.getPublicKey(hexToBytes(s.user!.deviceKey)))
  const signerDeviceId = `test-device-${signerPubkey.slice(0, 8)}`
  const timestamp = new Date().toISOString()
  const payload = { devicePubkey: bytesToHex(crypto.getRandomValues(new Uint8Array(32))) }
  const hash = computeLinkHash(newSeqNo, s.lastHash!, payload, signerDeviceId, signerPubkey, timestamp)
  const res = await apiPost(request, `/users/${s.user!.pubkey}/sigchain`, {
    seqNo: newSeqNo, linkType: 'device_add', payload,
    signature: 'badbad', // doesn't match 128-char hex regex
    prevHash: s.lastHash!, hash, signerDeviceId, signerPubkey, timestamp,
  }, s.user!.deviceKey)
  setLastResponse(world, res)
})

When('the user appends a link with wrong prevHash', async ({ request, world }) => {
  const s = getS(world)
  expect(s.user).toBeDefined()
  const newSeqNo = (s.lastSeqNo ?? 0) + 1
  const wrongPrevHash = bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
  const payload = { devicePubkey: bytesToHex(crypto.getRandomValues(new Uint8Array(32))) }
  const res = await appendLink(request, s.user!.deviceKey, s.user!.pubkey, { seqNo: newSeqNo, linkType: 'device_add', prevHash: wrongPrevHash, payload })
  setLastResponse(world, res)
})

When('the user appends a link with duplicate seqNo {int}', async ({ request, world }, seqNo: number) => {
  const s = getS(world)
  expect(s.user).toBeDefined()
  const payload = { devicePubkey: bytesToHex(crypto.getRandomValues(new Uint8Array(32))) }
  const res = await appendLink(request, s.user!.deviceKey, s.user!.pubkey, { seqNo, linkType: 'genesis', prevHash: '', payload })
  setLastResponse(world, res)
})

When('the second user tries to append to the first user\'s sigchain', async ({ request, world }) => {
  const s = getS(world)
  expect(s.user).toBeDefined()
  expect(s.secondUser).toBeDefined()
  const payload = { devicePubkey: bytesToHex(crypto.getRandomValues(new Uint8Array(32))) }
  const res = await appendLink(request, s.secondUser!.deviceKey, s.user!.pubkey, { seqNo: 1, linkType: 'genesis', prevHash: null, payload })
  setLastResponse(world, res)
})

When('the admin reads the user\'s sigchain', async ({ request, world }) => {
  const s = getS(world)
  expect(s.user).toBeDefined()
  setLastResponse(world, await apiGet(request, `/users/${s.user!.pubkey}/sigchain`, ADMIN_NSEC))
})

When('the second user tries to read the first user\'s sigchain', async ({ request, world }) => {
  const s = getS(world)
  expect(s.user).toBeDefined()
  expect(s.secondUser).toBeDefined()
  setLastResponse(world, await apiGet(request, `/users/${s.user!.pubkey}/sigchain`, s.secondUser!.deviceKey))
})

// ── Hash recomputation scenarios ─────────────────────────────────

When('the user appends a genesis sigchain link with correctly computed hash', async ({ request, world }) => {
  const s = getS(world)
  expect(s.user).toBeDefined()
  const payload = { devicePubkey: bytesToHex(crypto.getRandomValues(new Uint8Array(32))) }
  const res = await appendLink(request, s.user!.deviceKey, s.user!.pubkey, { seqNo: 1, linkType: 'genesis', prevHash: null, payload })
  setLastResponse(world, res)
  if (res.status === 201) {
    const hash = (res.data as { hash: string }).hash
    s.genesisHash = hash; s.lastHash = hash; s.lastSeqNo = 1
  }
})

When('the user appends a sigchain link whose payload was modified after hashing', async ({ request, world }) => {
  const s = getS(world)
  expect(s.user).toBeDefined()
  const signerPubkey = bytesToHex(ed25519.getPublicKey(hexToBytes(s.user!.deviceKey)))
  const signerDeviceId = `test-device-${signerPubkey.slice(0, 8)}`
  const timestamp = new Date().toISOString()
  const originalPayload = { devicePubkey: bytesToHex(crypto.getRandomValues(new Uint8Array(32))) }
  // Compute hash with the original payload
  const hash = computeLinkHash(1, null, originalPayload, signerDeviceId, signerPubkey, timestamp)
  const signature = bytesToHex(ed25519.sign(hexToBytes(hash), hexToBytes(s.user!.deviceKey)))
  // Tamper the payload AFTER hashing
  const tamperedPayload = { devicePubkey: bytesToHex(crypto.getRandomValues(new Uint8Array(32))) }
  const res = await apiPost(request, `/users/${s.user!.pubkey}/sigchain`, {
    seqNo: 1, linkType: 'genesis', payload: tamperedPayload,
    signature, prevHash: null, hash, signerDeviceId, signerPubkey, timestamp,
  }, s.user!.deviceKey)
  setLastResponse(world, res)
})

When('the user appends a sigchain link with a hash that does not match the canonical content', async ({ request, world }) => {
  const s = getS(world)
  expect(s.user).toBeDefined()
  const signerPubkey = bytesToHex(ed25519.getPublicKey(hexToBytes(s.user!.deviceKey)))
  const signerDeviceId = `test-device-${signerPubkey.slice(0, 8)}`
  const timestamp = new Date().toISOString()
  const payload = { devicePubkey: bytesToHex(crypto.getRandomValues(new Uint8Array(32))) }
  // Use a forged hash that doesn't match the content
  const forgedHash = bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
  const signature = bytesToHex(ed25519.sign(hexToBytes(forgedHash), hexToBytes(s.user!.deviceKey)))
  const res = await apiPost(request, `/users/${s.user!.pubkey}/sigchain`, {
    seqNo: 1, linkType: 'genesis', payload,
    signature, prevHash: null, hash: forgedHash, signerDeviceId, signerPubkey, timestamp,
  }, s.user!.deviceKey)
  setLastResponse(world, res)
})

// ── Then ─────────────��───────────────────────���──────────────────────

Then('the sigchain has {int} link(s)', async ({ request, world }, count: number) => {
  const s = getS(world)
  expect(s.user).toBeDefined()
  const res = await apiGet<{ links: unknown[] }>(request, `/users/${s.user!.pubkey}/sigchain`, s.user!.deviceKey)
  expect(res.status).toBe(200)
  expect(res.data.links).toHaveLength(count)
})

Then('the first link has linkType {string}', async ({ request, world }, linkType: string) => {
  const s = getS(world)
  expect(s.user).toBeDefined()
  const res = await apiGet<{ links: Array<{ linkType: string }> }>(request, `/users/${s.user!.pubkey}/sigchain`, s.user!.deviceKey)
  expect(res.data.links[0].linkType).toBe(linkType)
})
