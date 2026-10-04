/**
 * Unit tests for apps/worker/lib/push-dispatch.ts
 *
 * Tests push dispatcher factory, NoopPushDispatcher, RecordingPushDispatcher,
 * and test push log management.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createPushDispatcherFromService,
  recordTestPushPayload,
  getTestPushLog,
  clearTestPushLog,
} from '@worker/lib/push-dispatch'
import type { WakePayload, FullPushPayload, Env } from '@worker/types/infra'

// Mock push-encryption (not needed for unit tests)
vi.mock('@worker/lib/push-encryption', () => ({
  encryptWakePayload: () => 'encrypted-wake',
  encryptFullPayload: () => 'encrypted-full',
}))

vi.mock('@worker/lib/ntfy-client', () => {
  const NtfyClient = vi.fn()
  NtfyClient.prototype.send = vi.fn().mockResolvedValue(true)
  NtfyClient.prototype.publishToTopic = vi.fn().mockResolvedValue(true)
  return { NtfyClient }
})

// ---------------------------------------------------------------------------
// Test push log
// ---------------------------------------------------------------------------

describe('test push log', () => {
  beforeEach(() => clearTestPushLog())

  it('records and retrieves push payloads', () => {
    const payload: WakePayload = { hubId: 'h1', type: 'message' }
    recordTestPushPayload(payload, 'pk-1')

    const log = getTestPushLog()
    expect(log).toHaveLength(1)
    expect(log[0].wakePayload.hubId).toBe('h1')
    expect(log[0].recipientPubkey).toBe('pk-1')
    expect(log[0].recordedAt).toBeDefined()
  })

  it('returns a copy (not the internal array)', () => {
    recordTestPushPayload({ hubId: 'h1', type: 'message' }, 'pk-1')
    const log1 = getTestPushLog()
    const log2 = getTestPushLog()
    expect(log1).not.toBe(log2)
    expect(log1).toEqual(log2)
  })

  it('clears the log', () => {
    recordTestPushPayload({ hubId: 'h1', type: 'message' }, 'pk-1')
    clearTestPushLog()
    expect(getTestPushLog()).toHaveLength(0)
  })

  it('caps at 50 entries', () => {
    for (let i = 0; i < 60; i++) {
      recordTestPushPayload({ hubId: `h${i}`, type: 'message' }, `pk-${i}`)
    }
    const log = getTestPushLog()
    expect(log.length).toBe(50)
    // Should retain the most recent entries
    expect(log[49].wakePayload.hubId).toBe('h59')
  })
})

// ---------------------------------------------------------------------------
// createPushDispatcherFromService
// ---------------------------------------------------------------------------

describe('createPushDispatcherFromService', () => {
  const mockIdentityService = {
    getDevices: vi.fn().mockResolvedValue({ devices: [] }),
    cleanupDevices: vi.fn(),
  } as never

  const mockShiftsService = {
    getCurrentVolunteers: vi.fn().mockResolvedValue([]),
  } as never

  it('returns NoopPushDispatcher when no push credentials in production', () => {
    const env = { ENVIRONMENT: 'production' } as Env
    const dispatcher = createPushDispatcherFromService(env, mockIdentityService, mockShiftsService)
    // Should be a noop — calling methods should not throw
    expect(dispatcher.sendToVolunteer('pk', {} as WakePayload, {} as FullPushPayload)).resolves.toBeUndefined()
    expect(dispatcher.sendToAllOnShift({} as WakePayload, {} as FullPushPayload)).resolves.toBeUndefined()
  })

  it('returns a recording dispatcher in development without credentials', () => {
    clearTestPushLog()
    const env = { ENVIRONMENT: 'development' } as Env
    const dispatcher = createPushDispatcherFromService(env, mockIdentityService, mockShiftsService)

    // The development wrapper records to the test push log
    const payload: WakePayload = { hubId: 'h1', type: 'message' }
    dispatcher.sendToVolunteer('test-pk', payload, {} as FullPushPayload)

    // The logging dispatcher should record the payload
    const log = getTestPushLog()
    expect(log.length).toBeGreaterThanOrEqual(1)
  })

  it('returns ServicePushDispatcher when APNs credentials are present', () => {
    const env = {
      ENVIRONMENT: 'production',
      APNS_KEY_P8: 'key',
      APNS_KEY_ID: 'kid',
      APNS_TEAM_ID: 'team',
    } as Env
    const dispatcher = createPushDispatcherFromService(env, mockIdentityService, mockShiftsService)
    // Should be the real dispatcher, not noop
    expect(dispatcher).toBeDefined()
    expect(typeof dispatcher.sendToVolunteer).toBe('function')
  })

  it('returns ServicePushDispatcher when ntfy URL is configured', () => {
    const env = {
      ENVIRONMENT: 'production',
      NTFY_URL: 'http://ntfy:80',
    } as Env
    const dispatcher = createPushDispatcherFromService(env, mockIdentityService, mockShiftsService)
    expect(dispatcher).toBeDefined()
  })

  // Regression guard: the test push log used to be written only by a dev-only
  // dispatcher that was selected exclusively when BOTH transports were
  // unconfigured. Setting a single transport variable therefore emptied the log
  // permanently and silently — the hubId contract went unobserved in every
  // configuration that ships. In development the payload must be recorded
  // whichever transport is configured.
  it.each([
    ['ntfy configured', { ENVIRONMENT: 'development', NTFY_URL: 'http://ntfy:80' }],
    ['APNs configured', {
      ENVIRONMENT: 'development',
      APNS_KEY_P8: 'key',
      APNS_KEY_ID: 'kid',
      APNS_TEAM_ID: 'team',
    }],
    ['no transport configured', { ENVIRONMENT: 'development' }],
  ])('records the wake payload in development with %s', async (_label, envFields) => {
    clearTestPushLog()
    const dispatcher = createPushDispatcherFromService(
      envFields as Env,
      mockIdentityService,
      mockShiftsService,
    )

    const payload: WakePayload = { hubId: 'hub-xyz', type: 'message' }
    await dispatcher.sendToVolunteer('recipient-pk', payload, {} as FullPushPayload)

    const log = getTestPushLog()
    expect(log).toHaveLength(1)
    expect(log[0].wakePayload.hubId).toBe('hub-xyz')
    expect(log[0].recipientPubkey).toBe('recipient-pk')
  })

  it('does not record outside development even with no transport configured', async () => {
    clearTestPushLog()
    const dispatcher = createPushDispatcherFromService(
      { ENVIRONMENT: 'production' } as Env,
      mockIdentityService,
      mockShiftsService,
    )
    await dispatcher.sendToVolunteer('pk', { hubId: 'h', type: 'message' }, {} as FullPushPayload)
    expect(getTestPushLog()).toHaveLength(0)
  })

  it('records one entry per on-shift volunteer in development with a transport configured', async () => {
    clearTestPushLog()
    const shifts = {
      getCurrentVolunteers: vi.fn().mockResolvedValue(['pk-1', 'pk-2']),
    } as never
    const dispatcher = createPushDispatcherFromService(
      { ENVIRONMENT: 'development', NTFY_URL: 'http://ntfy:80' } as Env,
      mockIdentityService,
      shifts,
    )

    await dispatcher.sendToAllOnShift({ hubId: 'hub-multi', type: 'assignment' }, {} as FullPushPayload)

    const log = getTestPushLog()
    expect(log.map(l => l.recipientPubkey)).toEqual(['pk-1', 'pk-2'])
    expect(log.every(l => l.wakePayload.hubId === 'hub-multi')).toBe(true)
  })
})
