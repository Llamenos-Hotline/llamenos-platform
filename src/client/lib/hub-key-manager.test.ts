import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  HubKeyEnvelopeResponse,
  HubKeyEnvelopesBody,
  HubKeyRecipientsResponse,
  HubKeySetResponse,
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
 * the three hub-key routes with the same compare-and-set as
 * `SettingsService.setHubKeyEnvelopes`.
 */

type Invoke = <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>

const HUB = 'hub-1'

interface DeviceState { signingPubkeyHex: string; encryptionPubkeyHex: string }

interface Member { pubkey: string; encryptionPubkey: string | null; manager: boolean }

/** In-memory model of GET /key, GET /key/recipients and PUT /key. */
class FakeHubKeyServer {
  generation = 0
  wraps = new Map<string, { enc: string; ct: string }>()
  members = new Map<string, Member>()
  puts = 0

  join(member: Member) {
    this.members.set(member.pubkey, member)
  }

  getEnvelope(caller: string, ApiError: new (s: number, b: string) => Error): HubKeyEnvelopeResponse {
    if (!this.members.has(caller)) throw new ApiError(403, '{"error":"Access denied"}')
    const wrap = this.wraps.get(caller)
    if (!wrap) throw new ApiError(404, '{"error":"No key envelope for this user"}')
    return { envelope: { pubkey: caller, ...wrap } }
  }

  recipients(caller: string, ApiError: new (s: number, b: string) => Error): HubKeyRecipientsResponse {
    if (!this.members.get(caller)?.manager) throw new ApiError(403, '{"error":"Forbidden"}')
    return {
      generation: this.generation,
      envelopes: [...this.wraps].filter(([pk]) => this.members.has(pk)).map(([pubkey, w]) => ({ pubkey, ...w })),
      members: [...this.members.values()].map(m => ({ pubkey: m.pubkey, encryptionPubkey: m.encryptionPubkey })),
    }
  }

  put(caller: string, body: HubKeyEnvelopesBody, ApiError: new (s: number, b: string) => Error): HubKeySetResponse {
    if (!this.members.get(caller)?.manager) throw new ApiError(403, '{"error":"Forbidden"}')
    if (body.expectedGeneration !== this.generation) throw new ApiError(409, '{"error":"Hub key generation mismatch"}')
    this.puts++
    this.generation++
    this.wraps = new Map(body.envelopes.map(e => [e.pubkey, { enc: e.enc, ct: e.ct }]))
    return { ok: true, generation: this.generation }
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
  return { invoke, me, encryptionPubkey: state.encryptionPubkeyHex, hubKeys, roles, ApiError }
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
})
