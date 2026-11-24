import { describe, it, expect, vi } from 'vitest'
import { TeamsService } from '../../services/teams'
import { ServiceError } from '../../services/service-error'
import { CRYPTO_FORMAT_CURRENT } from '@protocol/crypto-format'

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------

function makeTeamRow(overrides: Partial<{
  id: string
  hubId: string
  encryptedName: string
  encryptedDescription: string | null
  createdBy: string
  createdAt: Date
  updatedAt: Date
}> = {}) {
  return {
    id: 'team-1',
    hubId: 'hub-1',
    encryptedName: 'enc-name',
    encryptedDescription: null,
    createdBy: 'pk-admin',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    cryptoFormat: CRYPTO_FORMAT_CURRENT,
    ...overrides,
  }
}

function makeMemberRow(overrides: Partial<{
  teamId: string
  userPubkey: string
  addedBy: string
  createdAt: Date
}> = {}) {
  return {
    teamId: 'team-1',
    userPubkey: 'pk-user',
    addedBy: 'pk-admin',
    createdAt: new Date('2026-01-01'),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// createTeam
// ---------------------------------------------------------------------------

describe('TeamsService — createTeam', () => {
  it('inserts a team row and returns it with zero counts', async () => {
    const row = makeTeamRow({ id: 'team-new' })
    const db = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([row]),
        }),
      }),
    }

    const svc = new TeamsService(db as never)
    const result = await svc.createTeam({
      id: 'team-new',
      hubId: 'hub-1',
      encryptedName: 'enc-name',
      createdBy: 'pk-admin',
    })

    expect(result.id).toBe('team-new')
    expect(result.memberCount).toBe(0)
    expect(result.contactCount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// getTeam
// ---------------------------------------------------------------------------

describe('TeamsService — getTeam', () => {
  it('returns team with member and contact counts', async () => {
    const row = makeTeamRow()
    let selectCall = 0
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCall++
        const n = selectCall
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(
              n === 1
                ? [row]
                : n === 2
                  ? [{ memberCount: 3 }]
                  : [{ contactCount: 2 }],
            ),
          }),
        }
      }),
    }

    const svc = new TeamsService(db as never)
    const result = await svc.getTeam('team-1', 'hub-1')

    expect(result.id).toBe('team-1')
    expect(result.memberCount).toBe(3)
    expect(result.contactCount).toBe(2)
  })

  it('throws 404 when team not found', async () => {
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      }),
    }

    const svc = new TeamsService(db as never)
    await expect(svc.getTeam('nonexistent', 'hub-1')).rejects.toThrow(ServiceError)
    await expect(svc.getTeam('nonexistent', 'hub-1')).rejects.toMatchObject({ status: 404 })
  })
})

// ---------------------------------------------------------------------------
// listTeams
// ---------------------------------------------------------------------------

describe('TeamsService — listTeams', () => {
  it('returns empty array when no teams', async () => {
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    }

    const svc = new TeamsService(db as never)
    const result = await svc.listTeams('hub-1')
    expect(result).toEqual([])
  })

  it('returns teams with aggregated counts', async () => {
    const rows = [makeTeamRow({ id: 'team-1' }), makeTeamRow({ id: 'team-2' })]
    let selectCall = 0
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCall++
        const n = selectCall
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue(
              n === 1
                ? { orderBy: vi.fn().mockResolvedValue(rows) }
                : {
                    groupBy: vi.fn().mockResolvedValue(
                      n === 2
                        ? [{ teamId: 'team-1', cnt: 2 }, { teamId: 'team-2', cnt: 1 }]
                        : [{ teamId: 'team-1', cnt: 3 }],
                    ),
                  },
            ),
          }),
        }
      }),
    }

    const svc = new TeamsService(db as never)
    const result = await svc.listTeams('hub-1')
    expect(result).toHaveLength(2)
    expect(result[0].id).toBe('team-1')
    expect(result[1].id).toBe('team-2')
  })
})

// ---------------------------------------------------------------------------
// updateTeam
// ---------------------------------------------------------------------------

describe('TeamsService — updateTeam', () => {
  it('throws 404 when team not found on update', async () => {
    const db = {
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    }

    const svc = new TeamsService(db as never)
    await expect(svc.updateTeam('nonexistent', 'hub-1', { encryptedName: 'new' }))
      .rejects.toThrow(ServiceError)
  })
})

// ---------------------------------------------------------------------------
// deleteTeam
// ---------------------------------------------------------------------------

describe('TeamsService — deleteTeam', () => {
  it('deletes team successfully', async () => {
    const db = {
      delete: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'team-1' }]),
        }),
      }),
    }

    const svc = new TeamsService(db as never)
    await expect(svc.deleteTeam('team-1', 'hub-1')).resolves.toBeUndefined()
  })

  it('throws 404 when team not found on delete', async () => {
    const db = {
      delete: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      }),
    }

    const svc = new TeamsService(db as never)
    await expect(svc.deleteTeam('nonexistent', 'hub-1')).rejects.toThrow(ServiceError)
  })
})

