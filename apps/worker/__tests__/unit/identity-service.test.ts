import { describe, it, expect, vi } from 'vitest'
import { IdentityService } from '../../services/identity'
import { ServiceError } from '../../services/settings'

// ---------------------------------------------------------------------------
// DB row factory
// ---------------------------------------------------------------------------

function makeUserRow(overrides: Partial<{
  pubkey: string
  displayName: string
  phone: string
  roles: string[]
  hubRoles: unknown
  active: boolean
  createdAt: Date
  updatedAt: Date
  encryptedSecretKey: string
  transcriptionEnabled: boolean
  spokenLanguages: string[]
  uiLanguage: string
  profileCompleted: boolean
  onBreak: boolean
  callPreference: string
  supportedMessagingChannels: unknown
  messagingEnabled: boolean
  specializations: string[]
  maxCaseAssignments: number | null
  teamId: string | null
  supervisorPubkey: string | null
}> = {}) {
  return {
    pubkey: 'pk-default',
    displayName: 'Test User',
    phone: '+15551234567',
    roles: ['role-volunteer'],
    hubRoles: [],
    active: true,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    encryptedSecretKey: 'enc-key',
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
    ...overrides,
  }
}

function makeInviteRow(overrides: Partial<{
  code: string
  name: string
  phone: string
  roleIds: string[]
  createdBy: string
  createdAt: Date
  expiresAt: Date
  usedAt: Date | null
  usedBy: string | null
}> = {}) {
  return {
    code: 'inv-1',
    name: 'Invited Person',
    phone: '+15559999999',
    roleIds: ['role-volunteer'],
    createdBy: 'admin-pk',
    createdAt: new Date('2026-01-01'),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    usedAt: null,
    usedBy: null,
    ...overrides,
  }
}

function makeSessionRow(overrides: Partial<{
  token: string
  pubkey: string
  createdAt: Date
  expiresAt: Date
}> = {}) {
  return {
    token: 'session-token-abc',
    pubkey: 'pk-1',
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000), // 8h from now
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Admin Bootstrap
// ---------------------------------------------------------------------------

describe('IdentityService — Admin Bootstrap', () => {
  describe('hasAdmin', () => {
    it('returns false when no super-admin exists', async () => {
      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      }
      const svc = new IdentityService(db as never)
      const result = await svc.hasAdmin()
      expect(result).toEqual({ hasAdmin: false })
    })

    it('returns true when active super-admin exists', async () => {
      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ pubkey: 'admin-pk' }]),
            }),
          }),
        }),
      }
      const svc = new IdentityService(db as never)
      const result = await svc.hasAdmin()
      expect(result).toEqual({ hasAdmin: true })
    })
  })

  describe('bootstrapAdmin', () => {
    it('creates admin when none exists', async () => {
      const insertValues = vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
      })

      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
        insert: vi.fn().mockReturnValue({
          values: insertValues,
        }),
      }

      const svc = new IdentityService(db as never)
      await svc.bootstrapAdmin('new-admin-pk')

      expect(insertValues).toHaveBeenCalled()
      const vals = insertValues.mock.calls[0][0]
      expect(vals.pubkey).toBe('new-admin-pk')
      expect(vals.roles).toEqual(['role-super-admin'])
      expect(vals.active).toBe(true)
    })

    it('throws 403 when admin already exists', async () => {
      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ pubkey: 'existing-admin' }]),
            }),
          }),
        }),
      }

      const svc = new IdentityService(db as never)
      await expect(svc.bootstrapAdmin('new-pk')).rejects.toThrow('Admin already exists')
    })
  })
})

// ---------------------------------------------------------------------------
// User CRUD
// ---------------------------------------------------------------------------

