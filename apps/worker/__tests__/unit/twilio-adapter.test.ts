import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { TwilioAdapter, isMachineAnsweredBy } from '../../telephony/twilio'
import { SignalWireAdapter } from '../../telephony/signalwire'
import { holdMusicEntry } from '@worker/telephony/hold-music'

const HOLD_ORIGIN = 'https://hotline.example.org'
const HOLD = holdMusicEntry(HOLD_ORIGIN)
const HOLD_URL = `${HOLD_ORIGIN}/api/ivr-audio/hold-music.wav`

describe('TwilioAdapter', () => {
  let adapter: TwilioAdapter
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    adapter = new TwilioAdapter('AC1234567890', 'auth-token-123', '+15551234567')
    fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // --- IVR Response Tests ---

  describe('handleLanguageMenu', () => {
    it('returns auto-redirect when only 1 language enabled', async () => {
      const res = await adapter.handleLanguageMenu({
        callSid: 'CA123',
        callerNumber: '+15559876543',
        hotlineName: 'Test Hotline',
        enabledLanguages: ['en'],
      })
      expect(res.contentType).toBe('text/xml')
      expect(res.body).toContain('<Redirect')
      expect(res.body).toContain('auto=1')
      expect(res.body).toContain('forceLang=en')
    })

    it('returns Gather with Say elements for multiple languages', async () => {
      const res = await adapter.handleLanguageMenu({
        callSid: 'CA123',
        callerNumber: '+15559876543',
        hotlineName: 'Test Hotline',
        enabledLanguages: ['en', 'es'],
      })
      expect(res.contentType).toBe('text/xml')
      expect(res.body).toContain('<Gather')
      expect(res.body).toContain('numDigits="1"')
      expect(res.body).toContain('language="en-US"')
      expect(res.body).toContain('language="es-MX"')
    })

    it('appends hub param to callback URLs when hubId provided', async () => {
      const res = await adapter.handleLanguageMenu({
        callSid: 'CA123',
        callerNumber: '+15559876543',
        hotlineName: 'Test Hotline',
        enabledLanguages: ['en', 'es'],
        hubId: 'hub-123',
      })
      expect(res.body).toContain('hub=hub-123')
    })

    it('escapes XML special characters in hubId', async () => {
      const res = await adapter.handleLanguageMenu({
        callSid: 'CA123',
        callerNumber: '+15559876543',
        hotlineName: 'Test Hotline',
        enabledLanguages: ['en'],
        hubId: 'hub&123',
      })
      expect(res.body).toContain('hub=hub%26')
      // Should not contain raw & in XML attribute
      const gatherMatch = res.body.match(/action="([^"]*)"/)
      if (gatherMatch) {
        expect(gatherMatch[1]).not.toContain('&')
      }
    })
  })

  describe('handleIncomingCall', () => {
    it('returns rate-limited response when rateLimited=true', async () => {
      const res = await adapter.handleIncomingCall({
        callRecordingEnabled: false,
        callSid: 'CA123',
        callerNumber: '+15559876543',
        voiceCaptchaEnabled: false,
        rateLimited: true,
        callerLanguage: 'en',
        hotlineName: 'Test',
      })
      expect(res.body).toContain('<Hangup/>')
      expect(res.body).toContain('Thank you for calling')
    })

    it('returns CAPTCHA gather when voiceCaptchaEnabled and captchaDigits provided', async () => {
      const res = await adapter.handleIncomingCall({
        callRecordingEnabled: false,
        callSid: 'CA123',
        callerNumber: '+15559876543',
        voiceCaptchaEnabled: true,
        rateLimited: false,
        callerLanguage: 'en',
        hotlineName: 'Test',
        captchaDigits: '1234',
      })
      expect(res.body).toContain('<Gather')
      expect(res.body).toContain('numDigits="4"')
      expect(res.body).toContain('1, 2, 3, 4.')
      expect(res.body).toContain('To hear the numbers again, press star.')
      const action = '/api/telephony/captcha?callSid=CA123&amp;lang=en&amp;round=0'
      expect(res.body).toContain(`action="${action}"`)
      // #2179: Twilio requests `action` only when it received input; with none
      // the Gather falls through. The timeout must reach the server, not hang up.
      const afterGather = res.body.split('</Gather>')[1]
      expect(afterGather).toContain(`<Redirect method="POST">${action}</Redirect>`)
      expect(afterGather).not.toContain('<Hangup/>')
      // finishOnKey stays the default '#', so a '*' arrives in Digits.
      expect(res.body).not.toContain('finishOnKey')
    })

    it('returns enqueue response for normal call', async () => {
      const res = await adapter.handleIncomingCall({
        callRecordingEnabled: false,
        callSid: 'CA123',
        callerNumber: '+15559876543',
        voiceCaptchaEnabled: false,
        rateLimited: false,
        callerLanguage: 'en',
        hotlineName: 'Test',
      })
      expect(res.body).toContain('<Enqueue')
      expect(res.body).toContain('CA123')
      expect(res.body).toContain('/api/telephony/wait-music')
    })

    it('uses custom audio URLs when provided', async () => {
      const res = await adapter.handleIncomingCall({
        callRecordingEnabled: false,
        callSid: 'CA123',
        callerNumber: '+15559876543',
        voiceCaptchaEnabled: false,
        rateLimited: false,
        callerLanguage: 'en',
        hotlineName: 'Test',
        audioUrls: { 'greeting:en': 'https://example.com/greeting.mp3' },
      })
      expect(res.body).toContain('<Play>')
      expect(res.body).toContain('https://example.com/greeting.mp3')
    })
  })

  // #2179: the adapter renders an outcome the server already classified; it
  // never sees the expected answer.
  describe('handleCaptchaResponse', () => {
    it('queues the caller on pass', async () => {
      const res = await adapter.handleCaptchaResponse({ outcome: 'pass', callSid: 'CA123', callerLanguage: 'en' })
      expect(res.body).toContain('<Enqueue')
      expect(res.body).not.toContain('<Hangup/>')
    })

    it('on retry says captchaRetry, then challenges again with the same digits and the star hint', async () => {
      const res = await adapter.handleCaptchaResponse({
        outcome: 'retry', digitsToSpeak: '5678', round: 1, callSid: 'CA123', callerLanguage: 'en', hubId: 'hub-1',
      })
      const gather = res.body.slice(res.body.indexOf('<Gather'), res.body.indexOf('</Gather>'))
      expect(gather).toContain('That was incorrect. Please try again.')
      expect(gather).toContain('5, 6, 7, 8.')
      expect(gather).toContain('To hear the numbers again, press star.')
      expect(gather).toContain('action="/api/telephony/captcha?callSid=CA123&amp;lang=en&amp;round=1&amp;hub=hub-1"')
      expect(res.body).not.toContain('<Enqueue')
    })

    it('on repeat re-speaks the same digits without the retry prompt', async () => {
      const res = await adapter.handleCaptchaResponse({
        outcome: 'repeat', digitsToSpeak: '5678', round: 2, callSid: 'CA123', callerLanguage: 'en',
      })
      expect(res.body).toContain('5, 6, 7, 8.')
      expect(res.body).not.toContain('That was incorrect.')
      expect(res.body).toContain('round=2')
    })

    it('a repeat plays the hub\'s uploaded captchaPrompt recording when there is one', async () => {
      const res = await adapter.handleCaptchaResponse({
        outcome: 'repeat', digitsToSpeak: '5678', round: 1, callSid: 'CA123', callerLanguage: 'en',
        audioUrls: { 'captchaPrompt:en': 'https://example.com/prompt.mp3' },
      })
      expect(res.body).toContain('<Play>https://example.com/prompt.mp3</Play>')
    })
  })

  // #1505 — provider-side recording is opt-in per hub and OFF by default.
  describe('handleCallAnswered', () => {
    const answer = (recordCall: boolean) =>
      adapter.handleCallAnswered({
        recordCall,
        parentCallSid: 'CA-parent',
        callbackUrl: 'https://example.com',
        userPubkey: 'pk123',
      })

    it('emits no recording directive at all when recording is off', async () => {
      const res = await answer(false)
      // Still bridges the caller to the volunteer...
      expect(res.body).toContain('<Dial')
      expect(res.body).toContain('<Queue>CA-parent</Queue>')
      // ...but nothing that would make Twilio write the audio to disk.
      expect(res.body).not.toContain('record')
      expect(res.body).not.toContain('record="record-from-answer"')
      expect(res.body).not.toContain('recordingStatusCallback')
      expect(res.body).not.toContain('/api/telephony/call-recording')
    })

    it('records and posts the recording callback when recording is on', async () => {
      const res = await answer(true)
      expect(res.body).toContain('<Dial')
      expect(res.body).toContain('record="record-from-answer"')
      expect(res.body).toContain('<Queue>CA-parent</Queue>')
      expect(res.body).toContain('/api/telephony/call-recording')
    })

    // SignalWire inherits this method rather than overriding it, which is how it
    // was silently recording every call too. Pin the inherited behaviour.
    it('SignalWire inherits the same opt-in, not an unconditional record', async () => {
      const sw = new SignalWireAdapter('11111111-2222-3333-4444-555555555555', 'tok', '+15551234567', 'space')
      const off = await sw.handleCallAnswered({
        recordCall: false,
        parentCallSid: 'CA-parent',
        callbackUrl: 'https://example.com',
        userPubkey: 'pk123',
      })
      expect(off.body).toContain('<Dial')
      expect(off.body).not.toContain('record')

      const on = await sw.handleCallAnswered({
        recordCall: true,
        parentCallSid: 'CA-parent',
        callbackUrl: 'https://example.com',
        userPubkey: 'pk123',
      })
      expect(on.body).toContain('record="record-from-answer"')
    })
  })

  describe('handleWaitMusic', () => {
    it('returns Leave when queueTime exceeds timeout', async () => {
      const res = await adapter.handleWaitMusic('en', undefined, 100, 90)
      expect(res.body).toContain('<Leave/>')
    })

    it('returns wait music with audio URL when within timeout', async () => {
      const res = await adapter.handleWaitMusic('en', HOLD, 30, 90)
      expect(res.body).toContain(`<Play>${HOLD_URL}</Play>`)
    })
  })

  describe('handleVoicemail', () => {
    it('returns Record with correct callback URLs', async () => {
      const res = await adapter.handleVoicemail({
        callSid: 'CA123',
        callerLanguage: 'en',
        callbackUrl: 'https://example.com',
      })
      expect(res.body).toContain('<Record')
      expect(res.body).toContain('/api/telephony/voicemail-complete')
      expect(res.body).toContain('/api/telephony/voicemail-recording')
      expect(res.body).toContain('maxLength="120"')
    })

    it('uses custom maxRecordingSeconds', async () => {
      const res = await adapter.handleVoicemail({
        callSid: 'CA123',
        callerLanguage: 'en',
        callbackUrl: 'https://example.com',
        maxRecordingSeconds: 300,
      })
      expect(res.body).toContain('maxLength="300"')
    })
  })

  describe('rejectCall', () => {
    it('returns Reject verb', () => {
      const res = adapter.rejectCall()
      expect(res.body).toContain('<Reject')
    })
  })

  describe('hangupCall', () => {
    it('POSTs to Twilio API with completed status', async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200 } as Response)
      await adapter.hangupCall('CA123')
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toContain('/Calls/CA123.json')
      expect(init.method).toBe('POST')
      expect(init.body.toString()).toContain('Status=completed')
    })
  })

  describe('hangupCall failures', () => {
    it('rejects when Twilio refuses the hang-up, so callers never claim a disconnect that did not happen', async () => {
      fetchMock.mockResolvedValue(new Response('{"message":"boom"}', { status: 500 }))
      await expect(adapter.hangupCall('CA123')).rejects.toThrow(/hangup failed: 500/)
    })

    it('treats an already-completed call (21220) as disconnected', async () => {
      fetchMock.mockResolvedValue(new Response('{"code":21220,"message":"Call is not in-progress"}', { status: 400 }))
      await expect(adapter.hangupCall('CA123')).resolves.toBeUndefined()
    })

    it('treats a missing call (404) as disconnected', async () => {
      fetchMock.mockResolvedValue(new Response('{}', { status: 404 }))
      await expect(adapter.hangupCall('CA123')).resolves.toBeUndefined()
    })
  })

  describe('ringVolunteers', () => {
    it('initiates parallel calls and returns call SIDs', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ sid: 'CA-vol-1' }),
      } as Response)

      const sids = await adapter.ringVolunteers({
        callSid: 'CA-parent',
        callerNumber: '+15551111111',
        volunteers: [
          { phone: '+15552222222', callToken: 'token-abc' },
          { phone: '+15553333333', callToken: 'token-def' },
        ],
        callbackUrl: 'https://example.com',
      })

      expect(sids).toHaveLength(2)
      expect(sids[0]).toBe('CA-vol-1')
      expect(fetchMock).toHaveBeenCalledTimes(2)

      // Verify first call params
      const [, init] = fetchMock.mock.calls[0]
      const body = init.body as URLSearchParams
      expect(body.get('To')).toBe('+15552222222')
      expect(body.get('From')).toBe('+15551234567')
      expect(body.get('Url')).toContain('callToken=token-abc')
      expect(body.get('StatusCallback')).toContain('callToken=token-abc')
      expect(body.get('Timeout')).toBe('30')
      expect(body.get('MachineDetection')).toBe('Enable')
    })

    // #1136: when EVERY dial attempt fails this must reject (not resolve to `[]`) so
    // the caller (services/ringing.ts) can retry and the circuit breaker can see the
    // failure — a total provider outage must never look like a successful ring.
    it('rejects when every dial attempt fails (total outage, #1136)', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 400,
      } as Response)

      await expect(adapter.ringVolunteers({
        callSid: 'CA-parent',
        callerNumber: '+15551111111',
        volunteers: [{ phone: '+15552222222', callToken: 'token-abc' }],
        callbackUrl: 'https://example.com',
      })).rejects.toThrow('All 1 dial attempt(s) failed')
    })

    it('returns whatever succeeded on a partial failure — not every leg failing (#1136)', async () => {
      fetchMock
        .mockResolvedValueOnce({ ok: false, status: 500 } as Response)
        .mockResolvedValueOnce({ ok: true, json: async () => ({ sid: 'CA-vol-ok' }) } as Response)

      const sids = await adapter.ringVolunteers({
        callSid: 'CA-parent',
        callerNumber: '+15551111111',
        volunteers: [
          { phone: '+15552222222', callToken: 'token-a' },
          { phone: '+15553333333', callToken: 'token-b' },
        ],
        callbackUrl: 'https://example.com',
      })

      expect(sids).toEqual(['CA-vol-ok'])
    })

    it('uses MachineDetection for volunteer calls', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ sid: 'CA-vol-1' }),
      } as Response)

      await adapter.ringVolunteers({
        callSid: 'CA-parent',
        callerNumber: '+15551111111',
        volunteers: [{ phone: '+15552222222', callToken: 'token-abc' }],
        callbackUrl: 'https://example.com',
      })

      const [, init] = fetchMock.mock.calls[0]
      const body = init.body as URLSearchParams
      expect(body.get('MachineDetection')).toBe('Enable')
    })
  })

  describe('cancelRinging', () => {
    it('hangs up all calls except the answered one', async () => {
      fetchMock.mockResolvedValue({ ok: true } as Response)
      await adapter.cancelRinging(['CA1', 'CA2', 'CA3'], 'CA2')
      expect(fetchMock).toHaveBeenCalledTimes(2)
      const urls = fetchMock.mock.calls.map(c => c[0] as string)
      expect(urls.some(u => u.includes('CA1'))).toBe(true)
      expect(urls.some(u => u.includes('CA3'))).toBe(true)
      expect(urls.every(u => !u.includes('CA2'))).toBe(true)
    })
  })

  // --- Webhook Validation Tests ---

  describe('validateWebhook', () => {
    it('accepts valid Twilio signature', async () => {
      // Build a request with known parameters
      const body = new URLSearchParams({ CallSid: 'CA123', From: '+15551234567' })

      // Compute expected signature manually
      const encoder = new TextEncoder()
      const url = 'https://example.com/webhook'
      let dataString = url
      const sortedKeys = Array.from(body.keys()).sort()
      for (const key of sortedKeys) {
        dataString += key + body.get(key)
      }
      const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode('auth-token-123'),
        { name: 'HMAC', hash: 'SHA-1' },
        false,
        ['sign']
      )
      const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(dataString))
      const expectedSig = btoa(String.fromCharCode(...new Uint8Array(sig)))

      const signedRequest = new Request('https://example.com/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Twilio-Signature': expectedSig,
        },
        body: body.toString(),
      })

      const result = await adapter.validateWebhook(signedRequest)
      expect(result).toBe(true)
    })

    it('rejects invalid signature', async () => {
      const body = new URLSearchParams({ CallSid: 'CA123' })
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Twilio-Signature': 'invalid-signature',
        },
        body: body.toString(),
      })

      const result = await adapter.validateWebhook(request)
      expect(result).toBe(false)
    })

    it('rejects missing signature header', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: 'CallSid=CA123',
      })

      const result = await adapter.validateWebhook(request)
      expect(result).toBe(false)
    })

    it('handles multi-value parameters correctly in signature', async () => {
      // Twilio sends StatusCallbackEvent multiple times
      const params = new URLSearchParams()
      params.append('CallSid', 'CA123')
      params.append('StatusCallbackEvent', 'initiated')
      params.append('StatusCallbackEvent', 'ringing')
      params.append('StatusCallbackEvent', 'answered')
      params.append('StatusCallbackEvent', 'completed')

      // Compute expected signature using Twilio's algorithm:
      // URL + sorted(key + value) for ALL values
      const encoder = new TextEncoder()
      const url = 'https://example.com/webhook'
      let dataString = url
      const sortedEntries = Array.from(params.entries()).sort(([a], [b]) => a.localeCompare(b))
      for (const [key, value] of sortedEntries) {
        dataString += key + value
      }
      const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode('auth-token-123'),
        { name: 'HMAC', hash: 'SHA-1' },
        false,
        ['sign']
      )
      const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(dataString))
      const expectedSig = btoa(String.fromCharCode(...new Uint8Array(sig)))

      const signedRequest = new Request('https://example.com/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Twilio-Signature': expectedSig,
        },
        body: params.toString(),
      })

      const result = await adapter.validateWebhook(signedRequest)
      expect(result).toBe(true)
    })
  })

  // --- Host header spoofing protection tests ---

  describe('Host header spoofing protection', () => {
    it('rejects signature when Host header is spoofed and webhookBaseUrl is configured', async () => {
      // Attacker sends a request with a spoofed Host header pointing to their domain.
      // They compute a valid HMAC over 'https://attacker.com/webhook' + params.
      // The adapter is configured with webhookBaseUrl='https://example.com' so it
      // uses that as the origin instead — the attacker's HMAC will not match.
      const adapterWithBase = new TwilioAdapter('AC1234567890', 'auth-token-123', '+15551234567', 'https://example.com')

      const body = new URLSearchParams({ CallSid: 'CA123', From: '+15551234567' })
      const encoder = new TextEncoder()

      // Attacker computes HMAC over their spoofed URL
      let attackerDataString = 'https://attacker.com/webhook'
      const sortedKeys = Array.from(body.keys()).sort()
      for (const key of sortedKeys) {
        attackerDataString += key + body.get(key)
      }
      const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode('auth-token-123'),
        { name: 'HMAC', hash: 'SHA-1' },
        false,
        ['sign']
      )
      const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(attackerDataString))
      const attackerSig = btoa(String.fromCharCode(...new Uint8Array(sig)))

      // Attacker sends request claiming to be from example.com but signed for attacker.com
      const spoofedRequest = new Request('https://attacker.com/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Twilio-Signature': attackerSig,
        },
        body: body.toString(),
      })

      // Must reject — adapter uses configured 'https://example.com', not 'https://attacker.com'
      const result = await adapterWithBase.validateWebhook(spoofedRequest)
      expect(result).toBe(false)
    })

    it('accepts valid signature when request URL matches webhookBaseUrl origin', async () => {
      const adapterWithBase = new TwilioAdapter('AC1234567890', 'auth-token-123', '+15551234567', 'https://example.com')

      const body = new URLSearchParams({ CallSid: 'CA123', From: '+15551234567' })
      const encoder = new TextEncoder()

      // Legitimate provider signs over the correct canonical URL
      let dataString = 'https://example.com/webhook'
      const sortedKeys = Array.from(body.keys()).sort()
      for (const key of sortedKeys) {
        dataString += key + body.get(key)
      }
      const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode('auth-token-123'),
        { name: 'HMAC', hash: 'SHA-1' },
        false,
        ['sign']
      )
      const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(dataString))
      const validSig = btoa(String.fromCharCode(...new Uint8Array(sig)))

      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Twilio-Signature': validSig,
        },
        body: body.toString(),
      })

      const result = await adapterWithBase.validateWebhook(request)
      expect(result).toBe(true)
    })
  })

  // --- Webhook Parsing Tests ---

  describe('parseIncomingWebhook', () => {
    it('parses CallSid and From from form data', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'CallSid=CA123&From=%2B15551234567&To=%2B15559876543',
      })

      const result = await adapter.parseIncomingWebhook(request)
      expect(result.callSid).toBe('CA123')
      expect(result.callerNumber).toBe('+15551234567')
      expect(result.calledNumber).toBe('+15559876543')
    })

    // Legs are dialled with MachineDetection, so Twilio sends AnsweredBy on the answer URL.
    // A carrier voicemail greeting must not read as a pickup (#2169).
    const legAnsweredBy = async (answeredBy?: string) => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `CallSid=CA123&From=%2B15551234567${answeredBy ? `&AnsweredBy=${answeredBy}` : ''}`,
      })
      return (await adapter.parseIncomingWebhook(request)).answeredByMachine
    }

    it.each(['machine_start', 'machine_end_beep', 'machine_end_silence', 'machine_end_other', 'fax'])(
      'flags AnsweredBy=%s as a machine',
      async (answeredBy) => {
        expect(await legAnsweredBy(answeredBy)).toBe(true)
      },
    )

    it.each(['human', 'unknown'])('does not flag AnsweredBy=%s', async (answeredBy) => {
      expect(await legAnsweredBy(answeredBy)).toBe(false)
    })

    it('does not flag a webhook that carries no AnsweredBy', async () => {
      expect(await legAnsweredBy()).toBe(false)
    })

    it('treats a missing or empty AnsweredBy as not a machine', () => {
      expect(isMachineAnsweredBy('machine_start')).toBe(true)
      expect(isMachineAnsweredBy(null)).toBe(false)
      expect(isMachineAnsweredBy('')).toBe(false)
    })
  })

  describe('parseLanguageWebhook', () => {
    it('parses CallSid, From, and Digits', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'CallSid=CA123&From=%2B15551234567&Digits=2',
      })

      const result = await adapter.parseLanguageWebhook(request)
      expect(result.callSid).toBe('CA123')
      expect(result.callerNumber).toBe('+15551234567')
      expect(result.digits).toBe('2')
    })
  })

  describe('parseCaptchaWebhook', () => {
    it('parses Digits and From', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'Digits=1234&From=%2B15551234567',
      })

      const result = await adapter.parseCaptchaWebhook(request)
      expect(result.digits).toBe('1234')
      expect(result.callerNumber).toBe('+15551234567')
    })
  })

  describe('parseCallStatusWebhook', () => {
    it('maps Twilio statuses correctly', async () => {
      const tests = [
        { raw: 'initiated', expected: 'initiated' },
        { raw: 'ringing', expected: 'ringing' },
        { raw: 'in-progress', expected: 'answered' },
        { raw: 'completed', expected: 'completed' },
        { raw: 'busy', expected: 'busy' },
        { raw: 'no-answer', expected: 'no-answer' },
        { raw: 'failed', expected: 'failed' },
        { raw: 'canceled', expected: 'failed' },
      ]

      for (const t of tests) {
        const request = new Request('https://example.com/webhook', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `CallStatus=${t.raw}`,
        })
        const result = await adapter.parseCallStatusWebhook(request)
        expect(result.status).toBe(t.expected)
      }
    })
  })

  describe('parseQueueWaitWebhook', () => {
    it('parses QueueTime', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'QueueTime=45',
      })

      const result = await adapter.parseQueueWaitWebhook(request)
      expect(result.queueTime).toBe(45)
    })
  })

  describe('parseQueueExitWebhook', () => {
    it('maps queue results correctly', async () => {
      const tests = [
        { raw: 'leave', expected: 'leave' },
        { raw: 'queue-full', expected: 'queue-full' },
        { raw: 'error', expected: 'error' },
        { raw: 'bridged', expected: 'bridged' },
        { raw: 'hangup', expected: 'hangup' },
      ]

      for (const t of tests) {
        const request = new Request('https://example.com/webhook', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `QueueResult=${t.raw}`,
        })
        const result = await adapter.parseQueueExitWebhook(request)
        expect(result.result).toBe(t.expected)
      }
    })
  })

  describe('parseRecordingWebhook', () => {
    it('parses completed recording', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'RecordingStatus=completed&RecordingSid=RE123&CallSid=CA123',
      })

      const result = await adapter.parseRecordingWebhook(request)
      expect(result.status).toBe('completed')
      expect(result.recordingSid).toBe('RE123')
      expect(result.callSid).toBe('CA123')
    })

    it('recovers the sid from RecordingUrl when RecordingSid is absent', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'RecordingStatus=completed&CallSid=CA123&RecordingUrl='
          + encodeURIComponent('https://api.twilio.com/2010-04-01/Accounts/AC1/Recordings/RE0123abcd'),
      })
      const result = await adapter.parseRecordingWebhook(request)
      expect(result.status).toBe('completed')
      expect(result.recordingSid).toBe('RE0123abcd')
    })

    it('yields no handle when neither RecordingSid nor a recognisable RecordingUrl is sent', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'RecordingStatus=completed&CallSid=CA123&RecordingUrl=' + encodeURIComponent('https://api.twilio.com/elsewhere'),
      })
      const result = await adapter.parseRecordingWebhook(request)
      expect(result.status).toBe('completed')
      expect(result.recordingSid).toBeUndefined()
    })

    it('parses failed recording', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'RecordingStatus=failed',
      })

      const result = await adapter.parseRecordingWebhook(request)
      expect(result.status).toBe('failed')
    })
  })

  // --- Recording Tests ---

  describe('getCallRecording', () => {
    it('fetches recording list and then audio', async () => {
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ recordings: [{ sid: 'RE123' }] }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: async () => new ArrayBuffer(1024),
        } as Response)

      const result = await adapter.getCallRecording('CA123')
      expect(result).not.toBeNull()
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('returns null when no recordings found', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ recordings: [] }),
      } as Response)

      const result = await adapter.getCallRecording('CA123')
      expect(result).toBeNull()
    })
  })

  describe('getRecordingAudio', () => {
    it('fetches audio by recording SID', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(512),
      } as Response)

      const result = await adapter.getRecordingAudio('RE123')
      expect(result).not.toBeNull()
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/Recordings/RE123.wav'),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: expect.stringContaining('Basic'),
          }),
        })
      )
    })
  })

  // #2297: provider-side deletion — fail loudly, never a silent no-op.
  describe('deleteRecording', () => {
    it('DELETEs the Recording and resolves on 204', async () => {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
      await expect(adapter.deleteRecording('RE123')).resolves.toBeUndefined()
      expect(fetchMock.mock.calls[0]![0]).toBe('https://api.twilio.com/2010-04-01/Accounts/AC1234567890/Recordings/RE123.json')
      expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe('DELETE')
    })

    it('treats 404 as already deleted', async () => {
      fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }))
      await expect(adapter.deleteRecording('RE123')).resolves.toBeUndefined()
    })

    it('rejects when Twilio refuses (e.g. a recording still in progress)', async () => {
      fetchMock.mockResolvedValueOnce(new Response('{"code":20009}', { status: 400 }))
      await expect(adapter.deleteRecording('RE123')).rejects.toThrow(/Twilio recording deletion failed: 400/)
    })

    it('rejects when Twilio is unreachable', async () => {
      fetchMock.mockRejectedValueOnce(new Error('ETIMEDOUT'))
      await expect(adapter.deleteRecording('RE123')).rejects.toThrow(/ETIMEDOUT/)
    })
  })

  describe('probeRecordingPosture', () => {
    const context = (tracked: string[]) => ({ trackedRecordings: async (h: string[]) => new Set(h.filter(x => tracked.includes(x))) })
    const old = new Date(Date.now() - 60 * 60 * 1000).toUTCString()

    function route(map: Record<string, Response>) {
      fetchMock.mockImplementation(async (url: string) => {
        for (const [needle, res] of Object.entries(map)) {
          if (String(url).includes(needle)) return res.clone()
        }
        return new Response('unexpected', { status: 599 })
      })
    }

    const healthy = {
      '/IncomingPhoneNumbers.json': Response.json({ incoming_phone_numbers: [{ voice_url: 'https://hotline.example/api/telephony/incoming' }] }),
      '/Recordings.json': Response.json({ recordings: [{ sid: 'RE1', date_created: old }] }),
      '/Transcriptions.json': Response.json({ transcriptions: [] }),
      'intelligence.twilio.com': Response.json({ services: [] }),
    }

    it('reports off/off, with evidence, when everything read says so', async () => {
      route(healthy)
      const posture = await adapter.probeRecordingPosture(context(['RE1']))
      expect(posture.recording.state).toBe('off')
      expect(posture.transcription.state).toBe('off')
    })

    it('reports recording on for a recording this server never requested', async () => {
      route(healthy)
      const posture = await adapter.probeRecordingPosture(context([]))
      expect(posture.recording).toMatchObject({ state: 'on' })
    })

    it('does not judge a recording younger than the webhook grace period', async () => {
      route({ ...healthy, '/Recordings.json': Response.json({ recordings: [{ sid: 'RE2', date_created: new Date().toUTCString() }] }) })
      const posture = await adapter.probeRecordingPosture(context([]))
      expect(posture.recording.state).toBe('off')
    })

    it('reports transcription on when an Intelligence service auto-transcribes', async () => {
      route({ ...healthy, 'intelligence.twilio.com': Response.json({ services: [{ sid: 'GA1', unique_name: 'qa', auto_transcribe: true }] }) })
      const posture = await adapter.probeRecordingPosture(context(['RE1']))
      expect(posture.transcription).toMatchObject({ state: 'on' })
    })

    it('reports recording on for a trunk that records', async () => {
      route({
        ...healthy,
        '/IncomingPhoneNumbers.json': Response.json({ incoming_phone_numbers: [{ trunk_sid: 'TK1' }] }),
        'trunking.twilio.com': Response.json({ recording: { mode: 'record-from-answer' } }),
      })
      const posture = await adapter.probeRecordingPosture(context(['RE1']))
      expect(posture.recording).toMatchObject({ state: 'on' })
    })

    it('reports unknown — never off — when a setting cannot be read', async () => {
      route({ ...healthy, 'intelligence.twilio.com': new Response('', { status: 403 }) })
      const posture = await adapter.probeRecordingPosture(context(['RE1']))
      expect(posture.recording.state).toBe('off')
      expect(posture.transcription).toMatchObject({ state: 'unknown' })
    })

    it('reports unknown when the number routes somewhere else', async () => {
      route({ ...healthy, '/IncomingPhoneNumbers.json': Response.json({ incoming_phone_numbers: [{ voice_url: 'https://elsewhere.example/twiml' }] }) })
      const posture = await adapter.probeRecordingPosture(context(['RE1']))
      expect(posture.recording).toMatchObject({ state: 'unknown' })
      expect(posture.transcription).toMatchObject({ state: 'unknown' })
    })

    it('reports unknown for everything when the credentials are refused', async () => {
      fetchMock.mockResolvedValue(new Response('', { status: 401 }))
      const posture = await adapter.probeRecordingPosture(context([]))
      expect(posture.recording).toMatchObject({ state: 'unknown' })
      expect(posture.transcription).toMatchObject({ state: 'unknown' })
    })

    it('SignalWire reads its own space and has no Intelligence check', async () => {
      const sw = new SignalWireAdapter('proj', 'tok', '+15551234567', 'myspace')
      route({
        '/IncomingPhoneNumbers.json': Response.json({ incoming_phone_numbers: [{ voice_url: 'https://hotline.example/api/telephony/incoming' }] }),
        '/Recordings.json': Response.json({ recordings: [] }),
        '/Transcriptions.json': Response.json({ transcriptions: [] }),
      })
      const posture = await sw.probeRecordingPosture(context([]))
      expect(posture.recording.state).toBe('off')
      expect(posture.transcription.state).toBe('off')
      const urls = fetchMock.mock.calls.map(c => String(c[0]))
      expect(urls.every(u => u.startsWith('https://myspace.signalwire.com/'))).toBe(true)
    })
  })

  describe('deleteCallLog (#2309)', () => {
    it('DELETEs the call record and resolves on 204', async () => {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
      await adapter.deleteCallLog('CA123')
      const [url, init] = fetchMock.mock.calls[0]
      expect(String(url)).toBe('https://api.twilio.com/2010-04-01/Accounts/AC1234567890/Calls/CA123.json')
      expect(init.method).toBe('DELETE')
    })

    it('treats 404 as already deleted', async () => {
      fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }))
      await expect(adapter.deleteCallLog('CA123')).resolves.toBeUndefined()
    })

    it('rejects while the call is in progress — never reported as deleted', async () => {
      fetchMock.mockResolvedValueOnce(new Response('{"code":20404}', { status: 400 }))
      await expect(adapter.deleteCallLog('CA123')).rejects.toThrow(/Twilio call log deletion failed: 400/)
    })
  })

  describe('enforceRecordingPosture (#2309)', () => {
    function route(map: Record<string, Response>) {
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        const key = `${init?.method ?? 'GET'} ${String(url)}`
        for (const [needle, res] of Object.entries(map)) {
          if (key.includes(needle)) return res.clone()
        }
        return new Response('unexpected', { status: 599 })
      })
    }
    const ours = { 'GET https://api.twilio.com/2010-04-01/Accounts/AC1234567890/IncomingPhoneNumbers.json': Response.json({ incoming_phone_numbers: [{ voice_url: 'https://hotline.example/api/telephony/incoming' }] }) }

    it('sets a recording trunk to do-not-record and turns off auto-transcribing Intelligence services', async () => {
      route({
        'GET https://api.twilio.com/2010-04-01/Accounts/AC1234567890/IncomingPhoneNumbers.json': Response.json({ incoming_phone_numbers: [{ trunk_sid: 'TK1' }] }),
        'GET https://trunking.twilio.com/v1/Trunks/TK1': Response.json({ recording: { mode: 'record-from-answer' } }),
        'POST https://trunking.twilio.com/v1/Trunks/TK1/Recording': Response.json({ mode: 'do-not-record' }, { status: 202 }),
        'GET https://intelligence.twilio.com/v2/Services': Response.json({ services: [{ sid: 'GA1', unique_name: 'qa', auto_transcribe: true }, { sid: 'GA2', auto_transcribe: false }] }),
        'POST https://intelligence.twilio.com/v2/Services/GA1': Response.json({ sid: 'GA1', auto_transcribe: false }),
      })
      const actions = await adapter.enforceRecordingPosture()
      expect(actions.map(a => [a.setting, a.target, a.outcome])).toEqual([
        ['recording', 'SIP trunk TK1', 'disabled'],
        ['transcription', 'Intelligence service qa', 'disabled'],
      ])
      const posts = fetchMock.mock.calls.filter(c => c[1]?.method === 'POST')
      expect(posts.map(c => [String(c[0]), String(c[1].body)]).sort()).toEqual([
        ['https://intelligence.twilio.com/v2/Services/GA1', 'AutoTranscribe=false'],
        ['https://trunking.twilio.com/v1/Trunks/TK1/Recording', 'Mode=do-not-record'],
      ])
    })

    it('writes nothing when everything already reads off', async () => {
      route({ ...ours, 'GET https://intelligence.twilio.com/v2/Services': Response.json({ services: [] }) })
      const actions = await adapter.enforceRecordingPosture()
      expect(actions.map(a => a.outcome)).toEqual(['already-off', 'already-off'])
      expect(fetchMock.mock.calls.some(c => c[1]?.method === 'POST')).toBe(false)
    })

    it('reports a refused write as failed, never as disabled', async () => {
      route({
        ...ours,
        'GET https://intelligence.twilio.com/v2/Services': Response.json({ services: [{ sid: 'GA1', auto_transcribe: true }] }),
        'POST https://intelligence.twilio.com/v2/Services/GA1': new Response('', { status: 403 }),
      })
      const actions = await adapter.enforceRecordingPosture()
      expect(actions[1]).toMatchObject({ setting: 'transcription', outcome: 'failed', reason: expect.stringMatching(/Twilio answered 403/) })
    })

    it('does not claim to control a number that routes elsewhere', async () => {
      route({
        'GET https://api.twilio.com/2010-04-01/Accounts/AC1234567890/IncomingPhoneNumbers.json': Response.json({ incoming_phone_numbers: [{ voice_url: 'https://elsewhere.example/twiml' }] }),
        'GET https://intelligence.twilio.com/v2/Services': Response.json({ services: [] }),
      })
      const [recording] = await adapter.enforceRecordingPosture()
      expect(recording).toMatchObject({ setting: 'recording', outcome: 'not-settable', reason: expect.stringMatching(/elsewhere\.example/) })
    })

    it('SignalWire touches no Twilio-only API and says transcription has no switch', async () => {
      const sw = new SignalWireAdapter('proj', 'tok', '+15551234567', 'myspace')
      route({ 'GET https://myspace.signalwire.com/api/laml/2010-04-01/Accounts/proj/IncomingPhoneNumbers.json': Response.json({ incoming_phone_numbers: [{ trunk_sid: 'TK9' }] }) })
      const actions = await sw.enforceRecordingPosture()
      expect(actions.map(a => [a.setting, a.outcome])).toEqual([['recording', 'already-off'], ['transcription', 'not-settable']])
      expect(fetchMock.mock.calls.every(c => String(c[0]).startsWith('https://myspace.signalwire.com/'))).toBe(true)
    })
  })

  describe('handleVoicemailComplete', () => {
    it('returns thank you message and hangup', () => {
      const res = adapter.handleVoicemailComplete('en')
      expect(res.body).toContain('<Say')
      expect(res.body).toContain('<Hangup/>')
    })
  })

  describe('emptyResponse', () => {
    it('returns empty Response', () => {
      const res = adapter.emptyResponse()
      expect(res.body).toBe('<Response/>')
    })
  })
})

