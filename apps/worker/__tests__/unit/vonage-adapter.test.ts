import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { VonageAdapter } from '@worker/telephony/vonage'
import { getPrompt, getVoicemailThanks } from '@shared/voice-prompts'

describe('VonageAdapter', () => {
  let adapter: VonageAdapter
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    adapter = new VonageAdapter(
      'test-api-key',
      'test-api-secret',
      'test-app-id',
      '+15551234567',
      'test-private-key',
    )
    globalThis.fetch = vi.fn() as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function parseNcco(response: { contentType: string; body: string }) {
    expect(response.contentType).toBe('application/json')
    return JSON.parse(response.body)
  }

  async function buildSignedUrl(
    baseUrl: string,
    params: Record<string, string>,
    secret: string,
  ): Promise<string> {
    const url = new URL(baseUrl)
    const now = Math.floor(Date.now() / 1000)
    url.searchParams.set('timestamp', String(now))
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value)
    }

    const sortedParams = Array.from(url.searchParams.entries())
      .filter(([key]) => key !== 'sig')
      .sort(([a], [b]) => a.localeCompare(b))

    let sigInput = ''
    for (const [key, value] of sortedParams) {
      sigInput += `&${key}=${value}`
    }

    const encoder = new TextEncoder()
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const signed = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(sigInput))
    const sig = Array.from(new Uint8Array(signed))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')

    url.searchParams.set('sig', sig)
    return url.toString()
  }

  async function signUrl(url: URL, secret: string): Promise<string> {
    const sortedParams = Array.from(url.searchParams.entries())
      .filter(([key]) => key !== 'sig')
      .sort(([a], [b]) => a.localeCompare(b))
    let sigInput = ''
    for (const [key, value] of sortedParams) {
      sigInput += `&${key}=${value}`
    }
    const encoder = new TextEncoder()
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const signed = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(sigInput))
    const sig = Array.from(new Uint8Array(signed))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
    url.searchParams.set('sig', sig)
    return url.toString()
  }

  describe('handleLanguageMenu', () => {
    it('returns notify NCCO when only one language is enabled', async () => {
      const response = await adapter.handleLanguageMenu({
        callSid: 'call-123',
        callerNumber: '+15559876543',
        hotlineName: 'Test Hotline',
        enabledLanguages: ['en'],
      })

      const ncco = parseNcco(response)
      expect(ncco).toHaveLength(2)
      expect(ncco[0]).toEqual({ action: 'talk', text: ' ' })
      expect(ncco[1].action).toBe('notify')
      expect(ncco[1].payload).toEqual({ lang: 'en', auto: true })
      expect(ncco[1].eventUrl[0]).toContain('/api/telephony/language-selected?auto=1&forceLang=en')
    })

    it('returns input + talk actions for multiple enabled languages', async () => {
      const response = await adapter.handleLanguageMenu({
        callSid: 'call-123',
        callerNumber: '+15559876543',
        hotlineName: 'Test Hotline',
        enabledLanguages: ['en', 'es'],
      })

      const ncco = parseNcco(response)
      expect(ncco[0].action).toBe('input')
      expect(ncco[0].type).toEqual(['dtmf'])
      expect(ncco[0].dtmf).toEqual({ maxDigits: 1, timeOut: 8 })

      const talkActions = ncco.slice(1).filter((a: Record<string, unknown>) => a.action === 'talk')
      expect(talkActions.length).toBe(2)
      expect(talkActions[0].bargeIn).toBe(true)
      expect(talkActions[1].bargeIn).toBe(true)
    })

    it('appends hubId to callback URLs when provided', async () => {
      const response = await adapter.handleLanguageMenu({
        callSid: 'call-123',
        callerNumber: '+15559876543',
        hotlineName: 'Test Hotline',
        enabledLanguages: ['en'],
        hubId: 'hub-abc',
      })

      const ncco = parseNcco(response)
      expect(ncco[1].eventUrl[0]).toContain('&hub=hub-abc')
    })

    it('prepends hubId as first param for multi-language menu', async () => {
      const response = await adapter.handleLanguageMenu({
        callSid: 'call-123',
        callerNumber: '+15559876543',
        hotlineName: 'Test Hotline',
        enabledLanguages: ['en', 'es'],
        hubId: 'hub-abc',
      })

      const ncco = parseNcco(response)
      expect(ncco[0].eventUrl[0]).toBe('/api/telephony/language-selected?hub=hub-abc')
    })
  })

  describe('handleIncomingCall', () => {
    it('returns rate-limited NCCO when rateLimited is true', async () => {
      const response = await adapter.handleIncomingCall({
        callSid: 'call-123',
        callerNumber: '+15559876543',
        voiceCaptchaEnabled: false,
        rateLimited: true,
        callerLanguage: 'en',
        hotlineName: 'Test Hotline',
      })

      const ncco = parseNcco(response)
      expect(ncco).toHaveLength(2)
      expect(ncco[0].action).toBe('talk')
      expect(ncco[0].text).toContain('Thank you for calling Test Hotline')
      expect(ncco[1].action).toBe('talk')
    })

    it('returns captcha NCCO when voiceCaptchaEnabled and captchaDigits provided', async () => {
      const response = await adapter.handleIncomingCall({
        callSid: 'call-123',
        callerNumber: '+15559876543',
        voiceCaptchaEnabled: true,
        rateLimited: false,
        callerLanguage: 'en',
        hotlineName: 'Test Hotline',
        captchaDigits: '7391',
      })

      const ncco = parseNcco(response)
      expect(ncco).toHaveLength(4)
      expect(ncco[0].action).toBe('talk')
      expect(ncco[1].action).toBe('talk')
      expect(ncco[2].action).toBe('talk')
      expect(ncco[2].text).toBe('7, 3, 9, 1.')
      expect(ncco[3].action).toBe('input')
      expect(ncco[3].dtmf.maxDigits).toBe(4)
    })

    it('returns hold/conversation NCCO for normal call flow', async () => {
      const response = await adapter.handleIncomingCall({
        callSid: 'call-123',
        callerNumber: '+15559876543',
        voiceCaptchaEnabled: false,
        rateLimited: false,
        callerLanguage: 'en',
        hotlineName: 'Test Hotline',
      })

      const ncco = parseNcco(response)
      expect(ncco).toHaveLength(3)
      expect(ncco[0].action).toBe('talk')
      expect(ncco[1].action).toBe('talk')
      expect(ncco[2].action).toBe('conversation')
      expect(ncco[2].name).toBe('call-123')
      expect(ncco[2].startOnEnter).toBe(false)
      expect(ncco[2].musicOnHoldUrl[0]).toContain('/api/telephony/wait-music')
    })

    it('uses custom audio URLs when provided', async () => {
      const response = await adapter.handleIncomingCall({
        callSid: 'call-123',
        callerNumber: '+15559876543',
        voiceCaptchaEnabled: false,
        rateLimited: false,
        callerLanguage: 'en',
        hotlineName: 'Test Hotline',
        audioUrls: { 'greeting:en': 'https://example.com/greeting.mp3' },
      })

      const ncco = parseNcco(response)
      expect(ncco[0].action).toBe('stream')
      expect(ncco[0].streamUrl).toEqual(['https://example.com/greeting.mp3'])
    })
  })

  describe('handleCaptchaResponse', () => {
    it('returns success NCCO with conversation on correct digits', async () => {
      const response = await adapter.handleCaptchaResponse({
        callSid: 'call-123',
        digits: '7391',
        expectedDigits: '7391',
        callerLanguage: 'en',
      })

      const ncco = parseNcco(response)
      expect(ncco).toHaveLength(2)
      expect(ncco[0].action).toBe('talk')
      expect(ncco[1].action).toBe('conversation')
      expect(ncco[1].name).toBe('call-123')
    })

    it('returns failure NCCO on incorrect digits', async () => {
      const response = await adapter.handleCaptchaResponse({
        callSid: 'call-123',
        digits: '1234',
        expectedDigits: '7391',
        callerLanguage: 'en',
      })

      const ncco = parseNcco(response)
      expect(ncco).toHaveLength(1)
      expect(ncco[0].action).toBe('talk')
      expect(ncco[0].text).toBe(getPrompt('captchaFail', 'en'))
    })
  })

  describe('handleCallAnswered', () => {
    it('returns conversation NCCO with recording enabled', async () => {
      const response = await adapter.handleCallAnswered({
        parentCallSid: 'call-parent',
        callbackUrl: 'https://example.com',
        userPubkey: 'pubkey-123',
      })

      const ncco = parseNcco(response)
      expect(ncco).toHaveLength(1)
      expect(ncco[0].action).toBe('conversation')
      expect(ncco[0].name).toBe('call-parent')
      expect(ncco[0].startOnEnter).toBe(true)
      expect(ncco[0].endOnExit).toBe(true)
      expect(ncco[0].record).toBe(true)
      expect(ncco[0].eventUrl[0]).toContain('/api/telephony/call-recording')
    })
  })

  describe('handleWaitMusic', () => {
    it('returns empty NCCO when queue time exceeds timeout', async () => {
      const response = await adapter.handleWaitMusic('en', undefined, 120, 90)

      const ncco = parseNcco(response)
      expect(ncco).toEqual([])
    })

    it('returns wait message + music when within timeout', async () => {
      const response = await adapter.handleWaitMusic('en', undefined, 30, 90)

      const ncco = parseNcco(response)
      expect(ncco).toHaveLength(2)
      expect(ncco[0].action).toBe('talk')
      expect(ncco[1].action).toBe('stream')
      expect(ncco[1].streamUrl[0]).toContain('twilio.music')
    })

    it('returns wait message + music when no queue time provided', async () => {
      const response = await adapter.handleWaitMusic('en')

      const ncco = parseNcco(response)
      expect(ncco).toHaveLength(2)
    })

    it('uses custom audio URL for wait message when provided', async () => {
      const response = await adapter.handleWaitMusic('en', { 'waitMessage:en': 'https://example.com/wait.mp3' })

      const ncco = parseNcco(response)
      expect(ncco[0].action).toBe('stream')
      expect(ncco[0].streamUrl).toEqual(['https://example.com/wait.mp3'])
    })
  })

  describe('handleVoicemail', () => {
    it('returns record NCCO with correct parameters', async () => {
      const response = await adapter.handleVoicemail({
        callSid: 'call-123',
        callerLanguage: 'en',
        callbackUrl: 'https://example.com',
      })

      const ncco = parseNcco(response)
      expect(ncco).toHaveLength(3)
      expect(ncco[0].action).toBe('talk')
      expect(ncco[1].action).toBe('record')
      expect(ncco[1].endOnSilence).toBe(5)
      expect(ncco[1].endOnKey).toBe('#')
      expect(ncco[1].beepStart).toBe(true)
      expect(ncco[1].timeOut).toBe(120)
      expect(ncco[2].action).toBe('talk')
      expect(ncco[2].text).toBe(getVoicemailThanks('en'))
    })

    it('uses custom maxRecordingSeconds', async () => {
      const response = await adapter.handleVoicemail({
        callSid: 'call-123',
        callerLanguage: 'en',
        callbackUrl: 'https://example.com',
        maxRecordingSeconds: 300,
      })

      const ncco = parseNcco(response)
      expect(ncco[1].timeOut).toBe(300)
    })
  })

  describe('rejectCall', () => {
    it('returns empty NCCO array', () => {
      const response = adapter.rejectCall()
      const ncco = parseNcco(response)
      expect(ncco).toEqual([])
    })
  })

  describe('handleVoicemailComplete', () => {
    it('returns thank-you talk action', () => {
      const response = adapter.handleVoicemailComplete('en')
      const ncco = parseNcco(response)
      expect(ncco).toHaveLength(1)
      expect(ncco[0].action).toBe('talk')
      expect(ncco[0].text).toBe(getVoicemailThanks('en'))
    })
  })

  describe('emptyResponse', () => {
    it('returns empty NCCO array', () => {
      const response = adapter.emptyResponse()
      const ncco = parseNcco(response)
      expect(ncco).toEqual([])
    })
  })

  describe('hangupCall failures', () => {
    it('rejects when Vonage refuses the hang-up', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response('{}', { status: 500 }))
      await expect(adapter.hangupCall('call-uuid-123')).rejects.toThrow(/hangup failed: 500/)
    })
  })

  describe('hangupCall', () => {
    it('sends PUT request with hangup action', async () => {
      const mockFetch = vi.mocked(globalThis.fetch)
      mockFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }))

      await adapter.hangupCall('call-uuid-123')

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const [url, init] = mockFetch.mock.calls[0]
      expect(url).toBe('https://api.nexmo.com/v1/calls/call-uuid-123')
      expect(init?.method).toBe('PUT')
      expect(JSON.parse(init?.body as string)).toEqual({ action: 'hangup' })
      expect((init?.headers as Record<string, string>)?.Authorization).toContain('Basic ')
    })
  })

  describe('ringVolunteers', () => {
    it('calls each volunteer and returns UUIDs', async () => {
      const mockFetch = vi.mocked(globalThis.fetch)
      mockFetch
        .mockResolvedValueOnce(new Response(JSON.stringify({ uuid: 'uuid-1' }), { status: 201 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ uuid: 'uuid-2' }), { status: 201 }))

      const result = await adapter.ringVolunteers({
        callSid: 'call-123',
        callerNumber: '+15559876543',
        volunteers: [
          { phone: '+15551111111', callToken: 'token-a' },
          { phone: '+15552222222', callToken: 'token-b' },
        ],
        callbackUrl: 'https://example.com',
      })

      expect(result).toEqual(['uuid-1', 'uuid-2'])
      expect(mockFetch).toHaveBeenCalledTimes(2)

      const [, init1] = mockFetch.mock.calls[0]
      const body1 = JSON.parse(init1?.body as string)
      expect(body1.to).toEqual([{ type: 'phone', number: '15551111111' }])
      expect(body1.from).toEqual({ type: 'phone', number: '15551234567' })
      expect(body1.answer_url[0]).toContain('callToken=token-a')
      expect(body1.ringing_timer).toBe(30)
      expect(body1.machine_detection).toBe('hangup')
    })

    it('strips + from phone numbers', async () => {
      const mockFetch = vi.mocked(globalThis.fetch)
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ uuid: 'uuid-1' }), { status: 201 }))

      await adapter.ringVolunteers({
        callSid: 'call-123',
        callerNumber: '+15559876543',
        volunteers: [{ phone: '+15551111111', callToken: 'token-a' }],
        callbackUrl: 'https://example.com',
      })

      const [, init] = mockFetch.mock.calls[0]
      const body = JSON.parse(init?.body as string)
      expect(body.to[0].number).toBe('15551111111')
      expect(body.from.number).toBe('15551234567')
    })

    it('returns only successful call UUIDs, skipping failures', async () => {
      const mockFetch = vi.mocked(globalThis.fetch)
      mockFetch
        .mockResolvedValueOnce(new Response(JSON.stringify({ uuid: 'uuid-1' }), { status: 201 }))
        .mockResolvedValueOnce(new Response('Error', { status: 500 }))

      const result = await adapter.ringVolunteers({
        callSid: 'call-123',
        callerNumber: '+15559876543',
        volunteers: [
          { phone: '+15551111111', callToken: 'token-a' },
          { phone: '+15552222222', callToken: 'token-b' },
        ],
        callbackUrl: 'https://example.com',
      })

      expect(result).toEqual(['uuid-1'])
    })

    it('returns empty array when all calls fail', async () => {
      const mockFetch = vi.mocked(globalThis.fetch)
      mockFetch
        .mockResolvedValueOnce(new Response('Error', { status: 500 }))
        .mockResolvedValueOnce(new Response('Error', { status: 500 }))

      const result = await adapter.ringVolunteers({
        callSid: 'call-123',
        callerNumber: '+15559876543',
        volunteers: [
          { phone: '+15551111111', callToken: 'token-a' },
          { phone: '+15552222222', callToken: 'token-b' },
        ],
        callbackUrl: 'https://example.com',
      })

      expect(result).toEqual([])
    })
  })

  describe('cancelRinging', () => {
    it('hangs up all provided call SIDs', async () => {
      const mockFetch = vi.mocked(globalThis.fetch)
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }))

      await adapter.cancelRinging(['uuid-1', 'uuid-2', 'uuid-3'])

      expect(mockFetch).toHaveBeenCalledTimes(3)
      expect(mockFetch.mock.calls[0][0]).toBe('https://api.nexmo.com/v1/calls/uuid-1')
      expect(mockFetch.mock.calls[1][0]).toBe('https://api.nexmo.com/v1/calls/uuid-2')
      expect(mockFetch.mock.calls[2][0]).toBe('https://api.nexmo.com/v1/calls/uuid-3')
    })

    it('skips the exceptSid', async () => {
      const mockFetch = vi.mocked(globalThis.fetch)
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }))

      await adapter.cancelRinging(['uuid-1', 'uuid-2', 'uuid-3'], 'uuid-2')

      expect(mockFetch).toHaveBeenCalledTimes(2)
      expect(mockFetch.mock.calls[0][0]).toBe('https://api.nexmo.com/v1/calls/uuid-1')
      expect(mockFetch.mock.calls[1][0]).toBe('https://api.nexmo.com/v1/calls/uuid-3')
    })
  })

  describe('getCallRecording', () => {
    it('fetches recording and returns array buffer', async () => {
      const mockFetch = vi.mocked(globalThis.fetch)
      mockFetch
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ recording_url: 'https://example.com/recording.mp3' }), { status: 200 }),
        )
        .mockResolvedValueOnce(new Response(new ArrayBuffer(1024), { status: 200 }))

      const result = await adapter.getCallRecording('call-uuid-123')

      expect(result).not.toBeNull()
      expect(result?.byteLength).toBe(1024)
      expect(mockFetch).toHaveBeenCalledTimes(2)
      expect(mockFetch.mock.calls[0][0]).toBe('https://api.nexmo.com/v1/calls/call-uuid-123')
      expect(mockFetch.mock.calls[1][0]).toBe('https://example.com/recording.mp3')
    })

    it('returns null when call info has no recording_url', async () => {
      const mockFetch = vi.mocked(globalThis.fetch)
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }))

      const result = await adapter.getCallRecording('call-uuid-123')

      expect(result).toBeNull()
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('returns null when call info fetch fails', async () => {
      const mockFetch = vi.mocked(globalThis.fetch)
      mockFetch.mockResolvedValueOnce(new Response('Not found', { status: 404 }))

      const result = await adapter.getCallRecording('call-uuid-123')

      expect(result).toBeNull()
    })

    it('returns null when audio fetch fails', async () => {
      const mockFetch = vi.mocked(globalThis.fetch)
      mockFetch
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ recording_url: 'https://example.com/recording.mp3' }), { status: 200 }),
        )
        .mockResolvedValueOnce(new Response('Error', { status: 500 }))

      const result = await adapter.getCallRecording('call-uuid-123')

      expect(result).toBeNull()
    })
  })

  describe('getRecordingAudio', () => {
    it('fetches audio from full URL and returns array buffer', async () => {
      const mockFetch = vi.mocked(globalThis.fetch)
      mockFetch.mockResolvedValueOnce(new Response(new ArrayBuffer(2048), { status: 200 }))

      const result = await adapter.getRecordingAudio('https://example.com/recording.mp3')

      expect(result).not.toBeNull()
      expect(result?.byteLength).toBe(2048)
      expect(mockFetch.mock.calls[0][0]).toBe('https://example.com/recording.mp3')
    })

    it('returns null when fetch fails', async () => {
      const mockFetch = vi.mocked(globalThis.fetch)
      mockFetch.mockResolvedValueOnce(new Response('Error', { status: 500 }))

      const result = await adapter.getRecordingAudio('https://example.com/recording.mp3')

      expect(result).toBeNull()
    })
  })

  describe('validateWebhook', () => {
    it('accepts valid signature with fresh timestamp', async () => {
      const url = await buildSignedUrl('https://example.com/webhook', { foo: 'bar' }, 'test-api-secret')
      const request = new Request(url)

      const result = await adapter.validateWebhook(request)
      expect(result).toBe(true)
    })

    it('rejects invalid signature', async () => {
      const url = await buildSignedUrl('https://example.com/webhook', { foo: 'bar' }, 'wrong-secret')
      const request = new Request(url)

      const result = await adapter.validateWebhook(request)
      expect(result).toBe(false)
    })

    it('rejects tampered parameters after signing', async () => {
      const url = await buildSignedUrl('https://example.com/webhook', { foo: 'bar' }, 'test-api-secret')
      const tamperedUrl = url.replace('foo=bar', 'foo=baz')
      const request = new Request(tamperedUrl)

      const result = await adapter.validateWebhook(request)
      expect(result).toBe(false)
    })

    it('rejects expired timestamp (> 5 minutes old)', async () => {
      const now = Math.floor(Date.now() / 1000) - 301
      const url = new URL('https://example.com/webhook')
      url.searchParams.set('timestamp', String(now))
      url.searchParams.set('foo', 'bar')

      const signedUrl = await signUrl(url, 'test-api-secret')
      const request = new Request(signedUrl)
      const result = await adapter.validateWebhook(request)
      expect(result).toBe(false)
    })

    it('rejects future timestamp (> 5 minutes ahead)', async () => {
      // Use 600s (10min) ahead to avoid flakiness from test-suite startup latency
      const now = Math.floor(Date.now() / 1000) + 600
      const url = new URL('https://example.com/webhook')
      url.searchParams.set('timestamp', String(now))
      url.searchParams.set('foo', 'bar')

      const signedUrl = await signUrl(url, 'test-api-secret')
      const request = new Request(signedUrl)
      const result = await adapter.validateWebhook(request)
      expect(result).toBe(false)
    })

    it('rejects missing timestamp', async () => {
      const url = new URL('https://example.com/webhook')
      url.searchParams.set('foo', 'bar')
      url.searchParams.set('sig', 'some-signature')
      const request = new Request(url.toString())

      const result = await adapter.validateWebhook(request)
      expect(result).toBe(false)
    })

    it('rejects missing sig', async () => {
      const url = new URL('https://example.com/webhook')
      url.searchParams.set('timestamp', String(Math.floor(Date.now() / 1000)))
      url.searchParams.set('foo', 'bar')
      const request = new Request(url.toString())

      const result = await adapter.validateWebhook(request)
      expect(result).toBe(false)
    })

    it('rejects both missing timestamp and sig', async () => {
      const request = new Request('https://example.com/webhook?foo=bar')

      const result = await adapter.validateWebhook(request)
      expect(result).toBe(false)
    })

    it('rejects invalid (non-numeric) timestamp', async () => {
      const url = new URL('https://example.com/webhook')
      url.searchParams.set('timestamp', 'not-a-number')
      url.searchParams.set('sig', 'some-signature')
      const request = new Request(url.toString())

      const result = await adapter.validateWebhook(request)
      expect(result).toBe(false)
    })

    it('accepts timestamp at exactly 60 second boundary', async () => {
      const fakeNow = 1700000000000 // fixed epoch ms
      vi.useFakeTimers({ now: fakeNow })
      try {
        const ts = Math.floor(fakeNow / 1000) - 60 // exactly at boundary
        const url = new URL('https://example.com/webhook')
        url.searchParams.set('timestamp', String(ts))
        url.searchParams.set('foo', 'bar')

        const signedUrl = await signUrl(url, 'test-api-secret')
        const request = new Request(signedUrl)
        const result = await adapter.validateWebhook(request)
        expect(result).toBe(true)
      } finally {
        vi.useRealTimers()
      }
    })

    it('validates with multiple query parameters', async () => {
      const url = await buildSignedUrl(
        'https://example.com/webhook',
        { a: '1', b: '2', c: '3' },
        'test-api-secret',
      )
      const request = new Request(url)

      const result = await adapter.validateWebhook(request)
      expect(result).toBe(true)
    })

    it('rejects when sig parameter length differs from expected', async () => {
      const url = new URL('https://example.com/webhook')
      url.searchParams.set('timestamp', String(Math.floor(Date.now() / 1000)))
      url.searchParams.set('sig', 'short')
      const request = new Request(url.toString())

      const result = await adapter.validateWebhook(request)
      expect(result).toBe(false)
    })
  })

  describe('parseIncomingWebhook', () => {
    it('parses uuid and from fields', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: JSON.stringify({ uuid: 'call-123', from: '+15559876543', to: '+15551234567' }),
        headers: { 'Content-Type': 'application/json' },
      })

      const result = await adapter.parseIncomingWebhook(request)
      expect(result.callSid).toBe('call-123')
      expect(result.callerNumber).toBe('+15559876543')
      expect(result.calledNumber).toBe('+15551234567')
    })

    it('falls back to conversation_uuid', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: JSON.stringify({ conversation_uuid: 'conv-123', from: '+15559876543' }),
        headers: { 'Content-Type': 'application/json' },
      })

      const result = await adapter.parseIncomingWebhook(request)
      expect(result.callSid).toBe('conv-123')
    })

    it('handles missing fields gracefully', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: JSON.stringify({}),
        headers: { 'Content-Type': 'application/json' },
      })

      const result = await adapter.parseIncomingWebhook(request)
      expect(result.callSid).toBe('')
      expect(result.callerNumber).toBe('')
      expect(result.calledNumber).toBeUndefined()
    })
  })

  describe('parseLanguageWebhook', () => {
    it('parses dtmf digits', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: JSON.stringify({ uuid: 'call-123', from: '+15559876543', dtmf: { digits: '2' } }),
        headers: { 'Content-Type': 'application/json' },
      })

      const result = await adapter.parseLanguageWebhook(request)
      expect(result.callSid).toBe('call-123')
      expect(result.callerNumber).toBe('+15559876543')
      expect(result.digits).toBe('2')
    })

    it('returns empty digits when dtmf is missing', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: JSON.stringify({ uuid: 'call-123', from: '+15559876543' }),
        headers: { 'Content-Type': 'application/json' },
      })

      const result = await adapter.parseLanguageWebhook(request)
      expect(result.digits).toBe('')
    })
  })

  describe('parseCaptchaWebhook', () => {
    it('parses dtmf digits and caller number', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: JSON.stringify({ from: '+15559876543', dtmf: { digits: '7391' } }),
        headers: { 'Content-Type': 'application/json' },
      })

      const result = await adapter.parseCaptchaWebhook(request)
      expect(result.digits).toBe('7391')
      expect(result.callerNumber).toBe('+15559876543')
    })
  })

  describe('parseCallStatusWebhook', () => {
    it.each([
      ['started', 'initiated'],
      ['ringing', 'ringing'],
      ['answered', 'answered'],
      ['completed', 'completed'],
      ['busy', 'busy'],
      ['timeout', 'no-answer'],
      ['unanswered', 'no-answer'],
      ['failed', 'failed'],
      ['rejected', 'failed'],
      ['cancelled', 'failed'],
      ['unknown', 'failed'],
    ])('maps %s → %s', async (vonageStatus, expectedStatus) => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: JSON.stringify({ status: vonageStatus }),
        headers: { 'Content-Type': 'application/json' },
      })

      const result = await adapter.parseCallStatusWebhook(request)
      expect(result.status).toBe(expectedStatus)
    })
  })

  describe('parseQueueWaitWebhook', () => {
    it('parses duration as queueTime', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: JSON.stringify({ duration: '45' }),
        headers: { 'Content-Type': 'application/json' },
      })

      const result = await adapter.parseQueueWaitWebhook(request)
      expect(result.queueTime).toBe(45)
    })

    it('defaults to 0 when duration is missing', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: JSON.stringify({}),
        headers: { 'Content-Type': 'application/json' },
      })

      const result = await adapter.parseQueueWaitWebhook(request)
      expect(result.queueTime).toBe(0)
    })
  })

  describe('parseQueueExitWebhook', () => {
    it('returns bridged for answered status', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: JSON.stringify({ status: 'answered' }),
        headers: { 'Content-Type': 'application/json' },
      })

      const result = await adapter.parseQueueExitWebhook(request)
      expect(result.result).toBe('bridged')
    })

    it('returns hangup for completed status', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: JSON.stringify({ status: 'completed' }),
        headers: { 'Content-Type': 'application/json' },
      })

      const result = await adapter.parseQueueExitWebhook(request)
      expect(result.result).toBe('hangup')
    })

    it('returns error for other statuses', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: JSON.stringify({ status: 'failed' }),
        headers: { 'Content-Type': 'application/json' },
      })

      const result = await adapter.parseQueueExitWebhook(request)
      expect(result.result).toBe('error')
    })
  })

  describe('parseRecordingWebhook', () => {
    it('returns completed when recording_url is present', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: JSON.stringify({ recording_url: 'https://example.com/rec.mp3', conversation_uuid: 'conv-123' }),
        headers: { 'Content-Type': 'application/json' },
      })

      const result = await adapter.parseRecordingWebhook(request)
      expect(result.status).toBe('completed')
      expect(result.recordingSid).toBe('https://example.com/rec.mp3')
      expect(result.callSid).toBe('conv-123')
    })

    it('returns failed when recording_url is missing', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: JSON.stringify({ conversation_uuid: 'conv-123' }),
        headers: { 'Content-Type': 'application/json' },
      })

      const result = await adapter.parseRecordingWebhook(request)
      expect(result.status).toBe('failed')
      expect(result.recordingSid).toBeUndefined()
    })
  })
})