describe('IdentityService — User CRUD', () => {
  describe('getUsers', () => {
    it('strips encryptedSecretKey from returned users', async () => {
      const row = makeUserRow({ pubkey: 'pk-1', encryptedSecretKey: 'SENSITIVE' })
      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockResolvedValue([row]),
        }),
      }

      const svc = new IdentityService(db as never)
      const result = await svc.getUsers()

      expect(result.users).toHaveLength(1)
      expect(result.users[0].encryptedSecretKey).toBeUndefined()
      expect(result.users[0].pubkey).toBe('pk-1')
    })
  })

  describe('getUser', () => {
    it('returns sanitized user', async () => {
      const row = makeUserRow({ pubkey: 'pk-1' })
      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([row]),
            }),
          }),
        }),
      }

      const svc = new IdentityService(db as never)
      const result = await svc.getUser('pk-1')
      expect(result.pubkey).toBe('pk-1')
      expect(result.encryptedSecretKey).toBeUndefined()
    })

    it('throws 404 for unknown pubkey', async () => {
      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      }

      const svc = new IdentityService(db as never)
      await expect(svc.getUser('nonexistent')).rejects.toThrow('Not found')
    })
  })

  describe('getUserInternal', () => {
    it('returns full user with encryptedSecretKey', async () => {
      const row = makeUserRow({ pubkey: 'pk-1', encryptedSecretKey: 'SENSITIVE' })
      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([row]),
            }),
          }),
        }),
      }

      const svc = new IdentityService(db as never)
      const result = await svc.getUserInternal('pk-1')
      expect(result).not.toBeNull()
      expect(result!.encryptedSecretKey).toBe('SENSITIVE')
    })

    it('returns null for unknown pubkey', async () => {
      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      }

      const svc = new IdentityService(db as never)
      const result = await svc.getUserInternal('nonexistent')
      expect(result).toBeNull()
    })
  })

  describe('createUser', () => {
    it('creates user with default role-volunteer', async () => {
      const insertValues = vi.fn()
      const returnedRow = makeUserRow({ pubkey: 'new-pk' })

      const db = {
        insert: vi.fn().mockReturnValue({
          values: insertValues.mockReturnValue({
            onConflictDoNothing: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([returnedRow]),
            }),
          }),
        }),
      }

      const svc = new IdentityService(db as never)
      const { volunteer } = await svc.createUser({
        pubkey: 'new-pk',
        name: 'New User',
        phone: '+15551111111',
        encryptedSecretKey: 'enc',
      })

      expect(volunteer.pubkey).toBe('new-pk')
      const vals = insertValues.mock.calls[0][0]
      expect(vals.roles).toEqual(['role-volunteer'])
    })

    it('uses provided roleIds', async () => {
      const insertValues = vi.fn()
      const returnedRow = makeUserRow({ pubkey: 'new-pk', roles: ['role-admin'] })

      const db = {
        insert: vi.fn().mockReturnValue({
          values: insertValues.mockReturnValue({
            onConflictDoNothing: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([returnedRow]),
            }),
          }),
        }),
      }

      const svc = new IdentityService(db as never)
      await svc.createUser({
        pubkey: 'new-pk',
        name: 'Admin User',
        phone: '',
        roleIds: ['role-admin'],
        encryptedSecretKey: 'enc',
      })

      const vals = insertValues.mock.calls[0][0]
      expect(vals.roles).toEqual(['role-admin'])
    })

    it('raises a 409 ServiceError instead of an unhandled DB error when the pubkey already exists', async () => {
      // #1197: demo-mode setup re-creates accounts with fixed pubkeys. The insert
      // must resolve the unique-constraint conflict itself (onConflictDoNothing
      // returns no row) rather than let a raw Postgres error reach app.ts's
      // catch-all 500 handler.
      const db = {
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            onConflictDoNothing: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      }

      const svc = new IdentityService(db as never)
      await expect(svc.createUser({
        pubkey: 'existing-pk',
        name: 'Duplicate',
        phone: '+15551111111',
        encryptedSecretKey: 'enc',
      })).rejects.toMatchObject({ status: 409 })
    })
  })

  describe('updateUser', () => {
    it('non-admin can only update safe fields', async () => {
      const existingRow = makeUserRow({ pubkey: 'pk-1' })
      const updatedRow = makeUserRow({
        pubkey: 'pk-1',
        displayName: 'New Name',
        onBreak: true,
      })

      const updateSet = vi.fn()
      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([existingRow]),
            }),
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: updateSet.mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([updatedRow]),
            }),
          }),
        }),
      }

      const svc = new IdentityService(db as never)
      await svc.updateUser(
        'pk-1',
        { name: 'New Name', onBreak: true, roles: ['role-admin'] } as never,
        false, // NOT admin
      )

      const setVals = updateSet.mock.calls[0][0]
      expect(setVals.displayName).toBe('New Name')
      expect(setVals.onBreak).toBe(true)
      // roles should NOT be in the update for non-admin
      expect(setVals.roles).toBeUndefined()
    })

    it('never demotes the configured platform admin', async () => {
      const existingRow = makeUserRow({ pubkey: 'admin-pk' })
      const updatedRow = makeUserRow({ pubkey: 'admin-pk', roles: ['role-super-admin'] })

      const updateSet = vi.fn()
      const db = {
        update: vi.fn().mockReturnValue({
          set: updateSet.mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([updatedRow]),
            }),
          }),
        }),
      }
      void existingRow

      const svc = new IdentityService(db as never, 'admin-pk')
      await svc.updateUser('admin-pk', { roles: ['role-volunteer'] } as never, true)

      expect(updateSet.mock.calls[0][0].roles).toEqual(['role-super-admin'])
    })

    it('creates the configured platform admin as super-admin even without explicit roles', async () => {
      const insertValues = vi.fn()
      const db = {
        insert: vi.fn().mockReturnValue({
          values: insertValues.mockReturnValue({
            onConflictDoNothing: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([makeUserRow({ pubkey: 'admin-pk', roles: ['role-super-admin'] })]),
            }),
          }),
        }),
      }

      const svc = new IdentityService(db as never, 'admin-pk')
      await svc.createUser({ pubkey: 'admin-pk', name: 'Admin', phone: '', encryptedSecretKey: '' })

      expect(insertValues.mock.calls[0][0].roles).toEqual(['role-super-admin'])
    })

    it('admin can update restricted fields like roles', async () => {
      const existingRow = makeUserRow({ pubkey: 'pk-1' })
      const updatedRow = makeUserRow({ pubkey: 'pk-1', roles: ['role-admin'] })

      const updateSet = vi.fn()
      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([existingRow]),
            }),
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: updateSet.mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([updatedRow]),
            }),
          }),
        }),
      }

      const svc = new IdentityService(db as never)
      await svc.updateUser(
        'pk-1',
        { roles: ['role-admin'] } as never,
        true, // IS admin
      )

      const setVals = updateSet.mock.calls[0][0]
      expect(setVals.roles).toEqual(['role-admin'])
    })

    it('never allows overwriting pubkey', async () => {
      const existingRow = makeUserRow({ pubkey: 'pk-1' })
      const updateSet = vi.fn()
      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([existingRow]),
            }),
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: updateSet.mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([existingRow]),
            }),
          }),
        }),
      }

      const svc = new IdentityService(db as never)
      await svc.updateUser(
        'pk-1',
        { pubkey: 'evil-pk', name: 'Legit' } as never,
        true,
      )

      const setVals = updateSet.mock.calls[0][0]
      // pubkey should never be in the update set
      expect(setVals.pubkey).toBeUndefined()
      expect(setVals.displayName).toBe('Legit')
    })

    it('throws 404 when user does not exist', async () => {
      const db = {
        // RACE-11: updateUser now uses UPDATE...RETURNING directly (no prior SELECT)
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      }

      const svc = new IdentityService(db as never)
      await expect(
        svc.updateUser('nonexistent', { name: 'x' } as never, true),
      ).rejects.toThrow('Not found')
    })

    it('non-admin cannot deactivate a user — throws 403', async () => {
      const existingRow = makeUserRow({ pubkey: 'pk-1', active: true })
      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([existingRow]),
            }),
          }),
        }),
      }

      const svc = new IdentityService(db as never)
      await expect(
        svc.updateUser('pk-1', { active: false } as never, false),
      ).rejects.toMatchObject({ status: 403 })
    })
  })
})