describe('SignalWireAdapter', () => {
  let adapter: SignalWireAdapter
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    adapter = new SignalWireAdapter('project-123', 'api-token-456', '+15551234567', 'myspace')
    fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('uses SignalWire base URLs', async () => {
    fetchMock.mockResolvedValue({ ok: true } as Response)
    await adapter.hangupCall('CA123')
    const [url] = fetchMock.mock.calls[0]
    expect(url).toContain('myspace.signalwire.com')
    expect(url).toContain('project-123')
  })

  it('validates SignalWire-specific webhook signature', async () => {
    const body = new URLSearchParams({ CallSid: 'CA123' })
    const encoder = new TextEncoder()
    const url = 'https://example.com/webhook'
    let dataString = url
    const sortedKeys = Array.from(body.keys()).sort()
    for (const key of sortedKeys) {
      dataString += key + body.get(key)
    }
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode('api-token-456'),
      { name: 'HMAC', hash: 'SHA-1' },
      false,
      ['sign']
    )
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(dataString))
    const expectedSig = btoa(String.fromCharCode(...new Uint8Array(sig)))

    // Test with X-SignalWire-Signature header
    const request = new Request('https://example.com/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-SignalWire-Signature': expectedSig,
      },
      body: body.toString(),
    })

    const result = await adapter.validateWebhook(request)
    expect(result).toBe(true)
  })

  it('falls back to X-Twilio-Signature header', async () => {
    const body = new URLSearchParams({ CallSid: 'CA123' })
    const encoder = new TextEncoder()
    const url = 'https://example.com/webhook'
    let dataString = url
    const sortedKeys = Array.from(body.keys()).sort()
    for (const key of sortedKeys) {
      dataString += key + body.get(key)
    }
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode('api-token-456'),
      { name: 'HMAC', hash: 'SHA-1' },
      false,
      ['sign']
    )
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(dataString))
    const expectedSig = btoa(String.fromCharCode(...new Uint8Array(sig)))

    const request = new Request('https://example.com/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Twilio-Signature': expectedSig,
      },
      body: body.toString(),
    })

    const result = await adapter.validateWebhook(request)
    expect(result).toBe(true)
  })

  it('rejects invalid SignalWire signature', async () => {
    const request = new Request('https://example.com/webhook', {
      method: 'POST',
      headers: {
        'X-SignalWire-Signature': 'bad-sig',
      },
      body: 'CallSid=CA123',
    })

    const result = await adapter.validateWebhook(request)
    expect(result).toBe(false)
  })

  it('inherits Twilio IVR behavior', async () => {
    const res = await adapter.handleIncomingCall({
      callRecordingEnabled: false,
      callSid: 'CA123',
      callerNumber: '+15559876543',
      voiceCaptchaEnabled: false,
      rateLimited: false,
      callerLanguage: 'en',
      hotlineName: 'Test',
    })
    expect(res.body).toContain('<Enqueue')
  })
})
