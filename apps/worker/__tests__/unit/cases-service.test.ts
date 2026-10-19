import { describe, it, expect, vi } from 'vitest'
import { CasesService } from '../../services/cases'

// ---------------------------------------------------------------------------
// DB Mock Helpers
// ---------------------------------------------------------------------------

function makeCaseRow(overrides: Partial<{
  id: string
  hubId: string
  entityTypeId: string
  caseNumber: string | null
  statusHash: string
  severityHash: string | null
  categoryHash: string | null
  assignedTo: string[]
  blindIndexes: Record<string, string>
  encryptedSummary: string
  summaryEnvelopes: unknown
  encryptedFields: unknown
  fieldEnvelopes: unknown
  encryptedPii: unknown
  piiEnvelopes: unknown
  contactCount: number
  interactionCount: number
  fileCount: number
  reportCount: number
  eventIds: string[]
  reportIds: string[]
  parentRecordId: string | null
  closedAt: Date | null
  createdBy: string
  createdAt: Date
  updatedAt: Date
}> = {}) {
  return {
    id: 'case-1',
    hubId: 'hub-1',
    entityTypeId: 'et-incident',
    caseNumber: null,
    statusHash: 'hash-open',
    severityHash: null,
    categoryHash: null,
    assignedTo: [],
    blindIndexes: {},
    encryptedSummary: 'enc-summary',
    summaryEnvelopes: [{ pubkey: 'pk-admin', enc: 'b'.repeat(64), ct: 'wk1' }],
    encryptedFields: null,
    fieldEnvelopes: null,
    encryptedPii: null,
    piiEnvelopes: null,
    contactCount: 0,
    interactionCount: 0,
    fileCount: 0,
    reportCount: 0,
    eventIds: [],
    reportIds: [],
    parentRecordId: null,
    closedAt: null,
    createdBy: 'pk-author',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Case CRUD
// ---------------------------------------------------------------------------

describe('CasesService — CRUD', () => {
  describe('create', () => {
    it('creates a case and returns the row', async () => {
      const row = makeCaseRow({ id: 'case-new' })

      const insertValues = vi.fn()
      const db = {
        insert: vi.fn().mockReturnValue({
          values: insertValues.mockReturnValue({
            returning: vi.fn().mockResolvedValue([row]),
          }),
        }),
      }

      const svc = new CasesService(db as never)
      const result = await svc.create({
        hubId: 'hub-1',
        entityTypeId: 'et-incident',
        createdBy: 'pk-author',
        encryptedSummary: 'enc-summary',
        summaryEnvelopes: [{ pubkey: 'pk-admin', enc: 'b'.repeat(64), ct: 'wk1' }],
        statusHash: 'hash-open',
      })

      expect(result.id).toBe('case-new')
      expect(result.hubId).toBe('hub-1')
      expect(result.statusHash).toBe('hash-open')
    })

    it('creates contact links atomically when provided', async () => {
      const row = makeCaseRow({ id: 'case-linked' })
      const insertContactValues = vi.fn().mockResolvedValue(undefined)
      const updateSet = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      })

      const db = {
        insert: vi.fn()
          .mockReturnValueOnce({
            values: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([row]),
            }),
          })
          .mockReturnValueOnce({
            values: insertContactValues,
          }),
        update: vi.fn().mockReturnValue({ set: updateSet }),
      }

      const svc = new CasesService(db as never)
      const result = await svc.create({
        hubId: 'hub-1',
        entityTypeId: 'et-incident',
        createdBy: 'pk-author',
        encryptedSummary: 'enc',
        summaryEnvelopes: [{ pubkey: 'pk-admin', enc: 'b'.repeat(64), ct: 'wk1' }],
        statusHash: 'hash-open',
        contactLinks: [
          { contactId: 'contact-1', role: 'caller' },
          { contactId: 'contact-2', role: 'witness' },
        ],
      })

      expect(insertContactValues).toHaveBeenCalled()
      expect(result.contactCount).toBe(2)
    })
  })

  describe('get', () => {
    it('returns case record', async () => {
      const row = makeCaseRow({ id: 'case-1' })
      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([row]),
          }),
        }),
      }

      const svc = new CasesService(db as never)
      const result = await svc.get('case-1')
      expect(result.id).toBe('case-1')
    })

    it('throws 404 for nonexistent case', async () => {
      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        }),
      }

      const svc = new CasesService(db as never)
      await expect(svc.get('nonexistent')).rejects.toThrow('Record not found')
    })
  })

  describe('update', () => {
    it('auto-creates status_change interaction on status change', async () => {
      const existingRow = makeCaseRow({
        id: 'case-1',
        statusHash: 'hash-open',
        interactionCount: 0,
      })
      const updatedRow = makeCaseRow({
        id: 'case-1',
        statusHash: 'hash-closed',
        interactionCount: 1,
      })

      const insertInteraction = vi.fn().mockReturnValue({
        values: vi.fn().mockResolvedValue(undefined),
      })

      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([existingRow]),
          }),
        }),
        insert: insertInteraction,
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([updatedRow]),
            }),
          }),
        }),
      }

      const svc = new CasesService(db as never)
      await svc.update('case-1', {
        statusHash: 'hash-closed',
        authorPubkey: 'pk-admin',
      })

      // A status_change interaction should have been created with correct fields
      expect(insertInteraction).toHaveBeenCalled()
      const insertedValues = insertInteraction.mock.results[0].value.values.mock.calls[0][0]
      expect(insertedValues.interactionType).toBe('status_change')
      expect(insertedValues.caseId).toBe('case-1')
      expect(insertedValues.authorPubkey).toBe('pk-admin')
      expect(insertedValues.previousStatusHash).toBe('hash-open')
      expect(insertedValues.newStatusHash).toBe('hash-closed')
    })

    it('does NOT create interaction when status is unchanged', async () => {
      const existingRow = makeCaseRow({
        id: 'case-1',
        statusHash: 'hash-open',
      })
      const updatedRow = makeCaseRow({
        id: 'case-1',
        statusHash: 'hash-open',
      })

      const insertInteraction = vi.fn()
      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([existingRow]),
          }),
        }),
        insert: insertInteraction,
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([updatedRow]),
            }),
          }),
        }),
      }

      const svc = new CasesService(db as never)
      await svc.update('case-1', {
        severityHash: 'hash-high',
      })

      // No interaction should be created (status didn't change)
      expect(insertInteraction).not.toHaveBeenCalled()
    })
  })
})

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