// ---------------------------------------------------------------------------
// Invite Codes
// ---------------------------------------------------------------------------

describe('IdentityService — Invites', () => {
  describe('validateInvite', () => {
    it('returns valid for unused, unexpired invite', async () => {
      const invite = makeInviteRow()
      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([invite]),
            }),
          }),
        }),
      }

      const svc = new IdentityService(db as never)
      const result = await svc.validateInvite('inv-1')
      expect(result.valid).toBe(true)
      expect(result.name).toBe('Invited Person')
      expect(result.roleIds).toEqual(['role-volunteer'])
    })

    it('returns not_found for unknown code', async () => {
      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      }

      const svc = new IdentityService(db as never)
      const result = await svc.validateInvite('nonexistent')
      expect(result.valid).toBe(false)
      expect(result.error).toBe('not_found')
    })

    it('returns already_used for redeemed invite', async () => {
      const invite = makeInviteRow({ usedAt: new Date() })
      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([invite]),
            }),
          }),
        }),
      }

      const svc = new IdentityService(db as never)
      const result = await svc.validateInvite('inv-1')
      expect(result.valid).toBe(false)
      expect(result.error).toBe('already_used')
    })

    it('returns expired for expired invite', async () => {
      const invite = makeInviteRow({
        expiresAt: new Date('2020-01-01'), // in the past
      })
      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([invite]),
            }),
          }),
        }),
      }

      const svc = new IdentityService(db as never)
      const result = await svc.validateInvite('inv-expired')
      expect(result.valid).toBe(false)
      expect(result.error).toBe('expired')
    })
  })
})

