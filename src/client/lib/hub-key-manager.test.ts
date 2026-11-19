import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HUB_NOT_FOUND_CODE } from '@protocol/schemas/common'
import { renderHook, waitFor } from '@testing-library/react'
import type {
  HubKeyEnvelopeResponse,
  HubKeyEnvelopesBody,
  HubKeyRecipientsResponse,
  HubKeyRotateBody,
  HubKeyRotateResponse,
  HubKeyRotationResponse,
  HubKeyRotationStatement,
  HubKeySetResponse,
  HubSealedValues,
  RoleDefinition,
} from '@protocol/schemas'

/**
 * The hub key lifecycle, end to end on the client (#1042, #2788).
 *
 * #2788 sealed hub role names under the hub key while no client generated,
 * distributed or loaded one, so on `main` a desktop admin could not create a
 * hub role at all (`Hub key not loaded`) and nobody could read one. These drive
 * the real modules — hub-key-manager, role-vocabulary, platform.ts and the
 * Tauri IPC mock (tests/mocks/tauri-core.ts, the JS mirror of
 * apps/desktop/src/crypto.rs) — for several devices at once, each a separate
 * module graph with its own CryptoState. The server is an in-memory model of
 * the hub-key routes with the same compare-and-set as
 * `SettingsService.setHubKeyEnvelopes`, and the same refusals as
 * `rotateHubKey` (apps/worker/lib/hub-key.ts) for a rotation.
 */

type Invoke = <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>

const HUB = 'hub-1'

interface DeviceState { signingPubkeyHex: string; encryptionPubkeyHex: string }

interface Member { pubkey: string; encryptionPubkey: string | null; manager: boolean }

type ApiErrorCtor = new (s: number, b: string) => Error

/** In-memory model of GET /key, GET /key/recipients, PUT /key, GET /key/rotation and POST /key/rotate. */
class FakeHubKeyServer {
  generation = 0
  epoch = 0
  rotation: HubKeyRotationStatement | null = null
  rotationDue = false
  wraps = new Map<string, { enc: string; ct: string }>()
  members = new Map<string, Member>()
  /** The hub's sealed values — role names only here; tags and teams go the same way. */
  roles = new Map<string, string>()
  puts = 0
  rotations = 0
  recipientReads = 0
  /** The hub is not there for this server (deleted elsewhere): every key route answers 404 with the HUB_NOT_FOUND code. */
  gone = false

  private served(ApiError: ApiErrorCtor) {
    if (this.gone) throw new ApiError(404, JSON.stringify({ error: 'Hub not found', code: HUB_NOT_FOUND_CODE }))
  }

  join(member: Member) {
    this.members.set(member.pubkey, member)
  }

  /** `IdentityService.removeHubRole`: the wrap goes, and the key is due a rotation. */
  remove(pubkey: string) {
    this.members.delete(pubkey)
    if (this.wraps.delete(pubkey)) this.rotationDue = true
  }

  getEnvelope(caller: string, ApiError: ApiErrorCtor): HubKeyEnvelopeResponse {
    this.served(ApiError)
    if (!this.members.has(caller)) throw new ApiError(403, '{"error":"Access denied"}')
    const wrap = this.wraps.get(caller)
    if (!wrap) throw new ApiError(404, '{"error":"No key envelope for this user"}')
    return { envelope: { pubkey: caller, ...wrap } }
  }

  sealed(): HubSealedValues {
    return {
      tags: [],
      teams: [],
      roles: [...this.roles].map(([id, encryptedName]) => ({ id, encryptedName, encryptedDescription: null })),
    }
  }

  recipients(caller: string, ApiError: ApiErrorCtor): HubKeyRecipientsResponse {
    this.recipientReads++
    this.served(ApiError)
    if (!this.members.get(caller)?.manager) throw new ApiError(403, '{"error":"Forbidden"}')
    const rotationRequired = this.rotationDue && this.wraps.size > 0
    return {
      generation: this.generation,
      epoch: this.epoch,
      rotation: this.rotation,
      envelopes: [...this.wraps].filter(([pk]) => this.members.has(pk)).map(([pubkey, w]) => ({ pubkey, ...w })),
      members: [...this.members.values()].map(m => ({ pubkey: m.pubkey, encryptionPubkey: m.encryptionPubkey })),
      rotationRequired,
      ...(rotationRequired ? { sealed: this.sealed() } : {}),
    }
  }

