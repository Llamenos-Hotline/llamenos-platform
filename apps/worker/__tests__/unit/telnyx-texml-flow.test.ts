/**
 * #2305 / #1135 — a Telnyx caller gets through the IVR, and a volunteer leg's
 * progress events never claim the answer.
 *
 * The real telephony router, the real TelnyxAdapter and REAL Ed25519 signatures
 * — only the services behind the routes are stubbed. Each step follows the URL
 * the PREVIOUS step's TeXML named, instead of POSTing to a route this test
 * already knew: "phase written but never read" is exactly the bug that passed
 * every test which hard-coded the next route.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '@worker/types'
import type { Services } from '@worker/services'
import { TelnyxAdapter, TELNYX_VOICES } from '@worker/telephony/telnyx'
import '@worker/__tests__/mocks/llamenos-crypto-ffi'
import { makeTelnyxSigner, publicKeyResponse, type TelnyxSigner } from '../helpers/telnyx-signing'

vi.mock('@worker/lib/service-factories')
vi.mock('@worker/services/webhook-replay', () => ({
  checkWebhookReplay: vi.fn().mockResolvedValue(true),
}))
vi.mock('@worker/db', () => ({ getDb: vi.fn().mockReturnValue({}) }))
vi.mock('@worker/services/ringing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@worker/services/ringing')>()),
  startParallelRinging: vi.fn().mockResolvedValue(undefined),
  cancelLosingLegs: vi.fn().mockResolvedValue(undefined),
}))
import { getTelephonyFromService, getHubTelephonyFromService } from '@worker/lib/service-factories'
import { startParallelRinging, cancelLosingLegs } from '@worker/services/ringing'
import { checkWebhookReplay } from '@worker/services/webhook-replay'

const ORIGIN = 'https://hotline.example.org'
const HOTLINE_NUMBER = '+15551234567'
const CALLER = '+15559876543'
const CONNECTION_ID = 'conn-123'
const CALL_SID = 'v3:caller-leg'

function makeServices() {
  return {
    settings: {
      getHubByPhone: vi.fn().mockResolvedValue({ hub: { id: 'hub-1' } }),
      getHub: vi.fn().mockResolvedValue({ hub: { id: 'hub-1' } }),
      isHubChannelEnabled: vi.fn().mockResolvedValue(true),
      getIvrLanguages: vi.fn().mockResolvedValue({ enabledLanguages: ['en', 'es'] }),
      resolveIvrVoiceCatalog: vi.fn().mockResolvedValue({ state: 'resolved', catalog: TELNYX_VOICES }),
      getSpamSettings: vi.fn().mockResolvedValue({ voiceCaptchaEnabled: true, rateLimitEnabled: false, maxCallsPerMinute: 5, overLimitAction: 'message' }),
      checkRateLimit: vi.fn().mockResolvedValue({ limited: false }),
      storeCaptcha: vi.fn().mockResolvedValue(undefined),
      submitCaptcha: vi.fn().mockResolvedValue({ outcome: 'pass' }),
      getCallSettings: vi.fn().mockResolvedValue({ queueTimeoutSeconds: 90, voicemailMaxSeconds: 120, recordCalls: false }),
      resolveIvrAudioList: vi.fn().mockResolvedValue({ recordings: [] }),
    },
    records: { checkBan: vi.fn().mockResolvedValue(false) },
    incidents: { signal: vi.fn().mockResolvedValue(undefined) },
    calls: {
      resolveCallToken: vi.fn().mockResolvedValue({ callSid: CALL_SID, hubId: 'hub-1', volunteerPubkey: 'pk-1' }),
      answerCallWithToken: vi.fn().mockResolvedValue({ callSid: CALL_SID, hubId: 'hub-1', volunteerPubkey: 'pk-1' }),
      getActiveCalls: vi.fn().mockResolvedValue([]),
      getHubIdForCall: vi.fn().mockResolvedValue('hub-1'),
      endCall: vi.fn().mockResolvedValue(undefined),
      addCall: vi.fn().mockResolvedValue({ callId: CALL_SID }),
      markVoicemail: vi.fn().mockResolvedValue(undefined),
    },
    providerRecordings: { track: vi.fn().mockResolvedValue(undefined), trackUnaddressable: vi.fn().mockResolvedValue(undefined) },
    audit: { log: vi.fn().mockResolvedValue(undefined) },
  } as unknown as Services
}

function makeEnv(): AppEnv['Bindings'] {
  return {
    ENVIRONMENT: 'test',
    HOTLINE_NAME: 'Test Hotline',
    HMAC_SECRET: 'a'.repeat(64),
    SERVER_KEK: 'c'.repeat(64),
    BAN_HASH_KEY: 'b'.repeat(64),
    ADMIN_PUBKEY: 'a'.repeat(64),
  } as unknown as AppEnv['Bindings']
}

/** The path-and-query of an absolute callback URL a TeXML document named */
const pathOf = (callbackUrl: string) => {
  const u = new URL(callbackUrl, ORIGIN)
  return `${u.pathname}${u.search}`
}

