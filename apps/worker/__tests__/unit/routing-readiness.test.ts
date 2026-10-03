/**
 * `hubRoutingReadiness` / `warnOnUnroutableHubs` — a hub that can ring nobody.
 *
 * A fresh install has no shift and no fallback group, so a call rings nobody.
 * That is the intended default (nobody is enrolled into receiving crisis calls
 * implicitly) but the deployment looks healthy: `/health/ready` passes and the
 * wizard reports complete. These pin the boot-time warning that says so, and
 * that it goes quiet the moment EITHER routing path is provisioned.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { hubRoutingReadiness, warnOnUnroutableHubs } from '../../services/routing-readiness'
import type { Services } from '../../services'

// vi.mock is hoisted above every const in this file, so the spies it closes
// over have to be created in a hoisted block too.
const { errorLog, warnLog } = vi.hoisted(() => ({ errorLog: vi.fn(), warnLog: vi.fn() }))

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: warnLog, error: errorLog }),
}))

function makeServices(opts: {
  hubs?: Array<{ id: string; status: string }>
  shifts?: Record<string, Array<{ userPubkeys: string[] }>>
  fallback?: Record<string, string[]>
  getHubsThrows?: boolean
}): Services {
  const { hubs = [], shifts = {}, fallback = {}, getHubsThrows = false } = opts
  return {
    settings: {
      getHubs: vi.fn(async () => {
        if (getHubsThrows) throw new Error('postgres is down')
        return { hubs }
      }),
      getFallbackGroup: vi.fn(async (hubId: string) => ({ userPubkeys: fallback[hubId] ?? [] })),
    },
    shifts: {
      list: vi.fn(async (hubId: string) => ({ shifts: shifts[hubId] ?? [] })),
    },
  } as unknown as Services
}

describe('hubRoutingReadiness', () => {
  beforeEach(() => vi.clearAllMocks())

  it('a fresh hub — no shift, no fallback group — can ring nobody', async () => {
    const readiness = await hubRoutingReadiness(makeServices({}), 'hub-1')

    expect(readiness).toEqual({
      hubId: 'hub-1',
      rosteredVolunteers: 0,
      fallbackVolunteers: 0,
      canEverRing: false,
    })
  })

  it('a shift naming a volunteer is enough, even outside its hours', async () => {
    const services = makeServices({ shifts: { 'hub-1': [{ userPubkeys: ['pk-a'] }] } })

    const readiness = await hubRoutingReadiness(services, 'hub-1')

    expect(readiness.rosteredVolunteers).toBe(1)
    expect(readiness.canEverRing).toBe(true)
  })

  it('a fallback group alone is enough', async () => {
    const services = makeServices({ fallback: { 'hub-1': ['pk-a', 'pk-b'] } })

    const readiness = await hubRoutingReadiness(services, 'hub-1')

    expect(readiness.fallbackVolunteers).toBe(2)
    expect(readiness.canEverRing).toBe(true)
  })

  it('a shift with an empty roster is not somebody to ring', async () => {
    const services = makeServices({ shifts: { 'hub-1': [{ userPubkeys: [] }] } })

    expect((await hubRoutingReadiness(services, 'hub-1')).canEverRing).toBe(false)
  })

  it('counts a volunteer on two shifts once', async () => {
    const services = makeServices({
      shifts: { 'hub-1': [{ userPubkeys: ['pk-a'] }, { userPubkeys: ['pk-a', 'pk-b'] }] },
    })

    expect((await hubRoutingReadiness(services, 'hub-1')).rosteredVolunteers).toBe(2)
  })
})

describe('warnOnUnroutableHubs', () => {
  beforeEach(() => vi.clearAllMocks())

  it('logs an error naming each hub a caller could not reach', async () => {
    const services = makeServices({
      hubs: [{ id: 'hub-empty', status: 'active' }, { id: 'hub-staffed', status: 'active' }],
      shifts: { 'hub-staffed': [{ userPubkeys: ['pk-a'] }] },
    })

    const unroutable = await warnOnUnroutableHubs(services)

    expect(unroutable.map(h => h.hubId)).toEqual(['hub-empty'])
    expect(errorLog).toHaveBeenCalledTimes(1)
    expect(errorLog.mock.calls[0][1]).toEqual({ hubId: 'hub-empty' })
    // The message has to tell the operator what to do about it.
    expect(errorLog.mock.calls[0][0]).toMatch(/fallback group/)
  })

  it('says nothing when every active hub can route', async () => {
    const services = makeServices({
      hubs: [{ id: 'hub-1', status: 'active' }],
      fallback: { 'hub-1': ['pk-a'] },
    })

    expect(await warnOnUnroutableHubs(services)).toEqual([])
    expect(errorLog).not.toHaveBeenCalled()
  })

  it('ignores hubs that are not active', async () => {
    const services = makeServices({ hubs: [{ id: 'hub-archived', status: 'archived' }] })

    expect(await warnOnUnroutableHubs(services)).toEqual([])
    expect(errorLog).not.toHaveBeenCalled()
  })

  it('never throws — a hotline still boots if the check itself fails', async () => {
    const services = makeServices({ getHubsThrows: true })

    await expect(warnOnUnroutableHubs(services)).resolves.toEqual([])
    expect(warnLog).toHaveBeenCalled()
    expect(errorLog).not.toHaveBeenCalled()
  })
})
