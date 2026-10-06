import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '@worker/types'
import { publicSecurityEventsRoutes } from '@worker/routes/security-events'
import {
  MAX_CLIENT_SECURITY_EVENTS_PER_REQUEST,
  MAX_PIN_IDENTIFIERS_PER_EVENT,
} from '@worker/schemas/client-security-events'
import { renderAlertMessage } from '@worker/services/user-notifications'

const PIN_A = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
const PIN_B = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB='

function validEvent(overrides: Record<string, unknown> = {}) {
  return {
    event_type: 'cert_pin_mismatch',
    occurred_at: '2026-09-25T12:00:00Z',
    app_version: '1.2.3 (45)',
    os_version: 'iOS Version 18.0 (Build 22A)',
    pin_identifiers: [PIN_A, PIN_B],
    ...overrides,
  }
}

function makeServices(overrides: { rateLimited?: boolean; alertThrottled?: boolean; admins?: string[] } = {}) {
  const { rateLimited = false, alertThrottled = false, admins = ['a'.repeat(64)] } = overrides
  return {
    settings: {
      checkRateLimit: vi.fn().mockResolvedValue({ limited: rateLimited }),
      checkApiRateLimit: vi.fn().mockResolvedValue({ limited: alertThrottled, retryAfterSeconds: 0 }),
    },
    identity: {
      emitSecurityEvent: vi.fn().mockResolvedValue(undefined),
      listActiveSuperAdminPubkeys: vi.fn().mockResolvedValue(admins),
    },
    audit: { log: vi.fn().mockResolvedValue(undefined) },
    userNotifications: { sendAlert: vi.fn().mockResolvedValue({ delivered: true }) },
  }
}

function createApp(services: ReturnType<typeof makeServices>) {
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('services', services as unknown as AppEnv['Variables']['services'])
    c.env = { HMAC_SECRET: 'a'.repeat(64) } as unknown as AppEnv['Bindings']
    await next()
  })
  app.route('/security-events', publicSecurityEventsRoutes)
  return app
}

