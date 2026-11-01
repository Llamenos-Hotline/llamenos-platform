import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '@worker/types'
import type { TelephonyAdapter } from '@worker/telephony/adapter'
import { AsteriskAdapter } from '@worker/telephony/asterisk'
import type { Services } from '@worker/services'
import { ServiceError } from '@worker/services/settings'
// Ensure the crypto FFI mock is loaded before any code that imports @llamenos/crypto/ffi.
// The real ffi.ts uses bun:ffi to load a native .so — unavailable in the Vitest environment.
import '@worker/__tests__/mocks/llamenos-crypto-ffi'

// Top-level mock ensures the telephony route always gets the mocked service-factories,
// regardless of module cache state from parallel test files.
vi.mock('@worker/lib/service-factories')
vi.mock('@worker/services/webhook-replay', () => ({
  checkWebhookReplay: vi.fn().mockResolvedValue(true),
}))
vi.mock('@worker/db', () => ({
  getDb: vi.fn().mockReturnValue({}),
}))
import { getTelephonyFromService, getHubTelephonyFromService } from '@worker/lib/service-factories'
import { recordRingLegs } from '@worker/services/ringing'
import { checkWebhookReplay } from '@worker/services/webhook-replay'
import metricsRoutes from '@worker/routes/metrics'
import { resetWebhookRejectionDamping } from '@worker/telephony/webhook-rejection'

// Mock webhook replay protection — unit tests have no database
vi.mock('@worker/services/webhook-replay', () => ({
  checkWebhookReplay: vi.fn().mockResolvedValue(true),
}))
vi.mock('@worker/db', () => ({
  getDb: vi.fn().mockReturnValue({}),
}))

function makeMockAdapter(overrides?: Partial<TelephonyAdapter>): TelephonyAdapter {
  return {
    handleLanguageMenu: vi.fn().mockResolvedValue({ contentType: 'text/xml', body: '<Response><Gather/></Response>' }),
    handleIncomingCall: vi.fn().mockResolvedValue({ contentType: 'text/xml', body: '<Response><Enqueue/></Response>' }),
    handleCaptchaResponse: vi.fn().mockResolvedValue({ contentType: 'text/xml', body: '<Response><Enqueue/></Response>' }),
    handleCallAnswered: vi.fn().mockResolvedValue({ contentType: 'text/xml', body: '<Response><Dial><Queue/></Dial></Response>' }),
    handleVoicemail: vi.fn().mockResolvedValue({ contentType: 'text/xml', body: '<Response><Record/></Response>' }),
    handleWaitMusic: vi.fn().mockResolvedValue({ contentType: 'text/xml', body: '<Response><Play/></Response>' }),
    handleVoicemailComplete: vi.fn().mockReturnValue({ contentType: 'text/xml', body: '<Response><Say>Thank you</Say><Hangup/></Response>' }),
    rejectCall: vi.fn().mockReturnValue({ contentType: 'text/xml', body: '<Response><Reject/></Response>' }),
    hangupResponse: vi.fn().mockReturnValue({ contentType: 'text/xml', body: '<Response><Hangup/></Response>' }),
    hangupCall: vi.fn().mockResolvedValue(undefined),
    ringVolunteers: vi.fn().mockResolvedValue([]),
    cancelRinging: vi.fn().mockResolvedValue(undefined),
    validateWebhook: vi.fn().mockResolvedValue(true),
    // Twilio's rule: the signed URL, query included, and the body.
    webhookReplayKey: vi.fn(async (req: Request) => `${req.url}\n${await req.clone().text()}`),
    getCallRecording: vi.fn().mockResolvedValue(null),
    getRecordingAudio: vi.fn().mockResolvedValue(null),
    parseIncomingWebhook: vi.fn().mockResolvedValue({ callSid: 'CA-incoming', callerNumber: '+15551111111', calledNumber: '+15551234567' }),
    parseLanguageWebhook: vi.fn().mockResolvedValue({ callSid: 'CA-lang', callerNumber: '+15551111111', digits: '1' }),
    parseCaptchaWebhook: vi.fn().mockResolvedValue({ digits: '1234', callerNumber: '+15551111111' }),
    parseCallStatusWebhook: vi.fn().mockResolvedValue({ status: 'completed' }),
    parseQueueWaitWebhook: vi.fn().mockResolvedValue({ queueTime: 30 }),
    parseQueueExitWebhook: vi.fn().mockResolvedValue({ result: 'leave' }),
    parseRecordingWebhook: vi.fn().mockResolvedValue({ status: 'completed', recordingSid: 'RE123', callSid: 'CA-rec' }),
    emptyResponse: vi.fn().mockReturnValue({ contentType: 'text/xml', body: '<Response/>' }),
    ...overrides,
  } as TelephonyAdapter
}

function makeServices(): Services {
  return {
    settings: {
      getTelephonyProvider: vi.fn().mockResolvedValue(null),
      getHubTelephonyProvider: vi.fn().mockResolvedValue(null),
      getHubByPhone: vi.fn().mockResolvedValue({ hub: { id: 'hub-1' } }),
      isHubChannelEnabled: vi.fn().mockResolvedValue(true),
      getIvrLanguages: vi.fn().mockResolvedValue({ enabledLanguages: ['en', 'es'] }),
      getSpamSettings: vi.fn().mockResolvedValue({ voiceCaptchaEnabled: false, rateLimitEnabled: false, maxCallsPerMinute: 5, blockDurationMinutes: 30, overLimitAction: 'message' }),
      checkRateLimit: vi.fn().mockResolvedValue({ limited: false }),
      storeCaptcha: vi.fn().mockResolvedValue(undefined),
      submitCaptcha: vi.fn().mockResolvedValue({ outcome: 'pass' }),
      getCallSettings: vi.fn().mockResolvedValue({ queueTimeoutSeconds: 90, voicemailMaxSeconds: 120 }),
      getFallbackGroup: vi.fn().mockResolvedValue({ userPubkeys: [] }),
      resolveIvrAudioList: vi.fn().mockResolvedValue({ recordings: [] }),
      getTranscriptionSettings: vi.fn().mockResolvedValue({ globalEnabled: false }),
    },
    records: {
      checkBan: vi.fn().mockResolvedValue(false),
    },
    incidents: {
      signal: vi.fn().mockResolvedValue(undefined),
    },
    calls: {
      resolveCallToken: vi.fn().mockResolvedValue(null),
      answerCallWithToken: vi.fn().mockResolvedValue(null),
      answerCall: vi.fn().mockResolvedValue(undefined),
      getActiveCalls: vi.fn().mockResolvedValue([]),
      endCall: vi.fn().mockResolvedValue(undefined),
      getHubIdForCall: vi.fn().mockResolvedValue('hub-1'),
      markVoicemail: vi.fn().mockResolvedValue(undefined),
      addCall: vi.fn().mockResolvedValue({ callId: 'CA-test' }),
      createCallToken: vi.fn().mockResolvedValue('token-abc'),
    },
    providerRecordings: {
      track: vi.fn().mockResolvedValue(undefined),
      trackUnaddressable: vi.fn().mockResolvedValue(undefined),
      deleteHeld: vi.fn().mockResolvedValue({ deleted: 1, failed: [] }),
    },
    identity: {
      getUser: vi.fn().mockResolvedValue({ name: 'Volunteer' }),
      getUsers: vi.fn().mockResolvedValue({ users: [] }),
    },
    audit: {
      log: vi.fn().mockResolvedValue(undefined),
    },
    shifts: {
      getCurrentVolunteers: vi.fn().mockResolvedValue([]),
    },
    conversations: {} as unknown as Services['conversations'],
    blasts: {} as unknown as Services['blasts'],
    contacts: {} as unknown as Services['contacts'],
    cases: {} as unknown as Services['cases'],
    scheduler: {} as unknown as Services['scheduler'],
    cryptoKeys: {} as unknown as Services['cryptoKeys'],
    firehose: {} as unknown as Services['firehose'],
    signalContacts: {} as unknown as Services['signalContacts'],
    securityPrefs: {} as unknown as Services['securityPrefs'],
    userNotifications: {} as unknown as Services['userNotifications'],
    digestCron: {} as unknown as Services['digestCron'],
  } as unknown as Services
}

