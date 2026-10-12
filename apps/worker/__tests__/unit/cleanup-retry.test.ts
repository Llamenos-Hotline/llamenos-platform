/**
 * Unit tests for retry + circuit breaker integration in cleanup methods.
 *
 * Verifies that SettingsService.runCleanup() and IdentityService.cleanup()
 * use withRetry (exponential backoff) and a circuit breaker (fail-fast after
 * N consecutive failures). Both utilities are mocked so tests run
 * synchronously without actual delays or DB connections.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks — hoisted so vi.mock factories can reference them
// ---------------------------------------------------------------------------

const { mockCircuitExecute, mockGetCircuitBreaker, mockWithRetry } = vi.hoisted(() => {
  const mockCircuitExecute = vi.fn()
  const mockGetCircuitBreaker = vi.fn(() => ({ execute: mockCircuitExecute }))
  const mockWithRetry = vi.fn()
  return { mockCircuitExecute, mockGetCircuitBreaker, mockWithRetry }
})

vi.mock('@worker/lib/circuit-breaker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@worker/lib/circuit-breaker')>()
  return {
    ...actual,
    getCircuitBreaker: mockGetCircuitBreaker,
  }
})

vi.mock('@worker/lib/retry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@worker/lib/retry')>()
  return {
    ...actual,
    withRetry: mockWithRetry,
  }
})

import { CircuitOpenError } from '@worker/lib/circuit-breaker'

// Mock logger to suppress output in tests
vi.mock('@worker/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

// ---------------------------------------------------------------------------
// Lazy-import the services AFTER mocks are in place
// ---------------------------------------------------------------------------

async function importServices() {
  const { SettingsService } = await import('@worker/services/settings')
  const { IdentityService } = await import('@worker/services/identity')
  return { SettingsService, IdentityService }
}

// ---------------------------------------------------------------------------
// Minimal mock DB factory
// ---------------------------------------------------------------------------

function createMockDb() {
  const returning = vi.fn().mockResolvedValue([])
  const where = vi.fn().mockReturnValue({ returning })
  const singletonRow = {
    id: 'singleton',
    ttlOverrides: {},
    cleanupMetrics: null,
    spamSettings: null,
    callSettings: null,
    webauthnSettings: null,
  }
  const valuesChain = {
    returning: vi.fn().mockResolvedValue([singletonRow]),
    onConflictDoNothing: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([singletonRow]),
    }),
    onConflictDoUpdate: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([singletonRow]),
    }),
  }
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockImplementation(() => {
        // Support both `await db.select().from(tbl)` (direct await)
        // and `await db.select().from(tbl).where(...).limit(...)` (chained)
        const chain: {
          then: (resolve: (v: typeof singletonRow[]) => unknown) => unknown
          where: (...args: unknown[]) => { limit: (n: number) => Promise<typeof singletonRow[]>; returning: () => Promise<typeof singletonRow[]>; for: () => { limit: (n: number) => Promise<typeof singletonRow[]> }; orderBy: () => { limit: (n: number) => { offset: (n: number) => Promise<typeof singletonRow[]> } } }
          limit: (n: number) => Promise<typeof singletonRow[]>
          for: () => { limit: (n: number) => Promise<typeof singletonRow[]> }
          orderBy: () => { limit: (n: number) => { offset: (n: number) => Promise<typeof singletonRow[]> } }
        } = {
          then: (resolve) => resolve([]),
          where: () => ({
            limit: () => Promise.resolve([singletonRow]),
            returning: () => Promise.resolve([singletonRow]),
            for: () => ({ limit: () => Promise.resolve([singletonRow]) }),
            orderBy: () => ({ limit: () => ({ offset: () => Promise.resolve([singletonRow]) }) }),
          }),
          limit: () => Promise.resolve([singletonRow]),
          for: () => ({ limit: () => Promise.resolve([singletonRow]) }),
          orderBy: () => ({ limit: () => ({ offset: () => Promise.resolve([singletonRow]) }) }),
        }
        return chain
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
    }),
    delete: vi.fn().mockReturnValue({ where }),
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue(valuesChain) }),
    transaction: vi.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(createMockDb())),
    // runCleanup()'s rate-limit trim/delete is a single raw SQL CTE
    // (issue #1127 — the previous select-the-whole-table loop pulled every
    // distinct rate-limit key into app memory on every tick).
    execute: vi.fn().mockResolvedValue([]),
  }
}

// ---------------------------------------------------------------------------
// SettingsService.runCleanup()
// ---------------------------------------------------------------------------

describe('SettingsService.runCleanup() — retry + circuit breaker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default: circuit passes through to withRetry
    mockCircuitExecute.mockImplementation((fn: () => Promise<unknown>) => fn())
    // Default: withRetry passes through to the wrapped fn
    mockWithRetry.mockImplementation((fn: () => Promise<unknown>) => fn())
  })

  it('calls getCircuitBreaker with name "settings-cleanup"', async () => {
    const { SettingsService } = await importServices()
    const db = createMockDb()
    const svc = new SettingsService(db as never)

    await svc.runCleanup()

    expect(mockGetCircuitBreaker).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'settings-cleanup' }),
    )
  })

  it('calls getCircuitBreaker with failureThreshold 5', async () => {
    const { SettingsService } = await importServices()
    const db = createMockDb()
    const svc = new SettingsService(db as never)

    await svc.runCleanup()

    expect(mockGetCircuitBreaker).toHaveBeenCalledWith(
      expect.objectContaining({ failureThreshold: 5 }),
    )
  })

  it('executes cleanup through circuitBreaker.execute()', async () => {
    const { SettingsService } = await importServices()
    const db = createMockDb()
    const svc = new SettingsService(db as never)

    await svc.runCleanup()

    expect(mockCircuitExecute).toHaveBeenCalledTimes(1)
  })

  it('wraps cleanup in withRetry with maxAttempts 3', async () => {
    const { SettingsService } = await importServices()
    const db = createMockDb()
    const svc = new SettingsService(db as never)

    await svc.runCleanup()

    expect(mockWithRetry).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ maxAttempts: 3 }),
    )
  })

  it('passes isRetryable predicate to withRetry', async () => {
    const { SettingsService } = await importServices()
    const db = createMockDb()
    const svc = new SettingsService(db as never)

    await svc.runCleanup()

    expect(mockWithRetry).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isRetryable: expect.any(Function) }),
    )
  })

  it('propagates CircuitOpenError when circuit is open', async () => {
    mockCircuitExecute.mockRejectedValue(new CircuitOpenError('settings-cleanup'))

    const { SettingsService } = await importServices()
    const db = createMockDb()
    const svc = new SettingsService(db as never)

    await expect(svc.runCleanup()).rejects.toThrow(CircuitOpenError)
  })

  it('propagates DB error when withRetry exhausts attempts', async () => {
    const dbError = new Error('deadlock detected')
    mockWithRetry.mockRejectedValue(dbError)

    const { SettingsService } = await importServices()
    const db = createMockDb()
    const svc = new SettingsService(db as never)

    await expect(svc.runCleanup()).rejects.toThrow('deadlock detected')
  })

  it('returns metrics on success', async () => {
    const { SettingsService } = await importServices()
    const db = createMockDb()
    const svc = new SettingsService(db as never)

    const result = await svc.runCleanup()

    expect(result).toMatchObject({
      rateLimitEntriesDeleted: expect.any(Number),
      captchaChallengesDeleted: expect.any(Number),
    })
  })
})

// ---------------------------------------------------------------------------
// IdentityService.cleanup()
// ---------------------------------------------------------------------------

describe('IdentityService.cleanup() — retry + circuit breaker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCircuitExecute.mockImplementation((fn: () => Promise<unknown>) => fn())
    mockWithRetry.mockImplementation((fn: () => Promise<unknown>) => fn())
  })

  it('calls getCircuitBreaker with name "identity-cleanup"', async () => {
    const { IdentityService } = await importServices()
    const db = createMockDb()
    const svc = new IdentityService(db as never)

    await svc.cleanup()

    expect(mockGetCircuitBreaker).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'identity-cleanup' }),
    )
  })

  it('calls getCircuitBreaker with failureThreshold 5', async () => {
    const { IdentityService } = await importServices()
    const db = createMockDb()
    const svc = new IdentityService(db as never)

    await svc.cleanup()

    expect(mockGetCircuitBreaker).toHaveBeenCalledWith(
      expect.objectContaining({ failureThreshold: 5 }),
    )
  })

  it('executes cleanup through circuitBreaker.execute()', async () => {
    const { IdentityService } = await importServices()
    const db = createMockDb()
    const svc = new IdentityService(db as never)

    await svc.cleanup()

    expect(mockCircuitExecute).toHaveBeenCalledTimes(1)
  })

  it('wraps cleanup in withRetry with maxAttempts 3', async () => {
    const { IdentityService } = await importServices()
    const db = createMockDb()
    const svc = new IdentityService(db as never)

    await svc.cleanup()

    expect(mockWithRetry).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ maxAttempts: 3 }),
    )
  })

  it('passes isRetryable predicate to withRetry', async () => {
    const { IdentityService } = await importServices()
    const db = createMockDb()
    const svc = new IdentityService(db as never)

    await svc.cleanup()

    expect(mockWithRetry).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isRetryable: expect.any(Function) }),
    )
  })

  it('propagates CircuitOpenError when circuit is open', async () => {
    mockCircuitExecute.mockRejectedValue(new CircuitOpenError('identity-cleanup'))

    const { IdentityService } = await importServices()
    const db = createMockDb()
    const svc = new IdentityService(db as never)

    await expect(svc.cleanup()).rejects.toThrow(CircuitOpenError)
  })

  it('propagates DB error when withRetry exhausts attempts', async () => {
    const dbError = new Error('too many connections')
    mockWithRetry.mockRejectedValue(dbError)

    const { IdentityService } = await importServices()
    const db = createMockDb()
    const svc = new IdentityService(db as never)

    await expect(svc.cleanup()).rejects.toThrow('too many connections')
  })

  it('returns cleanup counts on success', async () => {
    const { IdentityService } = await importServices()
    const db = createMockDb()
    const svc = new IdentityService(db as never)

    const result = await svc.cleanup()

    expect(result).toMatchObject({
      expiredSessions: expect.any(Number),
      expiredChallenges: expect.any(Number),
      expiredProvisionRooms: expect.any(Number),
      expiredInvites: expect.any(Number),
    })
  })
})

// ---------------------------------------------------------------------------
// Circuit breaker onStateChange — alert logging on open
// ---------------------------------------------------------------------------

describe('Cleanup circuit breaker — onStateChange alert', () => {
  it('onStateChange callback triggers log.error when circuit opens for settings-cleanup', async () => {
    let capturedCallback: ((name: string, from: string, to: string) => void) | undefined

    mockGetCircuitBreaker.mockImplementation(((opts: { onStateChange?: (name: string, from: string, to: string) => void }) => {
      capturedCallback = opts.onStateChange
      return { execute: mockCircuitExecute }
    }) as never)
    mockCircuitExecute.mockImplementation((fn: () => Promise<unknown>) => fn())
    mockWithRetry.mockImplementation((fn: () => Promise<unknown>) => fn())

    const { SettingsService } = await importServices()
    const db = createMockDb()
    const svc = new SettingsService(db as never)
    await svc.runCleanup()

    expect(capturedCallback).toBeDefined()
    // Should not throw when invoked — invoke with type assertion to satisfy TS after toBeDefined check
    const cb = capturedCallback as (name: string, from: string, to: string) => void
    expect(() => cb('settings-cleanup', 'closed', 'open')).not.toThrow()
    expect(() => cb('settings-cleanup', 'open', 'closed')).not.toThrow()
  })

  it('onStateChange callback triggers log.error when circuit opens for identity-cleanup', async () => {
    let capturedCallback: ((name: string, from: string, to: string) => void) | undefined

    mockGetCircuitBreaker.mockImplementation(((opts: { onStateChange?: (name: string, from: string, to: string) => void }) => {
      capturedCallback = opts.onStateChange
      return { execute: mockCircuitExecute }
    }) as never)
    mockCircuitExecute.mockImplementation((fn: () => Promise<unknown>) => fn())
    mockWithRetry.mockImplementation((fn: () => Promise<unknown>) => fn())

    const { IdentityService } = await importServices()
    const db = createMockDb()
    const svc = new IdentityService(db as never)
    await svc.cleanup()

    expect(capturedCallback).toBeDefined()
    const cb = capturedCallback as (name: string, from: string, to: string) => void
    expect(() => cb('identity-cleanup', 'closed', 'open')).not.toThrow()
    expect(() => cb('identity-cleanup', 'open', 'closed')).not.toThrow()
  })
})
