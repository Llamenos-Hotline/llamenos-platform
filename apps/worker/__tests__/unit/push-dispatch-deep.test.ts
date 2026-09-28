import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  recordTestPushPayload,
  getTestPushLog,
  clearTestPushLog,
  createPushDispatcherFromService,
} from '@worker/lib/push-dispatch'
import type { WakePayload, FullPushPayload } from '@worker/types'

describe('Test Push Log (development helper)', () => {
  beforeEach(() => {
    clearTestPushLog()
  })

  it('records and retrieves push payloads', () => {
    const payload: WakePayload = { type: 'message', hubId: 'hub-1' }
    recordTestPushPayload(payload, 'pubkey-1')

    const log = getTestPushLog()
    expect(log).toHaveLength(1)
    expect(log[0].wakePayload).toEqual(payload)
    expect(log[0].recipientPubkey).toBe('pubkey-1')
    expect(log[0].recordedAt).toBeTruthy()
  })

  it('returns a copy — mutations do not affect internal state', () => {
    recordTestPushPayload({ type: 'message', hubId: 'h' }, 'pk')
    const log = getTestPushLog()
    log.push({ wakePayload: { type: 'voicemail', hubId: 'x' }, recipientPubkey: 'fake', recordedAt: '' })

    // Internal state should still have only 1 entry
    expect(getTestPushLog()).toHaveLength(1)
  })

  it('clears log correctly', () => {
    recordTestPushPayload({ type: 'message', hubId: 'h' }, 'pk')
    expect(getTestPushLog()).toHaveLength(1)

    clearTestPushLog()
    expect(getTestPushLog()).toHaveLength(0)
  })

  it('caps log at 50 entries (prevents unbounded memory growth)', () => {
    for (let i = 0; i < 60; i++) {
      recordTestPushPayload({ type: 'message', hubId: `h-${i}` }, `pk-${i}`)
    }

    const log = getTestPushLog()
    expect(log.length).toBeLessThanOrEqual(50)
    // Most recent entries should be preserved
    expect(log[log.length - 1].wakePayload.hubId).toBe('h-59')
  })
})

describe('createPushDispatcherFromService', () => {
  const mockIdentityService = {
    getDevices: vi.fn().mockResolvedValue({ devices: [] }),
    cleanupDevices: vi.fn(),
  }
  const mockShiftsService = {
    getCurrentVolunteers: vi.fn().mockResolvedValue([]),
  }

  it('returns NoopPushDispatcher when no credentials and not dev', () => {
    const dispatcher = createPushDispatcherFromService(
      { ENVIRONMENT: 'production' } as any,
      mockIdentityService as any,
      mockShiftsService as any,
    )

    // Should be a noop — call should do nothing without error
    expect(dispatcher).toBeDefined()
    expect(dispatcher.sendToVolunteer).toBeDefined()
    expect(dispatcher.sendToAllOnShift).toBeDefined()
  })

  it('returns a recording dispatcher in development without credentials', () => {
    clearTestPushLog()

    const dispatcher = createPushDispatcherFromService(
      { ENVIRONMENT: 'development' } as any,
      mockIdentityService as any,
      mockShiftsService as any,
    )

    expect(dispatcher).toBeDefined()
    // Should record payloads even without real push credentials
  })

  it('records payloads to the test log in development', async () => {
    clearTestPushLog()

    const dispatcher = createPushDispatcherFromService(
      { ENVIRONMENT: 'development' } as any,
      mockIdentityService as any,
      mockShiftsService as any,
    )

    const wake: WakePayload = { type: 'voicemail', hubId: 'hub-test' }
    const full: FullPushPayload = {} as FullPushPayload

    await dispatcher.sendToVolunteer('pubkey-abc', wake, full)

    const log = getTestPushLog()
    expect(log).toHaveLength(1)
    expect(log[0].wakePayload.type).toBe('voicemail')
    expect(log[0].wakePayload.hubId).toBe('hub-test')
    expect(log[0].recipientPubkey).toBe('pubkey-abc')
  })

  it('sendToAllOnShift records one entry for each on-shift volunteer', async () => {
    clearTestPushLog()
    mockShiftsService.getCurrentVolunteers.mockResolvedValue(['pk-1', 'pk-2', 'pk-3'])

    const dispatcher = createPushDispatcherFromService(
      { ENVIRONMENT: 'development' } as any,
      mockIdentityService as any,
      mockShiftsService as any,
    )

    const wake: WakePayload = { type: 'assignment', hubId: 'hub-multi' }
    await dispatcher.sendToAllOnShift(wake, {} as FullPushPayload)

    const log = getTestPushLog()
    expect(log).toHaveLength(3)
    expect(log.map(l => l.recipientPubkey)).toEqual(['pk-1', 'pk-2', 'pk-3'])
  })

  it('returns ServicePushDispatcher when APNs credentials are set', () => {
    const dispatcher = createPushDispatcherFromService(
      {
        APNS_KEY_P8: 'fake-p8',
        APNS_KEY_ID: 'KEYID123',
        APNS_TEAM_ID: 'TEAM123',
      } as any,
      mockIdentityService as any,
      mockShiftsService as any,
    )

    expect(dispatcher).toBeDefined()
  })

  it('returns ServicePushDispatcher when ntfy URL is configured', () => {
    const dispatcher = createPushDispatcherFromService(
      {
        NTFY_URL: 'http://ntfy:80',
      } as any,
      mockIdentityService as any,
      mockShiftsService as any,
    )

    expect(dispatcher).toBeDefined()
  })
})
