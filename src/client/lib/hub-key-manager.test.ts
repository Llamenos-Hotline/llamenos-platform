/**
 * Hub-key lifecycle, end to end across several member clients.
 *
 * Each member gets its OWN hub-key-manager module instance (its own slot
 * tracking) bound to its OWN fake device (X25519 keypair + hub-key slot), the
 * way separate desktop installs behave. Crypto is real: envelopes are sealed
 * with the shared HPKE primitive the Playwright IPC mock uses
 * (tests/mocks/hpke-mock.ts — X25519 + HKDF-SHA256 + AES-256-GCM, label-bound)
 * and hub fields with AES-256-GCM under the hub key with the label as AAD, as
 * apps/desktop/src/crypto.rs does. The server is an in-memory stand-in for the
 * hub-key, device-overview, tag and team routes with the real replace
 * semantics of `PUT /hubs/:id/key`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { x25519 } from '@noble/curves/ed25519.js'
import { gcm } from '@noble/ciphers/aes.js'
import { randomBytes, bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { LABEL_HUB_KEY_WRAP, LABEL_TAG_ENCRYPT, LABEL_TEAM_ENCRYPT } from '@shared/crypto-labels'
import type { TagResponse, TeamResponse } from '@protocol/schemas'
import { hpkeSealMock, hpkeOpenMock } from '../../../tests/mocks/hpke-mock'

interface FakeDevice {
  userPubkey: string
  deviceId: string
  secret: Uint8Array
  encryptionPubkeyHex: string
  hubKey: Uint8Array | null
}

interface Envelope { v: number; labelId: number; enc: string; ct: string }

/** Shared between the mock factories (hoisted) and the test body. */
const h = vi.hoisted(() => {
  class ApiError extends Error {
    constructor(public status: number, public body: string) {
      super(`API error ${status}: ${body}`)
      this.name = 'ApiError'
    }
  }
  return {
    ApiError,
    /** The device the currently running client code executes on. */
    current: null as FakeDevice | null,
    activeHub: null as string | null,
    /** Platform (Rust CryptoState) behaviour, installed by the test body. */
    platform: {} as Record<string, (...args: never[]) => unknown>,
    /** Server request handler, installed by the test body. */
    request: (async () => { throw new Error('server not installed') }) as (path: string, init?: RequestInit) => Promise<unknown>,
  }
})

vi.mock('./platform', () => ({
  getDevicePubkeys: (...a: never[]) => h.platform.getDevicePubkeys(...a),
  generateHubKeyInState: (...a: never[]) => h.platform.generateHubKeyInState(...a),
  wrapHubKeyForMember: (...a: never[]) => h.platform.wrapHubKeyForMember(...a),
  hpkeUnwrapAndSetHubKey: (...a: never[]) => h.platform.hpkeUnwrapAndSetHubKey(...a),
  encryptHubField: (...a: never[]) => h.platform.encryptHubField(...a),
  decryptHubField: (...a: never[]) => h.platform.decryptHubField(...a),
}))

vi.mock('./api/client', () => ({
  ApiError: h.ApiError,
  request: (path: string, init?: RequestInit) => h.request(path, init),
  getActiveHub: () => h.activeHub,
  setActiveHub: (id: string | null) => { h.activeHub = id },
  hp: (path: string) => (h.activeHub ? `/hubs/${h.activeHub}${path}` : path),
}))

vi.mock('./key-manager', () => ({ onLock: () => () => {} }))

// ── Fake device (mirrors apps/desktop/src/crypto.rs hub-key commands) ──

function device(): FakeDevice {
  if (!h.current) throw new Error('no current device')
  return h.current
}

function hubFieldEncrypt(key: Uint8Array, plaintext: string, label: string): string {
  const nonce = randomBytes(12)
  const ct = gcm(key, nonce, utf8ToBytes(label)).encrypt(utf8ToBytes(plaintext))
  const packed = new Uint8Array(12 + ct.length)
  packed.set(nonce)
  packed.set(ct, 12)
  return bytesToHex(packed)
}

function hubFieldDecrypt(key: Uint8Array, packedHex: string, label: string): string {
  const data = hexToBytes(packedHex)
  return new TextDecoder().decode(gcm(key, data.slice(0, 12), utf8ToBytes(label)).decrypt(data.slice(12)))
}