// ---------------------------------------------------------------------------
// Session Management
// ---------------------------------------------------------------------------

describe('IdentityService — Sessions', () => {
  describe('validateSession', () => {
    it('returns session for valid, fresh token', async () => {
      const session = makeSessionRow()
      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([session]),
            }),
          }),
        }),
      }

      const svc = new IdentityService(db as never)
      const result = await svc.validateSession('session-token-abc')
      expect(result.token).toBe('session-token-abc')
      expect(result.pubkey).toBe('pk-1')
    })

    it('throws 401 for unknown token', async () => {
      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      }

      const svc = new IdentityService(db as never)
      await expect(svc.validateSession('bad-token')).rejects.toThrow('Invalid session')
    })

    it('throws 401 and deletes expired session', async () => {
      const expired = makeSessionRow({
        expiresAt: new Date('2020-01-01'),
      })
      const deleteFn = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      })

      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([expired]),
            }),
          }),
        }),
        delete: deleteFn,
      }

      const svc = new IdentityService(db as never)
      // B-M15: token must match the mock row's token for constant-time comparison to pass
      await expect(svc.validateSession('session-token-abc')).rejects.toThrow('Session expired')
      expect(deleteFn).toHaveBeenCalled()
    })

    it('renews session when remaining time < 1 hour, rotating the token', async () => {
      const nearExpiry = makeSessionRow({
        expiresAt: new Date(Date.now() + 30 * 60 * 1000), // 30 min from now
      })
      const rotatedRow = { ...nearExpiry, token: 'rotated-token-hex' }
      // RACE-06: update().set().where().returning() chain
      const updateSet = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([rotatedRow]),
        }),
      })

      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([nearExpiry]),
            }),
          }),
        }),
        update: vi.fn().mockReturnValue({ set: updateSet }),
      }

      const svc = new IdentityService(db as never)
      // B-M15: token must match the mock row's token for constant-time comparison
      const result = await svc.validateSession('session-token-abc')

      // Session should be renewed with a new expiry
      expect(updateSet).toHaveBeenCalled()
      const updateArgs = updateSet.mock.calls[0][0]
      // The update must include both a new token and a new expiresAt
      expect(updateArgs).toHaveProperty('token')
      expect(updateArgs).toHaveProperty('expiresAt')
      // New expiry should be ~8 hours from now (not 30 min)
      const newExpiry = new Date(result.expiresAt)
      expect(newExpiry.getTime()).toBeGreaterThan(Date.now() + 7 * 60 * 60 * 1000)
      // newToken should be propagated for client rotation
      expect(result.newToken).toBeTruthy()
    })
  })
})