describe('CasesService — Assignment', () => {
  describe('assign', () => {
    // #1144: assign() now computes dedup atomically in SQL against the row
    // the UPDATE itself locks, rather than a prior SELECT read — so even a
    // fully-redundant request (every pubkey already assigned) issues the
    // UPDATE and lets the database confirm nothing changes, instead of
    // deciding that in JS from a potentially stale read.
    it('deduplicates — does not add already-assigned pubkeys', async () => {
      const db = {
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{
                assignedTo: ['pk-1', 'pk-2'],
              }]),
            }),
          }),
        }),
      }

      const svc = new CasesService(db as never)
      const result = await svc.assign('case-1', ['pk-1', 'pk-2'])

      // DB-side dedup leaves the list unchanged (no new pubkeys)
      expect(result.assignedTo).toEqual(['pk-1', 'pk-2'])
      expect(db.update).toHaveBeenCalled()
    })

    it('adds only new pubkeys', async () => {
      const db = {
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{
                assignedTo: ['pk-1', 'pk-3'],
              }]),
            }),
          }),
        }),
      }

      const svc = new CasesService(db as never)
      const result = await svc.assign('case-1', ['pk-1', 'pk-3'])

      expect(result.assignedTo).toContain('pk-3')
      expect(db.update).toHaveBeenCalled()
    })

    it('throws 404 for nonexistent case', async () => {
      const db = {
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      }

      const svc = new CasesService(db as never)
      await expect(svc.assign('nonexistent', ['pk-1'])).rejects.toThrow('Record not found')
    })

    it('short-circuits on an empty pubkey list without issuing an UPDATE', async () => {
      const existingRow = makeCaseRow({
        id: 'case-1',
        assignedTo: ['pk-1'],
      })

      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([existingRow]),
          }),
        }),
        update: vi.fn(),
      }

      const svc = new CasesService(db as never)
      const result = await svc.assign('case-1', [])

      expect(result.assignedTo).toEqual(['pk-1'])
      expect(db.update).not.toHaveBeenCalled()
    })
  })

  describe('unassign', () => {
    it('throws 404 when pubkey is not assigned', async () => {
      const existingRow = makeCaseRow({
        id: 'case-1',
        assignedTo: ['pk-1'],
      })

      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([existingRow]),
          }),
        }),
      }

      const svc = new CasesService(db as never)
      await expect(svc.unassign('case-1', 'pk-not-assigned')).rejects.toThrow('Pubkey not assigned')
    })
  })
})

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

describe('CasesService — list pagination', () => {
  it('caps limit at 100', async () => {
    const db = {
      select: vi.fn()
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 0 }]),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  offset: vi.fn().mockResolvedValue([]),
                }),
              }),
            }),
          }),
        }),
    }

    const svc = new CasesService(db as never)
    const result = await svc.list({
      hubId: 'hub-1',
      limit: 500, // should be capped to 100
    })

    expect(result.limit).toBe(100)
  })

  it('defaults to page 1, limit 20', async () => {
    const db = {
      select: vi.fn()
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 5 }]),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  offset: vi.fn().mockResolvedValue([]),
                }),
              }),
            }),
          }),
        }),
    }

    const svc = new CasesService(db as never)
    const result = await svc.list({ hubId: 'hub-1' })

    expect(result.page).toBe(1)
    expect(result.limit).toBe(20)
  })

  it('computes hasMore correctly', async () => {
    const db = {
      select: vi.fn()
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 50 }]),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  offset: vi.fn().mockResolvedValue([]),
                }),
              }),
            }),
          }),
        }),
    }

    const svc = new CasesService(db as never)
    const result = await svc.list({
      hubId: 'hub-1',
      page: 1,
      limit: 20,
    })

    expect(result.hasMore).toBe(true) // 0 + 20 < 50
  })
})

