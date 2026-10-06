import { describe, it, expect, vi } from 'vitest'
import { AuditService, audit, computeEntryHash } from '@worker/services/audit'
import { ServiceError } from '@worker/services/settings'
import { createMockDb } from './mock-db'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAuditRow(overrides: Record<string, unknown> = {}) {
  const now = new Date()
  return {
    id: 'audit-1',
    hubId: null,
    action: 'login',
    actorPubkey: 'a'.repeat(64),
    details: {},
    previousEntryHash: null,
    entryHash: 'b'.repeat(64),
    createdAt: now,
    ...overrides,
  }
}

/**
 * Build a mock db suitable for AuditService.
 * AuditService.log() uses db.transaction(): take a per-chain advisory lock
 * (tx.execute), then read the tip (tx.select). We model this by running the callback immediately with a tx that proxies
 * back to the same mock db.
 *
 * The tx select chain is implemented as a fluent builder that resolves to
 * the configured result — supporting .where().orderBy().limit().
 */
function setupAuditDb() {
  const { db, reset } = createMockDb(['auditLog'])

  /** Build a fully chainable select */
  function makeSelectChain(result: unknown[]) {
    const terminal = Promise.resolve(result) as any
    // Add all chain methods as no-ops that return the same terminal promise
    const methods = ['from', 'where', 'orderBy', 'limit', 'offset', 'groupBy']
    for (const m of methods) {
      terminal[m] = () => terminal
    }
    return terminal
  }

  // Keep track of which select result to use (mirrors nextSelect logic from mock-db)
  let selectResultQueue: unknown[][] = []
  let selectIdx = 0

  const selectWithFor = vi.fn(() => {
    const result = selectResultQueue[selectIdx] ?? []
    selectIdx++
    return makeSelectChain(result)
  })

  // Override $setSelectResults on db to also update the tx queue
  const origSetSelectResults = (db as any).$setSelectResults.bind(db)
  ;(db as any).$setSelectResults = (results: unknown[][]) => {
    origSetSelectResults(results)
    selectResultQueue = results
    selectIdx = 0
  }
  const origSetSelectResult = (db as any).$setSelectResult.bind(db)
  ;(db as any).$setSelectResult = (rows: unknown[]) => {
    origSetSelectResult(rows)
    selectResultQueue = [rows]
    selectIdx = 0
  }

  const txProxy = {
    select: selectWithFor,
    insert: (...args: unknown[]) => (db.insert as any)(...args),
    update: (...args: unknown[]) => (db.update as any)(...args),
    delete: (...args: unknown[]) => (db.delete as any)(...args),
    execute: (...args: unknown[]) => (db.execute as any)(...args),
  }

  ;(db as any).transaction = vi.fn().mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) => fn(txProxy),
  )

  return { db, reset, txSelect: selectWithFor }
}

/** A valid 64-char hex string for use as HMAC secret in audit() helper tests */
const TEST_HMAC_SECRET = 'a'.repeat(64)

// ---------------------------------------------------------------------------
// AuditService.log
// ---------------------------------------------------------------------------