function post(app: Hono<AppEnv>, body: unknown, headers: Record<string, string> = {}) {
  return app.request('/security-events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

describe('POST /security-events (unauthenticated client submission)', () => {
  let services: ReturnType<typeof makeServices>
  let app: Hono<AppEnv>

  beforeEach(() => {
    services = makeServices()
    app = createApp(services)
  })

  it('accepts a pin mismatch event without any auth and stores it with no user, device or IP', async () => {
    const res = await post(app, { events: [validEvent()] }, { 'X-Forwarded-For': '203.0.113.9' })
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ accepted: 1 })

    expect(services.identity.emitSecurityEvent).toHaveBeenCalledTimes(1)
    const [userPubkey, eventType, deviceId, metadata] = services.identity.emitSecurityEvent.mock.calls[0]
    expect(userPubkey).toBeNull()
    expect(eventType).toBe('cert_pin_mismatch')
    expect(deviceId).toBeNull()
    expect(metadata).toEqual({
      source: 'client',
      occurredAt: '2026-09-25T12:00:00Z',
      appVersion: '1.2.3 (45)',
      osVersion: 'iOS Version 18.0 (Build 22A)',
      pinIdentifiers: [PIN_A, PIN_B],
    })
    expect(JSON.stringify(services.identity.emitSecurityEvent.mock.calls)).not.toContain('203.0.113.9')
    expect(services.audit.log).toHaveBeenCalledWith('cert_pin_mismatch_reported', 'system', { eventCount: 1 })
  })

  it('accepts fractional-second timestamps (Foundation ISO8601 output)', async () => {
    const res = await post(app, { events: [validEvent({ occurred_at: '2026-09-25T12:00:00.123Z' })] })
    expect(res.status).toBe(202)
  })

  it('alerts every active super-admin via the notifier', async () => {
    const admins = ['a'.repeat(64), 'b'.repeat(64)]
    services = makeServices({ admins })
    app = createApp(services)
    await post(app, { events: [validEvent(), validEvent()] })
    await vi.waitFor(() => expect(services.userNotifications.sendAlert).toHaveBeenCalledTimes(2))
    for (const admin of admins) {
      expect(services.userNotifications.sendAlert).toHaveBeenCalledWith(admin, { type: 'cert_pin_mismatch', eventCount: 2 })
    }
  })

  it('throttles admin alerts globally but still records the event', async () => {
    services = makeServices({ alertThrottled: true })
    app = createApp(services)
    const res = await post(app, { events: [validEvent()] })
    expect(res.status).toBe(202)
    await vi.waitFor(() => expect(services.settings.checkApiRateLimit).toHaveBeenCalled())
    expect(services.identity.emitSecurityEvent).toHaveBeenCalledTimes(1)
    expect(services.userNotifications.sendAlert).not.toHaveBeenCalled()
  })

  it('still returns 202 when the notifier fails', async () => {
    services.userNotifications.sendAlert.mockRejectedValue(new Error('notifier down'))
    const res = await post(app, { events: [validEvent()] })
    expect(res.status).toBe(202)
  })

  describe('abuse bounds', () => {
    it('rate limits per IP with 429 and stores nothing', async () => {
      services = makeServices({ rateLimited: true })
      app = createApp(services)
      const res = await post(app, { events: [validEvent()] })
      expect(res.status).toBe(429)
      expect(services.identity.emitSecurityEvent).not.toHaveBeenCalled()
      expect(services.audit.log).not.toHaveBeenCalled()
    })

    it('keys the rate limit on a hash of the IP, never the raw IP', async () => {
      await post(app, { events: [validEvent()] }, { 'X-Forwarded-For': '203.0.113.9' })
      const [{ key, maxPerMinute }] = services.settings.checkRateLimit.mock.calls[0]
      expect(key).toMatch(/^security-events-submit:[0-9a-f]+$/)
      expect(key).not.toContain('203.0.113.9')
      expect(maxPerMinute).toBe(5)
    })

    it('rate limits malformed requests too (counted before validation)', async () => {
      services = makeServices({ rateLimited: true })
      app = createApp(services)
      const res = await post(app, { events: [] })
      expect(res.status).toBe(429)
    })

    it(`rejects more than ${MAX_CLIENT_SECURITY_EVENTS_PER_REQUEST} events per request`, async () => {
      const events = Array.from({ length: MAX_CLIENT_SECURITY_EVENTS_PER_REQUEST + 1 }, () => validEvent())
      expect((await post(app, { events })).status).toBe(400)
      expect(services.identity.emitSecurityEvent).not.toHaveBeenCalled()
    })

    it('accepts exactly the maximum batch', async () => {
      const events = Array.from({ length: MAX_CLIENT_SECURITY_EVENTS_PER_REQUEST }, () => validEvent())
      const res = await post(app, { events })
      expect(res.status).toBe(202)
      expect(services.identity.emitSecurityEvent).toHaveBeenCalledTimes(MAX_CLIENT_SECURITY_EVENTS_PER_REQUEST)
    })

    it('rejects an empty events array', async () => {
      expect((await post(app, { events: [] })).status).toBe(400)
    })

    it(`rejects more than ${MAX_PIN_IDENTIFIERS_PER_EVENT} pin identifiers`, async () => {
      const pins = Array.from({ length: MAX_PIN_IDENTIFIERS_PER_EVENT + 1 }, () => PIN_A)
      expect((await post(app, { events: [validEvent({ pin_identifiers: pins })] })).status).toBe(400)
    })

    it('rejects oversized strings', async () => {
      for (const override of [
        { app_version: 'x'.repeat(65) },
        { os_version: 'x'.repeat(129) },
        { pin_identifiers: [PIN_A.repeat(2)] },
        { occurred_at: '2026-09-25T12:00:00Z' + ' '.repeat(40) },
      ]) {
        expect((await post(app, { events: [validEvent(override)] })).status).toBe(400)
      }
      expect(services.identity.emitSecurityEvent).not.toHaveBeenCalled()
    })

    it('rejects a body over the byte limit with 413 before parsing', async () => {
      const res = await post(app, { events: [validEvent()], padding: 'x'.repeat(20 * 1024) })
      expect(res.status).toBe(413)
      expect(services.identity.emitSecurityEvent).not.toHaveBeenCalled()
    })
  })

  describe('strict schema', () => {
    it('rejects unknown fields on an event (e.g. a device identifier)', async () => {
      expect((await post(app, { events: [validEvent({ device_id: 'abc' })] })).status).toBe(400)
      expect((await post(app, { events: [validEvent({ ip: '203.0.113.9' })] })).status).toBe(400)
    })

    it('rejects unknown top-level fields', async () => {
      expect((await post(app, { events: [validEvent()], user_pubkey: 'a'.repeat(64) })).status).toBe(400)
    })

    it('rejects event types clients may not self-report', async () => {
      expect((await post(app, { events: [validEvent({ event_type: 'login_failed' })] })).status).toBe(400)
    })

    it('rejects missing fields and non-JSON bodies', async () => {
      const { os_version: _omit, ...missing } = validEvent()
      expect((await post(app, { events: [missing] })).status).toBe(400)
      expect((await post(app, 'not json')).status).toBe(400)
    })

    it('rejects non-base64 pin identifiers', async () => {
      expect((await post(app, { events: [validEvent({ pin_identifiers: ['api.example.org:443'] })] })).status).toBe(400)
    })
  })
})

describe('renderAlertMessage cert_pin_mismatch', () => {
  it('mentions the count and does not leak pins', () => {
    const msg = renderAlertMessage({ type: 'cert_pin_mismatch', eventCount: 3 })
    expect(msg).toContain('3 client(s)')
    expect(msg).toContain('pin mismatch')
  })
})