  put(caller: string, body: HubKeyEnvelopesBody, ApiError: ApiErrorCtor): HubKeySetResponse {
    this.served(ApiError)
    if (!this.members.get(caller)?.manager) throw new ApiError(403, '{"error":"Forbidden"}')
    if (body.expectedGeneration !== this.generation) throw new ApiError(409, '{"error":"Hub key generation mismatch"}')
    this.puts++
    this.generation++
    this.wraps = new Map(body.envelopes.map(e => [e.pubkey, { enc: e.enc, ct: e.ct }]))
    return { ok: true, generation: this.generation }
  }

  getRotation(caller: string, ApiError: ApiErrorCtor): HubKeyRotationResponse {
    this.served(ApiError)
    if (!this.members.has(caller)) throw new ApiError(403, '{"error":"Access denied"}')
    return { epoch: this.epoch, rotation: this.rotation }
  }

  rotate(caller: string, body: HubKeyRotateBody, ApiError: ApiErrorCtor): HubKeyRotateResponse {
    this.served(ApiError)
    if (!this.members.get(caller)?.manager) throw new ApiError(403, '{"error":"Forbidden"}')
    if (body.expectedGeneration !== this.generation) throw new ApiError(409, '{"error":"Hub key generation mismatch"}')
    const wrapped = new Set(body.envelopes.map(e => e.pubkey))
    if ([...wrapped].some(pk => !this.members.has(pk))) throw new ApiError(403, '{"error":"wrap for a non-member"}')
    const addressable = [...this.members.values()].filter(m => m.encryptionPubkey !== null).map(m => m.pubkey)
    if (wrapped.size !== addressable.length || addressable.some(pk => !wrapped.has(pk))) {
      throw new ApiError(409, '{"error":"wrap every member"}')
    }
    if (body.resealed.roles.length !== this.roles.size
      || body.resealed.roles.some(r => this.roles.get(r.from.id) !== r.from.encryptedName)) {
      throw new ApiError(409, '{"error":"re-seal every value"}')
    }
    for (const { to } of body.resealed.roles) this.roles.set(to.id, to.encryptedName)
    this.wraps = new Map(body.envelopes.map(e => [e.pubkey, { enc: e.enc, ct: e.ct }]))
    this.generation++
    this.epoch++
    this.rotation = body.rotation
    this.rotationDue = false
    this.rotations++
    return { generation: this.generation, epoch: this.epoch }
  }
}

let server: FakeHubKeyServer

/** A device: fresh webview modules and a fresh CryptoState, talking to `server` as itself. */
async function device(name: string, opts: { manager: boolean; registered?: boolean }) {
  vi.resetModules()
  vi.doMock('@tauri-apps/api/core', async () => await import('../../../tests/mocks/tauri-core'))
  const { invoke } = (await import('@tauri-apps/api/core')) as unknown as { invoke: Invoke }
  const { state } = await invoke<{ state: DeviceState }>(
    'device_generate_and_load', { pin: '12345678', deviceId: name },
  )
  const me = state.signingPubkeyHex
  const { ApiError } = await import('./api/client')
  // Each request is answered as THIS device's user.
  vi.doMock('./api/hubs', () => ({
    getHubKeyEnvelope: async () => server.getEnvelope(me, ApiError),
    getHubKeyRecipients: async () => server.recipients(me, ApiError),
    setHubKeyEnvelopes: async (_hubId: string, body: HubKeyEnvelopesBody) => server.put(me, body, ApiError),
    getHubKeyRotation: async () => server.getRotation(me, ApiError),
    rotateHubKey: async (_hubId: string, body: HubKeyRotateBody) => server.rotate(me, body, ApiError),
  }))
  const keyManager = await import('./key-manager')
  keyManager.markUnlocked(me)
  // Bind this device's platform.ts to ITS CryptoState before the next device
  // registers its own (platform.ts resolves the IPC bridge once, on first use).
  const platform = await import('./platform')
  expect((await platform.getDevicePubkeys())?.signingPubkeyHex).toBe(me)
  const hubKeys = await import('./hub-key-manager')
  const roles = await import('./role-vocabulary')
  server.join({ pubkey: me, encryptionPubkey: opts.registered === false ? null : state.encryptionPubkeyHex, manager: opts.manager })
  return { invoke, me, encryptionPubkey: state.encryptionPubkeyHex, hubKeys, roles, platform, ApiError }
}