h.platform = {
  getDevicePubkeys: async () => ({
    deviceId: device().deviceId,
    signingPubkeyHex: device().userPubkey,
    encryptionPubkeyHex: device().encryptionPubkeyHex,
  }),
  generateHubKeyInState: async () => { device().hubKey = randomBytes(32) },
  wrapHubKeyForMember: async (recipientPubkeyHex: string, label: string, aadHex: string) => {
    const key = device().hubKey
    if (!key) throw new Error('Hub key not loaded')
    return hpkeSealMock(key, recipientPubkeyHex, label, hexToBytes(aadHex))
  },
  hpkeUnwrapAndSetHubKey: async (envelope: Envelope, expectedLabel: string, aadHex: string) => {
    device().hubKey = hpkeOpenMock(envelope, bytesToHex(device().secret), expectedLabel, hexToBytes(aadHex))
  },
  encryptHubField: async (plaintext: string, label: string) => {
    const key = device().hubKey
    if (!key) throw new Error('Hub key not loaded')
    return hubFieldEncrypt(key, plaintext, label)
  },
  decryptHubField: async (packedHex: string, label: string) => {
    const key = device().hubKey
    if (!key) return null
    try { return hubFieldDecrypt(key, packedHex, label) } catch { return null }
  },
} as unknown as typeof h.platform

// ── In-memory server ────────────────────────────────────────────────

interface HubState {
  createdBy: string
  /** Current members (hubRoles) → the X25519 key of their device. */
  members: Map<string, string>
  admins: Set<string>
  /** Stored hub-key envelopes, by recipient user pubkey. */
  envelopes: Map<string, { enc: string; ct: string }>
  tags: TagResponse[]
  teams: TeamResponse[]
}

let hubs: Map<string, HubState>

function json<T>(init: RequestInit | undefined): T {
  return JSON.parse(String(init?.body)) as T
}

h.request = async (path, init) => {
  const method = (init?.method ?? 'GET').toUpperCase()
  const me = device().userPubkey
  const url = new URL(path, 'http://server')
  const hubOf = (id: string) => {
    const hub = hubs.get(id)
    if (!hub) throw new h.ApiError(404, 'Hub not found')
    return hub
  }

  if (url.pathname === '/admin/devices/overview') {
    const hub = hubOf(url.searchParams.get('hubId') ?? '')
    if (!hub.admins.has(me)) throw new h.ApiError(403, 'Forbidden')
    const all = [...hub.members]
    const offset = Number(url.searchParams.get('offset'))
    const limit = Number(url.searchParams.get('limit'))
    return {
      total: all.length,
      entries: all.slice(offset, offset + limit).map(([userPubkey, x25519Pubkey]) => ({
        userPubkey,
        displayName: null,
        deviceCount: 1,
        lastSeenAt: null,
        verified: false,
        devices: [{ ed25519Pubkey: userPubkey, x25519Pubkey, lastSeenAt: null }],
      })),
    }
  }

  const m = url.pathname.match(/^\/hubs\/([^/]+)\/(key|tags|teams)(?:\/([^/]+))?$/)
  if (!m) throw new h.ApiError(404, `No route ${method} ${path}`)
  const [, hubId, resource, id] = m
  const hub = hubOf(hubId)
  if (!hub.members.has(me)) throw new h.ApiError(403, 'Access denied')

  if (resource === 'key') {
    if (method === 'GET') {
      const env = hub.envelopes.get(me)
      if (!env) throw new h.ApiError(404, 'No key envelope for this user')
      return { envelope: { pubkey: me, ...env } }
    }
    if (!hub.admins.has(me)) throw new h.ApiError(403, 'Forbidden')
    const { envelopes } = json<{ envelopes: Array<{ pubkey: string; enc: string; ct: string }> }>(init)
    if (envelopes.length === 0) throw new h.ApiError(400, 'At least one envelope required')
    hub.envelopes = new Map(envelopes.map(e => [e.pubkey, { enc: e.enc, ct: e.ct }]))
    return { ok: true }
  }

  const list = resource === 'tags' ? hub.tags : hub.teams
  if (method === 'GET') return resource === 'tags' ? { tags: hub.tags } : { teams: hub.teams }
  if (method === 'POST') {
    const now = new Date().toISOString()
    const body = json<Record<string, string>>(init)
    const record = resource === 'tags'
      ? { hubId, name: body.id, color: '#000', encryptedCategory: null, createdBy: me, createdAt: now, ...body }
      : { hubId, encryptedDescription: null, createdBy: me, memberCount: 0, contactCount: 0, createdAt: now, updatedAt: now, ...body }
    ;(list as unknown[]).push(record)
    return record
  }
  if (method === 'PATCH') {
    const record = (list as Array<{ id: string }>).find(r => r.id === id)
    if (!record) throw new h.ApiError(404, 'Not found')
    Object.assign(record, json<object>(init))
    return record
  }
  throw new h.ApiError(405, `${method} ${path}`)
}

