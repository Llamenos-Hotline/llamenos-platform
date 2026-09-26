import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { PlivoAdapter } from '@worker/telephony/plivo'
import { getVoicemailThanks } from '@shared/voice-prompts'

describe('PlivoAdapter', () => {
  let adapter: PlivoAdapter
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    adapter = new PlivoAdapter('auth-id-123', 'auth-token-456', '+15551234567')
    fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('handleLanguageMenu', () => {
    it('returns auto-redirect when only 1 language enabled', async () => {
      const res = await adapter.handleLanguageMenu({
        callSid: 'CA123',
        callerNumber: '+15559876543',
        hotlineName: 'Test Hotline',
        enabledLanguages: ['en'],
      })
      expect(res.contentType).toBe('application/xml')
      expect(res.body).toContain('<Redirect')
      expect(res.body).toContain('auto=1')
      expect(res.body).toContain('forceLang=en')
    })

    it('returns GetDigits with Speak elements for multiple languages', async () => {
      const res = await adapter.handleLanguageMenu({
        callSid: 'CA123',
        callerNumber: '+15559876543',
        hotlineName: 'Test Hotline',
        enabledLanguages: ['en', 'es'],
      })
      expect(res.contentType).toBe('application/xml')
      expect(res.body).toContain('<GetDigits')
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
      const getDigitsMatch = res.body.match(/action="([^"]*)"/)
      if (getDigitsMatch) {
        expect(getDigitsMatch[1]).not.toContain('&')
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
      expect(res.body).toContain('<GetDigits')
      expect(res.body).toContain('numDigits="4"')
      expect(res.body).toContain('1, 2, 3, 4.')
      expect(res.body).toContain('/api/telephony/captcha')
    })

    it('returns Conference enqueue response for normal call', async () => {
      const res = await adapter.handleIncomingCall({
        callSid: 'CA123',
        callerNumber: '+15559876543',
        voiceCaptchaEnabled: false,
        rateLimited: false,
        callerLanguage: 'en',
        hotlineName: 'Test',
      })
      expect(res.body).toContain('<Conference')
      expect(res.body).toContain('CA123')
      expect(res.body).toContain('/api/telephony/wait-music')
      expect(res.body).toContain('startConferenceOnEnter="false"')
      expect(res.body).toContain('stayAlone="true"')
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
    it('returns Conference on correct digits', async () => {
      const res = await adapter.handleCaptchaResponse({
        callSid: 'CA123',
        digits: '5678',
        expectedDigits: '5678',
        callerLanguage: 'en',
      })
      expect(res.body).toContain('<Conference')
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
      expect(res.body).not.toContain('<Conference')
    })
  })

  describe('handleCallAnswered', () => {
    it('returns Conference with record=true and recording callback', async () => {
      const res = await adapter.handleCallAnswered({
        parentCallSid: 'CA-parent',
        callbackUrl: 'https://example.com',
        userPubkey: 'pk123',
      })
      expect(res.body).toContain('<Conference')
      expect(res.body).toContain('record="true"')
      expect(res.body).toContain('recordFileFormat="mp3"')
      expect(res.body).toContain('CA-parent')
      expect(res.body).toContain('/api/telephony/call-recording')
      expect(res.body).toContain('startConferenceOnEnter="true"')
      expect(res.body).toContain('endConferenceOnExit="true"')
    })
  })

  describe('handleWaitMusic', () => {
    it('returns Hangup when queueTime exceeds timeout', async () => {
      const res = await adapter.handleWaitMusic('en', undefined, 100, 90)
      expect(res.body).toContain('<Hangup/>')
    })

    it('returns wait music with audio URL when within timeout', async () => {
      const res = await adapter.handleWaitMusic('en', undefined, 30, 90)
      expect(res.body).toContain('<Play>')
      expect(res.body).toContain('twilio.music')
    })

    it('uses custom audio URL for wait message when provided', async () => {
      const res = await adapter.handleWaitMusic('en', { 'waitMessage:en': 'https://example.com/wait.mp3' })
      expect(res.body).toContain('<Play>')
      expect(res.body).toContain('https://example.com/wait.mp3')
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
      expect(res.body).toContain('finishOnKey="#"')
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
    it('returns Hangup with rejected reason', () => {
      const res = adapter.rejectCall()
      expect(res.body).toContain('<Hangup')
      expect(res.body).toContain('reason="rejected"')
    })
  })

  describe('hangupCall', () => {
    it('DELETEs to Plivo API', async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200 } as Response)
      await adapter.hangupCall('CA123')
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toContain('/Call/CA123/')
      expect(init.method).toBe('DELETE')
    })
  })

  describe('hangupCall failures', () => {
    it('rejects when Plivo refuses the hang-up', async () => {
      fetchMock.mockResolvedValue(new Response('{}', { status: 500 }))
      await expect(adapter.hangupCall('CA123')).rejects.toThrow(/hangup failed: 500/)
    })
  })

  describe('ringVolunteers', () => {
    it('initiates parallel calls and returns request UUIDs', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ request_uuid: 'req-uuid-1' }),
      } as Response)

      const uuids = await adapter.ringVolunteers({
        callSid: 'CA-parent',
        callerNumber: '+15551111111',
        volunteers: [
          { phone: '+15552222222', callToken: 'token-abc' },
          { phone: '+15553333333', callToken: 'token-def' },
        ],
        callbackUrl: 'https://example.com',
      })

      expect(uuids).toHaveLength(2)
      expect(uuids[0]).toBe('req-uuid-1')
      expect(fetchMock).toHaveBeenCalledTimes(2)

      const [, init] = fetchMock.mock.calls[0]
      const body = JSON.parse(init.body as string)
      expect(body.to).toBe('+15552222222')
      expect(body.from).toBe('+15551234567')
      expect(body.answer_url).toContain('callToken=token-abc')
      expect(body.hangup_url).toContain('callToken=token-abc')
      expect(body.ring_url).toContain('callToken=token-abc')
      expect(body.ring_timeout).toBe(30)
      expect(body.machine_detection).toBe('hangup')
    })

    it('handles API failures gracefully', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 400,
      } as Response)

      const uuids = await adapter.ringVolunteers({
        callSid: 'CA-parent',
        callerNumber: '+15551111111',
        volunteers: [{ phone: '+15552222222', callToken: 'token-abc' }],
        callbackUrl: 'https://example.com',
      })

      expect(uuids).toHaveLength(0)
    })

    it('uses machine_detection for volunteer calls', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ request_uuid: 'req-uuid-1' }),
      } as Response)

      await adapter.ringVolunteers({
        callSid: 'CA-parent',
        callerNumber: '+15551111111',
        volunteers: [{ phone: '+15552222222', callToken: 'token-abc' }],
        callbackUrl: 'https://example.com',
      })

      const [, init] = fetchMock.mock.calls[0]
      const body = JSON.parse(init.body as string)
      expect(body.machine_detection).toBe('hangup')
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

  describe('validateWebhook', () => {
    it('accepts valid Plivo V3 signature', async () => {
      const body = new URLSearchParams({ CallUUID: 'CA123', From: '+15551234567' })
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      })

      const encoder = new TextEncoder()
      const url = new URL('https://example.com/webhook')
      let dataString = url.origin + url.pathname
      const sortedKeys = Array.from(body.keys()).sort()
      for (const key of sortedKeys) {
        dataString += key + body.get(key)
      }
      const nonce = 'test-nonce-123'
      dataString += '.' + nonce

      const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode('auth-token-456'),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      )
      const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(dataString))
      const expectedSig = btoa(String.fromCharCode(...new Uint8Array(sig)))

      const signedRequest = new Request('https://example.com/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Plivo-Signature-V3': expectedSig,
          'X-Plivo-Signature-V3-Nonce': nonce,
        },
        body: body.toString(),
      })

      const result = await adapter.validateWebhook(signedRequest)
      expect(result).toBe(true)
    })

    it('rejects invalid signature', async () => {
      const body = new URLSearchParams({ CallUUID: 'CA123' })
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Plivo-Signature-V3': 'invalid-signature',
          'X-Plivo-Signature-V3-Nonce': 'nonce-123',
        },
        body: body.toString(),
      })

      const result = await adapter.validateWebhook(request)
      expect(result).toBe(false)
    })

    it('rejects missing signature header', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: 'CallUUID=CA123',
        headers: { 'X-Plivo-Signature-V3-Nonce': 'nonce-123' },
      })

      const result = await adapter.validateWebhook(request)
      expect(result).toBe(false)
    })

    it('rejects missing nonce header', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: 'CallUUID=CA123',
        headers: { 'X-Plivo-Signature-V3': 'some-sig' },
      })

      const result = await adapter.validateWebhook(request)
      expect(result).toBe(false)
    })

    it('rejects both missing headers', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: 'CallUUID=CA123',
      })

      const result = await adapter.validateWebhook(request)
      expect(result).toBe(false)
    })

    it('handles multi-value parameters correctly in signature', async () => {
      const params = new URLSearchParams()
      params.append('CallUUID', 'CA123')
      params.append('Status', 'ringing')
      params.append('Status', 'completed')

      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      })

      const encoder = new TextEncoder()
      const url = new URL('https://example.com/webhook')
      let dataString = url.origin + url.pathname
      const sortedEntries = Array.from(params.entries()).sort(([a], [b]) => a.localeCompare(b))
      for (const [key, value] of sortedEntries) {
        dataString += key + value
      }
      const nonce = 'test-nonce-456'
      dataString += '.' + nonce

      const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode('auth-token-456'),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      )
      const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(dataString))
      const expectedSig = btoa(String.fromCharCode(...new Uint8Array(sig)))

      const signedRequest = new Request('https://example.com/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Plivo-Signature-V3': expectedSig,
          'X-Plivo-Signature-V3-Nonce': nonce,
        },
        body: params.toString(),
      })

      const result = await adapter.validateWebhook(signedRequest)
      expect(result).toBe(true)
    })
  })

  describe('parseIncomingWebhook', () => {
    it('parses CallUUID and From from form data', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'CallUUID=CA123&From=%2B15551234567&To=%2B15559876543',
      })

      const result = await adapter.parseIncomingWebhook(request)
      expect(result.callSid).toBe('CA123')
      expect(result.callerNumber).toBe('+15551234567')
      expect(result.calledNumber).toBe('+15559876543')
    })
  })

  describe('parseLanguageWebhook', () => {
    it('parses CallUUID, From, and Digits', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'CallUUID=CA123&From=%2B15551234567&Digits=2',
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
    it('maps Plivo statuses correctly', async () => {
      const tests = [
        { raw: 'ringing', expected: 'ringing' },
        { raw: 'in-progress', expected: 'answered' },
        { raw: 'completed', expected: 'completed' },
        { raw: 'busy', expected: 'busy' },
        { raw: 'no-answer', expected: 'no-answer' },
        { raw: 'failed', expected: 'failed' },
        { raw: 'cancel', expected: 'failed' },
        { raw: 'hangup', expected: 'completed' },
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
    it('parses ConferenceDuration as queueTime', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'ConferenceDuration=45',
      })

      const result = await adapter.parseQueueWaitWebhook(request)
      expect(result.queueTime).toBe(45)
    })

    it('defaults to 0 when ConferenceDuration is missing', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: '',
      })

      const result = await adapter.parseQueueWaitWebhook(request)
      expect(result.queueTime).toBe(0)
    })
  })

  describe('parseQueueExitWebhook', () => {
    it('maps conference actions correctly', async () => {
      const tests = [
        { raw: 'enter', expected: 'bridged' },
        { raw: 'exit', expected: 'hangup' },
        { raw: 'other', expected: 'error' },
      ]

      for (const t of tests) {
        const request = new Request('https://example.com/webhook', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `ConferenceAction=${t.raw}`,
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
        body: 'RecordUrl=https://example.com/rec.mp3&RecordingID=RE123&CallUUID=CA123',
      })

      const result = await adapter.parseRecordingWebhook(request)
      expect(result.status).toBe('completed')
      expect(result.recordingSid).toBe('RE123')
      expect(result.callSid).toBe('CA123')
    })

    it('parses failed recording when RecordUrl is missing', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'RecordingID=RE123&CallUUID=CA123',
      })

      const result = await adapter.parseRecordingWebhook(request)
      expect(result.status).toBe('failed')
    })
  })

  describe('getCallRecording', () => {
    it('fetches recording list and then audio', async () => {
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ objects: [{ recording_url: 'https://example.com/rec.mp3' }] }),
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
        json: async () => ({ objects: [] }),
      } as Response)

      const result = await adapter.getCallRecording('CA123')
      expect(result).toBeNull()
    })

    it('returns null when recording list fetch fails', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 404,
      } as Response)

      const result = await adapter.getCallRecording('CA123')
      expect(result).toBeNull()
    })

    it('returns null when audio fetch fails', async () => {
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ objects: [{ recording_url: 'https://example.com/rec.mp3' }] }),
        } as Response)
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
        } as Response)

      const result = await adapter.getCallRecording('CA123')
      expect(result).toBeNull()
    })
  })

  describe('getRecordingAudio', () => {
    it('fetches audio by full URL', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(512),
      } as Response)

      const result = await adapter.getRecordingAudio('https://example.com/rec.mp3')
      expect(result).not.toBeNull()
      expect(fetchMock).toHaveBeenCalledWith(
        'https://example.com/rec.mp3',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: expect.stringContaining('Basic'),
          }),
        })
      )
    })

    it('returns null when fetch fails', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
      } as Response)

      const result = await adapter.getRecordingAudio('https://example.com/rec.mp3')
      expect(result).toBeNull()
    })
  })

  describe('handleVoicemailComplete', () => {
    it('returns thank you message and hangup', () => {
      const res = adapter.handleVoicemailComplete('en')
      expect(res.body).toContain('<Speak')
      expect(res.body).toContain('<Hangup/>')
      expect(res.body).toContain(getVoicemailThanks('en'))
    })
  })

  describe('emptyResponse', () => {
    it('returns empty Response', () => {
      const res = adapter.emptyResponse()
      expect(res.body).toBe('<Response></Response>')
    })
  })

  describe('escapeXml', () => {
    it('escapes special characters in generated XML', async () => {
      const res = await adapter.handleIncomingCall({
        callSid: 'CA123',
        callerNumber: '+15559876543',
        voiceCaptchaEnabled: false,
        rateLimited: false,
        callerLanguage: 'en',
        hotlineName: 'Test <Hotline> & "Co"',
      })
      expect(res.body).toContain('Test &lt;Hotline&gt; &amp; &quot;Co&quot;')
      expect(res.body).not.toContain('Test <Hotline>')
    })
  })
})
