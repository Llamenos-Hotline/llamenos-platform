import { describe, it, expect, vi, beforeEach } from 'vitest'
import { startParallelRinging } from '../../services/ringing'
import { hashPhone } from '../../lib/crypto'
import type { Env } from '../../types'
import type { Services } from '../../services'
import * as serviceFactories from '../../lib/service-factories'
import { DEFAULT_ROLES } from '@shared/permissions'
import type { Role } from '@shared/permissions'
import { incCounter } from '../../routes/metrics'
import { publishEvent } from '../../lib/ws-events'
import { KIND_CALL_RING } from '@shared/event-kinds'

const TEST_HMAC_SECRET = 'a'.repeat(64)

const mockAdapter = (serviceFactories as unknown as { __mockAdapter: { ringVolunteers: ReturnType<typeof vi.fn> } }).__mockAdapter

vi.mock('../../lib/service-factories', () => {
  const mockAdapter = {
    ringVolunteers: vi.fn().mockResolvedValue(undefined),
  }
  return {
    getTelephonyFromService: vi.fn().mockResolvedValue(mockAdapter),
    getHubTelephonyFromService: vi.fn().mockResolvedValue(mockAdapter),
    __mockAdapter: mockAdapter,
  }
})

vi.mock('../../lib/voip-push', () => ({
  dispatchVoipPushFromService: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../lib/ws-events', () => ({
  publishEvent: vi.fn(),
}))

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

