/**
 * `getHubPresence` — presence reports the ring set, nothing else.
 *
 * The defect these replace: presence was `CallsService.getPresence`, gated on an
 * optional `ShiftsService` that `createServices` never passed, so every
 * deployment answered "nobody on shift" while `/shifts/active` listed the
 * volunteer who had just clocked in. Its unit tests passed a stub in, and one of
 * them pinned the empty answer as correct.
 *
 * These are composition tests. They do NOT re-state the ring rule — presence
 * derives it by calling `resolveRingableVolunteers`, so the cases that matter
 * here are the ones the old implementation got wrong by deriving "on shift" from
 * the schedule itself: an on-break volunteer, a volunteer busy in another hub,
 * and a roster entry for somebody who is not a member of the hub. All three were
 * reported as `available`, and none of them would have been rung.
 *
 * The production-construction half of the proof is
 * __tests__/integration/presence-matches-ring-targets.test.ts, which drives the
 * real services `createServices` builds against real PostgreSQL. A mock is what
 * hid this defect, so it is not the only evidence here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getHubPresence } from '../../services/presence'
import { resolveRingableVolunteers } from '../../services/ringing'
import type { Services } from '../../services'
import { DEFAULT_ROLES } from '@shared/permissions'
import type { Role } from '@shared/permissions'

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

const HUB = 'hub-1'

function makeUser(overrides: {
  pubkey: string
  active?: boolean
  onBreak?: boolean
  roles?: string[]
  hubRoles?: { hubId: string; roleIds: string[] }[]
}) {
  return {
    pubkey: overrides.pubkey,
    name: overrides.pubkey,
    active: overrides.active ?? true,
    onBreak: overrides.onBreak ?? false,
    callPreference: 'phone',
    phone: '+15551234567',
    roles: overrides.roles ?? ['role-volunteer'],
    hubRoles: overrides.hubRoles ?? [],
  }
}

function makeServices(overrides: {
  onShiftPubkeys?: string[]
  fallbackPubkeys?: string[]
  allUsers?: ReturnType<typeof makeUser>[]
  /** Answering an in-progress call in ANY hub. */
  busyPubkeys?: string[]
  activeCalls?: Array<{ callId: string; status: string; answeredBy?: string }>
}): Services {
  const {
    onShiftPubkeys = [],
    fallbackPubkeys = [],
    allUsers = [],
    busyPubkeys = [],
    activeCalls = [],
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
    activeShifts: {
      listActiveByHub: vi.fn().mockResolvedValue({
        activeShifts: onShiftPubkeys.map(pubkey => ({ pubkey, hubId: HUB })),
      }),
      listClockedInPubkeys: vi.fn().mockResolvedValue(new Set(onShiftPubkeys)),
    },
    calls: {
      getActiveCalls: vi.fn().mockResolvedValue(activeCalls),
      getBusyPubkeys: vi.fn().mockResolvedValue(new Set(busyPubkeys)),
    },
  } as unknown as Services
}