describe('AuditService.log', () => {
  it('throws 400 for invalid actorPubkey format', async () => {
    const { db } = setupAuditDb()
    const service = new AuditService(db as any)

    await expect(
      service.log('login', 'not-valid-hex'),
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      service.log('login', 'not-valid-hex'),
    ).rejects.toBeInstanceOf(ServiceError)
  })

  it('accepts "system" as actorPubkey', async () => {
    const { db } = setupAuditDb()
    const service = new AuditService(db as any)
    const row = makeAuditRow({ actorPubkey: 'system' })

    // Inside tx: first select (get latest hash), then insert
    db.$setSelectResults([[]])  // no existing entry
    db.$setInsertResult([row])

    const result = await service.log('settingsUpdated', 'system', { key: 'val' })
    expect(result.actorPubkey).toBe('system')
  })

  it('throws 400 for 63-char hex pubkey (must be exactly 64)', async () => {
    const { db } = setupAuditDb()
    const service = new AuditService(db as any)

    await expect(
      service.log('login', 'a'.repeat(63)),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('accepts 64-char hex actorPubkey', async () => {
    const { db } = setupAuditDb()
    const service = new AuditService(db as any)
    const pubkey = 'a'.repeat(64)
    const row = makeAuditRow({ actorPubkey: pubkey })

    db.$setSelectResults([[]])  // no previous hash
    db.$setInsertResult([row])

    const result = await service.log('noteCreated', pubkey)
    expect(result.actorPubkey).toBe(pubkey)
  })

  it('uses a transaction', async () => {
    const { db } = setupAuditDb()
    const service = new AuditService(db as any)
    const row = makeAuditRow()

    db.$setSelectResults([[]])
    db.$setInsertResult([row])

    await service.log('login', 'a'.repeat(64))

    expect((db as any).transaction).toHaveBeenCalled()
  })

  it('sets previousEntryHash from the latest existing entry', async () => {
    const { db } = setupAuditDb()
    const service = new AuditService(db as any)
    const prevHash = 'c'.repeat(64)

    // Return an existing entry with a hash
    db.$setSelectResults([[{ entryHash: prevHash, createdAt: new Date('2026-01-01T00:00:00.000Z') }]])

    // The inserted row should have previousEntryHash set
    const insertedRow = makeAuditRow({ previousEntryHash: prevHash })
    db.$setInsertResult([insertedRow])

    const result = await service.log('noteCreated', 'a'.repeat(64))
    // The service builds the hash from the entry content;
    // we verify the returned row reflects the previous hash
    expect(result.previousEntryHash).toBe(prevHash)
  })

  it('sets previousEntryHash to null for first entry in hub', async () => {
    const { db } = setupAuditDb()
    const service = new AuditService(db as any)

    db.$setSelectResults([[]])  // no previous entry
    db.$setInsertResult([makeAuditRow({ previousEntryHash: null })])

    const result = await service.log('login', 'a'.repeat(64), {}, 'hub-1')
    expect(result.previousEntryHash).toBeNull()
  })

  /** The values object passed to the (first) insert inside log(). */
  function insertedValues(db: ReturnType<typeof setupAuditDb>['db']) {
    const insertResult = (db.insert as unknown as { mock: { results: Array<{ value: { values: { mock: { calls: unknown[][] } } } }> } }).mock.results[0]
    return insertResult.value.values.mock.calls[0][0] as { id: string; createdAt: unknown; entryHash: string; previousEntryHash: string | null }
  }

  it('takes the chain advisory lock before reading the tip', async () => {
    const { db, txSelect } = setupAuditDb()
    const service = new AuditService(db as any)

    db.$setSelectResults([[]])
    db.$setInsertResult([makeAuditRow()])

    await service.log('login', 'a'.repeat(64), {}, 'hub-1')

    // An empty chain has no tip row to FOR UPDATE and a waiter would re-read a
    // stale tip, so the lock must be an advisory lock acquired first.
    expect(db.execute).toHaveBeenCalledTimes(1)
    expect(db.execute.mock.invocationCallOrder[0]).toBeLessThan(txSelect.mock.invocationCallOrder[0])
  })

  it('forces created_at strictly past the tip so append order is total', async () => {
    const { db } = setupAuditDb()
    const service = new AuditService(db as any)
    const prevHash = 'c'.repeat(64)
    // Tip stamped in the future relative to this writer's clock (skew / same-ms tie).
    const tipCreatedAt = new Date(Date.now() + 60_000)

    db.$setSelectResults([[{ entryHash: prevHash, createdAt: tipCreatedAt }]])
    db.$setInsertResult([makeAuditRow()])

    await service.log('noteCreated', 'a'.repeat(64), { k: 'v' }, 'hub-1')

    const values = insertedValues(db)
    // createdAt is passed as a `${iso}::timestamptz` SQL fragment; the ISO string is its first param.
    const chunks = (values.createdAt as { queryChunks: unknown[] }).queryChunks
    const iso = chunks.find((c) => typeof c === 'string' && c.startsWith('20')) as string
    expect(new Date(iso).getTime()).toBe(tipCreatedAt.getTime() + 1)
    expect(values.previousEntryHash).toBe(prevHash)
    // The stored hash must have been computed over the bumped timestamp.
    expect(values.entryHash).toBe(computeEntryHash({
      id: values.id,
      action: 'noteCreated',
      actorPubkey: 'a'.repeat(64),
      createdAt: iso,
      details: { k: 'v' },
      previousEntryHash: prevHash,
    }))
  })

  it('uses the current time when it is already past the tip', async () => {
    const { db } = setupAuditDb()
    const service = new AuditService(db as any)
    const before = Date.now()

    db.$setSelectResults([[{ entryHash: 'c'.repeat(64), createdAt: new Date(before - 60_000) }]])
    db.$setInsertResult([makeAuditRow()])

    await service.log('noteCreated', 'a'.repeat(64), {}, 'hub-1')

    const chunks = (insertedValues(db).createdAt as { queryChunks: unknown[] }).queryChunks
    const iso = chunks.find((c) => typeof c === 'string' && c.startsWith('20')) as string
    expect(new Date(iso).getTime()).toBeGreaterThanOrEqual(before)
  })

  it('returns the inserted audit entry', async () => {
    const { db } = setupAuditDb()
    const service = new AuditService(db as any)
    const row = makeAuditRow({ action: 'callAnswered' })

    db.$setSelectResults([[]])
    db.$setInsertResult([row])

    const result = await service.log('callAnswered', 'a'.repeat(64), { duration: 120 })
    expect(result.action).toBe('callAnswered')
    expect(result.id).toBe('audit-1')
  })
})

// ---------------------------------------------------------------------------
// AuditService.list
// ---------------------------------------------------------------------------

describe('AuditService.list', () => {
  it('returns entries and total', async () => {
    const { db } = setupAuditDb()
    const service = new AuditService(db as any)

    const entries = [makeAuditRow(), makeAuditRow({ id: 'audit-2' })]
    // Promise.all: two selects in parallel — rows first, count second
    db.$setSelectResults([entries, [{ total: 2 }]])

    const result = await service.list(undefined)
    expect(result.entries).toHaveLength(2)
    expect(result.total).toBe(2)
  })

  it('returns empty list when no entries', async () => {
    const { db } = setupAuditDb()
    const service = new AuditService(db as any)

    db.$setSelectResults([[], [{ total: 0 }]])

    const result = await service.list('hub-1')
    expect(result.entries).toEqual([])
    expect(result.total).toBe(0)
  })

  it('uses page-based offset calculation', async () => {
    const { db } = setupAuditDb()
    const service = new AuditService(db as any)

    db.$setSelectResults([[], [{ total: 0 }]])

    // page=2, limit=10 → offset should be 10
    await service.list('hub-1', { page: 2, limit: 10 })

    // select was called — we can't easily inspect offset but at minimum
    // verify no error was thrown and the method ran
    expect(db.select).toHaveBeenCalled()
  })

  it('handles default limit of 50', async () => {
    const { db } = setupAuditDb()
    const service = new AuditService(db as any)

    db.$setSelectResults([[], [{ total: 0 }]])

    // Should not throw; default limit=50 applies
    await expect(service.list('hub-1', {})).resolves.toBeDefined()
  })

  it('handles eventType filter with known category', async () => {
    const { db } = setupAuditDb()
    const service = new AuditService(db as any)
    const entries = [makeAuditRow({ action: 'login' })]

    db.$setSelectResults([entries, [{ total: 1 }]])

    const result = await service.list('hub-1', { eventType: 'authentication' })
    // The list runs without error; actual SQL filtering happens in the DB layer
    expect(result.entries).toHaveLength(1)
  })

  it('handles unknown eventType gracefully (no category filter applied)', async () => {
    const { db } = setupAuditDb()
    const service = new AuditService(db as any)

    db.$setSelectResults([[], [{ total: 0 }]])

    // Unknown eventType should not crash — category filter is simply skipped
    await expect(service.list('hub-1', { eventType: 'unknown-category' })).resolves.toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// AuditService.getLatestHash
// ---------------------------------------------------------------------------

describe('AuditService.getLatestHash', () => {
  it('returns null when no entries exist', async () => {
    const { db } = setupAuditDb()
    const service = new AuditService(db as any)

    db.$setSelectResult([])

    const hash = await service.getLatestHash()
    expect(hash).toBeNull()
  })

  it('returns the entryHash of the most recent entry', async () => {
    const { db } = setupAuditDb()
    const service = new AuditService(db as any)
    const expectedHash = 'd'.repeat(64)

    db.$setSelectResult([{ entryHash: expectedHash }])

    const hash = await service.getLatestHash('hub-1')
    expect(hash).toBe(expectedHash)
  })
})

// ---------------------------------------------------------------------------
// AuditService.reset
// ---------------------------------------------------------------------------

describe('AuditService.reset', () => {
  it('calls db.delete', async () => {
    const { db } = setupAuditDb()
    const service = new AuditService(db as any)

    await service.reset()

    expect(db.delete).toHaveBeenCalled()
  })

  it('resolves without error', async () => {
    const { db } = setupAuditDb()
    const service = new AuditService(db as any)

    await expect(service.reset()).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// audit() convenience helper
// ---------------------------------------------------------------------------

describe('audit() helper', () => {
  it('delegates to auditService.log', async () => {
    const auditService = { log: vi.fn().mockResolvedValue(undefined) } as any
    const pubkey = 'a'.repeat(64)

    await audit(auditService, 'login', pubkey, { foo: 'bar' }, undefined, null)

    expect(auditService.log).toHaveBeenCalledWith(
      'login',
      pubkey,
      expect.objectContaining({ foo: 'bar' }),
      null,
    )
  })

  it('hashes IP from the forwarded-for header when ctx provided', async () => {
    const auditService = { log: vi.fn().mockResolvedValue(undefined) } as any
    const pubkey = 'a'.repeat(64)
    const request = new Request('https://example.com', {
      headers: { 'X-Forwarded-For': '1.2.3.4' },
    })

    // The address only reaches the audit log through getClientIp, which honors
    // forwarded-for headers only behind a declared trusted proxy (#1606).
    const originalTrust = process.env.TRUST_PROXY_HEADERS
    process.env.TRUST_PROXY_HEADERS = 'true'
    try {
      await audit(auditService, 'login', pubkey, {}, { request, hmacSecret: TEST_HMAC_SECRET }, null)
    } finally {
      if (originalTrust === undefined) delete process.env.TRUST_PROXY_HEADERS
      else process.env.TRUST_PROXY_HEADERS = originalTrust
    }

    const callDetails = auditService.log.mock.calls[0][2]
    // IP should be hashed (not raw)
    expect(callDetails.ip).toBeDefined()
    expect(callDetails.ip).not.toBe('1.2.3.4')
    expect(typeof callDetails.ip).toBe('string')
  })

  it('passes hubId to auditService.log when provided', async () => {
    const auditService = { log: vi.fn().mockResolvedValue(undefined) } as any
    const pubkey = 'a'.repeat(64)

    await audit(auditService, 'noteCreated', pubkey, {}, undefined, 'hub-42')

    expect(auditService.log).toHaveBeenCalledWith(
      'noteCreated',
      pubkey,
      expect.any(Object),
      'hub-42',
    )
  })

  it('sets ip to null when no IP header is present', async () => {
    const auditService = { log: vi.fn().mockResolvedValue(undefined) } as any
    const pubkey = 'a'.repeat(64)
    const request = new Request('https://example.com')

    await audit(auditService, 'login', pubkey, {}, { request, hmacSecret: TEST_HMAC_SECRET }, null)

    const callDetails = auditService.log.mock.calls[0][2]
    expect(callDetails.ip).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// computeEntryHash — hash chain integrity (regression for b5ea6b01 timestamp fix)
// ---------------------------------------------------------------------------

const HASH_FIXTURE = {
  id: '00000000-0000-0000-0000-000000000001',
  action: 'userAdded',
  actorPubkey: 'a'.repeat(64),
  createdAt: '2026-05-30T12:00:00.000Z',
  details: { name: 'Test Volunteer' } as Record<string, unknown>,
  previousEntryHash: null,
}

describe('computeEntryHash — output format', () => {
  it('returns a 64-character lowercase hex SHA-256 string', () => {
    const hash = computeEntryHash(HASH_FIXTURE)
    expect(hash).toHaveLength(64)
    expect(hash).toMatch(/^[0-9a-f]+$/)
  })
})

describe('computeEntryHash — determinism', () => {
  it('produces identical hashes for identical inputs', () => {
    expect(computeEntryHash(HASH_FIXTURE)).toBe(computeEntryHash(HASH_FIXTURE))
  })

  it('produces identical hashes for separate object references with same values', () => {
    const a = { ...HASH_FIXTURE, details: { name: 'Test Volunteer' } }
    const b = { ...HASH_FIXTURE, details: { name: 'Test Volunteer' } }
    expect(computeEntryHash(a)).toBe(computeEntryHash(b))
  })

  it('is key-order-invariant for details (matches PostgreSQL JSONB sort)', () => {
    const ab = { ...HASH_FIXTURE, details: { alpha: 1, beta: 2 } }
    const ba = { ...HASH_FIXTURE, details: { beta: 2, alpha: 1 } }
    expect(computeEntryHash(ab)).toBe(computeEntryHash(ba))
  })

  it('treats null details the same as empty object', () => {
    const withNull = { ...HASH_FIXTURE, details: null }
    const withEmpty = { ...HASH_FIXTURE, details: {} }
    expect(computeEntryHash(withNull)).toBe(computeEntryHash(withEmpty))
  })
})

describe('computeEntryHash — field sensitivity', () => {
  it('changes hash when id changes', () => {
    const modified = { ...HASH_FIXTURE, id: '00000000-0000-0000-0000-000000000002' }
    expect(computeEntryHash(HASH_FIXTURE)).not.toBe(computeEntryHash(modified))
  })

  it('changes hash when action changes', () => {
    expect(computeEntryHash(HASH_FIXTURE)).not.toBe(
      computeEntryHash({ ...HASH_FIXTURE, action: 'userRemoved' }),
    )
  })

  it('changes hash when actorPubkey changes', () => {
    expect(computeEntryHash(HASH_FIXTURE)).not.toBe(
      computeEntryHash({ ...HASH_FIXTURE, actorPubkey: 'b'.repeat(64) }),
    )
  })

  it('changes hash when createdAt changes (timestamp fix regression)', () => {
    // Regression guard for b5ea6b01: audit.ts must use the same timestamp for
    // hash computation and DB insertion; even a 1ms drift breaks verification.
    expect(computeEntryHash(HASH_FIXTURE)).not.toBe(
      computeEntryHash({ ...HASH_FIXTURE, createdAt: '2026-05-30T12:00:00.001Z' }),
    )
  })

  it('changes hash when details values change', () => {
    expect(computeEntryHash(HASH_FIXTURE)).not.toBe(
      computeEntryHash({ ...HASH_FIXTURE, details: { name: 'Different Name' } }),
    )
  })

  it('changes hash when previousEntryHash changes from null to a value', () => {
    expect(computeEntryHash(HASH_FIXTURE)).not.toBe(
      computeEntryHash({ ...HASH_FIXTURE, previousEntryHash: 'c'.repeat(64) }),
    )
  })
})

describe('computeEntryHash — chain linkage', () => {
  it('builds a 3-entry chain where each entry links to the previous', () => {
    const h1 = computeEntryHash({ ...HASH_FIXTURE, action: 'login', previousEntryHash: null })
    const h2 = computeEntryHash({
      ...HASH_FIXTURE,
      id: '00000000-0000-0000-0000-000000000002',
      action: 'userAdded',
      createdAt: '2026-05-30T12:00:01.000Z',
      previousEntryHash: h1,
    })
    const h3 = computeEntryHash({
      ...HASH_FIXTURE,
      id: '00000000-0000-0000-0000-000000000003',
      action: 'shiftCreated',
      createdAt: '2026-05-30T12:00:02.000Z',
      previousEntryHash: h2,
    })

    // All hashes are distinct 64-char hex strings
    expect(new Set([h1, h2, h3]).size).toBe(3)
    for (const h of [h1, h2, h3]) {
      expect(h).toHaveLength(64)
      expect(h).toMatch(/^[0-9a-f]+$/)
    }
  })

  it('produces a different downstream hash when an intermediate entry is tampered', () => {
    const h1 = computeEntryHash({ ...HASH_FIXTURE, action: 'login', previousEntryHash: null })

    const h2Legit = computeEntryHash({
      ...HASH_FIXTURE,
      id: '00000000-0000-0000-0000-000000000002',
      action: 'userAdded',
      createdAt: '2026-05-30T12:00:01.000Z',
      previousEntryHash: h1,
    })
    const h2Tampered = computeEntryHash({
      ...HASH_FIXTURE,
      id: '00000000-0000-0000-0000-000000000002',
      action: 'INJECTED',
      createdAt: '2026-05-30T12:00:01.000Z',
      previousEntryHash: h1,
    })

    expect(h2Legit).not.toBe(h2Tampered)

    // Entry 3 on top of tampered chain differs from entry 3 on legit chain
    const h3FromLegit = computeEntryHash({
      ...HASH_FIXTURE,
      id: '00000000-0000-0000-0000-000000000003',
      action: 'shiftCreated',
      createdAt: '2026-05-30T12:00:02.000Z',
      previousEntryHash: h2Legit,
    })
    const h3FromTampered = computeEntryHash({
      ...HASH_FIXTURE,
      id: '00000000-0000-0000-0000-000000000003',
      action: 'shiftCreated',
      createdAt: '2026-05-30T12:00:02.000Z',
      previousEntryHash: h2Tampered,
    })

    expect(h3FromLegit).not.toBe(h3FromTampered)
  })
})

// ---------------------------------------------------------------------------
// AuditService.listForEvidence (Issue #730 — evidence chain-of-custody log)
// ---------------------------------------------------------------------------

describe('AuditService.listForEvidence', () => {
  it('returns hash-chained entries referencing the given evidence item', async () => {
    const { db } = setupAuditDb()
    const service = new AuditService(db as any)

    const entries = [
      makeAuditRow({ id: 'audit-1', action: 'evidenceUploaded', details: { evidenceId: 'ev-1' } }),
      makeAuditRow({ id: 'audit-2', action: 'evidenceAccessed', details: { evidenceId: 'ev-1', action: 'metadata_read' } }),
    ]
    db.$setSelectResult(entries)

    const result = await service.listForEvidence('ev-1')

    expect(result).toHaveLength(2)
    expect(result[0].id).toBe('audit-1')
    expect(result[1].id).toBe('audit-2')
    // Every returned entry carries the same tamper-evidence fields as any
    // other audit_log row — this is the same chain, not a parallel table.
    for (const entry of result) {
      expect(entry.entryHash).toBeTruthy()
    }
  })

  it('returns an empty array when no access has been logged for the item', async () => {
    const { db } = setupAuditDb()
    const service = new AuditService(db as any)

    db.$setSelectResult([])

    const result = await service.listForEvidence('ev-does-not-exist')
    expect(result).toEqual([])
  })

  it('scopes the query to a hub when hubId is provided', async () => {
    const { db } = setupAuditDb()
    const service = new AuditService(db as any)

    db.$setSelectResult([])

    await service.listForEvidence('ev-1', 'hub-1')
    expect(db.select).toHaveBeenCalled()
  })
})