vi.mock('../../routes/metrics', () => ({
  incCounter: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEnv(overrides?: Partial<Env>): Env {
  return {
    SERVER_SECRET: 'a'.repeat(64),
    HMAC_SECRET: TEST_HMAC_SECRET,
    ...overrides,
  } as Env
}

function makeUser(overrides: {
  pubkey: string
  active?: boolean
  onBreak?: boolean
  callPreference?: string
  phone?: string | null
  /** Global role ids. Default: the instance-wide volunteer role. */
  roles?: string[]
  hubRoles?: { hubId: string; roleIds: string[] }[]
}) {
  return {
    pubkey: overrides.pubkey,
    name: overrides.pubkey,
    active: overrides.active ?? true,
    onBreak: overrides.onBreak ?? false,
    callPreference: overrides.callPreference ?? 'phone',
    phone: 'phone' in overrides ? overrides.phone : '+15551234567',
    roles: overrides.roles ?? ['role-volunteer'],
    hubRoles: overrides.hubRoles ?? [],
  }
}

function makeServices(overrides: {
  onShiftPubkeys?: string[]
  fallbackPubkeys?: string[]
  allUsers?: ReturnType<typeof makeUser>[]
}): Services {
  const {
    onShiftPubkeys = [],
    fallbackPubkeys = [],
    allUsers = [],
  } = overrides

  return {
    shifts: {
      getCurrentVolunteers: vi.fn().mockResolvedValue(onShiftPubkeys),
    },
    settings: {
      getFallbackGroup: vi.fn().mockResolvedValue({ userPubkeys: fallbackPubkeys }),
      getRoles: vi.fn().mockResolvedValue({ roles: DEFAULT_ROLES as unknown as Role[] }),
    },
    identity: {
      getUsers: vi.fn().mockResolvedValue({ users: allUsers }),
    },
    calls: {
      addCall: vi.fn().mockResolvedValue({ callId: 'CA-test' }),
      createCallToken: vi.fn().mockResolvedValue('token-abc'),
    },
  } as unknown as Services
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('startParallelRinging', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('creates the call record even when no volunteers are on shift and there is no fallback (#1043)', async () => {
    const services = makeServices({
      onShiftPubkeys: [],
      fallbackPubkeys: [],
    })

    const result = await startParallelRinging('CA-1', '+15551234567', 'http://localhost', makeEnv(), services, 'hub-1')

    expect(result).toEqual({ ringing: false, reason: 'no-volunteers', volunteersNotified: 0 })
    // The caller is queued and will leave a voicemail — a record must exist to attach it to
    expect(services.calls.addCall).toHaveBeenCalledWith('hub-1', {
      callId: 'CA-1',
      callerNumber: hashPhone('+15551234567', TEST_HMAC_SECRET),
      callerLast4: '4567',
      status: 'ringing',
    })
    // ...but nobody is rung and no ring event is published
    expect(mockAdapter.ringVolunteers).not.toHaveBeenCalled()
    expect(publishEvent).not.toHaveBeenCalled()
    // ...and the operational emergency is counted for alerting
    expect(incCounter).toHaveBeenCalledWith('llamenos_calls_unroutable_total', { reason: 'no-volunteers' })
  })

  it('uses fallback group when no one is on shift', async () => {
    const services = makeServices({
      onShiftPubkeys: [],
      fallbackPubkeys: ['pk-fallback'],
      allUsers: [
        makeUser({ pubkey: 'pk-fallback', active: true, phone: '+15559999999' }),
      ],
    })

    await startParallelRinging('CA-2', '+15551234567', 'http://localhost', makeEnv(), services, 'hub-1')

    // The hub's own group — not the instance-wide one (#1017).
    expect(services.settings.getFallbackGroup).toHaveBeenCalledWith('hub-1')
    expect(services.calls.addCall).toHaveBeenCalled()
  })

  describe('hub membership (#1017)', () => {
    it("rings the called hub's fallback group and nobody from another hub", async () => {
      // hub-B's group is configured; the instance/hub-A group must never be consulted for it.
      const services = makeServices({
        onShiftPubkeys: [],
        fallbackPubkeys: ['pk-hubB-fallback'],
        allUsers: [
          makeUser({ pubkey: 'pk-hubB-fallback', roles: [], hubRoles: [{ hubId: 'hub-B', roleIds: ['role-volunteer'] }] }),
          makeUser({ pubkey: 'pk-hubA-only', roles: [], hubRoles: [{ hubId: 'hub-A', roleIds: ['role-volunteer'] }] }),
        ],
      })

      const result = await startParallelRinging('CA-hb1', '+15551234567', 'http://localhost', makeEnv(), services, 'hub-B')

      expect(services.settings.getFallbackGroup).toHaveBeenCalledWith('hub-B')
      expect(result).toEqual({ ringing: true, volunteersNotified: 1 })
      const rung = (services.calls.createCallToken as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0].volunteerPubkey)
      expect(rung).toEqual(['pk-hubB-fallback'])
    })

    it('does not ring a fallback volunteer who is not a member of the called hub', async () => {
      const services = makeServices({
        onShiftPubkeys: [],
        fallbackPubkeys: ['pk-hubA-only'],
        allUsers: [
          makeUser({ pubkey: 'pk-hubA-only', roles: [], hubRoles: [{ hubId: 'hub-A', roleIds: ['role-volunteer'] }] }),
        ],
      })

      const result = await startParallelRinging('CA-hb2', '+15551234567', 'http://localhost', makeEnv(), services, 'hub-B')

      expect(result).toEqual({ ringing: false, reason: 'no-available-volunteers', volunteersNotified: 0 })
      // The call record exists before ringing is attempted (#1043) — nobody is rung for it
      expect(services.calls.addCall).toHaveBeenCalledTimes(1)
      expect(incCounter).toHaveBeenCalledWith('llamenos_calls_unroutable_total', { reason: 'no-available-volunteers' })
      expect(mockAdapter.ringVolunteers).not.toHaveBeenCalled()
    })

    it('does not ring an on-shift entry whose user has left the hub', async () => {
      const services = makeServices({
        onShiftPubkeys: ['pk-left', 'pk-member'],
        allUsers: [
          makeUser({ pubkey: 'pk-left', roles: [], hubRoles: [] }),
          makeUser({ pubkey: 'pk-member', roles: [], hubRoles: [{ hubId: 'hub-B', roleIds: ['role-volunteer'] }] }),
        ],
      })

      const result = await startParallelRinging('CA-hb3', '+15551234567', 'http://localhost', makeEnv(), services, 'hub-B')

      expect(result).toEqual({ ringing: true, volunteersNotified: 1 })
    })

    it('rings a super admin who has no hub-scoped role (all-hub access)', async () => {
      const services = makeServices({
        onShiftPubkeys: [],
        fallbackPubkeys: ['pk-admin'],
        allUsers: [makeUser({ pubkey: 'pk-admin', roles: ['role-super-admin'], hubRoles: [] })],
      })

      const result = await startParallelRinging('CA-hb4', '+15551234567', 'http://localhost', makeEnv(), services, 'hub-B')

      expect(result).toEqual({ ringing: true, volunteersNotified: 1 })
    })
  })

  it('rings the fallback group when everyone on shift is on break (#1055)', async () => {
    const services = makeServices({
      onShiftPubkeys: ['pk-break'],
      fallbackPubkeys: ['pk-fallback'],
      allUsers: [
        makeUser({ pubkey: 'pk-break', onBreak: true }),
        makeUser({ pubkey: 'pk-fallback', phone: '+15559999999' }),
      ],
    })

    const result = await startParallelRinging('CA-fb1', '+15551234567', 'http://localhost', makeEnv(), services, 'hub-1')

    expect(services.settings.getFallbackGroup).toHaveBeenCalledWith('hub-1')
    expect(result).toEqual({ ringing: true, volunteersNotified: 1 })
    const tokenArgs = (services.calls.createCallToken as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0].volunteerPubkey)
    expect(tokenArgs).toEqual(['pk-fallback'])
  })

  it('applies the same availability rules to the fallback group', async () => {
    const services = makeServices({
      onShiftPubkeys: ['pk-break'],
      fallbackPubkeys: ['pk-fb-break', 'pk-fb-inactive'],
      allUsers: [
        makeUser({ pubkey: 'pk-break', onBreak: true }),
        makeUser({ pubkey: 'pk-fb-break', onBreak: true }),
        makeUser({ pubkey: 'pk-fb-inactive', active: false }),
      ],
    })

    const result = await startParallelRinging('CA-fb2', '+15551234567', 'http://localhost', makeEnv(), services, 'hub-1')

    expect(result).toEqual({ ringing: false, reason: 'no-available-volunteers', volunteersNotified: 0 })
    // The call record still exists so a voicemail has somewhere to land (#1043)
    expect(services.calls.addCall).toHaveBeenCalledTimes(1)
    expect(mockAdapter.ringVolunteers).not.toHaveBeenCalled()
    expect(incCounter).toHaveBeenCalledWith('llamenos_calls_unroutable_total', { reason: 'no-available-volunteers' })
  })

  it('does not consult the fallback group when an on-shift volunteer is available', async () => {
    const services = makeServices({
      onShiftPubkeys: ['pk-1'],
      fallbackPubkeys: ['pk-fallback'],
      allUsers: [makeUser({ pubkey: 'pk-1' }), makeUser({ pubkey: 'pk-fallback' })],
    })

    await startParallelRinging('CA-fb3', '+15551234567', 'http://localhost', makeEnv(), services, 'hub-1')

    expect(services.settings.getFallbackGroup).not.toHaveBeenCalled()
    expect(mockAdapter.ringVolunteers.mock.calls[0][0].volunteers).toHaveLength(1)
  })

  it('filters out inactive volunteers', async () => {
    const services = makeServices({
      onShiftPubkeys: ['pk-active', 'pk-inactive'],
      allUsers: [
        makeUser({ pubkey: 'pk-active', active: true }),
        makeUser({ pubkey: 'pk-inactive', active: false }),
      ],
    })

    await startParallelRinging('CA-3', '+15551234567', 'http://localhost', makeEnv(), services, 'hub-1')

    // Call should be registered
    expect(services.calls.addCall).toHaveBeenCalled()
    // Only 1 volunteer should be rung (pk-active only)
    expect(mockAdapter.ringVolunteers).toHaveBeenCalled()
    const ringArgs = mockAdapter.ringVolunteers.mock.calls[0][0]
    expect(ringArgs.volunteers).toHaveLength(1)
  })

  it('filters out volunteers on break', async () => {
    const services = makeServices({
      onShiftPubkeys: ['pk-working', 'pk-break'],
      allUsers: [
        makeUser({ pubkey: 'pk-working', active: true, onBreak: false }),
        makeUser({ pubkey: 'pk-break', active: true, onBreak: true }),
      ],
    })

    await startParallelRinging('CA-4', '+15551234567', 'http://localhost', makeEnv(), services, 'hub-1')

    expect(mockAdapter.ringVolunteers).toHaveBeenCalled()
    const ringArgs = mockAdapter.ringVolunteers.mock.calls[0][0]
    expect(ringArgs.volunteers).toHaveLength(1)
  })

  it('only rings phones for volunteers with phone preference and a phone number', async () => {
    const services = makeServices({
      onShiftPubkeys: ['pk-phone', 'pk-browser', 'pk-both', 'pk-nophone'],
      allUsers: [
        makeUser({ pubkey: 'pk-phone', callPreference: 'phone', phone: '+15551111111' }),
        makeUser({ pubkey: 'pk-browser', callPreference: 'browser', phone: '+15552222222' }),
        makeUser({ pubkey: 'pk-both', callPreference: 'both', phone: '+15553333333' }),
        makeUser({ pubkey: 'pk-nophone', callPreference: 'phone', phone: null }),
      ],
    })

    await startParallelRinging('CA-5', '+15551234567', 'http://localhost', makeEnv(), services, 'hub-1')

    // Should create tokens for pk-phone and pk-both (phone or both + has phone)
    // pk-browser has browser pref (no phone ring), pk-nophone has no phone number
    // Also verify the adapter was called with the correct number of volunteers
    expect(mockAdapter.ringVolunteers).toHaveBeenCalled()
    const ringArgs = mockAdapter.ringVolunteers.mock.calls[0][0]
    expect(ringArgs.volunteers).toHaveLength(2)
  })

  it('registers the incoming call with hashed callerNumber (not plaintext)', async () => {
    const services = makeServices({
      onShiftPubkeys: ['pk-1'],
      allUsers: [makeUser({ pubkey: 'pk-1' })],
    })

    const rawPhone = '+15559876543'
    await startParallelRinging('CA-6', rawPhone, 'http://localhost', makeEnv(), services, 'hub-1')

    const expectedHash = hashPhone(rawPhone, TEST_HMAC_SECRET)
    expect(services.calls.addCall).toHaveBeenCalledWith('hub-1', {
      callId: 'CA-6',
      callerNumber: expectedHash,
      callerLast4: '6543',
      status: 'ringing',
    })
    // Verify the hash does not leak the raw number
    expect(expectedHash).not.toContain(rawPhone)
  })

  it('extracts last 4 digits of caller number', async () => {
    const services = makeServices({
      onShiftPubkeys: ['pk-1'],
      allUsers: [makeUser({ pubkey: 'pk-1' })],
    })

    await startParallelRinging('CA-7', '+13035551234', 'http://localhost', makeEnv(), services, 'hub-1')

    const addCallArgs = (services.calls.addCall as ReturnType<typeof vi.fn>).mock.calls[0][1]
    expect(addCallArgs.callerLast4).toBe('1234')
  })

  it('publishes call:ring to the hub that owns the call (#1013)', async () => {
    const { publishEvent } = await import('../../lib/ws-events')
    const services = makeServices({
      onShiftPubkeys: ['pk-1'],
      allUsers: [makeUser({ pubkey: 'pk-1', callPreference: 'browser' })],
    })

    await startParallelRinging('CA-ring', '+15551234567', 'http://localhost', makeEnv(), services, 'hub-1')

    expect(publishEvent).toHaveBeenCalledTimes(1)
    expect(publishEvent).toHaveBeenCalledWith(
      expect.anything(),
      KIND_CALL_RING,
      { type: 'call:ring', callId: 'CA-ring' },
      'hub-1',
    )
  })

  it('does not publish call:ring when the call resolved to no hub (#1013)', async () => {
    const { publishEvent } = await import('../../lib/ws-events')
    const services = makeServices({
      onShiftPubkeys: ['pk-1'],
      allUsers: [makeUser({ pubkey: 'pk-1', callPreference: 'browser' })],
    })

    await startParallelRinging('CA-nohub', '+15551234567', 'http://localhost', makeEnv(), services, '')

    expect(publishEvent).not.toHaveBeenCalled()
  })

  it('skips VoIP push for global-scope calls (empty hubId)', async () => {
    const { dispatchVoipPushFromService } = await import('../../lib/voip-push')

    const services = makeServices({
      onShiftPubkeys: ['pk-1'],
      allUsers: [makeUser({ pubkey: 'pk-1', callPreference: 'both' })],
    })

    await startParallelRinging('CA-8', '+15551234567', 'http://localhost', makeEnv(), services, '')

    // VoIP push should NOT be dispatched for empty hubId
    expect(dispatchVoipPushFromService).not.toHaveBeenCalled()
  })

  it('does not throw on errors (catches internally)', async () => {
    const services = makeServices({
      onShiftPubkeys: ['pk-1'],
    })
    // Make identity.getUsers throw
    ;(services.identity.getUsers as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('DB connection failed'),
    )

    // Should not throw — errors are caught, logged, and reported in the outcome
    await expect(
      startParallelRinging('CA-9', '+15551234567', 'http://localhost', makeEnv(), services, 'hub-1'),
    ).resolves.toEqual({ ringing: false, reason: 'error', volunteersNotified: 0 })
    // The record is created before anything that can fail, so the call is still tracked
    expect(services.calls.addCall).toHaveBeenCalledTimes(1)
  })

  it('creates the call record before consulting shifts or users', async () => {
    const order: string[] = []
    const services = makeServices({ onShiftPubkeys: [] })
    ;(services.calls.addCall as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push('addCall') })
    ;(services.shifts.getCurrentVolunteers as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push('shifts'); return [] })

    await startParallelRinging('CA-order', '+15551234567', 'http://localhost', makeEnv(), services, 'hub-1')

    expect(order).toEqual(['addCall', 'shifts'])
  })

  it('skips volunteers with empty pubkey — no token created', async () => {
    const services = makeServices({
      onShiftPubkeys: [''],
      allUsers: [makeUser({ pubkey: '', active: true, phone: '+15551111111' })],
    })

    await startParallelRinging('CA-10', '+15551234567', 'http://localhost', makeEnv(), services, 'hub-1')

    // Volunteers with falsy pubkeys are filtered out before token creation
    expect(services.calls.createCallToken).not.toHaveBeenCalled()
  })
})
