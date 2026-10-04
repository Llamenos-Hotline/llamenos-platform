/**
 * In-app "Hang up" and "Ban & hang up" must disconnect the caller AT THE PROVIDER
 * (TelephonyAdapter.hangupCall), before the active call record is ended, and the
 * reported outcome must be what actually happened.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import calls from '@worker/routes/calls'
import { MockTelephonyAdapter } from '@worker/telephony/mock'
import { ServiceError } from '@worker/services/settings'
import type { AppEnv } from '@worker/types'

const PUBKEY = 'a'.repeat(64)
const HUB = 'hub-1'

const adapterRef: { current: MockTelephonyAdapter | null } = { current: null }

vi.mock('@worker/lib/service-factories', () => ({
  getTelephonyFromService: vi.fn(async () => adapterRef.current),
  getHubTelephonyFromService: vi.fn(async () => adapterRef.current),
}))

function mockAdapter(): MockTelephonyAdapter {
  if (!adapterRef.current) throw new Error('test expects a mock adapter')
  return adapterRef.current
}

function makeMock() {
  return new MockTelephonyAdapter(
    { ENVIRONMENT: 'development', DEMO_MODE: 'true', DEMO_MODE_CONFIRM: 'DESTROY_ALL_DATA' },
    '+15555550100',
  )
}

const activeCall = {
  callId: 'CA-caller-1',
  hubId: HUB,
  answeredBy: PUBKEY,
  callerNumber: 'hashed-caller',
  callerLast4: '4567',
  status: 'in-progress',
}

function setup() {
  const order: string[] = []
  const callsSvc = {
    getActiveCallById: vi.fn().mockResolvedValue(activeCall),
    getActiveCallByCallId: vi.fn().mockResolvedValue(activeCall),
    getCallRecord: vi.fn().mockResolvedValue({ callId: activeCall.callId, status: 'completed' }),
    endCall: vi.fn(async () => {
      order.push('endCall')
      return { callId: activeCall.callId, status: 'completed' }
    }),
  }
  const services = {
    calls: callsSvc,
    records: { addBan: vi.fn().mockResolvedValue(undefined) },
    audit: { log: vi.fn().mockResolvedValue(undefined) },
    settings: {},
  }

  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('pubkey', PUBKEY)
    c.set('permissions', ['*'])
    c.set('services', services as unknown as AppEnv['Variables']['services'])
    c.set('allRoles', [])
    c.set('requestId', 'req-1')
    c.set('hubId', HUB)
    c.env = {} as AppEnv['Bindings']
    await next()
  })
  app.route('/', calls)
  return { app, callsSvc, services, order }
}

const post = (app: Hono<AppEnv>, path: string) =>
  app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'abusive' }),
  })

describe('provider hang-up on in-app call actions', () => {
  beforeEach(() => {
    adapterRef.current = makeMock()
  })

  describe('POST /:callId/hangup', () => {
    it('drops the caller leg at the provider before ending the record', async () => {
      const { app, callsSvc, order } = setup()
      const adapter = mockAdapter()
      const realHangup = adapter.hangupCall.bind(adapter)
      adapter.hangupCall = async (sid) => {
        order.push('hangupCall')
        await realHangup(sid)
      }

      const res = await post(app, '/CA-caller-1/hangup')

      expect(res.status).toBe(200)
      expect(adapter.actions).toEqual([{ type: 'hangup', callSid: 'CA-caller-1' }])
      expect(order).toEqual(['hangupCall', 'endCall'])
      expect(callsSvc.endCall).toHaveBeenCalledWith(HUB, 'CA-caller-1')
    })

    it('keeps the call active and returns 502 when the provider cannot disconnect the caller', async () => {
      const { app, callsSvc } = setup()
      mockAdapter().hangupCall = vi.fn().mockRejectedValue(new Error('Twilio hangup failed: 500'))

      const res = await post(app, '/CA-caller-1/hangup')

      expect(res.status).toBe(502)
      expect(callsSvc.endCall).not.toHaveBeenCalled()
    })

    it('returns the finished record when the provider callback already ended the call', async () => {
      const { app, callsSvc } = setup()
      callsSvc.endCall.mockRejectedValue(new ServiceError(404, 'Call not found'))

      const res = await post(app, '/CA-caller-1/hangup')

      expect(res.status).toBe(200)
      expect((await res.json()).call.callId).toBe('CA-caller-1')
      expect(mockAdapter().actions).toEqual([{ type: 'hangup', callSid: 'CA-caller-1' }])
    })

    it('still ends the record when no telephony provider is configured (nothing to disconnect)', async () => {
      adapterRef.current = null
      const { app, callsSvc } = setup()

      const res = await post(app, '/CA-caller-1/hangup')

      expect(res.status).toBe(200)
      expect(callsSvc.endCall).toHaveBeenCalledWith(HUB, 'CA-caller-1')
    })
  })

  describe('POST /:callId/ban', () => {
    it('bans, disconnects the caller at the provider, then ends the record', async () => {
      const { app, services, order } = setup()
      const adapter = mockAdapter()
      const realHangup = adapter.hangupCall.bind(adapter)
      adapter.hangupCall = async (sid) => {
        order.push('hangupCall')
        await realHangup(sid)
      }

      const res = await post(app, '/CA-caller-1/ban')

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ banned: true, hungUp: true })
      expect(services.records.addBan).toHaveBeenCalledTimes(1)
      expect(adapter.actions).toEqual([{ type: 'hangup', callSid: 'CA-caller-1' }])
      expect(order).toEqual(['hangupCall', 'endCall'])
    })

    it('reports hungUp:false and keeps the call active when the provider disconnect fails', async () => {
      const { app, callsSvc, services } = setup()
      mockAdapter().hangupCall = vi.fn().mockRejectedValue(new Error('provider unreachable'))

      const res = await post(app, '/CA-caller-1/ban')

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ banned: true, hungUp: false })
      expect(services.records.addBan).toHaveBeenCalledTimes(1)
      expect(callsSvc.endCall).not.toHaveBeenCalled()
    })
  })
})