// ---------------------------------------------------------------------------
// Evidence verification
// ---------------------------------------------------------------------------

describe('CasesService — Evidence verification', () => {
  it('returns valid=true when hashes match', async () => {
    const evidenceRow = {
      id: 'ev-1',
      integrityHash: 'sha256-abc123',
    }

    const insertEntry = vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    })
    const updateEvidence = vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    })

    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([evidenceRow]),
        }),
      }),
      insert: insertEntry,
      update: updateEvidence,
    }

    const svc = new CasesService(db as never)
    const result = await svc.verifyEvidence('ev-1', 'sha256-abc123', 'pk-verifier')

    expect(result.valid).toBe(true)
    expect(result.originalHash).toBe('sha256-abc123')
    expect(result.currentHash).toBe('sha256-abc123')
  })

  it('returns valid=false when hashes do not match', async () => {
    const evidenceRow = {
      id: 'ev-1',
      integrityHash: 'sha256-original',
    }

    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([evidenceRow]),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockResolvedValue(undefined),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      }),
    }

    const svc = new CasesService(db as never)
    const result = await svc.verifyEvidence('ev-1', 'sha256-tampered', 'pk-verifier')

    expect(result.valid).toBe(false)
    expect(result.originalHash).toBe('sha256-original')
    expect(result.currentHash).toBe('sha256-tampered')
  })

  it('throws 404 for nonexistent evidence', async () => {
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      }),
    }

    const svc = new CasesService(db as never)
    await expect(
      svc.verifyEvidence('nonexistent', 'hash', 'pk'),
    ).rejects.toThrow('Evidence not found')
  })
})

// ---------------------------------------------------------------------------
// Reset safety
// ---------------------------------------------------------------------------

describe('CasesService — Reset safety', () => {
  // Gated by `destructiveResetRefusal` (lib/dev-surfaces.ts) since #1604 — see
  // identity-service.test.ts for the four directions and why the DEMO_MODE /
  // DEMO_MODE_CONFIRM pair this used to assert is gone.
  const SECRET = 'a'.repeat(64)
  const STAGING = { ENVIRONMENT: 'staging', DEV_ROUTES_ENABLED: 'true', DEV_RESET_SECRET: SECRET }

  it('refuses on ENVIRONMENT=production even with a valid secret', async () => {
    const db = { delete: vi.fn().mockResolvedValue(undefined) }
    const svc = new CasesService(db as never)
    await expect(
      svc.reset({ ENVIRONMENT: 'production', DEV_ROUTES_ENABLED: 'true', DEV_RESET_SECRET: SECRET }, SECRET),
    ).rejects.toThrow('ENVIRONMENT=production never serves /api/test-*')
    expect(db.delete).not.toHaveBeenCalled()
  })

  it('refuses on staging without the secret', async () => {
    const db = { delete: vi.fn().mockResolvedValue(undefined) }
    const svc = new CasesService(db as never)
    await expect(svc.reset(STAGING, undefined)).rejects.toThrow('requires the dev-surface shared secret')
    expect(db.delete).not.toHaveBeenCalled()
  })

  it('refuses on staging with the wrong secret', async () => {
    const db = { delete: vi.fn().mockResolvedValue(undefined) }
    const svc = new CasesService(db as never)
    await expect(svc.reset(STAGING, 'b'.repeat(64))).rejects.toThrow('requires the dev-surface shared secret')
    expect(db.delete).not.toHaveBeenCalled()
  })

  it('allows the reset on staging with the correct secret and deletes all case tables', async () => {
    const db = { delete: vi.fn().mockResolvedValue(undefined) }
    const svc = new CasesService(db as never)

    await svc.reset(STAGING, SECRET)

    // 9 tables must be cleared: custodyEntries, evidence, caseInteractions,
    // reportCases, reportEvents, caseEvents, caseContacts, events, caseRecords
    expect(db.delete).toHaveBeenCalledTimes(9)
  })

  it('allows the reset on development with the configured secret', async () => {
    const db = { delete: vi.fn().mockResolvedValue(undefined) }
    const svc = new CasesService(db as never)

    await svc.reset({ ENVIRONMENT: 'development', DEV_ROUTES_ENABLED: 'true', DEV_RESET_SECRET: SECRET }, SECRET)

    expect(db.delete).toHaveBeenCalledTimes(9)
  })
})