// ── Helpers ─────────────────────────────────────────────────────────

type Manager = typeof import('./hub-key-manager')

interface Client {
  device: FakeDevice
  hkm: Manager
  /** Run client code on this member's device. */
  run<T>(fn: (hkm: Manager) => Promise<T>): Promise<T>
}

/** A separate desktop install: its own device and its own module state. */
async function newClient(): Promise<Client> {
  const secret = randomBytes(32)
  const dev: FakeDevice = {
    userPubkey: bytesToHex(randomBytes(32)),
    deviceId: crypto.randomUUID(),
    secret,
    encryptionPubkeyHex: bytesToHex(x25519.getPublicKey(secret)),
    hubKey: null,
  }
  vi.resetModules()
  const hkm = await import('./hub-key-manager')
  return {
    device: dev,
    hkm,
    run: async fn => {
      h.current = dev
      try { return await fn(hkm) } finally { h.current = null }
    },
  }
}

function createHub(id: string, admin: Client, members: Client[]): HubState {
  const hub: HubState = {
    createdBy: admin.device.userPubkey,
    members: new Map([admin, ...members].map(c => [c.device.userPubkey, c.device.encryptionPubkeyHex])),
    admins: new Set([admin.device.userPubkey]),
    envelopes: new Map(),
    tags: [],
    teams: [],
  }
  hubs.set(id, hub)
  return hub
}

/** Hub member departure as the server performs it: hubRoles edited, envelope rows untouched. */
function depart(hub: HubState, member: Client): void {
  hub.members.delete(member.device.userPubkey)
}

async function createTag(client: Client, hub: HubState, label: string): Promise<TagResponse> {
  const encryptedLabel = await client.run(hkm => hkm.encryptForHub(label, LABEL_TAG_ENCRYPT))
  return client.run(() => h.request(`/hubs/${h.activeHub}/tags`, {
    method: 'POST',
    body: JSON.stringify({ id: crypto.randomUUID(), encryptedLabel }),
  })) as Promise<TagResponse>
}

const HUB = 'hub-a'

beforeEach(() => {
  hubs = new Map()
  h.activeHub = HUB
  h.current = null
})

// ── Tests ───────────────────────────────────────────────────────────

