/**
 * Extended unit tests for IdentityService covering methods not tested in identity-service.test.ts.
 * Targets: deleteUser, hub roles, invites CRUD, redeemInvite, sessions, WebAuthn credentials/challenges/settings,
 * devices (register/list/delete/cleanup/voip), createProvisionRoom.
 */
import { describe, it, expect, vi } from 'vitest'
import { IdentityService } from '@worker/services/identity'
import { createMockDb } from './mock-db'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUserRow(overrides: Record<string, unknown> = {}) {
  return {
    pubkey: 'pk-1',
    displayName: 'Alice',
    phone: '+15551234567',
    roles: ['role-volunteer'],
    hubRoles: [],
    active: true,
    encryptedSecretKey: 'enc-secret',
    transcriptionEnabled: true,
    spokenLanguages: ['en'],
    uiLanguage: 'en',
    profileCompleted: false,
    onBreak: false,
    callPreference: 'phone',
    supportedMessagingChannels: null,
    messagingEnabled: null,
    specializations: [],
    maxCaseAssignments: null,
    teamId: null,
    supervisorPubkey: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function makeInviteRow(overrides: Record<string, unknown> = {}) {
  return {
    code: 'invite-code-abc',
    name: 'Bob Volunteer',
    phone: '+15559876543',
    roleIds: ['role-volunteer'],
    hubId: 'hub-1',
    createdBy: 'admin-pk',
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days out
    usedAt: null,
    usedBy: null,
    ...overrides,
  }
}

/**
 * A transaction stand-in for redeemInvite, which issues, in order: the atomic
 * invite claim (UPDATE ... RETURNING), optionally the sole-active-hub lookup
 * (SELECT with explicit columns), the existing-user lookup (SELECT ... FOR
 * UPDATE), and then either an UPDATE of that user or an INSERT.
 *
 * It records the values written so the tests can assert on the hubRoles
 * actually persisted rather than on "some write happened".
 */
function makeRedeemTx(opts: {
  invite: Record<string, unknown> | null
  activeHubs?: Array<{ id: string }>
  existingUser?: Record<string, unknown> | null
  insertedUser?: Record<string, unknown> | null
  updatedUser?: Record<string, unknown> | null
}) {
  const updated: unknown[] = []
  const inserted: unknown[] = []
  // UPDATE #1 is the invite claim; UPDATE #2, if any, is the user merge.
  const updateReturns: unknown[][] = [
    opts.invite ? [opts.invite] : [],
    opts.updatedUser ? [opts.updatedUser] : [],
  ]
  const existingRows = opts.existingUser ? [opts.existingUser] : []

  const tx = {
    $updated: updated,
    $inserted: inserted,
    update: vi.fn(() => ({
      set: vi.fn((values: unknown) => {
        updated.push(values)
        return {
          where: vi.fn(() => ({
            returning: vi.fn(async () => updateReturns.shift() ?? []),
          })),
        }
      }),
    })),
    // Explicit columns ⇒ the hubs lookup; no columns ⇒ the users lookup.
    select: vi.fn((columns?: unknown) => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => (columns ? (opts.activeHubs ?? []) : existingRows)),
          for: vi.fn(() => ({ limit: vi.fn(async () => existingRows) })),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((values: unknown) => {
        inserted.push(values)
        return {
          onConflictDoNothing: vi.fn(() => ({
            returning: vi.fn(async () => (opts.insertedUser ? [opts.insertedUser] : [])),
          })),
        }
      }),
    })),
  }
  return tx
}

function makeSessionRow(overrides: Record<string, unknown> = {}) {
  return {
    token: 'tok-abc123',
    pubkey: 'pk-1',
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000), // 8h from now
    ...overrides,
  }
}

function makeWebAuthnCredRow(overrides: Record<string, unknown> = {}) {
  return {
    credentialId: 'cred-1',
    pubkey: 'pk-1',
    publicKey: 'pub-key-bytes',
    counter: 0,
    transports: ['usb'],
    backedUp: false,
    label: 'My YubiKey',
    createdAt: new Date(),
    lastUsedAt: null,
    ...overrides,
  }
}

function makeChallengeRow(overrides: Record<string, unknown> = {}) {
  return {
    challengeId: 'challenge-1',
    challenge: 'random-challenge-bytes',
    pubkey: null,
    allowedCredIds: null,
    createdAt: new Date(),
    ...overrides,
  }
}

function makeDeviceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'device-1',
    pubkey: 'pk-1',
    platform: 'ios',
    pushToken: 'push-tok-1',
    voipToken: null,
    wakeKeyPublic: 'wake-key-pub',
    ed25519Pubkey: null,
    x25519Pubkey: null,
    registeredAt: new Date(),
    lastSeenAt: new Date(),
    ...overrides,
  }
}

function setup() {
  const { db } = createMockDb()
  // setHubRole/removeHubRole use db.transaction() for row locking
  ;(db as any).transaction = vi.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(db))
  const service = new IdentityService(db as any)
  return { db, service }
}

// ---------------------------------------------------------------------------
// deleteUser
// ---------------------------------------------------------------------------

describe('IdentityService.deleteUser', () => {
  it('calls db.delete for the given pubkey', async () => {
    const { db, service } = setup()

    await service.deleteUser('pk-1')
    expect(db.delete).toHaveBeenCalled()
  })

  it('resolves without error (no existence check)', async () => {
    const { service } = setup()
    await expect(service.deleteUser('nonexistent')).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// setHubRole / removeHubRole
// ---------------------------------------------------------------------------

describe('IdentityService.setHubRole', () => {
  it('throws 404 when user not found', async () => {
    const { db, service } = setup()
    db.$setSelectResult([]) // getUserInternal returns null

    await expect(
      service.setHubRole({ pubkey: 'pk-1', hubId: 'hub-1', roleIds: ['role-admin'] }),
    ).rejects.toMatchObject({ status: 404 })
  })

  it('adds new hub role when not yet present', async () => {
    const { db, service } = setup()
    const user = makeUserRow({ hubRoles: [] })
    db.$setSelectResult([user])
    db.$setUpdateResult([{ ...user, hubRoles: [{ hubId: 'hub-1', roleIds: ['role-admin'] }] }])

    const result = await service.setHubRole({ pubkey: 'pk-1', hubId: 'hub-1', roleIds: ['role-admin'] })
    expect(result.volunteer.hubRoles).toHaveLength(1)
    expect(result.volunteer.hubRoles![0].hubId).toBe('hub-1')
    expect(db.update).toHaveBeenCalled()
  })

  it('updates existing hub role when hub already present', async () => {
    const { db, service } = setup()
    const user = makeUserRow({ hubRoles: [{ hubId: 'hub-1', roleIds: ['role-volunteer'] }] })
    db.$setSelectResult([user])
    db.$setUpdateResult([{ ...user, hubRoles: [{ hubId: 'hub-1', roleIds: ['role-admin'] }] }])

    const result = await service.setHubRole({ pubkey: 'pk-1', hubId: 'hub-1', roleIds: ['role-admin'] })
    expect(result.volunteer.hubRoles![0].roleIds).toEqual(['role-admin'])
  })
})

describe('IdentityService.removeHubRole', () => {
  it('throws 404 when user not found', async () => {
    const { db, service } = setup()
    db.$setSelectResult([])

    await expect(
      service.removeHubRole({ pubkey: 'pk-1', hubId: 'hub-1' }),
    ).rejects.toMatchObject({ status: 404 })
  })

  it('removes hub role from user', async () => {
    const { db, service } = setup()
    const user = makeUserRow({ hubRoles: [{ hubId: 'hub-1', roleIds: ['role-volunteer'] }, { hubId: 'hub-2', roleIds: ['role-admin'] }] })
    db.$setSelectResult([user])
    db.$setUpdateResult([{ ...user, hubRoles: [{ hubId: 'hub-2', roleIds: ['role-admin'] }] }])

    const result = await service.removeHubRole({ pubkey: 'pk-1', hubId: 'hub-1' })
    expect(result.volunteer.hubRoles).toHaveLength(1)
    expect(result.volunteer.hubRoles![0].hubId).toBe('hub-2')
  })

  it('is idempotent when hub not in hubRoles', async () => {
    const { db, service } = setup()
    const user = makeUserRow({ hubRoles: [] })
    db.$setSelectResult([user])
    db.$setUpdateResult([user])

    const result = await service.removeHubRole({ pubkey: 'pk-1', hubId: 'nonexistent-hub' })
    expect(result.volunteer.hubRoles).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// getInvites
// ---------------------------------------------------------------------------

describe('IdentityService.getInvites', () => {
  it('returns empty array when no invites', async () => {
    const { db, service } = setup()
    db.$setSelectResult([])

    const result = await service.getInvites()
    expect(result.invites).toEqual([])
  })

  it('returns unredeemed invites mapped to InviteCode shape', async () => {
    const { db, service } = setup()
    db.$setSelectResult([makeInviteRow()])

    const result = await service.getInvites()
    expect(result.invites).toHaveLength(1)
    expect(result.invites[0].code).toBe('invite-code-abc')
    expect(result.invites[0].name).toBe('Bob Volunteer')
    expect(typeof result.invites[0].createdAt).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// createInvite
// ---------------------------------------------------------------------------

describe('IdentityService.createInvite', () => {
  it('creates an invite and returns it', async () => {
    const { db, service } = setup()
    const now = new Date()
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
    db.$setInsertResult([makeInviteRow({ createdAt: now, expiresAt })])

    const result = await service.createInvite({
      name: 'Charlie',
      phone: '+15550001111',
      roleIds: ['role-volunteer'],
      hubId: 'hub-1',
      createdBy: 'admin-pk',
    })
    expect(result.invite.name).toBe('Bob Volunteer') // from mock row
    expect(db.insert).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// validateInvite
// ---------------------------------------------------------------------------

describe('IdentityService.validateInvite', () => {
  it('returns valid: false when code not found', async () => {
    const { db, service } = setup()
    db.$setSelectResult([])

    const result = await service.validateInvite('nonexistent')
    expect(result.valid).toBe(false)
    expect(result.error).toBe('not_found')
  })

  it('returns valid: false when already used', async () => {
    const { db, service } = setup()
    db.$setSelectResult([makeInviteRow({ usedAt: new Date() })])

    const result = await service.validateInvite('invite-code-abc')
    expect(result.valid).toBe(false)
    expect(result.error).toBe('already_used')
  })

  it('returns valid: false when expired', async () => {
    const { db, service } = setup()
    db.$setSelectResult([makeInviteRow({ expiresAt: new Date(Date.now() - 1000) })])

    const result = await service.validateInvite('invite-code-abc')
    expect(result.valid).toBe(false)
    expect(result.error).toBe('expired')
  })

  it('returns valid: true with name and roleIds when valid', async () => {
    const { db, service } = setup()
    db.$setSelectResult([makeInviteRow()])

    const result = await service.validateInvite('invite-code-abc')
    expect(result.valid).toBe(true)
    expect(result.name).toBe('Bob Volunteer')
    expect(result.roleIds).toEqual(['role-volunteer'])
  })
})

// ---------------------------------------------------------------------------
// redeemInvite (transaction)
// ---------------------------------------------------------------------------

describe('IdentityService.redeemInvite', () => {
  it('throws 400 when invite not found', async () => {
    const { db, service } = setup()

    // RACE-01: Atomic claim — UPDATE...WHERE(usedAt IS NULL)...RETURNING
    const tx = {
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
      insert: vi.fn(),
    }
    ;(db as any).transaction = vi.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(tx))

    await expect(
      service.redeemInvite({ code: 'bad-code', pubkey: 'pk-new' }),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('throws 400 when invite already used', async () => {
    const { db, service } = setup()

    // RACE-01: Atomic claim returns empty (usedAt IS NULL check fails for used invite)
    const tx = {
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
      insert: vi.fn(),
    }
    ;(db as any).transaction = vi.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(tx))

    await expect(
      service.redeemInvite({ code: 'invite-code-abc', pubkey: 'pk-new' }),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('creates the user AND grants membership of the invite\'s hub', async () => {
    // The grant is the whole point of #1037: without a hubRoles entry the
    // redeemed volunteer is filtered out of GET /hubs/:hubId/users, so the
    // operator cannot see, schedule, or ring them.
    const { db, service } = setup()
    const invite = makeInviteRow({ hubId: 'hub-7', roleIds: ['role-volunteer'] })
    const tx = makeRedeemTx({
      invite,
      insertedUser: makeUserRow({
        pubkey: 'pk-new',
        displayName: invite.name,
        hubRoles: [{ hubId: 'hub-7', roleIds: ['role-volunteer'] }],
      }),
    })
    ;(db as any).transaction = vi.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(tx))

    const result = await service.redeemInvite({ code: 'invite-code-abc', pubkey: 'pk-new' })
    expect(result.volunteer.pubkey).toBe('pk-new')
    expect(tx.$inserted[0]).toMatchObject({
      pubkey: 'pk-new',
      roles: ['role-volunteer'],
      hubRoles: [{ hubId: 'hub-7', roleIds: ['role-volunteer'] }],
    })
  })

  it('grants no role when the invite names none, but still grants membership', async () => {
    // An invite whose roleIds are empty is one where neither the inviter nor
    // the hub's template named a role. The old code substituted a hardcoded
    // `role-volunteer` — call-answering permission nobody asked for.
    const { db, service } = setup()
    const tx = makeRedeemTx({
      invite: makeInviteRow({ hubId: 'hub-7', roleIds: [] }),
      insertedUser: makeUserRow({ pubkey: 'pk-new', roles: [], hubRoles: [{ hubId: 'hub-7', roleIds: [] }] }),
    })
    ;(db as any).transaction = vi.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(tx))

    await service.redeemInvite({ code: 'invite-code-abc', pubkey: 'pk-new' })
    expect(tx.$inserted[0]).toMatchObject({
      roles: [],
      hubRoles: [{ hubId: 'hub-7', roleIds: [] }],
    })
  })

  it('falls back to the sole active hub for an invite that carries none', async () => {
    const { db, service } = setup()
    const tx = makeRedeemTx({
      invite: makeInviteRow({ hubId: null }),
      activeHubs: [{ id: 'hub-only' }],
      insertedUser: makeUserRow({ pubkey: 'pk-new' }),
    })
    ;(db as any).transaction = vi.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(tx))

    await service.redeemInvite({ code: 'invite-code-abc', pubkey: 'pk-new' })
    expect(tx.$inserted[0]).toMatchObject({ hubRoles: [{ hubId: 'hub-only', roleIds: ['role-volunteer'] }] })
  })

  it('creates no hub membership when the hub is ambiguous', async () => {
    const { db, service } = setup()
    const tx = makeRedeemTx({
      invite: makeInviteRow({ hubId: null }),
      activeHubs: [{ id: 'hub-a' }, { id: 'hub-b' }],
      insertedUser: makeUserRow({ pubkey: 'pk-new' }),
    })
    ;(db as any).transaction = vi.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(tx))

    await service.redeemInvite({ code: 'invite-code-abc', pubkey: 'pk-new' })
    expect(tx.$inserted[0]).not.toHaveProperty('hubRoles')
  })

  it('merges the grant into an existing user\'s hubRoles instead of rejecting them', async () => {
    // A person invited into a SECOND hub must not be refused for existing.
    const { db, service } = setup()
    const existing = makeUserRow({
      pubkey: 'pk-existing',
      roles: ['role-volunteer'],
      hubRoles: [{ hubId: 'hub-1', roleIds: ['role-volunteer'] }],
    })
    const tx = makeRedeemTx({
      invite: makeInviteRow({ hubId: 'hub-2', roleIds: ['role-reviewer'] }),
      existingUser: existing,
      updatedUser: makeUserRow({
        pubkey: 'pk-existing',
        hubRoles: [
          { hubId: 'hub-1', roleIds: ['role-volunteer'] },
          { hubId: 'hub-2', roleIds: ['role-reviewer'] },
        ],
      }),
    })
    ;(db as any).transaction = vi.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(tx))

    const result = await service.redeemInvite({ code: 'invite-code-abc', pubkey: 'pk-existing' })
    expect(result.volunteer.pubkey).toBe('pk-existing')
    expect(tx.insert).not.toHaveBeenCalled()
    // The first hub survives, the second is added, and the global roles and
    // identity fields are untouched.
    expect(tx.$updated[1]).toMatchObject({
      hubRoles: [
        { hubId: 'hub-1', roleIds: ['role-volunteer'] },
        { hubId: 'hub-2', roleIds: ['role-reviewer'] },
      ],
    })
    expect(tx.$updated[1]).not.toHaveProperty('roles')
    expect(tx.$updated[1]).not.toHaveProperty('active')
  })

  it('unions roles when the existing user is re-invited to a hub they are already in', async () => {
    const { db, service } = setup()
    const tx = makeRedeemTx({
      invite: makeInviteRow({ hubId: 'hub-1', roleIds: ['role-reviewer'] }),
      existingUser: makeUserRow({
        pubkey: 'pk-existing',
        hubRoles: [{ hubId: 'hub-1', roleIds: ['role-volunteer'] }],
      }),
      updatedUser: makeUserRow({ pubkey: 'pk-existing' }),
    })
    ;(db as any).transaction = vi.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(tx))

    await service.redeemInvite({ code: 'invite-code-abc', pubkey: 'pk-existing' })
    expect(tx.$updated[1]).toMatchObject({
      hubRoles: [{ hubId: 'hub-1', roleIds: ['role-volunteer', 'role-reviewer'] }],
    })
  })

  it('throws 409 when the pubkey exists and there is no hub to merge into', async () => {
    const { db, service } = setup()
    const tx = makeRedeemTx({
      invite: makeInviteRow({ hubId: null }),
      activeHubs: [],
      existingUser: makeUserRow({ pubkey: 'pk-existing' }),
    })
    ;(db as any).transaction = vi.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(tx))

    await expect(
      service.redeemInvite({ code: 'invite-code-abc', pubkey: 'pk-existing' }),
    ).rejects.toMatchObject({ status: 409 })
  })

  it('throws 409 (not an unhandled duplicate-key error) when a concurrent insert wins', async () => {
    // The SELECT cannot lock a row that does not exist yet, so ON CONFLICT DO
    // NOTHING is still the guard against a racing redemption.
    const { db, service } = setup()
    const tx = makeRedeemTx({
      invite: makeInviteRow(),
      insertedUser: null,
    })
    ;(db as any).transaction = vi.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(tx))

    await expect(
      service.redeemInvite({ code: 'invite-code-abc', pubkey: 'pk-new' }),
    ).rejects.toMatchObject({ status: 409 })
  })
})

// ---------------------------------------------------------------------------
// revokeInvite
// ---------------------------------------------------------------------------

describe('IdentityService.revokeInvite', () => {
  it('deletes the invite code', async () => {
    const { db, service } = setup()

    await service.revokeInvite('invite-code-abc')
    expect(db.delete).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// createSession
// ---------------------------------------------------------------------------

describe('IdentityService.createSession', () => {
  it('creates a session with 8h expiry', async () => {
    const { db, service } = setup()
    db.$setInsertResult([makeSessionRow()])

    const result = await service.createSession('pk-1')
    expect(result.token).toBeDefined()
    expect(result.pubkey).toBe('pk-1')
    expect(db.insert).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// revokeSession / revokeAllSessions
// ---------------------------------------------------------------------------

describe('IdentityService.revokeSession', () => {
  it('calls db.delete for the session token', async () => {
    const { db, service } = setup()

    await service.revokeSession('tok-abc123')
    expect(db.delete).toHaveBeenCalled()
  })
})

describe('IdentityService.revokeAllSessions', () => {
  it('deletes all sessions for a pubkey', async () => {
    const { db, service } = setup()
    db.$setDeleteResult([{ token: 'tok-1' }, { token: 'tok-2' }])

    const result = await service.revokeAllSessions('pk-1')
    expect(result.revoked).toBe(2)
    expect(db.delete).toHaveBeenCalled()
  })

  it('returns 0 when no sessions to revoke', async () => {
    const { db, service } = setup()
    db.$setDeleteResult([])

    const result = await service.revokeAllSessions('pk-1')
    expect(result.revoked).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// WebAuthn Credentials
// ---------------------------------------------------------------------------

describe('IdentityService.getWebAuthnCredentials', () => {
  it('returns empty array when no credentials', async () => {
    const { db, service } = setup()
    db.$setSelectResult([])

    const result = await service.getWebAuthnCredentials('pk-1')
    expect(result.credentials).toEqual([])
  })

  it('maps DB rows to WebAuthnCredential shape', async () => {
    const { db, service } = setup()
    db.$setSelectResult([makeWebAuthnCredRow()])

    const result = await service.getWebAuthnCredentials('pk-1')
    expect(result.credentials).toHaveLength(1)
    expect(result.credentials[0].id).toBe('cred-1')
    expect(result.credentials[0].label).toBe('My YubiKey')
  })
})

describe('IdentityService.addWebAuthnCredential', () => {
  it('inserts credential into DB', async () => {
    const { db, service } = setup()

    await service.addWebAuthnCredential('pk-1', {
      id: 'cred-new',
      publicKey: 'pub-key',
      counter: 0,
      transports: ['ble'],
      backedUp: false,
      label: 'New Key',
      createdAt: new Date().toISOString(),
      lastUsedAt: '',
    })
    expect(db.insert).toHaveBeenCalled()
  })
})

describe('IdentityService.deleteWebAuthnCredential', () => {
  it('throws 404 when credential not found', async () => {
    const { db, service } = setup()
    db.$setDeleteResult([])

    await expect(
      service.deleteWebAuthnCredential('pk-1', 'nonexistent-cred'),
    ).rejects.toMatchObject({ status: 404 })
  })

  it('deletes credential when found', async () => {
    const { db, service } = setup()
    db.$setDeleteResult([{ credentialId: 'cred-1' }])

    await expect(service.deleteWebAuthnCredential('pk-1', 'cred-1')).resolves.toBeUndefined()
    expect(db.delete).toHaveBeenCalled()
  })
})

describe('IdentityService.updateWebAuthnCounter', () => {
  it('throws 404 when credential not found', async () => {
    const { db, service } = setup()
    db.$setUpdateResult([])

    await expect(
      service.updateWebAuthnCounter({
        pubkey: 'pk-1',
        credId: 'nonexistent',
        counter: 5,
        lastUsedAt: new Date().toISOString(),
      }),
    ).rejects.toMatchObject({ status: 404 })
  })

  it('updates counter and lastUsedAt', async () => {
    const { db, service } = setup()
    db.$setUpdateResult([{ credentialId: 'cred-1' }])

    await expect(
      service.updateWebAuthnCounter({
        pubkey: 'pk-1',
        credId: 'cred-1',
        counter: 10,
        lastUsedAt: new Date().toISOString(),
      }),
    ).resolves.toBeUndefined()
    expect(db.update).toHaveBeenCalled()
  })
})

describe('IdentityService.getAllWebAuthnCredentials', () => {
  it('returns all credentials with ownerPubkey', async () => {
    const { db, service } = setup()
    db.$setSelectResult([makeWebAuthnCredRow()])

    const result = await service.getAllWebAuthnCredentials()
    expect(result.credentials).toHaveLength(1)
    expect(result.credentials[0].ownerPubkey).toBe('pk-1')
    expect(result.credentials[0].id).toBe('cred-1')
  })
})

// ---------------------------------------------------------------------------
// WebAuthn Challenges
// ---------------------------------------------------------------------------

describe('IdentityService.storeWebAuthnChallenge', () => {
  it('inserts challenge into DB', async () => {
    const { db, service } = setup()

    await service.storeWebAuthnChallenge('challenge-id', 'challenge-bytes')
    expect(db.insert).toHaveBeenCalled()
  })
})

describe('IdentityService.getWebAuthnChallenge', () => {
  it('throws 404 when challenge not found', async () => {
    const { db, service } = setup()
    // Atomic delete returns empty (no valid challenge found)
    db.$setDeleteResult([])
    // Stale lookup also returns empty
    db.$setSelectResult([])

    await expect(
      service.getWebAuthnChallenge('nonexistent'),
    ).rejects.toMatchObject({ status: 404 })
  })

  it('throws 410 when challenge is expired', async () => {
    const { db, service } = setup()
    const oldDate = new Date(Date.now() - 10 * 60 * 1000) // 10 min ago
    // Atomic delete returns empty (challenge is expired, gt check fails)
    db.$setDeleteResult([])
    // Stale lookup finds the expired row
    db.$setSelectResult([makeChallengeRow({ createdAt: oldDate })])

    await expect(
      service.getWebAuthnChallenge('challenge-1'),
    ).rejects.toMatchObject({ status: 410 })
  })

  it('returns challenge and deletes it atomically (one-time use)', async () => {
    const { db, service } = setup()
    // Atomic DELETE...RETURNING succeeds with the valid challenge
    db.$setDeleteResult([makeChallengeRow()])

    const result = await service.getWebAuthnChallenge('challenge-1')
    expect(result.challenge).toBe('random-challenge-bytes')
    expect(db.delete).toHaveBeenCalled() // consumed atomically
  })
})

// ---------------------------------------------------------------------------
// WebAuthn Settings
// ---------------------------------------------------------------------------

describe('IdentityService.getWebAuthnSettings', () => {
  it('returns defaults when settings are null', async () => {
    const { db, service } = setup()
    db.$setSelectResult([{ webauthnSettings: null }])

    const result = await service.getWebAuthnSettings()
    expect(result.requireForAdmins).toBe(false)
    expect(result.requireForUsers).toBe(false)
  })

  it('returns stored settings', async () => {
    const { db, service } = setup()
    db.$setSelectResult([{ webauthnSettings: { requireForAdmins: true, requireForUsers: false } }])

    const result = await service.getWebAuthnSettings()
    expect(result.requireForAdmins).toBe(true)
  })
})

describe('IdentityService.updateWebAuthnSettings', () => {
  it('merges with existing and calls db.update', async () => {
    const { db, service } = setup()
    // getWebAuthnSettings call
    db.$setSelectResult([{ webauthnSettings: { requireForAdmins: false, requireForUsers: false } }])

    const result = await service.updateWebAuthnSettings({ requireForAdmins: true })
    expect(result.requireForAdmins).toBe(true)
    expect(result.requireForUsers).toBe(false)
    expect(db.update).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Device management
// ---------------------------------------------------------------------------

describe('IdentityService.getDevices', () => {
  it('returns empty array when no devices', async () => {
    const { db, service } = setup()
    db.$setSelectResult([])

    const result = await service.getDevices('pk-1')
    expect(result.devices).toEqual([])
  })

  it('maps device rows to DeviceRecord shape', async () => {
    const { db, service } = setup()
    db.$setSelectResult([makeDeviceRow()])

    const result = await service.getDevices('pk-1')
    expect(result.devices).toHaveLength(1)
    expect(result.devices[0].platform).toBe('ios')
    expect(result.devices[0].pushToken).toBe('push-tok-1')
  })
})

describe('IdentityService.listDevices', () => {
  it('returns raw device rows for a pubkey', async () => {
    const { db, service } = setup()
    db.$setSelectResult([makeDeviceRow()])

    const result = await service.listDevices('pk-1')
    expect(result).toHaveLength(1)
    expect(result[0].platform).toBe('ios')
  })
})

describe('IdentityService.deleteDeviceById', () => {
  it('returns false when device not found', async () => {
    const { db, service } = setup()
    db.$setDeleteResult([])

    const result = await service.deleteDeviceById('pk-1', 'nonexistent')
    expect(result).toBe(false)
  })

  it('returns true when device deleted', async () => {
    const { db, service } = setup()
    db.$setDeleteResult([{ id: 'device-1' }])

    const result = await service.deleteDeviceById('pk-1', 'device-1')
    expect(result).toBe(true)
    expect(db.delete).toHaveBeenCalled()
  })
})

describe('IdentityService.cleanupDevices', () => {
  it('returns removed: 0 for empty tokens array', async () => {
    const { service } = setup()

    const result = await service.cleanupDevices('pk-1', [])
    expect(result.removed).toBe(0)
  })

  it('deletes matching devices and returns count', async () => {
    const { db, service } = setup()
    db.$setDeleteResult([{ id: 'device-1' }, { id: 'device-2' }])

    const result = await service.cleanupDevices('pk-1', ['push-tok-1', 'push-tok-2'])
    expect(result.removed).toBe(2)
    expect(db.delete).toHaveBeenCalled()
  })
})

describe('IdentityService.deleteAllDevices', () => {
  it('calls db.delete for the pubkey', async () => {
    const { db, service } = setup()

    await service.deleteAllDevices('pk-1')
    expect(db.delete).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// VoIP tokens
// ---------------------------------------------------------------------------

describe('IdentityService.registerVoipToken', () => {
  it('updates existing device when found', async () => {
    const { db, service } = setup()
    db.$setSelectResult([makeDeviceRow()])

    await service.registerVoipToken('pk-1', { platform: 'ios', voipToken: 'voip-tok-1' })
    expect(db.update).toHaveBeenCalled()
  })

  it('creates new device when none exists', async () => {
    const { db, service } = setup()
    db.$setSelectResult([]) // no existing device

    await service.registerVoipToken('pk-1', { platform: 'ios', voipToken: 'voip-tok-1' })
    expect(db.insert).toHaveBeenCalled()
  })
})

describe('IdentityService.getVoipTokens', () => {
  it('returns empty array for empty pubkeys', async () => {
    const { service } = setup()

    const result = await service.getVoipTokens([])
    expect(result.devices).toEqual([])
  })

  it('returns devices with voip tokens', async () => {
    const { db, service } = setup()
    db.$setSelectResult([
      { pubkey: 'pk-1', platform: 'ios', voipToken: 'voip-tok-1' },
      { pubkey: 'pk-2', platform: 'android', voipToken: 'voip-tok-2' },
    ])

    const result = await service.getVoipTokens(['pk-1', 'pk-2'])
    expect(result.devices).toHaveLength(2)
    expect(result.devices[0].voipToken).toBe('voip-tok-1')
  })

  it('filters out devices with null voip token', async () => {
    const { db, service } = setup()
    db.$setSelectResult([
      { pubkey: 'pk-1', platform: 'ios', voipToken: null },
    ])

    const result = await service.getVoipTokens(['pk-1'])
    expect(result.devices).toHaveLength(0)
  })
})

describe('IdentityService.deleteVoipToken', () => {
  it('sets voipToken to null for all devices of a pubkey', async () => {
    const { db, service } = setup()

    await service.deleteVoipToken('pk-1')
    expect(db.update).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// createProvisionRoom
// ---------------------------------------------------------------------------

describe('IdentityService.createProvisionRoom', () => {
  it('creates a provision room and returns roomId + token', async () => {
    const { db, service } = setup()

    const result = await service.createProvisionRoom('ephemeral-pubkey')
    expect(result.roomId).toBeDefined()
    expect(result.token).toBeDefined()
    expect(result.roomId.length).toBeGreaterThan(0)
    expect(result.token.length).toBeGreaterThan(0)
    expect(db.insert).toHaveBeenCalled()
  })

  it('generates unique roomId and token on each call', async () => {
    const { service } = setup()

    const r1 = await service.createProvisionRoom('key-1')
    const r2 = await service.createProvisionRoom('key-2')
    expect(r1.roomId).not.toBe(r2.roomId)
    expect(r1.token).not.toBe(r2.token)
  })
})

// ---------------------------------------------------------------------------
// validateSession (sliding expiry edge case)
// ---------------------------------------------------------------------------

describe('IdentityService.validateSession - sliding expiry', () => {
  it('renews session when remaining time < 1 hour', async () => {
    const { db, service } = setup()
    // Session expiring in 30 minutes (< 1h threshold)
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000)
    const sessionRow = makeSessionRow({ expiresAt })
    db.$setSelectResult([sessionRow])
    // RACE-06: atomic update with .returning() needs a result to confirm renewal
    db.$setUpdateResult([sessionRow])

    const result = await service.validateSession('tok-abc123')
    // Should have extended the expiry
    expect(db.update).toHaveBeenCalled()
    const newExpiry = new Date(result.expiresAt).getTime()
    expect(newExpiry).toBeGreaterThan(expiresAt.getTime())
  })

  it('does not renew when remaining time > 1 hour', async () => {
    const { db, service } = setup()
    // Session expiring in 7 hours (> 1h threshold)
    const expiresAt = new Date(Date.now() + 7 * 60 * 60 * 1000)
    db.$setSelectResult([makeSessionRow({ expiresAt })])

    await service.validateSession('tok-abc123')
    expect(db.update).not.toHaveBeenCalled()
  })

  it('throws 401 when session expired', async () => {
    const { db, service } = setup()
    db.$setSelectResult([makeSessionRow({ expiresAt: new Date(Date.now() - 1000) })])

    await expect(service.validateSession('tok-abc123')).rejects.toMatchObject({ status: 401 })
  })
})

// ---------------------------------------------------------------------------
// IdentityService.cleanup
// ---------------------------------------------------------------------------

describe('IdentityService.cleanup', () => {
  it('returns zero counts when nothing is expired', async () => {
    const { db, service } = setup()
    db.$setDeleteResult([])

    const result = await service.cleanup()

    expect(result.expiredSessions).toBe(0)
    expect(result.expiredChallenges).toBe(0)
    expect(result.expiredProvisionRooms).toBe(0)
    expect(result.expiredInvites).toBe(0)
  })

  it('counts deleted sessions', async () => {
    const { db, service } = setup()
    // delete is called 4 times (sessions, challenges, rooms, redeemed invites, expired invites)
    // mock-db uses a single _deleteResult for all calls
    db.$setDeleteResult([{ token: 'tok-1' }, { token: 'tok-2' }])

    const result = await service.cleanup()

    expect(result.expiredSessions).toBe(2)
  })

  it('counts deleted challenges', async () => {
    const { db, service } = setup()
    db.$setDeleteResult([{ challengeId: 'ch-1' }])

    const result = await service.cleanup()

    // expiredChallenges uses the same delete mock result as all deletes
    expect(result.expiredChallenges).toBe(1)
  })

  it('returns all four cleanup counts', async () => {
    const { db, service } = setup()
    db.$setDeleteResult([{ id: 'row-1' }])

    const result = await service.cleanup()

    expect(typeof result.expiredSessions).toBe('number')
    expect(typeof result.expiredChallenges).toBe('number')
    expect(typeof result.expiredProvisionRooms).toBe('number')
    expect(typeof result.expiredInvites).toBe('number')
  })

  it('calls delete for sessions, challenges, provision rooms, and invites', async () => {
    const { db, service } = setup()
    db.$setDeleteResult([])

    await service.cleanup()

    // delete should be called 6 times: sessions, challenges, rooms, redeemed invites, expired invites, auth nonces
    expect(db.delete).toHaveBeenCalledTimes(6)
  })

  it('rethrows database errors', async () => {
    const { db, service } = setup()
    db.delete = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockRejectedValue(new Error('DB gone')),
      }),
    })

    await expect(service.cleanup()).rejects.toThrow('DB gone')
  })
})