describe('getHubPresence', () => {
  beforeEach(() => vi.clearAllMocks())

  it('reports the on-shift volunteers a call would ring', async () => {
    const services = makeServices({
      onShiftPubkeys: ['pk-a', 'pk-b'],
      allUsers: [makeUser({ pubkey: 'pk-a' }), makeUser({ pubkey: 'pk-b' })],
    })

    const presence = await getHubPresence(services, HUB)

    expect(presence.availableVolunteers).toBe(2)
    expect(presence.users.map(u => u.pubkey).sort()).toEqual(['pk-a', 'pk-b'])
    expect(presence.users.every(u => u.status === 'available')).toBe(true)
    expect(presence.activeCalls).toBe(0)
  })

  it('labels the volunteer on a live call in this hub as on-call, and does not count them available', async () => {
    const services = makeServices({
      onShiftPubkeys: ['pk-busy', 'pk-free'],
      allUsers: [makeUser({ pubkey: 'pk-busy' }), makeUser({ pubkey: 'pk-free' })],
      busyPubkeys: ['pk-busy'],
      activeCalls: [{ callId: 'call-1', status: 'in-progress', answeredBy: 'pk-busy' }],
    })

    const presence = await getHubPresence(services, HUB)

    expect(presence.activeCalls).toBe(1)
    expect(presence.availableVolunteers).toBe(1)
    expect(presence.users.find(u => u.pubkey === 'pk-busy')?.status).toBe('on-call')
    expect(presence.users.find(u => u.pubkey === 'pk-free')?.status).toBe('available')
    // Exactly once each — the on-call set and the ringable set must not overlap.
    expect(presence.users).toHaveLength(2)
  })

  it('does not report an on-break volunteer as available — a call would not ring them', async () => {
    const services = makeServices({
      onShiftPubkeys: ['pk-break', 'pk-free'],
      allUsers: [
        makeUser({ pubkey: 'pk-break', onBreak: true }),
        makeUser({ pubkey: 'pk-free' }),
      ],
    })

    const presence = await getHubPresence(services, HUB)

    expect(presence.users.map(u => u.pubkey)).toEqual(['pk-free'])
    expect(presence.availableVolunteers).toBe(1)
  })

  it('does not report a deactivated volunteer', async () => {
    const services = makeServices({
      onShiftPubkeys: ['pk-off', 'pk-free'],
      allUsers: [
        makeUser({ pubkey: 'pk-off', active: false }),
        makeUser({ pubkey: 'pk-free' }),
      ],
    })

    const presence = await getHubPresence(services, HUB)

    expect(presence.users.map(u => u.pubkey)).toEqual(['pk-free'])
  })

  it('does not report a roster entry for somebody with no access to this hub', async () => {
    const services = makeServices({
      onShiftPubkeys: ['pk-outsider', 'pk-member'],
      allUsers: [
        // No global roles and a hub role in a DIFFERENT hub: this hub's call
        // would not ring them, so presence must not claim they are available.
        makeUser({ pubkey: 'pk-outsider', roles: [], hubRoles: [{ hubId: 'hub-other', roleIds: ['role-volunteer'] }] }),
        makeUser({ pubkey: 'pk-member', roles: [], hubRoles: [{ hubId: HUB, roleIds: ['role-volunteer'] }] }),
      ],
    })

    const presence = await getHubPresence(services, HUB)

    expect(presence.users.map(u => u.pubkey)).toEqual(['pk-member'])
  })

  it('excludes a volunteer who is on a live call in a different hub, rather than showing them available', async () => {
    const services = makeServices({
      onShiftPubkeys: ['pk-elsewhere'],
      allUsers: [makeUser({ pubkey: 'pk-elsewhere' })],
      // Busy in another hub (getBusyPubkeys is instance-wide), with no active
      // call in THIS hub.
      busyPubkeys: ['pk-elsewhere'],
      activeCalls: [],
    })

    const presence = await getHubPresence(services, HUB)

    expect(presence.users).toEqual([])
    expect(presence.availableVolunteers).toBe(0)
  })

  it('reports the fallback group when nobody is on shift — that is who the call reaches', async () => {
    const services = makeServices({
      onShiftPubkeys: [],
      fallbackPubkeys: ['pk-fallback'],
      allUsers: [makeUser({ pubkey: 'pk-fallback' })],
    })

    const presence = await getHubPresence(services, HUB)

    expect(presence.users).toEqual([{ pubkey: 'pk-fallback', status: 'available' }])
  })

  it('reports nobody when the hub has no roster and no fallback group', async () => {
    const services = makeServices({ onShiftPubkeys: [], fallbackPubkeys: [], allUsers: [] })

    const presence = await getHubPresence(services, HUB)

    expect(presence).toEqual({ activeCalls: 0, availableVolunteers: 0, users: [] })
  })

  /**
   * The anti-drift assertion. Presence must agree with ringing by DERIVATION,
   * not by two implementations that happen to match today: whatever the ring
   * rule becomes (#1469 makes it `scheduled ∩ clocked_in`), presence reports
   * exactly that set without a change in services/presence.ts. This fails if
   * anybody re-derives "on shift" inside presence again.
   */
  it('reports exactly the set the ringing path resolves, over a mixed roster', async () => {
    const roster = ['pk-ok', 'pk-break', 'pk-inactive', 'pk-outsider']
    const build = () => makeServices({
      onShiftPubkeys: roster,
      allUsers: [
        makeUser({ pubkey: 'pk-ok' }),
        makeUser({ pubkey: 'pk-break', onBreak: true }),
        makeUser({ pubkey: 'pk-inactive', active: false }),
        makeUser({ pubkey: 'pk-outsider', roles: [], hubRoles: [] }),
      ],
    })

    const presence = await getHubPresence(build(), HUB)
    const ringable = await resolveRingableVolunteers(build(), HUB)

    expect(presence.users.map(u => u.pubkey).sort())
      .toEqual((ringable?.available ?? []).map(v => v.pubkey).sort())
    expect(presence.users.map(u => u.pubkey)).toEqual(['pk-ok'])
  })
})