describe('hub key lifecycle across members', () => {
  it('two members decrypt hub content; after one departs the survivor still decrypts new content and the departed member cannot', async () => {
    const admin = await newClient()
    const bob = await newClient()
    const dave = await newClient()
    const hub = createHub(HUB, admin, [bob, dave])

    // Hub creation: the admin generates the key and wraps it for every member.
    const provisioned = await admin.run(hkm => hkm.provisionHubKey(HUB))
    expect(new Set(provisioned.recipients)).toEqual(
      new Set([admin, bob, dave].map(c => c.device.userPubkey)),
    )
    expect(provisioned.unreachable).toEqual([])
    expect(hub.envelopes.size).toBe(3)

    const tag = await createTag(admin, hub, 'Eviction defense')
    const tagCiphertextBefore = tag.encryptedLabel

    // Both members load their own envelope and read the hub content.
    for (const member of [bob, dave]) {
      expect(await member.run(hkm => hkm.loadHubKey(HUB))).toBe(true)
      expect(await member.run(hkm => hkm.decryptFromHub(tag.encryptedLabel, LABEL_TAG_ENCRYPT)))
        .toBe('Eviction defense')
    }
    const daveOldKey = dave.device.hubKey
    const daveOldEnvelope = hub.envelopes.get(dave.device.userPubkey)
    if (!daveOldKey || !daveOldEnvelope) throw new Error('Dave holds no key before departure')

    // Dave leaves the hub; the admin rotates.
    depart(hub, dave)
    const rotation = await admin.run(hkm => hkm.rotateHubKey(HUB, [dave.device.userPubkey]))

    // The departed member's envelope is gone; only the remaining members hold one.
    expect(new Set(hub.envelopes.keys())).toEqual(new Set([admin.device.userPubkey, bob.device.userPubkey]))
    expect(new Set(rotation.recipients)).toEqual(new Set([admin.device.userPubkey, bob.device.userPubkey]))
    expect(rotation.unreadableRecords).toBe(0)
    // A genuinely new key, and existing hub data was re-sealed under it.
    expect(bytesToHex(admin.device.hubKey ?? new Uint8Array())).not.toBe(bytesToHex(daveOldKey))
    expect(hub.tags[0].encryptedLabel).not.toBe(tagCiphertextBefore)

    // New content written after the departure.
    const newTag = await createTag(admin, hub, 'Night shift roster')

    // The survivor re-loads and reads both the re-encrypted and the new content.
    expect(await bob.run(hkm => hkm.loadHubKey(HUB))).toBe(true)
    expect(await bob.run(hkm => hkm.decryptFromHub(newTag.encryptedLabel, LABEL_TAG_ENCRYPT)))
      .toBe('Night shift roster')
    expect(await bob.run(hkm => hkm.decryptFromHub(hub.tags[0].encryptedLabel, LABEL_TAG_ENCRYPT)))
      .toBe('Eviction defense')

    // The departed member: the server refuses them an envelope...
    await expect(dave.run(hkm => hkm.loadHubKey(HUB))).rejects.toMatchObject({ status: 403 })
    // ...and the old key they still hold decrypts nothing written afterwards,
    // re-encrypted records included.
    expect(await dave.run(hkm => hkm.decryptFromHub(newTag.encryptedLabel, LABEL_TAG_ENCRYPT))).toBeNull()
    expect(await dave.run(hkm => hkm.decryptFromHub(hub.tags[0].encryptedLabel, LABEL_TAG_ENCRYPT))).toBeNull()
    // Even replaying the envelope they had before departure yields only the old key.
    const replayed = hpkeOpenMock(
      { v: 3, labelId: 3, ...daveOldEnvelope }, bytesToHex(dave.device.secret), LABEL_HUB_KEY_WRAP, new Uint8Array(0),
    )
    expect(() => hubFieldDecrypt(replayed, newTag.encryptedLabel, LABEL_TAG_ENCRYPT)).toThrow()
  })

  it('rotation excludes the departed member even while the server still lists them', async () => {
    const admin = await newClient()
    const bob = await newClient()
    const dave = await newClient()
    const hub = createHub(HUB, admin, [bob, dave])
    await admin.run(hkm => hkm.provisionHubKey(HUB))

    // Removal not yet reflected in the member listing (e.g. a racing read).
    const rotation = await admin.run(hkm => hkm.rotateHubKey(HUB, [dave.device.userPubkey]))

    expect(rotation.recipients).not.toContain(dave.device.userPubkey)
    expect(hub.envelopes.has(dave.device.userPubkey)).toBe(false)
    await expect(dave.run(hkm => hkm.loadHubKey(HUB))).resolves.toBe(false)
  })

  it('rotation re-encrypts team fields too, preserving an absent description', async () => {
    const admin = await newClient()
    const bob = await newClient()
    const hub = createHub(HUB, admin, [bob])
    await admin.run(hkm => hkm.provisionHubKey(HUB))

    const encryptedName = await admin.run(hkm => hkm.encryptForHub('Legal observers', LABEL_TEAM_ENCRYPT))
    await admin.run(() => h.request(`/hubs/${HUB}/teams`, {
      method: 'POST',
      body: JSON.stringify({ id: 'team-1', encryptedName }),
    }))

    depart(hub, bob)
    await admin.run(hkm => hkm.rotateHubKey(HUB, [bob.device.userPubkey]))

    expect(hub.teams[0].encryptedName).not.toBe(encryptedName)
    expect(hub.teams[0].encryptedDescription).toBeNull()
    expect(await admin.run(hkm => hkm.decryptFromHub(hub.teams[0].encryptedName, LABEL_TEAM_ENCRYPT)))
      .toBe('Legal observers')
  })

  it('distributeHubKey gives a newly added member the SAME key', async () => {
    const admin = await newClient()
    const erin = await newClient()
    const hub = createHub(HUB, admin, [])
    await admin.run(hkm => hkm.provisionHubKey(HUB))
    const tag = await createTag(admin, hub, 'Intake')

    hub.members.set(erin.device.userPubkey, erin.device.encryptionPubkeyHex)
    await expect(erin.run(hkm => hkm.loadHubKey(HUB))).resolves.toBe(false)

    await admin.run(hkm => hkm.distributeHubKey(HUB))
    expect(await erin.run(hkm => hkm.loadHubKey(HUB))).toBe(true)
    expect(await erin.run(hkm => hkm.decryptFromHub(tag.encryptedLabel, LABEL_TAG_ENCRYPT))).toBe('Intake')
  })

  it('refuses to rotate without the current key rather than orphaning existing data', async () => {
    const admin = await newClient()
    const bob = await newClient()
    const hub = createHub(HUB, admin, [bob])

    await expect(admin.run(hkm => hkm.rotateHubKey(HUB, [bob.device.userPubkey])))
      .rejects.toBeInstanceOf(admin.hkm.HubKeyUnavailableError)
    expect(hub.envelopes.size).toBe(0)
  })

  it('refuses to rotate a hub other than the active one', async () => {
    const admin = await newClient()
    createHub(HUB, admin, [])
    await admin.run(hkm => hkm.provisionHubKey(HUB))
    h.activeHub = 'hub-b'
    await expect(admin.run(hkm => hkm.rotateHubKey(HUB, []))).rejects.toThrow(/active hub/)
  })
})