// ---------------------------------------------------------------------------
// WebAuthn Challenges
// ---------------------------------------------------------------------------

describe('IdentityService — WebAuthn Challenges', () => {
  describe('getWebAuthnChallenge', () => {
    it('returns and consumes a valid challenge atomically', async () => {
      const challenge = {
        challengeId: 'ch-1',
        challenge: 'random-challenge-data',
        createdAt: new Date(), // just created
      }
      // Atomic DELETE...WHERE(eq AND gt)...RETURNING succeeds
      const deleteFn = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([challenge]),
        }),
      })

      const db = {
        delete: deleteFn,
      }

      const svc = new IdentityService(db as never)
      const result = await svc.getWebAuthnChallenge('ch-1')

      expect(result.challenge).toBe('random-challenge-data')
      expect(deleteFn).toHaveBeenCalled() // consumed atomically
    })

    it('throws 404 for unknown challenge', async () => {
      // Atomic delete returns empty, stale lookup also returns empty
      const deleteFn = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      })

      const db = {
        delete: deleteFn,
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      }

      const svc = new IdentityService(db as never)
      await expect(svc.getWebAuthnChallenge('unknown')).rejects.toThrow('Challenge not found')
    })

    it('throws 410 for expired challenge (>5 min old)', async () => {
      const expired = {
        challengeId: 'ch-expired',
        challenge: 'old-data',
        createdAt: new Date(Date.now() - 10 * 60 * 1000), // 10 min ago
      }
      // Atomic delete returns empty (gt check fails for expired challenge)
      // Then select finds the stale row, and delete cleans it up
      let deleteCallCount = 0
      const deleteFn = vi.fn().mockImplementation(() => {
        deleteCallCount++
        if (deleteCallCount === 1) {
          // First call: atomic consume attempt — returns empty
          return {
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([]),
            }),
          }
        }
        // Second call: cleanup of stale row
        return {
          where: vi.fn().mockResolvedValue(undefined),
        }
      })

      const db = {
        delete: deleteFn,
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([expired]),
            }),
          }),
        }),
      }

      const svc = new IdentityService(db as never)
      try {
        await svc.getWebAuthnChallenge('ch-expired')
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(ServiceError)
        expect((err as ServiceError).status).toBe(410)
        expect((err as ServiceError).message).toContain('expired')
      }
    })
  })
})

// ---------------------------------------------------------------------------
// Provisioning Rooms
// ---------------------------------------------------------------------------