function makeEnv(overrides?: Record<string, unknown>): AppEnv['Bindings'] {
  return {
    ENVIRONMENT: 'test',
    HOTLINE_NAME: 'Test Hotline',
    HMAC_SECRET: 'a'.repeat(64),
    SERVER_KEK: 'c'.repeat(64),
    BAN_HASH_KEY: 'b'.repeat(64),
    TWILIO_ACCOUNT_SID: 'AC123',
    TWILIO_AUTH_TOKEN: 'token',
    TWILIO_PHONE_NUMBER: '+15551234567',
    ADMIN_PUBKEY: 'a'.repeat(64),
    AI: { run: vi.fn() } as unknown as AppEnv['Bindings']['AI'],
    BLOB_STORAGE: {
      put: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
    } as unknown as AppEnv['Bindings']['BLOB_STORAGE'],
    ...overrides,
  } as AppEnv['Bindings']
}

async function createTestApp(adapter: TelephonyAdapter, services: Services, envOverrides?: Record<string, unknown>) {
  vi.mocked(getTelephonyFromService).mockResolvedValue(adapter)
  vi.mocked(getHubTelephonyFromService).mockResolvedValue(adapter)

  const { default: telephony } = await import('@worker/routes/telephony')
  const app = new Hono<AppEnv>()

  app.use('*', async (c, next) => {
    c.set('services', services as unknown as AppEnv['Variables']['services'])
    c.env = makeEnv(envOverrides)
    Object.defineProperty(c, 'executionCtx', {
      value: {
        waitUntil: vi.fn(),
        passThroughOnException: vi.fn(),
      },
      writable: true,
      configurable: true,
    })
    await next()
  })

  app.route('/api/telephony', telephony)
  return app
}