/** An attribute of the first `<element>` in a TeXML document, unescaped */
function attr(xml: string, element: string, name: string): string {
  const tag = new RegExp(`<${element}\\b[^>]*>`).exec(xml)?.[0]
  const value = tag && new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1]
  if (value === undefined) throw new Error(`no ${element}@${name} in:\n${xml}`)
  return value.replace(/&amp;/g, '&')
}

describe('Telnyx TeXML call flow, through the real router with real signatures', () => {
  let signer: TelnyxSigner
  let services: ReturnType<typeof makeServices>
  let app: Hono<AppEnv>
  let fetchSpy: ReturnType<typeof vi.spyOn>
  let adapter: TelnyxAdapter
  let ringBodies: Array<Record<string, string>>

  beforeEach(async () => {
    vi.clearAllMocks()
    signer = await makeTelnyxSigner()
    ringBodies = []
    let legs = 0
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url === 'https://api.telnyx.com/v2/public_key') return publicKeyResponse(signer)
      if (url.startsWith('https://api.telnyx.com/v2/texml/calls/')) {
        ringBodies.push(JSON.parse(String(init?.body)))
        return Response.json({ call_sid: `v3:volunteer-leg-${++legs}`, status: 'queued' })
      }
      throw new Error(`unexpected request to ${url}`)
    })

    adapter = new TelnyxAdapter('test-api-key', CONNECTION_ID, HOTLINE_NUMBER, ORIGIN)
    vi.mocked(getTelephonyFromService).mockResolvedValue(adapter)
    vi.mocked(getHubTelephonyFromService).mockResolvedValue(adapter)

    services = makeServices()
    const { default: telephony } = await import('@worker/routes/telephony')
    app = new Hono<AppEnv>()
    app.use('*', async (c, next) => {
      c.set('services', services as unknown as AppEnv['Variables']['services'])
      c.env = makeEnv()
      Object.defineProperty(c, 'executionCtx', {
        value: { waitUntil: vi.fn(), passThroughOnException: vi.fn() },
        writable: true,
        configurable: true,
      })
      await next()
    })
    app.route('/api/telephony', telephony)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** POST the way Telnyx does: form-encoded, Ed25519-signed over timestamp|body */
  async function telnyxPost(path: string, fields: Record<string, string>, signWith: TelnyxSigner = signer) {
    const body = new URLSearchParams(fields).toString()
    return app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(await signWith.sign(body)) },
      body,
    })
  }

  const callFields = (extra: Record<string, string> = {}) => ({
    AccountSid: 'acct-1', CallSid: CALL_SID, From: CALLER, To: HOTLINE_NUMBER, ConnectionId: CONNECTION_ID, ...extra,
  })

  describe('#2305 — the caller advances through language → CAPTCHA → queue', () => {
    it('follows each step\'s own callback URL, and each callback reaches the step it belongs to', async () => {
      // 1. The call arrives: the language menu.
      const incoming = await telnyxPost('/api/telephony/incoming', callFields({ CallStatus: 'in-progress' }))
      expect(incoming.status).toBe(200)
      expect(incoming.headers.get('content-type')).toContain('text/xml')
      const menu = await incoming.text()
      expect(menu).toContain('<Gather')
      expect(services.settings.getIvrLanguages).toHaveBeenCalledTimes(1)

      // 2. The caller presses 2 (Spanish): the gather's action URL, with the digit.
      const afterMenu = await telnyxPost(pathOf(attr(menu, 'Gather', 'action')), callFields({ Digits: '2' }))
      expect(afterMenu.status).toBe(200)
      const captcha = await afterMenu.text()
      // It was NOT the language menu again — the call moved on, in Spanish.
      expect(captcha).not.toContain('language-selected')
      expect(captcha).toContain('voice="AWS.Polly.Lupe-Neural"')
      expect(services.settings.getIvrLanguages).toHaveBeenCalledTimes(2) // once to menu, once to resolve the digit
      expect(services.settings.storeCaptcha).toHaveBeenCalledWith({ callSid: CALL_SID, expected: expect.stringMatching(/^\d{4}$/) })
      expect(startParallelRinging).not.toHaveBeenCalled() // nothing rings before the CAPTCHA passes

      // 3. The caller keys in the digits: the CAPTCHA gather's action URL.
      const afterCaptcha = await telnyxPost(pathOf(attr(captcha, 'Gather', 'action')), callFields({ Digits: '1234' }))
      expect(afterCaptcha.status).toBe(200)
      const queued = await afterCaptcha.text()
      expect(services.settings.submitCaptcha).toHaveBeenCalledWith({ callSid: CALL_SID, digits: '1234' })
      expect(queued).toContain('<Enqueue')
      expect(startParallelRinging).toHaveBeenCalledTimes(1)
      expect(vi.mocked(startParallelRinging).mock.calls[0]![0]).toBe(CALL_SID)

      // 4. Waiting in the queue: hold music, then — at the timeout — the caller is let out to voicemail.
      const wait = await telnyxPost(pathOf(attr(queued, 'Enqueue', 'waitUrl')), callFields({ QueueTime: '10' }))
      expect(await wait.text()).toContain('<Play>')
      const timedOut = await telnyxPost(pathOf(attr(queued, 'Enqueue', 'waitUrl')), callFields({ QueueTime: '95' }))
      expect(await timedOut.text()).toContain('<Leave/>')
      const left = await telnyxPost(pathOf(attr(queued, 'Enqueue', 'action')), callFields({ QueueResult: 'leave' }))
      const voicemail = await left.text()
      expect(voicemail).toContain('<Record')
      expect(attr(voicemail, 'Record', 'action')).toContain('/api/telephony/voicemail-complete')
    })

    it('a caller who presses nothing is carried on by the menu\'s own fallback URL', async () => {
      const menu = await (await telnyxPost('/api/telephony/incoming', callFields())).text()
      const redirect = />([^<]*language-selected\?auto=1[^<]*)<\/Redirect>/.exec(menu)?.[1]?.replace(/&amp;/g, '&')
      expect(redirect, menu).toBeTruthy()
      const res = await telnyxPost(pathOf(redirect!), callFields())
      expect(res.status).toBe(200)
      expect(await res.text()).toContain('<Gather') // the CAPTCHA, in the detected language
      expect(services.settings.storeCaptcha).toHaveBeenCalled()
    })

    it('a wrong CAPTCHA answer is challenged again on the next round, not queued', async () => {
      vi.mocked(services.settings.submitCaptcha).mockResolvedValue({ outcome: 'retry', digitsToSpeak: '4821', round: 1 })
      const menu = await (await telnyxPost('/api/telephony/incoming', callFields())).text()
      const challenge = await (await telnyxPost(pathOf(attr(menu, 'Gather', 'action')), callFields({ Digits: '1' }))).text()
      const firstRound = pathOf(attr(challenge, 'Gather', 'action'))
      expect(new URL(firstRound, ORIGIN).searchParams.get('round')).toBe('0')
      const res = await telnyxPost(firstRound, callFields({ Digits: '0000' }))
      const body = await res.text()
      expect(new URL(attr(body, 'Gather', 'action')).searchParams.get('round')).toBe('1')
      expect(body).not.toContain('<Enqueue')
      expect(startParallelRinging).not.toHaveBeenCalled()
    })
  })

  describe('#1135 — a volunteer leg\'s progress events never claim the answer', () => {
    async function ringOneVolunteer() {
      await adapter.ringVolunteers({
        callSid: CALL_SID, callerNumber: CALLER, callbackUrl: ORIGIN, hubId: 'hub-1',
        volunteers: [{ phone: '+15550000001', callToken: 'leg-token-1' }],
      })
      return ringBodies[0]!
    }

    it('initiated and ringing go to /call-status and claim nothing; the answer fetch claims the call and bridges', async () => {
      const ring = await ringOneVolunteer()
      const legFields = (extra: Record<string, string>) => ({ AccountSid: 'acct-1', CallSid: 'v3:volunteer-leg-1', From: HOTLINE_NUMBER, To: '+15550000001', ConnectionId: CONNECTION_ID, ParentCallSid: CALL_SID, ...extra })

      // Telnyx's real event order for the leg, each to the URL it was given for that purpose.
      for (const status of ['initiated', 'ringing']) {
        const res = await telnyxPost(pathOf(ring.StatusCallback!), legFields({ CallStatus: status }))
        expect(res.status).toBe(200)
      }
      expect(services.calls.answerCallWithToken).not.toHaveBeenCalled()
      expect(cancelLosingLegs).not.toHaveBeenCalled()

      // The volunteer picks up: Telnyx fetches TeXML from the answer URL.
      const answer = await telnyxPost(pathOf(ring.Url!), legFields({ CallStatus: 'in-progress', AnsweredBy: 'human' }))
      expect(answer.status).toBe(200)
      expect(await answer.text()).toContain('<Queue>v3:caller-leg</Queue>')
      expect(services.calls.answerCallWithToken).toHaveBeenCalledTimes(1)
      expect(services.calls.answerCallWithToken).toHaveBeenCalledWith('leg-token-1')
      expect(vi.mocked(cancelLosingLegs).mock.calls[0]![4]).toBe('v3:volunteer-leg-1') // the winner is not cancelled

      // The answered leg's later events still find their call.
      const done = await telnyxPost(pathOf(ring.StatusCallback!), legFields({ CallStatus: 'completed' }))
      expect(done.status).toBe(200)
    })

    it('a leg an answering machine picked up is hung up and does not claim the call', async () => {
      const ring = await ringOneVolunteer()
      const res = await telnyxPost(pathOf(ring.Url!), {
        AccountSid: 'acct-1', CallSid: 'v3:volunteer-leg-1', From: HOTLINE_NUMBER, To: '+15550000001', ConnectionId: CONNECTION_ID, AnsweredBy: 'machine_start',
      })
      expect(await res.text()).toBe('<Response><Hangup/></Response>')
      expect(services.calls.answerCallWithToken).not.toHaveBeenCalled()
    })
  })

  describe('the callback URL a TeXML document names is authenticated, not just the body', () => {
    // Telnyx signs `timestamp|body` and nothing else, so `hub`, `callSid`,
    // `round`, `lang` and `callToken` — all in the URL — are outside what the
    // signature covers. A correctly signed callback captured on its way to us can
    // be re-sent inside the 60 s tolerance with the URL altered. These tests send
    // exactly that: a REAL signature over the body, and a mutated URL. (The replay
    // store is stubbed to "first sighting" — the case where the original never
    // arrived, which is the only case a replay guard cannot help with.)
    const OTHER_HUB = 'hub-2'

    async function menuPath() {
      const menu = await (await telnyxPost('/api/telephony/incoming', callFields())).text()
      return pathOf(attr(menu, 'Gather', 'action'))
    }
    const mutate = (path: string, change: (q: URLSearchParams) => void) => {
      const u = new URL(path, ORIGIN)
      change(u.searchParams)
      return `${u.pathname}${u.search}`
    }

    it('a callback minted for one hub, re-sent naming another, is refused and acts on neither', async () => {
      const genuine = await menuPath()
      expect(new URL(genuine, ORIGIN).searchParams.get('hub')).toBe('hub-1')

      const redirected = mutate(genuine, q => q.set('hub', OTHER_HUB))
      const res = await telnyxPost(redirected, callFields({ Digits: '1' }))

      expect(res.status).toBe(403)
      expect(services.settings.getIvrLanguages).toHaveBeenCalledTimes(1) // the menu's own, nothing since
      expect(services.settings.storeCaptcha).not.toHaveBeenCalled()
      expect(startParallelRinging).not.toHaveBeenCalled()
    })

    it('the same callback, untouched, is served', async () => {
      const res = await telnyxPost(await menuPath(), callFields({ Digits: '1' }))
      expect(res.status).toBe(200)
      expect(await res.text()).toContain('<Gather')
    })

    it('a callback with its hub removed is refused rather than served as though it had one', async () => {
      const res = await telnyxPost(mutate(await menuPath(), q => q.delete('hub')), callFields({ Digits: '1' }))
      expect(res.status).toBe(403)
      expect(services.settings.storeCaptcha).not.toHaveBeenCalled()
    })

    it('a callback with no authentication tag at all is refused', async () => {
      const res = await telnyxPost(mutate(await menuPath(), q => q.delete('sig')), callFields({ Digits: '1' }))
      expect(res.status).toBe(403)
    })

    it('an invented tag is refused', async () => {
      const res = await telnyxPost(mutate(await menuPath(), q => q.set('sig', 'A'.repeat(43))), callFields({ Digits: '1' }))
      expect(res.status).toBe(403)
    })

    it('a tag minted for one step does not vouch for another', async () => {
      const toLanguage = await menuPath() // /language-selected?hub=…&sig=…
      const asQueueExit = toLanguage.replace('/language-selected', '/queue-exit')
      const res = await telnyxPost(asQueueExit, callFields({ QueueResult: 'hangup' }))
      expect(res.status).toBe(403)
      expect(services.calls.endCall).not.toHaveBeenCalled()
    })

    async function captchaPath() {
      vi.mocked(services.settings.submitCaptcha).mockResolvedValue({ outcome: 'retry', digitsToSpeak: '4821', round: 1 })
      const afterMenu = await (await telnyxPost(await menuPath(), callFields({ Digits: '1' }))).text()
      return pathOf(attr(afterMenu, 'Gather', 'action'))
    }

    it.each([
      ['callSid', 'v3:another-callers-leg'],
      ['lang', 'es'],
      ['round', '9'],
      ['hub', OTHER_HUB],
    ])('a CAPTCHA answer re-sent with its %s altered is refused, and no challenge is touched', async (param, value) => {
      const genuine = await captchaPath()
      vi.mocked(services.settings.submitCaptcha).mockClear()
      const res = await telnyxPost(mutate(genuine, q => q.set(param, value)), callFields({ Digits: '0000' }))
      expect(res.status).toBe(403)
      expect(services.settings.submitCaptcha).not.toHaveBeenCalled()
    })

    it('a CAPTCHA answer with an extra parameter appended is refused', async () => {
      const res = await telnyxPost(mutate(await captchaPath(), q => q.append('callSid', 'v3:another-callers-leg')), callFields({ Digits: '0000' }))
      expect(res.status).toBe(403)
    })

    describe('a volunteer leg', () => {
      async function ring() {
        await adapter.ringVolunteers({
          callSid: CALL_SID, callerNumber: CALLER, callbackUrl: ORIGIN, hubId: 'hub-1',
          volunteers: [{ phone: '+15550000001', callToken: 'leg-token-1' }],
        })
        return ringBodies[0]!
      }
      const legFields = (extra: Record<string, string> = {}) => ({ AccountSid: 'acct-1', CallSid: 'v3:volunteer-leg-1', From: HOTLINE_NUMBER, To: '+15550000001', ConnectionId: CONNECTION_ID, ParentCallSid: CALL_SID, ...extra })

      it('answer URL re-sent with another leg\'s call token claims nothing', async () => {
        const { Url } = await ring()
        const res = await telnyxPost(mutate(pathOf(Url!), q => q.set('callToken', 'leg-token-2')), legFields({ CallStatus: 'in-progress' }))
        expect(res.status).toBe(403)
        expect(services.calls.answerCallWithToken).not.toHaveBeenCalled()
      })

      it('status URL re-sent with the token swapped for a call id ends no call', async () => {
        const { StatusCallback } = await ring()
        const res = await telnyxPost(
          mutate(pathOf(StatusCallback!), q => { q.delete('callToken'); q.set('parentCallSid', 'v3:someone-elses-call') }),
          legFields({ CallStatus: 'completed' }),
        )
        expect(res.status).toBe(403)
        expect(services.calls.endCall).not.toHaveBeenCalled()
      })

      it('status URL re-sent naming another hub is refused', async () => {
        const { StatusCallback } = await ring()
        const res = await telnyxPost(mutate(pathOf(StatusCallback!), q => q.set('hub', OTHER_HUB)), legFields({ CallStatus: 'completed' }))
        expect(res.status).toBe(403)
        expect(services.calls.endCall).not.toHaveBeenCalled()
      })
    })

    it('a voicemail recording callback re-sent with another call\'s id is refused', async () => {
      // Mint the recording callback the way the queue-exit step does, then alter it.
      const voicemail = await adapter.handleVoicemail({ callSid: CALL_SID, callerLanguage: 'en', callbackUrl: ORIGIN, hubId: 'hub-1', audioUrls: {} } as Parameters<typeof adapter.handleVoicemail>[0])
      const callback = attr(voicemail.body, 'Record', 'recordingStatusCallback')
      const res = await telnyxPost(mutate(pathOf(callback), q => q.set('callSid', 'v3:another-callers-leg')), callFields({ RecordingStatus: 'completed', RecordingSid: 'rec-1' }))
      expect(res.status).toBe(403)
      expect(services.calls.markVoicemail).not.toHaveBeenCalled()
    })
  })

  describe('webhook validation is not optional', () => {
    const routes = ['/api/telephony/incoming', '/api/telephony/language-selected?hub=hub-1', '/api/telephony/captcha?callSid=x&lang=en&hub=hub-1', '/api/telephony/user-answer?callToken=t&hub=hub-1', '/api/telephony/queue-exit?callSid=x&hub=hub-1']

    it.each(routes)('refuses an unsigned request to %s', async (route) => {
      const res = await app.request(route, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(callFields({ Digits: '1' })).toString(),
      })
      expect(res.status).toBe(403)
      expect(services.settings.getIvrLanguages).not.toHaveBeenCalled()
      expect(services.calls.answerCallWithToken).not.toHaveBeenCalled()
    })

    it.each(routes)('refuses %s signed by a key that is not the account\'s', async (route) => {
      const res = await telnyxPost(route, callFields({ Digits: '1' }), await makeTelnyxSigner())
      expect(res.status).toBe(403)
      expect(services.calls.answerCallWithToken).not.toHaveBeenCalled()
    })

    it('refuses a request whose body was altered after signing', async () => {
      const body = new URLSearchParams(callFields({ Digits: '1' })).toString()
      const headers = await signer.sign(body)
      const res = await app.request('/api/telephony/language-selected?hub=hub-1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
        body: body.replace('Digits=1', 'Digits=2'),
      })
      expect(res.status).toBe(403)
    })

    it('refuses every request when the account\'s public key cannot be fetched', async () => {
      fetchSpy.mockImplementation(async () => new Response('unauthorized', { status: 401 }))
      expect((await telnyxPost('/api/telephony/incoming', callFields())).status).toBe(403)
    })

    it('delivers a genuine request once and swallows its exact replay', async () => {
      vi.mocked(checkWebhookReplay).mockResolvedValueOnce(true).mockResolvedValueOnce(false)
      const body = new URLSearchParams(callFields()).toString()
      const headers = await signer.sign(body)
      const send = () => app.request('/api/telephony/incoming', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
        body,
      })
      expect((await send()).headers.get('content-type')).toContain('text/xml')
      const replay = await send()
      expect(await replay.text()).toBe('OK')
      expect(services.settings.getIvrLanguages).toHaveBeenCalledTimes(1)
    })
  })
})