describe('IdentityService — Provisioning Rooms', () => {
  describe('getProvisionRoom', () => {
    it('throws 403 for invalid token', async () => {
      const room = {
        roomId: 'room-1',
        token: 'correct-token',
        ephemeralPubkey: 'eph-pk',
        expiresAt: new Date(Date.now() + 60 * 1000),
        encryptedNsec: null,
        primaryPubkey: null,
      }
      // RACE-03: atomic delete returns empty, then select fallback finds room
      const db = {
        delete: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]),
          }),
        }),
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([room]),
            }),
          }),
        }),
      }

      const svc = new IdentityService(db as never)
      await expect(
        svc.getProvisionRoom('room-1', 'wrong-token'),
      ).rejects.toThrow('Invalid token')
    })

    it('returns expired status for expired room', async () => {
      const room = {
        roomId: 'room-1',
        token: 'correct-token',
        ephemeralPubkey: 'eph-pk',
        expiresAt: new Date('2020-01-01'), // expired
        encryptedNsec: null,
        primaryPubkey: null,
      }
      // RACE-03: atomic delete returns empty (expired), select fallback finds room
      const deleteFn = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      })
      const db = {
        delete: deleteFn,
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([room]),
            }),
          }),
        }),
      }

      const svc = new IdentityService(db as never)
      const result = await svc.getProvisionRoom('room-1', 'correct-token')
      expect(result.status).toBe('expired')
    })

    it('returns ready status and consumes room with payload', async () => {
      const room = {
        roomId: 'room-1',
        token: 'correct-token',
        ephemeralPubkey: 'eph-pk',
        expiresAt: new Date(Date.now() + 60 * 1000),
        encryptedNsec: 'enc-nsec-data',
        primaryPubkey: 'primary-pk',
      }
      // RACE-03: atomic delete succeeds — returns the consumed room
      const deleteFn = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([room]),
        }),
      })
      const db = {
        delete: deleteFn,
      }

      const svc = new IdentityService(db as never)
      const result = await svc.getProvisionRoom('room-1', 'correct-token')

      expect(result.status).toBe('ready')
      expect(result.encryptedNsec).toBe('enc-nsec-data')
      expect(result.primaryPubkey).toBe('primary-pk')
      expect(deleteFn).toHaveBeenCalled() // consumed atomically
    })

    it('returns waiting status when no payload yet', async () => {
      const room = {
        roomId: 'room-1',
        token: 'correct-token',
        ephemeralPubkey: 'eph-pk',
        expiresAt: new Date(Date.now() + 60 * 1000),
        encryptedNsec: null,
        primaryPubkey: null,
      }
      // RACE-03: atomic delete returns empty (no payload), select fallback finds room
      const db = {
        delete: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]),
          }),
        }),
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([room]),
            }),
          }),
        }),
      }

      const svc = new IdentityService(db as never)
      const result = await svc.getProvisionRoom('room-1', 'correct-token')
      expect(result.status).toBe('waiting')
      expect(result.ephemeralPubkey).toBe('eph-pk')
    })
  })
})

// ---------------------------------------------------------------------------
// Reset safety
// ---------------------------------------------------------------------------

describe('IdentityService — Reset', () => {
  it('throws 403 outside demo/development mode', async () => {
    const svc = new IdentityService({} as never)
    await expect(
      svc.reset(false, 'production'),
    ).rejects.toThrow('Reset not allowed')
  })

  it('throws 403 when DEMO_MODE=true but DEMO_MODE_CONFIRM is missing', async () => {
    const svc = new IdentityService({} as never)
    await expect(
      svc.reset(true, 'staging'),
    ).rejects.toThrow('DEMO_MODE reset requires DEMO_MODE_CONFIRM=DESTROY_ALL_DATA')
  })

  it('throws 403 when DEMO_MODE=true but DEMO_MODE_CONFIRM has wrong value', async () => {
    const svc = new IdentityService({} as never)
    await expect(
      svc.reset(true, 'staging', 'wrong'),
    ).rejects.toThrow('DEMO_MODE reset requires DEMO_MODE_CONFIRM=DESTROY_ALL_DATA')
  })

  it('allows reset in development mode without DEMO_MODE_CONFIRM', async () => {
    let txDelete: ReturnType<typeof vi.fn>
    const txFn = vi.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
      txDelete = vi.fn().mockResolvedValue(undefined)
      const tx = { delete: txDelete }
      return fn(tx)
    })
    const db = { transaction: txFn }
    const svc = new IdentityService(db as never)

    await svc.reset(false, 'development')

    expect(txFn).toHaveBeenCalled()
    // 8 tables must be cleared: devices, webauthnCredentials, webauthnChallenges,
    // sessions, authNonces, provisionRooms, inviteCodes, users
    expect(txDelete!).toHaveBeenCalledTimes(8)
  })

  it('allows reset in demo mode with DEMO_MODE_CONFIRM=DESTROY_ALL_DATA', async () => {
    let txDelete: ReturnType<typeof vi.fn>
    const txFn = vi.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
      txDelete = vi.fn().mockResolvedValue(undefined)
      const tx = { delete: txDelete }
      return fn(tx)
    })
    const db = { transaction: txFn }
    const svc = new IdentityService(db as never)

    await svc.reset(true, 'staging', 'DESTROY_ALL_DATA')

    expect(txFn).toHaveBeenCalled()
    expect(txDelete!).toHaveBeenCalledTimes(8)
  })
})