describe('Telephony routes', () => {
  let adapter: TelephonyAdapter
  let services: Services

  beforeEach(() => {
    vi.clearAllMocks()
    adapter = makeMockAdapter()
    services = makeServices()
  })

  describe('webhook validation middleware', () => {
    it('rejects invalid webhook signature with 403', async () => {
      adapter.validateWebhook = vi.fn().mockResolvedValue(false)
      const app = await createTestApp(adapter, services)
      const res = await app.request('/api/telephony/incoming', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'CallSid=CA123',
      })
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'Forbidden' })
    })

    it('rejects localhost requests with invalid signature (H05 — no bypass)', async () => {
      adapter.validateWebhook = vi.fn().mockResolvedValue(false)
      const app = await createTestApp(adapter, services, { ENVIRONMENT: 'development' })
      const res = await app.request('/api/telephony/incoming', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Forwarded-For': '127.0.0.1',
        },
        body: 'CallSid=CA123',
      })
      expect(res.status).toBe(403)
    })

    describe('refusals are counted at instance level (#2330)', () => {
      async function counts(): Promise<Record<string, number>> {
        const res = await metricsRoutes.request(
          '/prometheus',
          { headers: { Authorization: 'Bearer t' } },
          { METRICS_SCRAPE_TOKEN: 't' },
        )
        const out: Record<string, number> = {}
        for (const line of (await res.text()).split('\n')) {
          const m = /^llamenos_telephony_webhook_rejected_total\{reason="(\w+)",attribution="(\w+)"\} (\d+)$/.exec(line)
          if (m) out[`${m[1]}/${m[2]}`] = Number(m[3])
        }
        return out
      }
      const post = (app: Awaited<ReturnType<typeof createTestApp>>, ip: string) =>
        app.request('/api/telephony/incoming', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-For': ip },
          body: 'CallSid=CA123',
        })

      beforeEach(() => {
        resetWebhookRejectionDamping()
        process.env.TRUST_PROXY_HEADERS = 'true'
      })

      it('counts a failed signature, and nothing for an accepted webhook', async () => {
        const before = await counts()
        const ok = await post(await createTestApp(adapter, services), '198.51.100.1')
        expect(ok.status).toBe(200)
        expect(await counts()).toEqual(before)

        adapter.validateWebhook = vi.fn().mockResolvedValue(false)
        const res = await post(await createTestApp(adapter, services), '198.51.100.2')
        expect(res.status).toBe(403)
        const after = await counts()
        expect(after['signature_invalid/unattributed']).toBe(before['signature_invalid/unattributed'] + 1)
        expect(after['signature_invalid/own_account']).toBe(before['signature_invalid/own_account'])
      })

      it('counts a request from outside the IP allowlist as ip_not_allowed, still 403', async () => {
        const before = await counts()
        const app = await createTestApp(adapter, services, { TELEPHONY_WEBHOOK_IPS: '203.0.113.0/24' })
        const res = await post(app, '198.51.100.3')
        expect(res.status).toBe(403)
        expect((await counts())['ip_not_allowed/unattributed']).toBe(before['ip_not_allowed/unattributed'] + 1)
        expect(adapter.validateWebhook).not.toHaveBeenCalled()
      })

      it('counts a request when no provider is configured as no_provider', async () => {
        const before = await counts()
        const app = await createTestApp(adapter, services)
        vi.mocked(getTelephonyFromService).mockResolvedValue(null)
        vi.mocked(getHubTelephonyFromService).mockResolvedValue(null)
        const res = await post(app, '198.51.100.4')
        expect(res.status).toBe(403)
        expect((await counts())['no_provider/unattributed']).toBe(before['no_provider/unattributed'] + 1)
      })
    })

    describe('replay protection (#1036)', () => {
      // The real nonce table is unique on sha256(provider + the adapter's replay key). Model it with a
      // Set so a second insert of the same key reports "not first" exactly like
      // Postgres does — the always-true default mock hid the double-insert bug.
      function useStatefulReplayStore() {
        const seen = new Set<string>()
        vi.mocked(checkWebhookReplay).mockImplementation(async (_db, provider, body) => {
          const key = `${provider}:${body}`
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
      }

      afterEach(() => {
        vi.mocked(checkWebhookReplay).mockReset()
        vi.mocked(checkWebhookReplay).mockResolvedValue(true)
      })

      it('lets the FIRST delivery of a signed webhook reach the handler', async () => {
        useStatefulReplayStore()
        const app = await createTestApp(adapter, services)
        const res = await app.request('/api/telephony/incoming', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'CallSid=CA-first&From=%2B15551111111&To=%2B15551234567',
        })
        expect(res.status).toBe(200)
        expect(res.headers.get('Content-Type')).toContain('xml')
        expect(await res.text()).toContain('<Gather')
        expect(adapter.handleLanguageMenu).toHaveBeenCalledTimes(1)
        // Exactly one replay check per delivery — two would swallow every webhook.
        expect(checkWebhookReplay).toHaveBeenCalledTimes(1)
      })

      it('swallows an identical redelivery with an idempotent 200 before the handler', async () => {
        useStatefulReplayStore()
        const app = await createTestApp(adapter, services)
        const init = {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'CallSid=CA-dup&From=%2B15551111111&To=%2B15551234567',
        }
        const first = await app.request('/api/telephony/incoming', init)
        expect(first.headers.get('Content-Type')).toContain('xml')
        const second = await app.request('/api/telephony/incoming', init)
        expect(second.status).toBe(200)
        expect(await second.text()).toBe('OK')
        expect(adapter.handleLanguageMenu).toHaveBeenCalledTimes(1)
      })

      it('does not consume a nonce for a request with an invalid signature', async () => {
        useStatefulReplayStore()
        adapter.validateWebhook = vi.fn().mockResolvedValue(false)
        const app = await createTestApp(adapter, services)
        const res = await app.request('/api/telephony/incoming', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'CallSid=CA-unsigned',
        })
        expect(res.status).toBe(403)
        expect(checkWebhookReplay).not.toHaveBeenCalled()
      })
    })

    it('returns 404 when no telephony adapter is configured', async () => {
      vi.mocked(getTelephonyFromService).mockResolvedValue(null)
      vi.mocked(getHubTelephonyFromService).mockResolvedValue(null)
      const { default: telephony } = await import('@worker/routes/telephony')
      const app = new Hono<AppEnv>()
      app.use('*', async (c, next) => {
        c.set('services', services as unknown as AppEnv['Variables']['services'])
        c.env = makeEnv()
        await next()
      })
      app.route('/api/telephony', telephony)
      const res = await app.request('/api/telephony/incoming', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'CallSid=CA123',
      })
      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.error).toBe('Forbidden')
    })
  })

  describe('POST /incoming', () => {
    it('returns XML language menu for non-banned caller', async () => {
      const app = await createTestApp(adapter, services)
      const res = await app.request('/api/telephony/incoming', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'CallSid=CA123&From=%2B15551111111&To=%2B15551234567',
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('Content-Type')).toContain('xml')
      expect(await res.text()).toContain('<Gather')
      expect(adapter.parseIncomingWebhook).toHaveBeenCalled()
      expect(adapter.handleLanguageMenu).toHaveBeenCalledWith(
        expect.objectContaining({
          callSid: 'CA-incoming',
          callerNumber: '+15551111111',
          hotlineName: 'Test Hotline',
          enabledLanguages: ['en', 'es'],
          hubId: 'hub-1',
        }),
      )
    })

    it('rejects banned callers', async () => {
      services.records.checkBan = vi.fn().mockResolvedValue(true)
      const app = await createTestApp(adapter, services)
      const res = await app.request('/api/telephony/incoming', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'CallSid=CA123&From=%2B15551111111',
      })
      expect(res.status).toBe(200)
      expect(adapter.rejectCall).toHaveBeenCalled()
      expect(await res.text()).toContain('<Reject')
    })

    describe('the hub has switched voice off (#2384)', () => {
      const incomingCall = () => ({
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'CallSid=CA123&From=%2B15551111111&To=%2B15551234567',
      })

      it('rejects the call before greeting or ringing, and tells the hub through a channel-disabled incident', async () => {
        services.settings.isHubChannelEnabled = vi.fn().mockResolvedValue(false)
        const app = await createTestApp(adapter, services)

        const res = await app.request('/api/telephony/incoming', incomingCall())

        expect(await res.text()).toContain('<Reject')
        expect(adapter.rejectCall).toHaveBeenCalled()
        expect(adapter.handleLanguageMenu).not.toHaveBeenCalled()
        expect(services.settings.isHubChannelEnabled).toHaveBeenCalledWith('hub-1', 'voice')
        // The kind is the channel; there is no argument that could carry the caller, the called number or the call sid.
        expect(services.incidents.signal).toHaveBeenCalledTimes(1)
        expect(services.incidents.signal).toHaveBeenCalledWith('hub-1', 'channel-disabled', 'voice')
      })

      it('the same hub with voice on greets the caller and raises nothing', async () => {
        const app = await createTestApp(adapter, services)

        const res = await app.request('/api/telephony/incoming', incomingCall())

        expect(await res.text()).toContain('<Gather')
        expect(adapter.handleLanguageMenu).toHaveBeenCalled()
        expect(services.incidents.signal).not.toHaveBeenCalled()
      })

      it('still tracks the provider call log for deletion, since the provider keeps one for a refused call too', async () => {
        services.settings.isHubChannelEnabled = vi.fn().mockResolvedValue(false)
        adapter.deleteCallLog = vi.fn()
        const app = await createTestApp(adapter, services)

        await app.request('/api/telephony/incoming', incomingCall())

        expect(services.providerRecordings.track).toHaveBeenCalledWith(expect.objectContaining({ hubId: 'hub-1', kind: 'call-log' }))
      })

      it('fails open when the switch cannot be read: the call is answered, not turned away', async () => {
        services.settings.isHubChannelEnabled = vi.fn().mockRejectedValue(new Error('postgres is down'))
        const app = await createTestApp(adapter, services)

        const res = await app.request('/api/telephony/incoming', incomingCall())

        expect(await res.text()).toContain('<Gather')
        expect(adapter.rejectCall).not.toHaveBeenCalled()
      })

      it('is still rejected when the incident cannot be recorded', async () => {
        services.settings.isHubChannelEnabled = vi.fn().mockResolvedValue(false)
        services.incidents.signal = vi.fn().mockRejectedValue(new Error('incident store down'))
        const app = await createTestApp(adapter, services)

        const res = await app.request('/api/telephony/incoming', incomingCall())

        expect(await res.text()).toContain('<Reject')
        expect(adapter.handleLanguageMenu).not.toHaveBeenCalled()
      })
    })

    it('falls back to global adapter when hub not found', async () => {
      services.settings.getHubByPhone = vi.fn().mockRejectedValue(new Error('No hub'))
      const app = await createTestApp(adapter, services)
      const res = await app.request('/api/telephony/incoming', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'CallSid=CA123&From=%2B15551111111&To=%2B15551234567',
      })
      expect(res.status).toBe(200)
      expect(adapter.handleLanguageMenu).toHaveBeenCalledWith(
        expect.objectContaining({ hubId: undefined }),
      )
    })
  })

  describe('POST /language-selected', () => {
    it('rejects a caller banned after the language menu was played, without ringing anyone', async () => {
      services.records.checkBan = vi.fn().mockResolvedValue(true)
      const app = await createTestApp(adapter, services)
      const res = await app.request('/api/telephony/language-selected?hub=hub-1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'CallSid=CA123&From=%2B15551111111&Digits=1',
      })
      expect(res.status).toBe(200)
      expect(await res.text()).toContain('<Reject')
      expect(adapter.handleIncomingCall).not.toHaveBeenCalled()
      expect(services.calls.addCall).not.toHaveBeenCalled()
    })

    it('returns enqueue response for normal call', async () => {
      // parseLanguageWebhook is mocked — override to return digit '2' matching the body.
      // With hub languages ['en', 'es'], digit '2' (index 1) resolves to 'es'.
      adapter.parseLanguageWebhook = vi.fn().mockResolvedValue({ callSid: 'CA-lang', callerNumber: '+15551111111', digits: '2' })
      const app = await createTestApp(adapter, services)
      const res = await app.request('/api/telephony/language-selected?hub=hub-1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'CallSid=CA-lang&From=%2B15551111111&Digits=2',
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('Content-Type')).toContain('xml')
      expect(await res.text()).toContain('<Enqueue')
      expect(adapter.parseLanguageWebhook).toHaveBeenCalled()
      expect(adapter.handleIncomingCall).toHaveBeenCalledWith(
        expect.objectContaining({
          callSid: 'CA-lang',
          callerNumber: '+15551111111',
          callerLanguage: 'es',
          voiceCaptchaEnabled: false,
          rateLimited: false,
          hubId: 'hub-1',
        }),
      )
    })

    // ---- #1505: the caller is told, in the greeting, before being connected ----

    const selectLanguage = async () => {
      const app = await createTestApp(adapter, services)
      return app.request('/api/telephony/language-selected?hub=hub-1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'CallSid=CA-lang&From=%2B15551111111&Digits=2',
      })
    }

    /** The callRecordingEnabled flag the greeting was built with */
    const noticeArg = () =>
      (adapter.handleIncomingCall as ReturnType<typeof vi.fn>).mock.calls[0][0].callRecordingEnabled

    it('builds the greeting with no recording notice when the hub does not record', async () => {
      const res = await selectLanguage()
      expect(res.status).toBe(200)
      expect(noticeArg()).toBe(false)
    })

    it('builds the greeting with the recording notice when the hub records', async () => {
      services.settings.getCallSettings = vi.fn().mockResolvedValue({
        queueTimeoutSeconds: 90, voicemailMaxSeconds: 120, recordCalls: true,
      })
      const res = await selectLanguage()
      expect(res.status).toBe(200)
      expect(noticeArg()).toBe(true)
      expect(services.settings.getCallSettings).toHaveBeenCalledWith('hub-1')
    })

    it('uses forceLang query param when provided', async () => {
      const app = await createTestApp(adapter, services)
      await app.request('/api/telephony/language-selected?hub=hub-1&forceLang=es', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'CallSid=CA-lang&From=%2B15551111111',
      })
      expect(adapter.handleIncomingCall).toHaveBeenCalledWith(
        expect.objectContaining({ callerLanguage: 'es' }),
      )
    })

    // #2179 / operator ruling Q4: one setting, one code path, three outcomes —
    // and every one of them raises a spam incident (rule V).
    describe('over the per-number limit', () => {
      const overLimit = async (overLimitAction: 'reject' | 'message' | 'voicemail', voiceCaptchaEnabled = false) => {
        services.settings.checkRateLimit = vi.fn().mockResolvedValue({ limited: true })
        services.settings.getSpamSettings = vi.fn().mockResolvedValue({
          voiceCaptchaEnabled,
          rateLimitEnabled: true,
          maxCallsPerMinute: 5,
          blockDurationMinutes: 30,
          overLimitAction,
        })
        const app = await createTestApp(adapter, services)
        return app.request('/api/telephony/language-selected?hub=hub-1', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'CallSid=CA-lang&From=%2B15551111111&Digits=2',
        })
      }

      it('message: plays the rateLimited prompt with nothing recorded, and signals over_limit_message', async () => {
        const res = await overLimit('message')
        expect(res.status).toBe(200)
        expect(adapter.handleIncomingCall).toHaveBeenCalledTimes(1)
        expect(adapter.handleIncomingCall).toHaveBeenCalledWith(
          expect.objectContaining({ rateLimited: true, callRecordingEnabled: false, voiceCaptchaEnabled: false }),
        )
        expect(adapter.handleVoicemail).not.toHaveBeenCalled()
        expect(services.incidents.signal).toHaveBeenCalledWith('hub-1', 'spam', 'over_limit_message')
      })

      it('reject: refuses the call unanswered and signals reject', async () => {
        const res = await overLimit('reject')
        expect(await res.text()).toContain('<Reject')
        expect(adapter.handleIncomingCall).not.toHaveBeenCalled()
        expect(services.incidents.signal).toHaveBeenCalledWith('hub-1', 'spam', 'reject')
      })

      it('voicemail: registers the call so the message has a record, offers voicemail, signals over_limit_voicemail', async () => {
        const res = await overLimit('voicemail')
        expect(res.status).toBe(200)
        expect(services.calls.addCall).toHaveBeenCalledWith('hub-1', expect.objectContaining({ callId: 'CA-lang', status: 'ringing' }))
        expect(adapter.handleVoicemail).toHaveBeenCalledWith(expect.objectContaining({ callSid: 'CA-lang', hubId: 'hub-1', maxRecordingSeconds: 120 }))
        expect(adapter.handleIncomingCall).not.toHaveBeenCalled()
        expect(services.incidents.signal).toHaveBeenCalledWith('hub-1', 'spam', 'over_limit_voicemail')
      })

      it('never issues a CAPTCHA to an over-limit caller, even with the hub\'s CAPTCHA on', async () => {
        await overLimit('message', true)
        expect(services.settings.storeCaptcha).not.toHaveBeenCalled()
      })

      it('the incident signal carries no caller number and no call SID', async () => {
        await overLimit('message')
        const args = JSON.stringify((services.incidents.signal as ReturnType<typeof vi.fn>).mock.calls)
        expect(args).not.toContain('5551111111')
        expect(args).not.toContain('CA-lang')
      })

      it('a failing incident signal still answers the caller', async () => {
        services.incidents.signal = vi.fn().mockRejectedValue(new Error('db down'))
        const res = await overLimit('message')
        expect(res.status).toBe(200)
        expect(adapter.handleIncomingCall).toHaveBeenCalledWith(expect.objectContaining({ rateLimited: true }))
      })
    })

    it('reads spam settings and scopes the rate-limit window to the called hub (#1051)', async () => {
      services.settings.checkRateLimit = vi.fn().mockResolvedValue({ limited: false })
      services.settings.getSpamSettings = vi.fn().mockResolvedValue({
        voiceCaptchaEnabled: false,
        rateLimitEnabled: true,
        maxCallsPerMinute: 5,
        blockDurationMinutes: 30,
      })
      const app = await createTestApp(adapter, services)
      await app.request('/api/telephony/language-selected?hub=hub-1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'CallSid=CA-lang&From=%2B15551111111&Digits=2',
      })
      expect(services.settings.getSpamSettings).toHaveBeenCalledWith('hub-1')
      const [{ key }] = (services.settings.checkRateLimit as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(key).toMatch(/^phone:hub-1:/)
    })

    it('returns CAPTCHA gather when voice CAPTCHA enabled', async () => {
      services.settings.getSpamSettings = vi.fn().mockResolvedValue({
        voiceCaptchaEnabled: true,
        rateLimitEnabled: false,
        maxCallsPerMinute: 5,
        blockDurationMinutes: 30,
      })
      adapter.handleIncomingCall = vi.fn().mockResolvedValue({
        contentType: 'text/xml',
        body: '<Response><Gather numDigits="4"/></Response>',
      })
      const app = await createTestApp(adapter, services)
      const res = await app.request('/api/telephony/language-selected?hub=hub-1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'CallSid=CA-lang&From=%2B15551111111&Digits=2',
      })
      expect(res.status).toBe(200)
      expect(services.settings.storeCaptcha).toHaveBeenCalledWith(
        expect.objectContaining({ callSid: 'CA-lang' }),
      )
      const handleCallArgs = (adapter.handleIncomingCall as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(handleCallArgs.captchaDigits).toMatch(/^\d{4}$/)
    })

    it('does not start parallel ringing when rate limited', async () => {
      services.settings.checkRateLimit = vi.fn().mockResolvedValue({ limited: true })
      services.settings.getSpamSettings = vi.fn().mockResolvedValue({
        voiceCaptchaEnabled: false,
        rateLimitEnabled: true,
        maxCallsPerMinute: 5,
        blockDurationMinutes: 30,
        overLimitAction: 'message',
      })
      const app = await createTestApp(adapter, services)
      const res = await app.request('/api/telephony/language-selected?hub=hub-1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'CallSid=CA-lang&From=%2B15551111111&Digits=2',
      })
      expect(res.status).toBe(200)
      const handleCallArgs = (adapter.handleIncomingCall as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(handleCallArgs.rateLimited).toBe(true)
    })
  })

  describe('POST /captcha', () => {
    const submit = async (body = 'Digits=1234&From=%2B15551111111', query = 'hub=hub-1&callSid=CA-captcha&lang=en') => {
      const app = await createTestApp(adapter, services)
      return app.request(`/api/telephony/captcha?${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      })
    }

    it('rejects a caller banned while solving the CAPTCHA, without enqueueing, and signals ban_match', async () => {
      services.records.checkBan = vi.fn().mockResolvedValue(true)
      const res = await submit()
      expect(res.status).toBe(200)
      expect(await res.text()).toContain('<Reject')
      expect(adapter.handleCaptchaResponse).not.toHaveBeenCalled()
      expect(services.settings.submitCaptcha).not.toHaveBeenCalled()
      expect(services.incidents.signal).toHaveBeenCalledWith('hub-1', 'spam', 'ban_match')
    })

    it('a pass enqueues the caller; the adapter is never handed the expected answer', async () => {
      const res = await submit()
      expect(res.status).toBe(200)
      expect(await res.text()).toContain('<Enqueue')
      expect(services.settings.submitCaptcha).toHaveBeenCalledWith({ callSid: 'CA-captcha', digits: '1234' })
      const params = (adapter.handleCaptchaResponse as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(params).toMatchObject({ outcome: 'pass', callSid: 'CA-captcha', callerLanguage: 'en', hubId: 'hub-1' })
      expect(params).not.toHaveProperty('expectedDigits')
      expect(services.incidents.signal).not.toHaveBeenCalled()
    })

    it.each(['retry', 'repeat'] as const)('%s re-challenges with the same digits and does not ring or signal', async (outcome) => {
      services.settings.submitCaptcha = vi.fn().mockResolvedValue({ outcome, digitsToSpeak: '4821', round: 1 })
      const res = await submit()
      expect(res.status).toBe(200)
      expect(adapter.handleCaptchaResponse).toHaveBeenCalledWith(
        expect.objectContaining({ outcome, digitsToSpeak: '4821', round: 1, callSid: 'CA-captcha', hubId: 'hub-1' }),
      )
      expect(services.calls.addCall).not.toHaveBeenCalled()
      expect(adapter.handleVoicemail).not.toHaveBeenCalled()
      expect(services.incidents.signal).not.toHaveBeenCalled()
    })

    it.each(['fail', 'timeout'] as const)('%s goes to voicemail — never a silent drop — and signals the incident', async (outcome) => {
      services.settings.submitCaptcha = vi.fn().mockResolvedValue({ outcome })
      const res = await submit('Digits=0000&From=%2B15551111111')
      expect(res.status).toBe(200)
      expect(adapter.handleCaptchaResponse).not.toHaveBeenCalled()
      expect(services.calls.addCall).toHaveBeenCalledWith('hub-1', expect.objectContaining({ callId: 'CA-captcha' }))
      expect(adapter.handleVoicemail).toHaveBeenCalledWith(expect.objectContaining({ callSid: 'CA-captcha', callerLanguage: 'en' }))
      expect(adapter.hangupResponse).not.toHaveBeenCalled()
      expect(services.incidents.signal).toHaveBeenCalledWith('hub-1', 'spam', outcome)
    })

    it('a timeout arrives with no digits and is submitted as such', async () => {
      adapter.parseCaptchaWebhook = vi.fn().mockResolvedValue({ digits: '', callerNumber: '+15551111111' })
      services.settings.submitCaptcha = vi.fn().mockResolvedValue({ outcome: 'retry', digitsToSpeak: '4821', round: 1 })
      await submit('CallSid=CA-captcha&From=%2B15551111111')
      expect(services.settings.submitCaptcha).toHaveBeenCalledWith({ callSid: 'CA-captcha', digits: '' })
    })

    // Twilio and Plivo post byte-identical bodies for two timeouts on one call;
    // only the signed callback URL's `round` differs. Modelled on the real
    // nonce table: unique on what the route hands checkWebhookReplay.
    it('two identical bodies on different challenge rounds are both processed; a true replay is not', async () => {
      const seen = new Set<string>()
      vi.mocked(checkWebhookReplay).mockImplementation(async (_db, provider, input) => {
        const key = `${provider}:${input}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      try {
        services.settings.submitCaptcha = vi.fn().mockResolvedValue({ outcome: 'retry', digitsToSpeak: '4821', round: 1 })
        const body = 'CallSid=CA-captcha&From=%2B15551111111'
        await submit(body, 'hub=hub-1&callSid=CA-captcha&lang=en&round=0')
        await submit(body, 'hub=hub-1&callSid=CA-captcha&lang=en&round=1')
        expect(services.settings.submitCaptcha).toHaveBeenCalledTimes(2)

        const replay = await submit(body, 'hub=hub-1&callSid=CA-captcha&lang=en&round=1')
        expect(await replay.text()).toBe('OK')
        expect(services.settings.submitCaptcha).toHaveBeenCalledTimes(2)
      } finally {
        vi.mocked(checkWebhookReplay).mockReset()
        vi.mocked(checkWebhookReplay).mockResolvedValue(true)
      }
    })
  })

  describe('POST /user-answer', () => {
    const validToken = () => {
      const leg = { callSid: 'CA-parent', volunteerPubkey: 'pk-vol-1', hubId: 'hub-1' }
      services.calls.resolveCallToken = vi.fn().mockResolvedValue(leg)
      services.calls.answerCallWithToken = vi.fn().mockResolvedValue(leg)
      services.calls.getActiveCalls = vi.fn().mockResolvedValue([
        { callId: 'CA-parent', callerLast4: '1111', startedAt: new Date().toISOString() },
      ])
    }
    const answer = async (body = 'CallSid=LEG-2', token = 'valid-token') => {
      const app = await createTestApp(adapter, services)
      return app.request(`/api/telephony/user-answer?callToken=${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      })
    }
    /** TwiML that ends the leg, with the call untouched: no bridge, no audit, no cancellation. */
    const expectLegRefused = async (res: Response) => {
      expect(res.status).toBe(200)
      expect(res.headers.get('Content-Type')).toContain('xml')
      expect(await res.text()).toBe('<Response><Hangup/></Response>')
      expect(adapter.handleCallAnswered).not.toHaveBeenCalled()
      expect(adapter.cancelRinging).not.toHaveBeenCalled()
      expect(services.audit.log).not.toHaveBeenCalled()
    }

    it('hangs up the leg (TwiML, not a JSON 403) for an invalid call token', async () => {
      const res = await answer('', 'bad-token')
      await expectLegRefused(res)
    })

    it('bridges call and publishes events on valid token', async () => {
      validToken()
      const res = await answer('')
      expect(res.status).toBe(200)
      expect(res.headers.get('Content-Type')).toContain('xml')
      expect(await res.text()).toContain('<Dial')
      expect(services.calls.answerCallWithToken).toHaveBeenCalledWith('valid-token')
      expect(adapter.handleCallAnswered).toHaveBeenCalledWith(
        expect.objectContaining({
          parentCallSid: 'CA-parent',
          userPubkey: 'pk-vol-1',
          hubId: 'hub-1',
        }),
      )
    })

    it('writes callAnswered only after the bridge instruction exists', async () => {
      validToken()
      const res = await answer()
      expect(res.status).toBe(200)
      expect(services.audit.log).toHaveBeenCalledWith('callAnswered', 'pk-vol-1', { callerLast4: '1111' }, 'hub-1')
      const bridged = vi.mocked(adapter.handleCallAnswered).mock.invocationCallOrder[0]
      const audited = vi.mocked(services.audit.log).mock.invocationCallOrder[0]
      expect(bridged).toBeLessThan(audited)
    })

    it('does not audit an answer when building the bridge fails', async () => {
      validToken()
      vi.mocked(adapter.handleCallAnswered).mockRejectedValue(new Error('provider down'))
      const res = await answer()
      expect(res.status).toBe(500)
      expect(services.audit.log).not.toHaveBeenCalled()
    })

    it('a leg answered by a machine neither claims the call nor cancels the other legs', async () => {
      // A carrier voicemail greeting picks up first when a volunteer's phone is off. It
      // must not take the call (the caller would be recorded onto a third-party mailbox
      // and every volunteer who really is ringing would be cancelled).
      validToken()
      vi.mocked(adapter.parseIncomingWebhook).mockResolvedValue({
        callSid: 'LEG-2', callerNumber: '+1', calledNumber: '+2', answeredByMachine: true,
      })
      recordRingLegs('CA-parent', ['LEG-1', 'LEG-2'])
      const res = await answer('CallSid=LEG-2&AnsweredBy=machine_start')
      await expectLegRefused(res)
      expect(services.calls.answerCallWithToken).not.toHaveBeenCalled()
    })

    // ---- #1505: provider-side recording is opt-in per hub, OFF by default ----

    /** The recordCall flag the route actually handed the adapter */
    const recordCallArg = () =>
      (adapter.handleCallAnswered as ReturnType<typeof vi.fn>).mock.calls[0][0].recordCall

    it('does not record when the hub has no recording setting (the default)', async () => {
      validToken()
      // makeServices()'s getCallSettings returns no recordCalls at all — the
      // shape a hub that never touched the setting has.
      const res = await answer()
      expect(res.status).toBe(200)
      expect(recordCallArg()).toBe(false)
    })

    it('does not record when the hub has recording explicitly disabled', async () => {
      validToken()
      services.settings.getCallSettings = vi.fn().mockResolvedValue({
        queueTimeoutSeconds: 90, voicemailMaxSeconds: 120, recordCalls: false,
      })
      const res = await answer()
      expect(res.status).toBe(200)
      expect(recordCallArg()).toBe(false)
    })

    it('records only when the hub has turned recording on', async () => {
      validToken()
      services.settings.getCallSettings = vi.fn().mockResolvedValue({
        queueTimeoutSeconds: 90, voicemailMaxSeconds: 120, recordCalls: true,
      })
      const res = await answer()
      expect(res.status).toBe(200)
      expect(recordCallArg()).toBe(true)
      // Read for this hub, not globally: hub A's choice must not record hub B.
      expect(services.settings.getCallSettings).toHaveBeenCalledWith('hub-1')
    })

    it('refuses a leg that lost the answer race: no bridge, no audit, no event, no leg cancellation', async () => {
      // answerCallWithToken is the atomic ringing → in-progress claim; null means
      // another volunteer already won (or the call is gone / the token is spent).
      validToken()
      services.calls.answerCallWithToken = vi.fn().mockResolvedValue(null)
      recordRingLegs('CA-parent', ['LEG-1', 'LEG-2'])
      const res = await answer()
      await expectLegRefused(res)
      expect(services.calls.answerCallWithToken).toHaveBeenCalledWith('valid-token')
    })

    it('cancels the other ringing legs, sparing the winner\'s own leg', async () => {
      validToken()
      vi.mocked(adapter.parseIncomingWebhook).mockResolvedValue({ callSid: 'LEG-2', callerNumber: '+1', calledNumber: '+2' } as never)
      recordRingLegs('CA-parent', ['LEG-1', 'LEG-2', 'LEG-3'])
      const res = await answer()
      expect(res.status).toBe(200)
      expect(adapter.cancelRinging).toHaveBeenCalledWith(['LEG-1', 'LEG-2', 'LEG-3'], 'LEG-2')
    })

    it('does not cancel any leg when the winner\'s leg SID is unknown (would hang up the winner)', async () => {
      validToken()
      vi.mocked(adapter.parseIncomingWebhook).mockRejectedValue(new Error('unparseable'))
      recordRingLegs('CA-parent', ['LEG-1', 'LEG-2'])
      const res = await answer()
      expect(res.status).toBe(200)
      expect(adapter.cancelRinging).not.toHaveBeenCalled()
    })
  })

  describe('POST /call-status', () => {
    it('ends call on completed status', async () => {
      services.calls.resolveCallToken = vi.fn().mockResolvedValue({
        callSid: 'CA-parent',
        volunteerPubkey: 'pk-vol-1',
        hubId: 'hub-1',
      })
      services.calls.getActiveCalls = vi.fn().mockResolvedValue([
        { callId: 'CA-parent', callerLast4: '1111', answeredBy: 'pk-vol-1', startedAt: new Date(Date.now() - 60000).toISOString() },
      ])
      adapter.parseCallStatusWebhook = vi.fn().mockResolvedValue({ status: 'completed' })

      const app = await createTestApp(adapter, services)
      const res = await app.request('/api/telephony/call-status?callToken=token-abc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'CallStatus=completed',
      })
      expect(res.status).toBe(200)
      expect(services.calls.endCall).toHaveBeenCalledWith('hub-1', 'CA-parent')
      expect(adapter.emptyResponse).toHaveBeenCalled()
    })

    it('does not end the call when a leg that never answered reports completed', async () => {
      services.calls.resolveCallToken = vi.fn().mockResolvedValue({
        callSid: 'CA-parent',
        volunteerPubkey: 'pk-vol-2',
        hubId: 'hub-1',
      })
      services.calls.getActiveCalls = vi.fn().mockResolvedValue([
        { callId: 'CA-parent', callerLast4: '1111', answeredBy: 'pk-vol-1', startedAt: new Date(Date.now() - 60000).toISOString() },
      ])
      adapter.parseCallStatusWebhook = vi.fn().mockResolvedValue({ status: 'completed' })

      const app = await createTestApp(adapter, services)
      const res = await app.request('/api/telephony/call-status?callToken=token-other-leg', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'CallStatus=completed',
      })
      expect(res.status).toBe(200)
      expect(services.calls.endCall).not.toHaveBeenCalled()
    })

    it('resolves the token read-only — a pre-answer status callback never consumes it', async () => {
      services.calls.resolveCallToken = vi.fn().mockResolvedValue({
        callSid: 'CA-parent',
        volunteerPubkey: 'pk-vol-1',
        hubId: 'hub-1',
      })
      adapter.parseCallStatusWebhook = vi.fn().mockResolvedValue({ status: 'initiated' })

      const app = await createTestApp(adapter, services)
      const res = await app.request('/api/telephony/call-status?callToken=token-abc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'CallStatus=initiated',
      })
      expect(res.status).toBe(200)
      expect(services.calls.resolveCallToken).toHaveBeenCalledWith('token-abc')
      expect(services.calls.answerCallWithToken).not.toHaveBeenCalled()
      expect(services.calls.endCall).not.toHaveBeenCalled()
    })

    it('does not end call on ringing status', async () => {
      services.calls.resolveCallToken = vi.fn().mockResolvedValue(null)
      adapter.parseCallStatusWebhook = vi.fn().mockResolvedValue({ status: 'ringing' })

      const app = await createTestApp(adapter, services)
      const res = await app.request('/api/telephony/call-status?parentCallSid=CA-parent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'CallStatus=ringing',
      })
      expect(res.status).toBe(200)
      expect(services.calls.endCall).not.toHaveBeenCalled()
    })

    it('handles busy/no-answer/failed statuses', async () => {
      for (const status of ['busy', 'no-answer', 'failed'] as const) {
        vi.clearAllMocks()
        adapter = makeMockAdapter()
        services = makeServices()
        services.calls.resolveCallToken = vi.fn().mockResolvedValue({
          callSid: 'CA-parent',
          volunteerPubkey: 'pk-vol-1',
          hubId: 'hub-1',
        })
        adapter.parseCallStatusWebhook = vi.fn().mockResolvedValue({ status })

        const app = await createTestApp(adapter, services)
        const res = await app.request('/api/telephony/call-status?callToken=token-abc', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `CallStatus=${status}`,
        })
        expect(res.status).toBe(200)
        expect(services.calls.endCall).not.toHaveBeenCalled()
      }
    })
  })

  describe('ALL /wait-music', () => {
    it('returns wait music XML on POST', async () => {
      const app = await createTestApp(adapter, services)
      const res = await app.request('/api/telephony/wait-music?hub=hub-1&lang=en', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'QueueTime=30',
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('Content-Type')).toContain('xml')
      // A cloud provider speaks prompts itself: no generated-speech builder.
      expect(adapter.handleWaitMusic).toHaveBeenCalledWith('en', expect.any(Object), 30, 90, undefined)
    })

    it('returns wait music XML on GET with queueTime 0', async () => {
      const app = await createTestApp(adapter, services)
      const res = await app.request('/api/telephony/wait-music?hub=hub-1&lang=es', {
        method: 'GET',
      })
      expect(res.status).toBe(200)
      expect(adapter.handleWaitMusic).toHaveBeenCalledWith('es', expect.any(Object), 0, 90, undefined)
    })
  })

  describe('POST /queue-exit', () => {
    it('ends call on hangup result', async () => {
      adapter.parseQueueExitWebhook = vi.fn().mockResolvedValue({ result: 'hangup' })
      const app = await createTestApp(adapter, services)
      const res = await app.request('/api/telephony/queue-exit?hub=hub-1&callSid=CA-exit&lang=en', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'QueueResult=hangup',
      })
      expect(res.status).toBe(200)
      expect(services.calls.endCall).toHaveBeenCalledWith('hub-1', 'CA-exit')
      expect(adapter.emptyResponse).toHaveBeenCalled()
    })

    it('returns voicemail prompt on leave result', async () => {
      adapter.parseQueueExitWebhook = vi.fn().mockResolvedValue({ result: 'leave' })
      const app = await createTestApp(adapter, services)
      const res = await app.request('/api/telephony/queue-exit?hub=hub-1&callSid=CA-exit&lang=en', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'QueueResult=leave',
      })
      expect(res.status).toBe(200)
      expect(adapter.handleVoicemail).toHaveBeenCalledWith(
        expect.objectContaining({
          callSid: 'CA-exit',
          callerLanguage: 'en',
          maxRecordingSeconds: 120,
          hubId: 'hub-1',
        }),
      )
    })

    it('returns voicemail prompt on queue-full result', async () => {
      adapter.parseQueueExitWebhook = vi.fn().mockResolvedValue({ result: 'queue-full' })
      const app = await createTestApp(adapter, services)
      const res = await app.request('/api/telephony/queue-exit?hub=hub-1&callSid=CA-exit&lang=en', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'QueueResult=queue-full',
      })
      expect(res.status).toBe(200)
      expect(adapter.handleVoicemail).toHaveBeenCalled()
    })

    it('returns voicemail prompt on error result', async () => {
      adapter.parseQueueExitWebhook = vi.fn().mockResolvedValue({ result: 'error' })
      const app = await createTestApp(adapter, services)
      const res = await app.request('/api/telephony/queue-exit?hub=hub-1&callSid=CA-exit&lang=en', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'QueueResult=error',
      })
      expect(res.status).toBe(200)
      expect(adapter.handleVoicemail).toHaveBeenCalled()
    })

    it('returns empty response on bridged result', async () => {
      adapter.parseQueueExitWebhook = vi.fn().mockResolvedValue({ result: 'bridged' })
      const app = await createTestApp(adapter, services)
      const res = await app.request('/api/telephony/queue-exit?hub=hub-1&callSid=CA-exit&lang=en', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'QueueResult=bridged',
      })
      expect(res.status).toBe(200)
      expect(adapter.emptyResponse).toHaveBeenCalled()
      expect(adapter.handleVoicemail).not.toHaveBeenCalled()
    })
  })

  describe('POST /voicemail-complete', () => {
    it('returns thank you and hangup', async () => {
      const app = await createTestApp(adapter, services)
      const res = await app.request('/api/telephony/voicemail-complete?hub=hub-1&lang=en', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: '',
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('Content-Type')).toContain('xml')
      const body = await res.text()
      expect(body).toContain('<Say')
      expect(body).toContain('<Hangup')
      expect(adapter.handleVoicemailComplete).toHaveBeenCalledWith('en', undefined)
    })

    it('hands a self-hosted PBX generated speech, rooted at the origin it reached us on (#1347)', async () => {
      // An AsteriskAdapter by type, with the mock's behaviour.
      const pbx = Object.assign(Object.create(AsteriskAdapter.prototype) as AsteriskAdapter, makeMockAdapter())
      const builder = vi.fn()
      const urlBuilder = vi.fn().mockResolvedValue(builder)
      const withSpeech = { ...services, ivrSpeech: { urlBuilder } } as unknown as Services
      const app = await createTestApp(pbx, withSpeech)
      const res = await app.request('http://app:3000/api/telephony/voicemail-complete?hub=hub-1&lang=fr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: '',
      })
      expect(res.status).toBe(200)
      expect(urlBuilder).toHaveBeenCalledWith('http://app:3000')
      expect(pbx.handleVoicemailComplete).toHaveBeenCalledWith('fr', builder)
    })
  })

  describe('POST /call-recording', () => {
    it('ends call and triggers transcription on completed recording', async () => {
      adapter.parseRecordingWebhook = vi.fn().mockResolvedValue({
        status: 'completed',
        recordingSid: 'RE123',
        callSid: 'CA-parent',
      })
      services.calls.getActiveCalls = vi.fn().mockResolvedValue([
        { callId: 'CA-parent', answeredBy: 'pk-vol-1', callerLast4: '1111' },
      ])

      const app = await createTestApp(adapter, services)
      const res = await app.request('/api/telephony/call-recording?parentCallSid=CA-parent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'RecordingStatus=completed&RecordingSid=RE123',
      })
      expect(res.status).toBe(200)
      expect(services.calls.endCall).toHaveBeenCalledWith('hub-1', 'CA-parent')
      // #2297: the provider now holds this call's audio — tracked until its record goes.
      expect(services.providerRecordings.track).toHaveBeenCalledWith({
        hubId: 'hub-1', callId: 'CA-parent', recordingSid: 'RE123', kind: 'call', adapter,
      })
      expect(adapter.emptyResponse).toHaveBeenCalled()
    })

    it('tracks a completed recording that carried no handle as unaddressable residue, never drops it', async () => {
      // The provider holds this audio but named no handle: before the fix the
      // route logged and wrote nothing, so the recording was indistinguishable
      // from one never made.
      adapter.parseRecordingWebhook = vi.fn().mockResolvedValue({ status: 'completed', callSid: 'CA-child' })

      const app = await createTestApp(adapter, services)
      const res = await app.request('/api/telephony/call-recording?parentCallSid=CA-parent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'RecordingStatus=completed',
      })
      expect(res.status).toBe(200)
      expect(services.providerRecordings.trackUnaddressable).toHaveBeenCalledWith({
        hubId: 'hub-1', callId: 'CA-parent', kind: 'call', adapter,
      })
      expect(services.providerRecordings.track).not.toHaveBeenCalled()
    })

    it('checks the signature with the adapter of the hub the call belongs to (#2309)', async () => {
      // The global provider would refuse the signature; the call's own hub
      // accepts it. Validating with the global adapter refused every hub with
      // its own provider account, and its recordings stayed at the provider.
      const globalAdapter = { ...adapter, validateWebhook: vi.fn().mockResolvedValue(false) }
      vi.mocked(getTelephonyFromService).mockResolvedValue(globalAdapter as never)
      adapter.parseRecordingWebhook = vi.fn().mockResolvedValue({ status: 'failed' })

      const app = await createTestApp(adapter, services)
      const res = await app.request('/api/telephony/call-recording?parentCallSid=CA-parent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'RecordingStatus=failed',
      })
      expect(res.status).toBe(200)
      expect(services.calls.getHubIdForCall).toHaveBeenCalledWith('CA-parent')
      expect(vi.mocked(getHubTelephonyFromService).mock.calls.some(call => call[2] === 'hub-1')).toBe(true)
      expect(globalAdapter.validateWebhook).not.toHaveBeenCalled()
    })

    it('ignores a ?hub= on /call-recording: another hub\'s credentials never vouch for this call (#2309)', async () => {
      // The handler acts with the adapter of the hub that owns parentCallSid.
      // Validating with a caller-chosen hub's adapter would let one hub's
      // provider account sign a callback that copies, deletes and ends another
      // hub's call.
      adapter.parseRecordingWebhook = vi.fn().mockResolvedValue({ status: 'failed' })

      const app = await createTestApp(adapter, services)
      const res = await app.request('/api/telephony/call-recording?hub=hub-other&parentCallSid=CA-parent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'RecordingStatus=failed',
      })
      expect(res.status).toBe(200)
      expect(services.calls.getHubIdForCall).toHaveBeenCalledWith('CA-parent')
      expect(vi.mocked(getHubTelephonyFromService).mock.calls.some(call => call[2] === 'hub-other')).toBe(false)
      expect(vi.mocked(getHubTelephonyFromService).mock.calls.some(call => call[2] === 'hub-1')).toBe(true)
    })

    it('does not end call on failed recording', async () => {
      adapter.parseRecordingWebhook = vi.fn().mockResolvedValue({
        status: 'failed',
        recordingSid: 'RE123',
      })

      const app = await createTestApp(adapter, services)
      const res = await app.request('/api/telephony/call-recording?parentCallSid=CA-parent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'RecordingStatus=failed',
      })
      expect(res.status).toBe(200)
      expect(services.calls.endCall).not.toHaveBeenCalled()
    })
  })

  describe('POST /voicemail-recording', () => {
    it('marks voicemail and triggers transcription on completed', async () => {
      adapter.parseRecordingWebhook = vi.fn().mockResolvedValue({
        status: 'completed',
        recordingSid: 'RE-vm',
        callSid: 'CA-vm',
      })

      const app = await createTestApp(adapter, services)
      const res = await app.request('/api/telephony/voicemail-recording?hub=hub-1&callSid=CA-vm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'RecordingStatus=completed&RecordingSid=RE-vm',
      })
      expect(res.status).toBe(200)
      expect(services.calls.markVoicemail).toHaveBeenCalledWith('hub-1', 'CA-vm')
      // The call is closed so it lands in history as unanswered + hasVoicemail (#1043)
      expect(services.calls.endCall).toHaveBeenCalledWith('hub-1', 'CA-vm')
      // #2297: tracked BEFORE the response, so the handle survives the background task.
      expect(services.providerRecordings.track).toHaveBeenCalledWith({
        hubId: 'hub-1', callId: 'CA-vm', recordingSid: 'RE-vm', kind: 'voicemail', adapter,
      })
      expect(adapter.emptyResponse).toHaveBeenCalled()
    })

    it('deletes the voicemail at the provider through the hub adapter (#2297)', async () => {
      adapter.parseRecordingWebhook = vi.fn().mockResolvedValue({ status: 'completed', recordingSid: 'RE-vm', callSid: 'CA-vm' })

      const app = await createTestApp(adapter, services)
      await app.request('/api/telephony/voicemail-recording?hub=hub-1&callSid=CA-vm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'RecordingStatus=completed&RecordingSid=RE-vm',
      })
      await vi.waitFor(() => expect(services.providerRecordings.deleteHeld).toHaveBeenCalled())
      const [resolve, filter] = vi.mocked(services.providerRecordings.deleteHeld).mock.calls[0]!
      expect(await resolve('hub-1')).toBe(adapter)
      expect(filter).toEqual({ hubId: 'hub-1', callIds: ['CA-vm'], kind: 'voicemail' })
    })

    it('tolerates the call having already ended', async () => {
      adapter.parseRecordingWebhook = vi.fn().mockResolvedValue({ status: 'completed', recordingSid: 'RE-vm', callSid: 'CA-vm' })
      services.calls.endCall = vi.fn().mockRejectedValue(new ServiceError(404, 'Call not found'))

      const app = await createTestApp(adapter, services)
      const res = await app.request('/api/telephony/voicemail-recording?hub=hub-1&callSid=CA-vm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'RecordingStatus=completed&RecordingSid=RE-vm',
      })
      expect(res.status).toBe(200)
    })

    it('does not swallow a missing call record: markVoicemail failures surface', async () => {
      adapter.parseRecordingWebhook = vi.fn().mockResolvedValue({ status: 'completed', recordingSid: 'RE-vm', callSid: 'CA-none' })
      services.calls.markVoicemail = vi.fn().mockRejectedValue(new ServiceError(404, 'Call not found'))

      const app = await createTestApp(adapter, services)
      // Mirror the production global handler (apps/worker/app.ts) for ServiceError
      app.onError((err, c) => c.json({ error: err.message }, err instanceof ServiceError ? (err.status as 404) : 500))
      const res = await app.request('/api/telephony/voicemail-recording?hub=hub-1&callSid=CA-none', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'RecordingStatus=completed&RecordingSid=RE-vm',
      })
      expect(res.status).toBe(404)
      expect(services.calls.endCall).not.toHaveBeenCalled()
      // The provider holds the audio whether or not the call is known here.
      expect(services.providerRecordings.track).toHaveBeenCalledWith({
        hubId: 'hub-1', callId: 'CA-none', recordingSid: 'RE-vm', kind: 'voicemail', adapter,
      })
    })

    it('tracks a completed voicemail that carried no handle as unaddressable residue, never drops it', async () => {
      adapter.parseRecordingWebhook = vi.fn().mockResolvedValue({ status: 'completed', callSid: 'CA-vm' })

      const app = await createTestApp(adapter, services)
      const res = await app.request('/api/telephony/voicemail-recording?hub=hub-1&callSid=CA-vm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'RecordingStatus=completed',
      })
      expect(res.status).toBe(200)
      expect(services.providerRecordings.trackUnaddressable).toHaveBeenCalledWith({
        hubId: 'hub-1', callId: 'CA-vm', kind: 'voicemail', adapter,
      })
      expect(services.providerRecordings.track).not.toHaveBeenCalled()
      // Nothing to fetch or delete with: no deletion is attempted, and none reported.
      expect(services.providerRecordings.deleteHeld).not.toHaveBeenCalled()
    })

    it('does nothing on non-completed status', async () => {
      adapter.parseRecordingWebhook = vi.fn().mockResolvedValue({
        status: 'failed',
        recordingSid: 'RE-vm',
      })

      const app = await createTestApp(adapter, services)
      const res = await app.request('/api/telephony/voicemail-recording?hub=hub-1&callSid=CA-vm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'RecordingStatus=failed',
      })
      expect(res.status).toBe(200)
      expect(services.calls.markVoicemail).not.toHaveBeenCalled()
      expect(services.providerRecordings.track).not.toHaveBeenCalled()
      expect(services.providerRecordings.trackUnaddressable).not.toHaveBeenCalled()
    })
  })
})
