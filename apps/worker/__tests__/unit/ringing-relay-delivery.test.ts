/**
 * #1013 — a real inbound call's `call:ring` must reach the relay sockets of the
 * members of the hub that owns the call, and nobody else.
 *
 * This drives the production ringing path end to end: the real
 * `startParallelRinging` → the real `publishEvent` → a real `ConnectionManager`.
 * Only the telephony adapter factory, VoIP push and metrics are stubbed.
 * (`ringing-service.test.ts` mocks `publishEvent` away, which is how a ring
 * published to the wrong hub stayed green.)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { KIND_CALL_RING } from '@shared/event-kinds'
import { DEFAULT_ROLES } from '@shared/permissions'
import type { Role } from '@shared/permissions'
import type { WsEventMessage } from '@protocol/schemas/ws-messages'
import { startParallelRinging } from '../../services/ringing'
import { initConnectionManager, type ConnectionManager, type ConnectionState } from '../../lib/ws-manager'
import type { Env } from '../../types'
import type { Services } from '../../services'

vi.mock('../../lib/service-factories', () => ({
  getTelephonyFromService: vi.fn().mockResolvedValue(null),
  getHubTelephonyFromService: vi.fn().mockResolvedValue(null),
}))

vi.mock('../../lib/voip-push', () => ({
  dispatchVoipPushFromService: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../routes/metrics', () => ({
  incCounter: vi.fn(),
}))

const HUB_A = 'hub-A'
const HUB_B = 'hub-B'

const env = { SERVER_SECRET: 'b'.repeat(64), HMAC_SECRET: 'a'.repeat(64) } as Env

/** A relay socket that records every event frame the server sends it. */
function connect(
  mgr: ConnectionManager,
  pubkey: string,
  memberHubs: string[],
  subscribeTo: string[],
): { received: () => Array<Pick<WsEventMessage, 'hubId' | 'kind'>> } {
  const frames: string[] = []
  const state: ConnectionState = {
    pubkey,
    ws: { send: (m: string) => frames.push(m) } as unknown as WebSocket,
    hubs: new Set(memberHubs),
    subscribedHubs: new Set(),
    lastReplayAt: 0,
  }
  expect(mgr.register(state)).toBe(true)
  for (const hubId of subscribeTo) mgr.subscribe(state, hubId, [KIND_CALL_RING])
  return {
    received: () =>
      frames
        .map(f => JSON.parse(f) as WsEventMessage)
        .filter(e => e.type === 'event')
        .map(({ hubId, kind }) => ({ hubId, kind })),
  }
}

/**
 * Services where each hub has its own on-shift roster; every user takes browser calls
 * and is a volunteer member of exactly the hubs whose roster names them (ringing only
 * rings hub members).
 */
function makeServices(rosters: Record<string, string[]>): Services {
  const everyone = [...new Set(Object.values(rosters).flat())]
  // The '' roster is a call that resolved to no hub: there is no hub to be a member
  // of, so those users hold the volunteer role globally instead.
  const hubRolesOf = (pubkey: string) =>
    Object.entries(rosters)
      .filter(([hubId, roster]) => hubId !== '' && roster.includes(pubkey))
      .map(([hubId]) => ({ hubId, roleIds: ['role-volunteer'] }))
  return {
    shifts: { getCurrentVolunteers: vi.fn(async (hubId: string) => rosters[hubId] ?? []) },
    settings: {
      getFallbackGroup: vi.fn().mockResolvedValue({ userPubkeys: [] }),
      getRoles: vi.fn().mockResolvedValue({ roles: DEFAULT_ROLES as unknown as Role[] }),
    },
    identity: {
      getUsers: vi.fn().mockResolvedValue({
        users: everyone.map(pubkey => ({
          pubkey, active: true, onBreak: false, callPreference: 'browser', phone: null,
          roles: (rosters[''] ?? []).includes(pubkey) ? ['role-volunteer'] : [],
          hubRoles: hubRolesOf(pubkey),
        })),
      }),
    },
    calls: {
      addCall: vi.fn().mockResolvedValue(undefined),
      createCallToken: vi.fn(),
    },
  } as unknown as Services
}

describe('call:ring relay delivery (#1013)', () => {
  let mgr: ConnectionManager

  beforeEach(() => {
    mgr = initConnectionManager(new Uint8Array(32).fill(7))
  })

  it('delivers the ring for a call to hub A on hub A — never on the global pseudo-hub', async () => {
    // The 'global' subscription is a control: before the fix every real ring
    // landed there and nowhere else.
    const vol = connect(mgr, 'pk-vol', [HUB_A], [HUB_A, 'global'])
    const services = makeServices({ [HUB_A]: ['pk-vol'] })

    const result = await startParallelRinging('CA-hubA', '+15551230001', 'http://x', env, services, HUB_A)

    expect(result).toEqual({ ringing: true, volunteersNotified: 1 })
    expect(vol.received()).toEqual([{ hubId: HUB_A, kind: KIND_CALL_RING }])
  })

  it('a volunteer on shift in two hubs receives both hubs\' rings, each on its own hub', async () => {
    // Multi-hub routing axiom: the client subscribes to every member hub, and the
    // server fan-out is independent of whichever hub is active in the UI.
    const vol = connect(mgr, 'pk-multi', [HUB_A, HUB_B], [HUB_A, HUB_B])
    const services = makeServices({ [HUB_A]: ['pk-multi'], [HUB_B]: ['pk-multi'] })

    await startParallelRinging('CA-A', '+15551230002', 'http://x', env, services, HUB_A)
    await startParallelRinging('CA-B', '+15551230003', 'http://x', env, services, HUB_B)

    expect(vol.received()).toEqual([
      { hubId: HUB_A, kind: KIND_CALL_RING },
      { hubId: HUB_B, kind: KIND_CALL_RING },
    ])
  })

  it('a member of another hub does not receive the ring', async () => {
    const outsider = connect(mgr, 'pk-outsider', [HUB_B], [HUB_B])
    const vol = connect(mgr, 'pk-vol', [HUB_A], [HUB_A])
    const services = makeServices({ [HUB_A]: ['pk-vol'], [HUB_B]: ['pk-outsider'] })

    await startParallelRinging('CA-isolated', '+15551230004', 'http://x', env, services, HUB_A)

    expect(vol.received()).toEqual([{ hubId: HUB_A, kind: KIND_CALL_RING }])
    expect(outsider.received()).toEqual([])
  })

  it('a call that resolved to no hub is not broadcast on the global pseudo-hub', async () => {
    const listener = connect(mgr, 'pk-any', [HUB_A], [HUB_A, 'global'])
    const services = makeServices({ '': ['pk-any'] })

    const result = await startParallelRinging('CA-nohub', '+15551230005', 'http://x', env, services, '')

    // The volunteer WAS selected, so an empty inbox is the publish decision, not an empty ring set
    expect(result).toEqual({ ringing: true, volunteersNotified: 1 })
    expect(listener.received()).toEqual([])
  })
})