function hubRole(id: string, encryptedName: string): RoleDefinition {
  return {
    id, name: null, hubId: HUB, slug: id, permissions: ['notes:read-own'],
    isDefault: false, isSystem: false, description: '', encryptedName,
    createdAt: '2026-11-16T00:00:00Z', updatedAt: '2026-11-16T00:00:00Z',
  }
}

describe('hub key lifecycle', () => {
  beforeEach(() => {
    vi.stubEnv('PLAYWRIGHT_TEST', 'true')
    server = new FakeHubKeyServer()
  })

  afterEach(() => {
    vi.doUnmock('@tauri-apps/api/core')
    vi.doUnmock('./api/hubs')
    vi.unstubAllEnvs()
  })

  it('a hub admin can create a hub role and read its name back (the #2788 regression)', { timeout: 60_000 }, async () => {
    const admin = await device('admin', { manager: true })

    const encryptedName = await admin.roles.sealHubRoleField(HUB, 'Legal observer')
    expect(encryptedName).not.toContain('Legal')
    expect(server.generation).toBe(1)
    expect([...server.wraps.keys()]).toEqual([admin.me])

    const [readable] = await admin.roles.readableRoles([hubRole('role-a', encryptedName)])
    expect(readable).toMatchObject({ displayName: 'Legal observer', readable: true })
  })

  it('a member reads the role once a manager has shared the key', { timeout: 60_000 }, async () => {
    const admin = await device('admin', { manager: true })
    const encryptedName = await admin.roles.sealHubRoleField(HUB, 'Jail support coordinator')

    const volunteer = await device('volunteer', { manager: false })
    // Not shared yet: the name is not readable, and nothing is guessed.
    const [before] = await volunteer.roles.readableRoles([hubRole('role-a', encryptedName)])
    expect(before).toMatchObject({ readable: false, displayName: 'role-a' })
    await expect(volunteer.hubKeys.encryptForHub(HUB, 'x', 'llamenos:hub-role-encrypt:v1'))
      .rejects.toBeInstanceOf(volunteer.hubKeys.HubKeyUnavailableError)
    expect(server.generation).toBe(1) // a non-manager never installs a key

    const adminWrap = server.wraps.get(admin.me)
    expect(await admin.hubKeys.distributeHubKey(HUB)).toBe(1)
    // Distributing adds; it never replaces an existing wrap.
    expect(server.wraps.get(admin.me)).toEqual(adminWrap)
    expect(await admin.hubKeys.distributeHubKey(HUB)).toBe(0)

    const [after] = await volunteer.roles.readableRoles([hubRole('role-a', encryptedName)])
    expect(after).toMatchObject({ readable: true, displayName: 'Jail support coordinator' })

  })

  it('two managers bootstrapping at once end up on ONE key', { timeout: 60_000 }, async () => {
    const a = await device('admin-a', { manager: true })
    const b = await device('admin-b', { manager: true })

    const [heldA, heldB] = await Promise.all([a.hubKeys.ensureHubKey(HUB), b.hubKeys.ensureHubKey(HUB)])
    // At most one of them installed; the other either loaded the winner's key or
    // is waiting for it to be shared — never holding a key of its own.
    expect(server.puts).toBe(1)
    expect(heldA || heldB).toBe(true)

    await (heldA ? a : b).hubKeys.distributeHubKey(HUB)
    const sealed = await a.roles.sealHubRoleField(HUB, 'Legal observer')
    const [readable] = await b.roles.readableRoles([hubRole('role-a', sealed)])
    expect(readable).toMatchObject({ readable: true, displayName: 'Legal observer' })
  })

  describe('a hub the server does not serve (deleted elsewhere, or a membership list ahead of the server)', () => {
    let errors: ReturnType<typeof vi.spyOn>
    let warnings: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      errors = vi.spyOn(console, 'error').mockImplementation(() => {})
      warnings = vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.spyOn(console, 'info').mockImplementation(() => {})
    })

    afterEach(() => {
      vi.doUnmock('./auth')
      vi.doUnmock('./member-hubs')
      vi.doUnmock('./relay/context')
      vi.restoreAllMocks()
    })

    it('is "no key", never a thrown error or a console.error, for every caller of the key', { timeout: 60_000 }, async () => {
      const admin = await device('admin', { manager: true })
      server.gone = true

      expect(await admin.hubKeys.ensureHubKey(HUB)).toBe(false)
      expect(await admin.hubKeys.decryptFromHub(HUB, '00', 'llamenos:hub-role-encrypt:v1')).toBeNull()
      await expect(admin.hubKeys.encryptForHub(HUB, 'x', 'llamenos:hub-role-encrypt:v1'))
        .rejects.toBeInstanceOf(admin.hubKeys.HubKeyUnavailableError)
      expect(errors).not.toHaveBeenCalled()
    })

    it('is learned from the key read alone: the recipients route is not asked to confirm it', { timeout: 60_000 }, async () => {
      const admin = await device('admin', { manager: true })
      server.gone = true

      expect(await admin.hubKeys.ensureHubKey(HUB)).toBe(false)

      // A second 404 for the same hub is a second console error for nothing.
      expect(server.recipientReads).toBe(0)
    })

    it('is reported once by the mounted lifecycle — across remounts and relay reconnects — and never as an error', { timeout: 60_000 }, async () => {
      let relay: 'connected' | 'disconnected' = 'connected'
      vi.doMock('./auth', () => ({ useAuth: () => ({ isAuthenticated: true, hasPermission: () => true }) }))
      vi.doMock('./member-hubs', () => ({ useMemberHubIds: () => [HUB] }))
      vi.doMock('./relay/context', () => ({ useRelayState: () => relay }))
      const admin = await device('admin', { manager: true })
      server.gone = true

      const sync = () => renderHook(() => admin.hubKeys.useHubKeys())
      const first = sync()
      await waitFor(() => expect(warnings).toHaveBeenCalledTimes(1))
      // A reconnect re-runs the sync; a remount mounts it afresh.
      relay = 'disconnected'
      first.rerender()
      relay = 'connected'
      first.rerender()
      first.unmount()
      sync().unmount()
      await admin.hubKeys.resyncHubKeys()

      expect(warnings).toHaveBeenCalledTimes(1)
      expect(warnings.mock.calls[0]?.[0]).toContain(`hub ${HUB}`)
      expect(errors).not.toHaveBeenCalled()
    })
  })

  it('says when the walk over the member hubs has ended — not before the hook is mounted, not while it runs', { timeout: 60_000 }, async () => {
    vi.doMock('./auth', () => ({ useAuth: () => ({ isAuthenticated: true, hasPermission: () => true }) }))
    vi.doMock('./member-hubs', () => ({ useMemberHubIds: () => [HUB] }))
    vi.doMock('./relay/context', () => ({ useRelayState: () => 'connected' }))
    try {
      const admin = await device('admin', { manager: true })
      let settled = false
      const waiting = admin.hubKeys.hubKeysSettled().then(() => { settled = true })

      // Nothing has mounted: there is no walk to have ended.
      await Promise.resolve()
      expect(settled).toBe(false)

      const mounted = renderHook(() => admin.hubKeys.useHubKeys())
      await waiting

      // The walk it waited for did all of its work: the hub's first key is installed.
      expect(server.puts).toBe(1)
      await admin.hubKeys.hubKeysSettled()
      mounted.unmount()
    } finally {
      vi.doUnmock('./auth')
      vi.doUnmock('./member-hubs')
      vi.doUnmock('./relay/context')
    }
  })

  it('a member who cannot manage keys never asks who the key is shared with (a read only a manager is allowed)', { timeout: 60_000 }, async () => {
    vi.doMock('./auth', () => ({ useAuth: () => ({ isAuthenticated: true, hasPermission: () => false }) }))
    vi.doMock('./member-hubs', () => ({ useMemberHubIds: () => [HUB] }))
    vi.doMock('./relay/context', () => ({ useRelayState: () => 'connected' }))
    try {
      const volunteer = await device('volunteer', { manager: false })

      const mounted = renderHook(() => volunteer.hubKeys.useHubKeys())
      await volunteer.hubKeys.resyncHubKeys()
      mounted.unmount()

      expect(server.recipientReads).toBe(0)
      expect(await volunteer.hubKeys.ensureHubKey(HUB)).toBe(false)
    } finally {
      vi.doUnmock('./auth')
      vi.doUnmock('./member-hubs')
      vi.doUnmock('./relay/context')
    }
  })

  it('a manager who lacks a wrap of an EXISTING key does not replace it', { timeout: 60_000 }, async () => {
    const first = await device('admin-first', { manager: true })
    await first.hubKeys.ensureHubKey(HUB)
    const late = await device('admin-late', { manager: true })

    expect(await late.hubKeys.ensureHubKey(HUB)).toBe(false)
    expect(server.generation).toBe(1)
    expect([...server.wraps.keys()]).toEqual([first.me])
  })

  it('a key the server swaps in after load is never the one handed to members', { timeout: 60_000 }, async () => {
    const admin = await device('admin', { manager: true })
    const sealed = await admin.roles.sealHubRoleField(HUB, 'Legal observer')

    // The server replaces the admin's wrap with one of a key IT chose — anyone
    // can seal to the admin's public X25519 key.
    const { hpkeSealMock, base64urlDecode } = await import('../../../tests/mocks/hpke-mock')
    const { keyWrapAad } = await import('@shared/envelope-aad')
    const { LABEL_HUB_KEY_WRAP } = await import('@shared/crypto-labels')
    const { bytesToHex, randomBytes } = await import('@noble/hashes/utils.js')
    const forged = await hpkeSealMock(randomBytes(32), admin.encryptionPubkey, LABEL_HUB_KEY_WRAP, keyWrapAad(LABEL_HUB_KEY_WRAP))
    server.wraps.set(admin.me, { enc: bytesToHex(base64urlDecode(forged.enc)), ct: bytesToHex(base64urlDecode(forged.ct)) })

    const volunteer = await device('volunteer', { manager: false })
    expect(await admin.hubKeys.distributeHubKey(HUB)).toBe(1)
    // The volunteer received the hub's REAL key: what the admin sealed before
    // the swap opens for them.
    const [readable] = await volunteer.roles.readableRoles([hubRole('role-a', sealed)])
    expect(readable).toMatchObject({ readable: true, displayName: 'Legal observer' })
  })

  it('a member with no registered device key is skipped, not sealed to some other key', { timeout: 60_000 }, async () => {
    const admin = await device('admin', { manager: true })
    await device('unregistered', { manager: false, registered: false })
    await admin.hubKeys.ensureHubKey(HUB)
    expect(await admin.hubKeys.distributeHubKey(HUB)).toBe(0)
    expect([...server.wraps.keys()]).toEqual([admin.me])
  })

  // ── Rotation on departure (PROTOCOL.md §2.7 "Key Rotation") ──────────────

  /** An admin and two volunteers sharing the hub key, and one sealed role name on the server. */
  async function hubWithSharedKey() {
    const admin = await device('admin', { manager: true })
    const staying = await device('staying', { manager: false })
    const departing = await device('departing', { manager: false })
    const sealed = await admin.roles.sealHubRoleField(HUB, 'Legal observer')
    server.roles.set('role-a', sealed)
    // The first key was wrapped for every member with a device key.
    expect([...server.wraps.keys()].sort()).toEqual([admin.me, staying.me, departing.me].sort())
    // Both volunteers' devices load the key, as they would on their next sync.
    expect(await staying.hubKeys.ensureHubKey(HUB)).toBe(true)
    expect(await departing.hubKeys.ensureHubKey(HUB)).toBe(true)
    return { admin, staying, departing, sealed }
  }

  it('a departure rotates the key: the leaver is not wrapped, and what the hub holds no longer opens for them', { timeout: 60_000 }, async () => {
    const { admin, staying, departing, sealed } = await hubWithSharedKey()

    server.remove(departing.me)
    expect(await admin.hubKeys.rotateHubKeyIfRequired(HUB)).toBe(true)

    expect(server.rotations).toBe(1)
    expect(server.epoch).toBe(1)
    expect(server.rotationDue).toBe(false)
    expect([...server.wraps.keys()].sort()).toEqual([admin.me, staying.me].sort())
    // The role name was re-sealed — and under a key the departed member's
    // device, which kept the OLD key in its CryptoState, cannot open.
    const resealed = server.roles.get('role-a')!
    expect(resealed).not.toBe(sealed)
    expect(await departing.platform.hasHubKey(HUB)).toBe(true)
    expect(await departing.platform.decryptHubField(HUB, resealed, 'llamenos:hub-role-encrypt:v1')).toBeNull()
    expect(await departing.platform.decryptHubField(HUB, sealed, 'llamenos:hub-role-encrypt:v1')).toBe('Legal observer')

    // The rotating admin holds the new key and reads the re-sealed name.
    const [adminView] = await admin.roles.readableRoles([hubRole('role-a', resealed)])
    expect(adminView).toMatchObject({ readable: true, displayName: 'Legal observer' })

    // A staying member's device, still on the old key, adopts the new one the
    // moment it meets a value sealed under it — and verifies it first.
    const [stayingView] = await staying.roles.readableRoles([hubRole('role-a', resealed)])
    expect(stayingView).toMatchObject({ readable: true, displayName: 'Legal observer' })
    expect(await staying.hubKeys.adoptHubKeyRotation(HUB)).toBe('current')

    // What anyone seals from now on is out of the departed member's reach.
    const later = await admin.roles.sealHubRoleField(HUB, 'Jail support coordinator')
    expect(await departing.platform.decryptHubField(HUB, later, 'llamenos:hub-role-encrypt:v1')).toBeNull()

    // And the departed member's own device drops the key once it asks: it is
    // no longer a member, so it has no key to hold.
    expect(await departing.hubKeys.adoptHubKeyRotation(HUB)).toBe('not-held')
    expect(await departing.platform.hasHubKey(HUB)).toBe(false)
  })

  it('without a departure there is nothing to rotate', { timeout: 60_000 }, async () => {
    const { admin } = await hubWithSharedKey()
    expect(await admin.hubKeys.rotateHubKeyIfRequired(HUB)).toBe(false)
    expect(server.rotations).toBe(0)
    expect(server.epoch).toBe(0)
  })

  it('a rotation the server fabricates is never adopted', { timeout: 60_000 }, async () => {
    const { staying, sealed } = await hubWithSharedKey()

    // The server "rotates" on its own: a key IT chose, wrapped to the member's
    // public key, and a statement it can only make up — it never held the old key.
    const { hpkeSealMock, base64urlDecode } = await import('../../../tests/mocks/hpke-mock')
    const { keyWrapAad } = await import('@shared/envelope-aad')
    const { LABEL_HUB_KEY_WRAP } = await import('@shared/crypto-labels')
    const { bytesToHex, randomBytes } = await import('@noble/hashes/utils.js')
    const forged = await hpkeSealMock(randomBytes(32), staying.encryptionPubkey, LABEL_HUB_KEY_WRAP, keyWrapAad(LABEL_HUB_KEY_WRAP))
    server.wraps.set(staying.me, { enc: bytesToHex(base64urlDecode(forged.enc)), ct: bytesToHex(base64urlDecode(forged.ct)) })
    server.epoch = 1
    server.rotation = { proof: bytesToHex(randomBytes(64)), check: bytesToHex(randomBytes(64)) }

    expect(await staying.hubKeys.adoptHubKeyRotation(HUB)).toBe('unverifiable')
    // The member keeps the hub's real key.
    const [view] = await staying.roles.readableRoles([hubRole('role-a', sealed)])
    expect(view).toMatchObject({ readable: true, displayName: 'Legal observer' })
  })

  it('a genuine statement paired with a server-chosen wrap is not adopted either', { timeout: 60_000 }, async () => {
    const { admin, staying, departing, sealed } = await hubWithSharedKey()
    server.remove(departing.me)
    expect(await admin.hubKeys.rotateHubKeyIfRequired(HUB)).toBe(true)

    // The proof opens under the member's old key, but the server hands the
    // member a wrap of a key of its own instead of the rotated-in one.
    const { hpkeSealMock, base64urlDecode } = await import('../../../tests/mocks/hpke-mock')
    const { keyWrapAad } = await import('@shared/envelope-aad')
    const { LABEL_HUB_KEY_WRAP } = await import('@shared/crypto-labels')
    const { bytesToHex, randomBytes } = await import('@noble/hashes/utils.js')
    const forged = await hpkeSealMock(randomBytes(32), staying.encryptionPubkey, LABEL_HUB_KEY_WRAP, keyWrapAad(LABEL_HUB_KEY_WRAP))
    server.wraps.set(staying.me, { enc: bytesToHex(base64urlDecode(forged.enc)), ct: bytesToHex(base64urlDecode(forged.ct)) })

    expect(await staying.hubKeys.adoptHubKeyRotation(HUB)).toBe('unverifiable')
    expect(await staying.platform.decryptHubField(HUB, sealed, 'llamenos:hub-role-encrypt:v1')).toBe('Legal observer')
  })

  it('a rotation that loses a race re-reads and completes', { timeout: 60_000 }, async () => {
    const { admin, departing } = await hubWithSharedKey()
    server.remove(departing.me)

    // Between the admin's read and its write, another member edits the role
    // name: the server refuses the stale re-seal, and the admin re-reads.
    const realRotate = server.rotate.bind(server)
    let first = true
    server.rotate = (caller, body, ApiError) => {
      if (first) {
        first = false
        server.roles.set('role-a', 'edited-meanwhile')
      }
      return realRotate(caller, body, ApiError)
    }
    expect(await admin.hubKeys.rotateHubKeyIfRequired(HUB)).toBe(true)
    expect(server.rotations).toBe(1)
    // The value that could not be opened under the old key is carried, not dropped.
    expect(server.roles.get('role-a')).toBe('edited-meanwhile')
  })

  it('a manager still holding a rotated-out key hands it to no one until it adopts the new one', { timeout: 60_000 }, async () => {
    const adminA = await device('admin-a', { manager: true })
    const adminB = await device('admin-b', { manager: true })
    const departing = await device('departing', { manager: false })
    server.roles.set('role-a', await adminA.roles.sealHubRoleField(HUB, 'Legal observer'))
    expect(await adminB.hubKeys.ensureHubKey(HUB)).toBe(true)
    expect(await departing.hubKeys.ensureHubKey(HUB)).toBe(true)

    server.remove(departing.me)
    // Nothing is distributed while the rotation is due — not even by the
    // manager who will rotate.
    const newcomer = await device('newcomer', { manager: false })
    expect(await adminA.hubKeys.distributeHubKey(HUB)).toBe(0)
    // The rotation wraps everyone who is a member now, the newcomer included.
    expect(await adminA.hubKeys.rotateHubKeyIfRequired(HUB)).toBe(true)
    expect([...server.wraps.keys()].sort()).toEqual([adminA.me, adminB.me, newcomer.me].sort())

    const late = await device('late', { manager: false })
    // adminB's device still holds the key the departed member knows: it must
    // not wrap that key for the late joiner.
    expect(await adminB.hubKeys.distributeHubKey(HUB)).toBe(0)
    expect(server.wraps.has(late.me)).toBe(false)
    expect(await adminB.hubKeys.rotateHubKeyIfRequired(HUB)).toBe(false)
    expect(server.rotations).toBe(1)

    expect(await adminB.hubKeys.adoptHubKeyRotation(HUB)).toBe('adopted')
    expect(await adminB.hubKeys.distributeHubKey(HUB)).toBe(1)
    const [view] = await late.roles.readableRoles([hubRole('role-a', server.roles.get('role-a')!)])
    expect(view).toMatchObject({ readable: true, displayName: 'Legal observer' })
  })

  it('a member still on the rotated-out key seals a new value under the NEW key, never the old one', { timeout: 60_000 }, async () => {
    const { admin, staying, departing } = await hubWithSharedKey()
    server.remove(departing.me)
    expect(await admin.hubKeys.rotateHubKeyIfRequired(HUB)).toBe(true)

    // The staying member's device has not synced since: it still holds the
    // key the departed member kept. Writing must not seal under it.
    const written = await staying.roles.sealHubRoleField(HUB, 'Street medic')
    expect(await departing.platform.decryptHubField(HUB, written, 'llamenos:hub-role-encrypt:v1')).toBeNull()
    const [view] = await admin.roles.readableRoles([hubRole('role-b', written)])
    expect(view).toMatchObject({ readable: true, displayName: 'Street medic' })
  })
})
