import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { TwilioAdapter } from '../../telephony/twilio'
import { SignalWireAdapter } from '../../telephony/signalwire'

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
      expect(res.body).toContain('/api/telephony/captcha')
    })

    it('returns enqueue response for normal call', async () => {
      const res = await adapter.handleIncomingCall({
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

  describe('handleCaptchaResponse', () => {
    it('returns enqueue on correct digits', async () => {
      const res = await adapter.handleCaptchaResponse({
        callSid: 'CA123',
        digits: '5678',
        expectedDigits: '5678',
        callerLanguage: 'en',
      })
      expect(res.body).toContain('<Enqueue')
      expect(res.body).not.toContain('<Hangup/>')
    })

    it('returns hangup on incorrect digits', async () => {
      const res = await adapter.handleCaptchaResponse({
        callSid: 'CA123',
        digits: '0000',
        expectedDigits: '5678',
        callerLanguage: 'en',
      })
      expect(res.body).toContain('<Hangup/>')
      expect(res.body).not.toContain('<Enqueue')
    })
  })

  describe('handleCallAnswered', () => {
    it('returns Dial with Queue and recording callback', async () => {
      const res = await adapter.handleCallAnswered({
        parentCallSid: 'CA-parent',
        callbackUrl: 'https://example.com',
        userPubkey: 'pk123',
      })
      expect(res.body).toContain('<Dial')
      expect(res.body).toContain('record="record-from-answer"')
      expect(res.body).toContain('<Queue>CA-parent</Queue>')
      expect(res.body).toContain('/api/telephony/call-recording')
    })
  })

  describe('handleWaitMusic', () => {
    it('returns Leave when queueTime exceeds timeout', async () => {
      const res = await adapter.handleWaitMusic('en', undefined, 100, 90)
      expect(res.body).toContain('<Leave/>')
    })

    it('returns wait music with audio URL when within timeout', async () => {
      const res = await adapter.handleWaitMusic('en', undefined, 30, 90)
      expect(res.body).toContain('<Play>')
      expect(res.body).toContain('twilio.music')
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

    it('handles API failures gracefully', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 400,
      } as Response)

      const sids = await adapter.ringVolunteers({
        callSid: 'CA-parent',
        callerNumber: '+15551111111',
        volunteers: [{ phone: '+15552222222', callToken: 'token-abc' }],
        callbackUrl: 'https://example.com',
      })

      expect(sids).toHaveLength(0)
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
