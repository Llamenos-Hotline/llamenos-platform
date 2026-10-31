/**
 * How `validateWebhook` (routes/telephony.ts) classifies a refused provider
 * webhook and bounds the work it does before authentication (#2330, spec
 * §5.7 amendments 1-4). The verifier — `adapter.validateWebhook`, the HMAC —
 * is a spy, so "no HMAC call" is asserted, not inferred.
 *
 * The incident service is a spy too: what reaches the real table, and who is
 * woken by it, is asserted against PostgreSQL in
 * integration/routing-incidents.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '@worker/types'
import type { TelephonyAdapter } from '@worker/telephony/adapter'
import type { Services } from '@worker/services'
import { ServiceError } from '@worker/services/settings'
import '@worker/__tests__/mocks/llamenos-crypto-ffi'

vi.mock('@worker/lib/service-factories')
vi.mock('@worker/services/webhook-replay', () => ({
  checkWebhookReplay: vi.fn().mockResolvedValue(true),
}))
vi.mock('@worker/db', () => ({
  getDb: vi.fn().mockReturnValue({}),
}))
import { getTelephonyFromService, getHubTelephonyFromService } from '@worker/lib/service-factories'
import { PROVIDER_AUTH_TRAFFIC_WINDOW_MS, providerAuthMonitor } from '@worker/services/provider-auth'

const PROVIDER_EGRESS = '10.0.0.0/8'
const HUB_NUMBER = '+15551234567'

function makeAdapter(opts: { signatureValid?: boolean; ownAccount?: boolean } = {}) {
  return {
    validateWebhook: vi.fn().mockResolvedValue(opts.signatureValid ?? false),
    webhookNamesOwnAccount: vi.fn().mockResolvedValue(opts.ownAccount ?? false),
    parseIncomingWebhook: vi.fn().mockResolvedValue({ callSid: 'CA-1', callerNumber: '+15551111111', calledNumber: HUB_NUMBER }),
    parseLanguageWebhook: vi.fn().mockResolvedValue({ callSid: 'CA-1', callerNumber: '+15551111111', digits: '1' }),
    handleLanguageMenu: vi.fn().mockResolvedValue({ contentType: 'text/xml', body: '<Response/>' }),
    handleWaitMusic: vi.fn().mockResolvedValue({ contentType: 'text/xml', body: '<Response/>' }),
    parseQueueWaitWebhook: vi.fn().mockResolvedValue({ queueTime: 1 }),
    rejectCall: vi.fn().mockReturnValue({ contentType: 'text/xml', body: '<Response><Reject/></Response>' }),
    providerAccountId: () => 'fake:account',
  } as unknown as TelephonyAdapter & {
    validateWebhook: ReturnType<typeof vi.fn>
    webhookNamesOwnAccount: ReturnType<typeof vi.fn>
  }
}

function makeServices() {
  const signal = vi.fn().mockResolvedValue(undefined)
  const services = {
    settings: {
      getHub: vi.fn(async (id: string) => {
        if (id !== 'hub-1') throw new ServiceError(404, 'Not found')
        return { hub: { id } }
      }),
      getHubByPhone: vi.fn(async (phone: string) => {
        if (phone !== HUB_NUMBER) throw new ServiceError(404, 'No hub for this number')
        return { hub: { id: 'hub-1' } }
      }),
      getIvrLanguages: vi.fn().mockResolvedValue({ enabledLanguages: ['en'] }),
      getCallSettings: vi.fn().mockResolvedValue({ queueTimeoutSeconds: 90, voicemailMaxSeconds: 120 }),
      resolveIvrAudioList: vi.fn().mockResolvedValue({ recordings: [] }),
    },
    records: { checkBan: vi.fn().mockResolvedValue(false) },
    calls: { getHubIdForCall: vi.fn().mockResolvedValue('hub-1') },
    providerRecordings: { track: vi.fn().mockResolvedValue(undefined) },
    incidents: { signal },
  } as unknown as Services
  return { services, signal }
}

async function appFor(adapter: TelephonyAdapter, services: Services, env: Record<string, unknown>) {
  vi.mocked(getTelephonyFromService).mockResolvedValue(adapter)
  vi.mocked(getHubTelephonyFromService).mockResolvedValue(adapter)
  const { default: telephony } = await import('@worker/routes/telephony')
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('services', services as unknown as AppEnv['Variables']['services'])
    c.env = { ENVIRONMENT: 'test', HMAC_SECRET: 'a'.repeat(64), BAN_HASH_KEY: 'b'.repeat(64), ...env } as AppEnv['Bindings']
    await next()
  })
  app.route('/api/telephony', telephony)
  return app
}

function post(app: Hono<AppEnv>, path: string, sourceIp: string, body: BodyInit = 'CallSid=CA-1&To=%2B15551234567', headers: Record<string, string> = {}) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-For': sourceIp, ...headers },
    body,
    duplex: 'half',
  } as RequestInit)
}

const kinds = (signal: ReturnType<typeof vi.fn>) => signal.mock.calls.map((call) => [call[0], call[1], call[2]])

describe('telephony webhook rejections (#2330)', () => {
  const prevTrust = process.env.TRUST_PROXY_HEADERS
  beforeEach(() => {
    process.env.TRUST_PROXY_HEADERS = 'true'
    providerAuthMonitor.reset()
    vi.clearAllMocks()
  })
  afterEach(() => {
    vi.useRealTimers()
    if (prevTrust === undefined) delete process.env.TRUST_PROXY_HEADERS
    else process.env.TRUST_PROXY_HEADERS = prevTrust
  })

  describe('bounded pre-auth work (amendment 4)', () => {
    it('a non-allowlisted 10 MB body → 403 with no HMAC call', async () => {
      const adapter = makeAdapter({ signatureValid: true })
      const { services, signal } = makeServices()
      const app = await appFor(adapter, services, { TELEPHONY_WEBHOOK_IPS: PROVIDER_EGRESS })

      const res = await post(app, '/api/telephony/incoming', '192.0.2.1', 'x'.repeat(10 * 1024 * 1024))
      expect(res.status).toBe(403)
      expect(adapter.validateWebhook).not.toHaveBeenCalled()
      // Its hub could only come from the body, which is never parsed past the cap.
      expect(adapter.parseIncomingWebhook).not.toHaveBeenCalled()
      expect(signal).not.toHaveBeenCalled()
    })

    it('a 10 MB body declared by Content-Length is refused before a byte is read, allowlisted or not', async () => {
      const adapter = makeAdapter({ signatureValid: true })
      const { services } = makeServices()
      const app = await appFor(adapter, services, {})
      const res = await post(app, '/api/telephony/incoming?hub=hub-1', '10.0.0.1', 'x'.repeat(10 * 1024 * 1024), {
        'Content-Length': String(10 * 1024 * 1024),
      })
      expect(res.status).toBe(403)
      expect(adapter.validateWebhook).not.toHaveBeenCalled()
    })

    it('a second request from the same /24 within a minute → no HMAC call', async () => {
      const adapter = makeAdapter()
      const { services, signal } = makeServices()
      const app = await appFor(adapter, services, { TELEPHONY_WEBHOOK_IPS: PROVIDER_EGRESS })

      expect((await post(app, '/api/telephony/incoming', '198.51.100.7')).status).toBe(403)
      expect(adapter.validateWebhook).toHaveBeenCalledTimes(1)
      expect((await post(app, '/api/telephony/incoming', '198.51.100.200')).status).toBe(403)
      expect(adapter.validateWebhook, 'the same /24 inside the minute is refused unhashed').toHaveBeenCalledTimes(1)
      expect(signal).toHaveBeenCalledTimes(1)

      // Another /24 is a separate source.
      expect((await post(app, '/api/telephony/incoming', '198.51.101.7')).status).toBe(403)
      expect(adapter.validateWebhook).toHaveBeenCalledTimes(2)
    })

    it('an allowed source is always verified: damping never gates authentication', async () => {
      const adapter = makeAdapter()
      const { services } = makeServices()
      const app = await appFor(adapter, services, { TELEPHONY_WEBHOOK_IPS: PROVIDER_EGRESS })
      for (let i = 0; i < 5; i++) expect((await post(app, '/api/telephony/incoming', '10.1.1.1')).status).toBe(403)
      expect(adapter.validateWebhook).toHaveBeenCalledTimes(5)
    })
  })

  describe('attribution is a conjunction (amendments 1-2)', () => {
    it('provider egress IP + our account id + a bad signature → own_account_signature_invalid', async () => {
      const adapter = makeAdapter({ ownAccount: true })
      const { services, signal } = makeServices()
      const app = await appFor(adapter, services, { TELEPHONY_WEBHOOK_IPS: PROVIDER_EGRESS })
      expect((await post(app, '/api/telephony/incoming', '10.2.3.4')).status).toBe(403)
      expect(kinds(signal)).toEqual([['hub-1', 'provider-auth', 'own_account_signature_invalid']])
    })

    it('our account id from a NON-provider IP → ip_rejected, never own-account', async () => {
      const adapter = makeAdapter({ ownAccount: true })
      const { services, signal } = makeServices()
      const app = await appFor(adapter, services, { TELEPHONY_WEBHOOK_IPS: PROVIDER_EGRESS })
      expect((await post(app, '/api/telephony/incoming', '192.0.2.50')).status).toBe(403)
      expect(kinds(signal)).toEqual([['hub-1', 'provider-auth', 'ip_rejected']])
    })

    it('a provider IP with a foreign (or no) account id → signature_invalid', async () => {
      const adapter = makeAdapter({ ownAccount: false })
      const { services, signal } = makeServices()
      const app = await appFor(adapter, services, { TELEPHONY_WEBHOOK_IPS: PROVIDER_EGRESS })
      expect((await post(app, '/api/telephony/incoming', '10.2.3.4')).status).toBe(403)
      expect(kinds(signal)).toEqual([['hub-1', 'provider-auth', 'signature_invalid']])
    })

    it('with the IP allowlist off there is no provider-IP evidence: our id + bad signature stays signature_invalid', async () => {
      const adapter = makeAdapter({ ownAccount: true })
      const { services, signal } = makeServices()
      const app = await appFor(adapter, services, {})
      expect((await post(app, '/api/telephony/incoming', '10.2.3.4')).status).toBe(403)
      expect(kinds(signal)).toEqual([['hub-1', 'provider-auth', 'signature_invalid']])
    })
  })

  describe('a stale allowlist (amendment 3)', () => {
    it('non-allowlisted IP + correctly signed body → provider_allowlist_stale, and the request is still 403', async () => {
      const adapter = makeAdapter({ signatureValid: true })
      const { services, signal } = makeServices()
      const app = await appFor(adapter, services, { TELEPHONY_WEBHOOK_IPS: PROVIDER_EGRESS })
      const res = await post(app, '/api/telephony/incoming', '192.0.2.10')
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'Forbidden' })
      expect(adapter.handleLanguageMenu, 'the signature never widens acceptance').not.toHaveBeenCalled()
      expect(kinds(signal)).toEqual([['hub-1', 'provider-auth', 'provider_allowlist_stale']])
    })
  })

  describe('hub resolution', () => {
    it('signals under the hub the URL names', async () => {
      const adapter = makeAdapter()
      const { services, signal } = makeServices()
      const app = await appFor(adapter, services, {})
      await post(app, '/api/telephony/language-selected?hub=hub-1', '10.0.0.9')
      expect(kinds(signal)).toEqual([['hub-1', 'provider-auth', 'signature_invalid']])
      expect(adapter.parseIncomingWebhook).not.toHaveBeenCalled()
    })

    it('invents no hub: an unknown ?hub= or an unowned number signals nothing', async () => {
      const adapter = makeAdapter()
      vi.mocked(adapter.parseIncomingWebhook).mockResolvedValue({ callSid: 'CA-1', callerNumber: '+1', calledNumber: '+15550000000' })
      const { services, signal } = makeServices()
      const app = await appFor(adapter, services, {})
      expect((await post(app, '/api/telephony/language-selected?hub=hub-nope', '10.0.0.9')).status).toBe(403)
      expect((await post(app, '/api/telephony/incoming', '10.0.1.9')).status).toBe(403)
      expect(signal).not.toHaveBeenCalled()
    })
  })

  describe('the traffic discriminator (amendment 2)', () => {
    it('escalates unattributed rejections only after accepted traffic flowed in the previous window and stopped', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      const t0 = new Date('2030-01-01T10:00:00Z').getTime()
      vi.setSystemTime(t0)
      const adapter = makeAdapter({ signatureValid: true })
      const { services, signal } = makeServices()
      const app = await appFor(adapter, services, {})

      // Accepted traffic for the hub.
      expect((await app.request('/api/telephony/wait-music?hub=hub-1', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'CallSid=CA-1' })).status).toBe(200)

      // A rejection while traffic still flows: record only.
      vi.mocked(adapter.validateWebhook).mockResolvedValue(false)
      vi.setSystemTime(t0 + 5 * 60_000)
      await post(app, '/api/telephony/language-selected?hub=hub-1', '10.0.0.1')
      expect(kinds(signal)).toEqual([['hub-1', 'provider-auth', 'signature_invalid']])

      // A window later with nothing accepted since: escalate.
      vi.setSystemTime(t0 + PROVIDER_AUTH_TRAFFIC_WINDOW_MS + 60_000)
      await post(app, '/api/telephony/language-selected?hub=hub-1', '10.0.0.1')
      expect(kinds(signal).slice(1)).toEqual([
        ['hub-1', 'provider-auth', 'signature_invalid'],
        ['hub-1', 'provider-auth', 'traffic_stopped'],
      ])
    })
  })
})