// ---------------------------------------------------------------------------
// addMembers / removeMember
// ---------------------------------------------------------------------------

describe('TeamsService — membership', () => {
  it('addMembers returns early with empty pubkeys', async () => {
    const row = makeTeamRow()
    let selectCall = 0
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCall++
        const n = selectCall
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(n === 1 ? [row] : [{ memberCount: 0 }]),
          }),
        }
      }),
      insert: vi.fn(),
    }
    const svc = new TeamsService(db as never)
    await svc.addMembers('team-1', 'hub-1', [], 'pk-admin')
    expect(db.insert).not.toHaveBeenCalled()
  })

  it('addMembers calls insert with correct values', async () => {
    const row = makeTeamRow()
    const insertValues = vi.fn().mockReturnValue({
      onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
    })
    let selectCall = 0
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCall++
        const n = selectCall
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(n === 1 ? [row] : [{ memberCount: 0 }]),
          }),
        }
      }),
      insert: vi.fn().mockReturnValue({ values: insertValues }),
    }

    const svc = new TeamsService(db as never)
    await svc.addMembers('team-1', 'hub-1', ['pk-user-1', 'pk-user-2'], 'pk-admin')
    expect(insertValues).toHaveBeenCalledWith([
      { teamId: 'team-1', userPubkey: 'pk-user-1', addedBy: 'pk-admin' },
      { teamId: 'team-1', userPubkey: 'pk-user-2', addedBy: 'pk-admin' },
    ])
  })

  it('listMembers returns member rows', async () => {
    const teamRow = makeTeamRow()
    const memberRow = makeMemberRow()
    let selectCall = 0
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCall++
        const n = selectCall
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockImplementation(() =>
              n === 1
                ? { ...Promise.resolve([teamRow]), then: undefined as never }
                : n <= 3
                  ? { ...Promise.resolve([{ memberCount: 0 }]), then: undefined as never }
                  : { orderBy: vi.fn().mockResolvedValue([memberRow]) },
            ),
          }),
        }
      }),
    }

    // Simpler approach: mock getTeam call separately
    const svc = new TeamsService(db as never)
    // Override getTeam so it doesn't interfere with listMembers mock
    vi.spyOn(svc, 'getTeam').mockResolvedValue({ ...teamRow, memberCount: 0, contactCount: 0 })
    const listDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue([memberRow]),
          }),
        }),
      }),
    }
    const svc2 = new TeamsService(listDb as never)
    vi.spyOn(svc2, 'getTeam').mockResolvedValue({ ...teamRow, memberCount: 0, contactCount: 0 })

    const result = await svc2.listMembers('team-1', 'hub-1')
    expect(result).toHaveLength(1)
    expect(result[0].userPubkey).toBe('pk-user')
  })
})

// ---------------------------------------------------------------------------
// assignContacts / unassignContact
// ---------------------------------------------------------------------------

describe('TeamsService — contact assignments', () => {
  it('assignContacts returns early with empty contactIds', async () => {
    const teamRow = makeTeamRow()
    const db = { insert: vi.fn() }
    const svc = new TeamsService(db as never)
    vi.spyOn(svc, 'getTeam').mockResolvedValue({ ...teamRow, memberCount: 0, contactCount: 0 })

    await svc.assignContacts('team-1', 'hub-1', [], 'pk-admin')
    expect(db.insert).not.toHaveBeenCalled()
  })

  it('assignContacts inserts assignment rows', async () => {
    const teamRow = makeTeamRow()
    const insertValues = vi.fn().mockReturnValue({
      onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
    })
    const db = {
      insert: vi.fn().mockReturnValue({ values: insertValues }),
    }
    const svc = new TeamsService(db as never)
    vi.spyOn(svc, 'getTeam').mockResolvedValue({ ...teamRow, memberCount: 0, contactCount: 0 })

    await svc.assignContacts('team-1', 'hub-1', ['contact-1', 'contact-2'], 'pk-admin')
    expect(insertValues).toHaveBeenCalledWith([
      { contactId: 'contact-1', teamId: 'team-1', hubId: 'hub-1', assignedBy: 'pk-admin' },
      { contactId: 'contact-2', teamId: 'team-1', hubId: 'hub-1', assignedBy: 'pk-admin' },
    ])
  })

  it('unassignContact calls delete with correct conditions', async () => {
    const teamRow = makeTeamRow()
    const deleteWhere = vi.fn().mockResolvedValue(undefined)
    const db = {
      delete: vi.fn().mockReturnValue({ where: deleteWhere }),
    }
    const svc = new TeamsService(db as never)
    vi.spyOn(svc, 'getTeam').mockResolvedValue({ ...teamRow, memberCount: 0, contactCount: 0 })

    await svc.unassignContact('team-1', 'hub-1', 'contact-1')
    expect(db.delete).toHaveBeenCalled()
    expect(deleteWhere).toHaveBeenCalled()
  })
})