describe('ensureHubKey', () => {
  it('provisions a key for the creator of a hub that has none and no hub data', async () => {
    const admin = await newClient()
    const hub = createHub(HUB, admin, [])
    const result = await admin.run(hkm => hkm.ensureHubKey(HUB, {
      selfPubkey: admin.device.userPubkey, hubCreatedBy: hub.createdBy, canManageKeys: true,
    }))
    expect(result).toBe('provisioned')
    expect(hub.envelopes.has(admin.device.userPubkey)).toBe(true)
  })

  it('never replaces a key when the hub already holds encrypted data', async () => {
    const admin = await newClient()
    const hub = createHub(HUB, admin, [])
    hub.tags.push({
      id: 't', hubId: HUB, name: 't', encryptedLabel: 'aa'.repeat(40), color: '#000',
      encryptedCategory: null, createdBy: admin.device.userPubkey, createdAt: '',
    })
    const result = await admin.run(hkm => hkm.ensureHubKey(HUB, {
      selfPubkey: admin.device.userPubkey, hubCreatedBy: hub.createdBy, canManageKeys: true,
    }))
    expect(result).toBe('unavailable')
    expect(hub.envelopes.size).toBe(0)
  })

  it('does not provision for a non-creator', async () => {
    const admin = await newClient()
    const other = await newClient()
    const hub = createHub(HUB, admin, [other])
    hub.admins.add(other.device.userPubkey)
    const result = await other.run(hkm => hkm.ensureHubKey(HUB, {
      selfPubkey: other.device.userPubkey, hubCreatedBy: hub.createdBy, canManageKeys: true,
    }))
    expect(result).toBe('unavailable')
    expect(hub.envelopes.size).toBe(0)
  })
})

describe('slot binding', () => {
  it('refuses to encrypt for the active hub while another hub key is loaded', async () => {
    const admin = await newClient()
    createHub(HUB, admin, [])
    createHub('hub-b', admin, [])
    await admin.run(hkm => hkm.provisionHubKey(HUB))
    h.activeHub = 'hub-b'
    await expect(admin.run(hkm => hkm.encryptForHub('x', LABEL_TAG_ENCRYPT)))
      .rejects.toBeInstanceOf(admin.hkm.HubKeyUnavailableError)
    expect(await admin.run(hkm => hkm.decryptFromHub('00'.repeat(40), LABEL_TAG_ENCRYPT))).toBeNull()
  })

  it('provisioning a non-active hub restores the active hub key afterwards', async () => {
    const admin = await newClient()
    const hub = createHub(HUB, admin, [])
    createHub('hub-b', admin, [])
    await admin.run(hkm => hkm.provisionHubKey(HUB))
    const tag = await createTag(admin, hub, 'Before')

    await admin.run(hkm => hkm.provisionHubKey('hub-b'))

    await expect(admin.run(hkm => Promise.resolve(hkm.getLoadedHubKeyHubId()))).resolves.toBe(HUB)
    expect(await admin.run(hkm => hkm.decryptFromHub(tag.encryptedLabel, LABEL_TAG_ENCRYPT))).toBe('Before')
  })
})
