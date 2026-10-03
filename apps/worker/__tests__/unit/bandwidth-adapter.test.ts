import { describe, it, expect, beforeEach, vi } from 'vitest'
import { BandwidthAdapter } from '@worker/telephony/bandwidth'
import { DEFAULT_LANGUAGE } from '@shared/languages'

describe('BandwidthAdapter', () => {
  let adapter: BandwidthAdapter
  const accountId = 'acc-123'
  const apiToken = 'token-abc'
  const apiSecret = 'secret-xyz'
  const applicationId = 'app-456'
  const phoneNumber = '+15551234567'

  beforeEach(() => {
    adapter = new BandwidthAdapter(accountId, apiToken, apiSecret, applicationId, phoneNumber)
    vi.restoreAllMocks()
  })

  // --- BXML / IVR Methods ---

  describe('handleLanguageMenu', () => {
    it('returns Gather when multiple languages are enabled', async () => {
      const result = await adapter.handleLanguageMenu({
        callSid: 'call-1',
        callerNumber: '+15559876543',
        hotlineName: 'Test Hotline',
        enabledLanguages: ['es', 'en'],
      })
      expect(result.contentType).toBe('application/xml')
      expect(result.body).toContain('<Gather')
      expect(result.body).toContain('maxDigits="1"')
      expect(result.body).toContain('gatherUrl="/api/telephony/language-selected"')
      expect(result.body).toContain('Para español, marque 1.')
      expect(result.body).toContain('For English, press 2.')
    })

    it('returns Redirect when only one language is enabled', async () => {
      const result = await adapter.handleLanguageMenu({
        callSid: 'call-1',
        callerNumber: '+15559876543',
        hotlineName: 'Test Hotline',
        enabledLanguages: ['es'],
      })
      expect(result.contentType).toBe('application/xml')
      expect(result.body).toContain('<Redirect')
      expect(result.body).toContain('forceLang=es')
      expect(result.body).toContain('auto=1')
    })

    it('falls back to default language when none are enabled', async () => {
      const result = await adapter.handleLanguageMenu({
        callSid: 'call-1',
        callerNumber: '+15559876543',
        hotlineName: 'Test Hotline',
        enabledLanguages: [],
      })
      expect(result.contentType).toBe('application/xml')
      expect(result.body).toContain('forceLang=' + DEFAULT_LANGUAGE)
    })

    it('appends hub parameter when hubId is provided', async () => {
      const result = await adapter.handleLanguageMenu({
        callSid: 'call-1',
        callerNumber: '+15559876543',
        hotlineName: 'Test Hotline',
        enabledLanguages: ['es', 'en'],
        hubId: 'hub-42',
      })
      expect(result.body).toContain('hub=hub-42')
    })
  })

  describe('handleIncomingCall', () => {
    it('returns rate-limited BXML when rateLimited is true', async () => {
      const result = await adapter.handleIncomingCall({
        callSid: 'call-1',
        callerNumber: '+15559876543',
        voiceCaptchaEnabled: false,
        rateLimited: true,
        callerLanguage: 'en',
        hotlineName: 'Test Hotline',
      })
      expect(result.contentType).toBe('application/xml')
      expect(result.body).toContain('<Hangup/>')
      expect(result.body).toContain('Thank you for calling Test Hotline.')
      expect(result.body).toContain('high call volume')
    })

    it('returns Gather BXML when voice captcha is enabled', async () => {
      const result = await adapter.handleIncomingCall({
        callSid: 'call-1',
        callerNumber: '+15559876543',
        voiceCaptchaEnabled: true,
        rateLimited: false,
        callerLanguage: 'en',
        hotlineName: 'Test Hotline',
        captchaDigits: '7391',
      })
      expect(result.contentType).toBe('application/xml')
      expect(result.body).toContain('<Gather')
      expect(result.body).toContain('maxDigits="4"')
      expect(result.body).toContain('gatherUrl="/api/telephony/captcha?callSid=call-1&amp;lang=en"')
      expect(result.body).toContain('7, 3, 9, 1.')
      expect(result.body).toContain('Please enter the following digits:')
    })

    it('returns Redirect to wait-music for normal calls', async () => {
      const result = await adapter.handleIncomingCall({
        callSid: 'call-1',
        callerNumber: '+15559876543',
        voiceCaptchaEnabled: false,
        rateLimited: false,
        callerLanguage: 'en',
        hotlineName: 'Test Hotline',
      })
      expect(result.contentType).toBe('application/xml')
      expect(result.body).toContain('<Redirect')
      expect(result.body).toContain('/api/telephony/wait-music?lang=en&amp;callSid=call-1')
      expect(result.body).toContain('Please hold while we connect you.')
    })

    it('appends hub parameter when hubId is provided', async () => {
      const result = await adapter.handleIncomingCall({
        callSid: 'call-1',
        callerNumber: '+15559876543',
        voiceCaptchaEnabled: false,
        rateLimited: false,
        callerLanguage: 'en',
        hotlineName: 'Test Hotline',
        hubId: 'hub-42',
      })
      expect(result.body).toContain('hub=hub-42')
    })
  })

  describe('handleCaptchaResponse', () => {
    it('returns success BXML when digits match', async () => {
      const result = await adapter.handleCaptchaResponse({
        callSid: 'call-1',
        digits: '7391',
        expectedDigits: '7391',
        callerLanguage: 'en',
      })
      expect(result.contentType).toBe('application/xml')
      expect(result.body).toContain('Thank you. Please hold while we connect you.')
      expect(result.body).toContain('<Redirect')
      expect(result.body).toContain('/api/telephony/wait-music?lang=en&amp;callSid=call-1')
    })

    it('returns failure BXML when digits do not match', async () => {
      const result = await adapter.handleCaptchaResponse({
        callSid: 'call-1',
        digits: '1234',
        expectedDigits: '7391',
        callerLanguage: 'en',
      })
      expect(result.contentType).toBe('application/xml')
      expect(result.body).toContain('We are unable to connect your call. Goodbye.')
      expect(result.body).toContain('<Hangup/>')
      expect(result.body).not.toContain('<Redirect')
    })
  })

  describe('handleCallAnswered', () => {
    it('returns StartRecording + Bridge BXML', async () => {
      const result = await adapter.handleCallAnswered({
        parentCallSid: 'parent-1',
        callbackUrl: 'https://example.com',
        userPubkey: 'pubkey-abc',
      })
      expect(result.contentType).toBe('application/xml')
      expect(result.body).toContain('<StartRecording')
      expect(result.body).toContain('recordingAvailableUrl="https://example.com/api/telephony/call-recording?parentCallSid=parent-1"')
      expect(result.body).toContain('<Bridge targetCall="parent-1"/>')
    })

    it('escapes XML in callback URL', async () => {
      const result = await adapter.handleCallAnswered({
        parentCallSid: 'call-1',
        callbackUrl: 'https://example.com?foo=bar&baz=qux',
        userPubkey: 'pk',
      })
      expect(result.body).toContain('recordingAvailableUrl="https://example.com?foo=bar&amp;baz=qux/api/telephony/call-recording?parentCallSid=call-1"')
      expect(result.body).toContain('<Bridge targetCall="call-1"/>')
    })
  })

  describe('handleVoicemail', () => {
    it('returns Record BXML with default max duration', async () => {
      const result = await adapter.handleVoicemail({
        callSid: 'call-1',
        callerLanguage: 'en',
        callbackUrl: 'https://example.com',
      })
      expect(result.contentType).toBe('application/xml')
      expect(result.body).toContain('<Record')
      expect(result.body).toContain('maxDuration="120"')
      expect(result.body).toContain('recordCompleteUrl="/api/telephony/voicemail-complete?callSid=call-1&amp;lang=en"')
      expect(result.body).toContain('recordingAvailableUrl="https://example.com/api/telephony/voicemail-recording?callSid=call-1"')
      expect(result.body).toContain('<Hangup/>')
    })

    it('uses custom maxRecordingSeconds', async () => {
      const result = await adapter.handleVoicemail({
        callSid: 'call-1',
        callerLanguage: 'en',
        callbackUrl: 'https://example.com',
        maxRecordingSeconds: 60,
      })
      expect(result.body).toContain('maxDuration="60"')
    })

    it('appends hub parameter when hubId is provided', async () => {
      const result = await adapter.handleVoicemail({
        callSid: 'call-1',
        callerLanguage: 'en',
        callbackUrl: 'https://example.com',
        hubId: 'hub-42',
      })
      expect(result.body).toContain('hub=hub-42')
    })
  })

  describe('handleWaitMusic', () => {
    it('returns wait music BXML under timeout', async () => {
      const result = await adapter.handleWaitMusic('en', undefined, 30, 90)
      expect(result.contentType).toBe('application/xml')
      expect(result.body).toContain('Your call is important to us')
      expect(result.body).toContain('<PlayAudio>https://com.twilio.music.soft-rock.s3.amazonaws.com/_ghost_-_promo_2_sample_pack.mp3</PlayAudio>')
      expect(result.body).toContain('<Redirect')
    })

    it('returns Hangup when queueTime exceeds timeout', async () => {
      const result = await adapter.handleWaitMusic('en', undefined, 95, 90)
      expect(result.contentType).toBe('application/xml')
      expect(result.body).toBe('<Response><Response><Hangup/></Response></Response>')
    })

    it('returns Hangup when queueTime equals timeout', async () => {
      const result = await adapter.handleWaitMusic('en', undefined, 90, 90)
      expect(result.contentType).toBe('application/xml')
      expect(result.body).toBe('<Response><Response><Hangup/></Response></Response>')
    })

    it('uses default timeout of 90 when not provided', async () => {
      const result = await adapter.handleWaitMusic('en', undefined, 100)
      expect(result.contentType).toBe('application/xml')
      expect(result.body).toBe('<Response><Response><Hangup/></Response></Response>')
    })

    it('uses custom audio URLs when provided', async () => {
      const audioUrls = { 'waitMessage:en': 'https://example.com/custom-wait.mp3' }
      const result = await adapter.handleWaitMusic('en', audioUrls, 10, 90)
      expect(result.body).toContain('<PlayAudio>https://example.com/custom-wait.mp3</PlayAudio>')
    })
  })

  describe('handleVoicemailComplete', () => {
    it('returns thank-you BXML', () => {
      const result = adapter.handleVoicemailComplete('en')
      expect(result.contentType).toBe('application/xml')
      expect(result.body).toContain('Thank you for your message. Goodbye.')
      expect(result.body).toContain('<Hangup/>')
    })
  })

  describe('rejectCall', () => {
    it('returns Hangup BXML', () => {
      const result = adapter.rejectCall()
      expect(result.contentType).toBe('application/xml')
      expect(result.body).toBe('<Response><Response><Hangup/></Response></Response>')
    })
  })

  describe('emptyResponse', () => {
    it('returns empty Response BXML', () => {
      const result = adapter.emptyResponse()
      expect(result.contentType).toBe('application/xml')
      expect(result.body).toBe('<Response><Response/></Response>')
    })
  })

  // --- escapeXml correctness ---

  describe('escapeXml', () => {
    it('escapes special XML characters in prompts', async () => {
      // Use a language with characters that need escaping, or inject via callbackUrl
      const result = await adapter.handleCallAnswered({
        parentCallSid: 'call-1',
        callbackUrl: 'https://example.com?a=1&b=2',
        userPubkey: 'pk',
      })
      // callbackUrl contains & which should be escaped in the XML attribute
      expect(result.body).not.toContain('recordingAvailableUrl="https://example.com?a=1&b=2"')
    })
  })

  // --- Call Control Methods ---

  describe('hangupCall', () => {
    it('POSTs state=completed to the call endpoint', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('{}', { status: 200 }),
      )

      await adapter.hangupCall('call-1')

      expect(fetchSpy).toHaveBeenCalledTimes(1)
      const [url, init] = fetchSpy.mock.calls[0]
      expect(url).toBe(`https://voice.bandwidth.com/api/v2/accounts/${accountId}/calls/call-1`)
      expect(init?.method).toBe('POST')
      expect(init?.body).toBe(JSON.stringify({ state: 'completed' }))
    })
  })

  describe('hangupCall failures', () => {
    it('rejects when Bandwidth refuses the hang-up', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 500 }))
      await expect(adapter.hangupCall('call-1')).rejects.toThrow(/hangup failed: 500/)
    })
  })

  describe('ringVolunteers', () => {
    it('POSTs outbound calls for each volunteer and returns callIds', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/calls')) {
          return Promise.resolve(
            new Response(JSON.stringify({ callId: 'out-call-1' }), { status: 201 }),
          )
        }
        return Promise.resolve(new Response('{}', { status: 200 }))
      })

      const result = await adapter.ringVolunteers({
        callSid: 'parent-1',
        callerNumber: '+15559876543',
        volunteers: [
          { phone: '+15551111111', callToken: 'token-a' },
          { phone: '+15552222222', callToken: 'token-b' },
        ],
        callbackUrl: 'https://example.com',
      })

      expect(fetchSpy).toHaveBeenCalledTimes(2)
      expect(result).toEqual(['out-call-1', 'out-call-1'])

      const [firstUrl, firstInit] = fetchSpy.mock.calls[0]
      expect(firstUrl).toBe(`https://voice.bandwidth.com/api/v2/accounts/${accountId}/calls`)
      const firstBody = JSON.parse(firstInit?.body as string)
      expect(firstBody.from).toBe(phoneNumber)
      expect(firstBody.to).toBe('+15551111111')
      expect(firstBody.applicationId).toBe(applicationId)
      expect(firstBody.callTimeout).toBe(30)
      expect(firstBody.tag).toBe(JSON.stringify({ parentCallSid: 'parent-1', callToken: 'token-a' }))
    })

    it('skips failed calls and returns only successful callIds', async () => {
      let callCount = 0
      vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
        callCount++
        if (callCount === 1) {
          return Promise.resolve(new Response(JSON.stringify({ callId: 'ok-1' }), { status: 201 }))
        }
        return Promise.resolve(new Response('Bad Request', { status: 400 }))
      })

      const result = await adapter.ringVolunteers({
        callSid: 'parent-1',
        callerNumber: '+15559876543',
        volunteers: [
          { phone: '+15551111111', callToken: 'token-a' },
          { phone: '+15552222222', callToken: 'token-b' },
        ],
        callbackUrl: 'https://example.com',
      })

      expect(result).toEqual(['ok-1'])
    })

    it('appends hub parameter when hubId is provided', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ callId: 'out-1' }), { status: 201 }),
      )

      await adapter.ringVolunteers({
        callSid: 'parent-1',
        callerNumber: '+15559876543',
        volunteers: [{ phone: '+15551111111', callToken: 'token-a' }],
        callbackUrl: 'https://example.com',
        hubId: 'hub-42',
      })

      const [, init] = fetchSpy.mock.calls[0]
      const body = JSON.parse(init?.body as string)
      expect(body.answerUrl).toContain('hub=hub-42')
      expect(body.disconnectUrl).toContain('hub=hub-42')
      expect(body.tag).toBe(JSON.stringify({ parentCallSid: 'parent-1', callToken: 'token-a', hubId: 'hub-42' }))
    })
  })

  describe('cancelRinging', () => {
    it('POSTs state=completed for each callSid', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('{}', { status: 200 }),
      )

      await adapter.cancelRinging(['call-a', 'call-b', 'call-c'])

      expect(fetchSpy).toHaveBeenCalledTimes(3)
      const urls = fetchSpy.mock.calls.map((call) => call[0])
      expect(urls).toContain(`https://voice.bandwidth.com/api/v2/accounts/${accountId}/calls/call-a`)
      expect(urls).toContain(`https://voice.bandwidth.com/api/v2/accounts/${accountId}/calls/call-b`)
      expect(urls).toContain(`https://voice.bandwidth.com/api/v2/accounts/${accountId}/calls/call-c`)
    })

    it('skips the exceptSid', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('{}', { status: 200 }),
      )

      await adapter.cancelRinging(['call-a', 'call-b'], 'call-b')

      expect(fetchSpy).toHaveBeenCalledTimes(1)
      const [url] = fetchSpy.mock.calls[0]
      expect(url).toBe(`https://voice.bandwidth.com/api/v2/accounts/${accountId}/calls/call-a`)
    })

    it('handles empty array', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('{}', { status: 200 }),
      )

      await adapter.cancelRinging([])

      expect(fetchSpy).not.toHaveBeenCalled()
    })
  })

  // --- Recording Methods ---

  describe('getCallRecording', () => {
    it('fetches recordings and returns audio buffer', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/recordings/')) {
          return Promise.resolve(new Response(new ArrayBuffer(8), { status: 200 }))
        }
        return Promise.resolve(
          new Response(JSON.stringify([{ recordingId: 'rec-1', mediaUrl: 'https://example.com/media' }]), { status: 200 }),
        )
      })

      const result = await adapter.getCallRecording('call-1')

      expect(fetchSpy).toHaveBeenCalledTimes(2)
      expect(result).toBeInstanceOf(ArrayBuffer)
    })

    it('returns null when recordings list is empty', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify([]), { status: 200 }),
      )

      const result = await adapter.getCallRecording('call-1')
      expect(result).toBeNull()
    })

    it('returns null when API returns non-ok', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('Not Found', { status: 404 }),
      )

      const result = await adapter.getCallRecording('call-1')
      expect(result).toBeNull()
    })
  })

  describe('getRecordingAudio', () => {
    it('returns ArrayBuffer on success', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(new ArrayBuffer(4), { status: 200 }),
      )

      const result = await adapter.getRecordingAudio('rec-1')
      expect(result).toBeInstanceOf(ArrayBuffer)
    })

    it('returns null on non-ok response', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('Not Found', { status: 404 }),
      )

      const result = await adapter.getRecordingAudio('rec-1')
      expect(result).toBeNull()
    })
  })

  // --- Webhook Validation ---

  describe('validateWebhook', () => {
    it('accepts correct Basic auth credentials', async () => {
      const credentials = btoa(`${apiToken}:${apiSecret}`)
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        headers: { Authorization: `Basic ${credentials}` },
        body: '{}',
      })

      const result = await adapter.validateWebhook(request)
      expect(result).toBe(true)
    })

    it('rejects incorrect password', async () => {
      const credentials = btoa(`${apiToken}:wrong-secret`)
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        headers: { Authorization: `Basic ${credentials}` },
        body: '{}',
      })

      const result = await adapter.validateWebhook(request)
      expect(result).toBe(false)
    })

    it('rejects incorrect username', async () => {
      const credentials = btoa(`wrong-token:${apiSecret}`)
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        headers: { Authorization: `Basic ${credentials}` },
        body: '{}',
      })

      const result = await adapter.validateWebhook(request)
      expect(result).toBe(false)
    })

    it('rejects missing Authorization header', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: '{}',
      })

      const result = await adapter.validateWebhook(request)
      expect(result).toBe(false)
    })

    it('rejects non-Basic auth scheme', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        headers: { Authorization: 'Bearer some-token' },
        body: '{}',
      })

      const result = await adapter.validateWebhook(request)
      expect(result).toBe(false)
    })

    it('rejects malformed base64', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        headers: { Authorization: 'Basic !!!not-valid-base64!!!' },
        body: '{}',
      })

      const result = await adapter.validateWebhook(request)
      expect(result).toBe(false)
    })

    it('rejects empty username or password', async () => {
      const credentials = btoa(':')
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        headers: { Authorization: `Basic ${credentials}` },
        body: '{}',
      })

      const result = await adapter.validateWebhook(request)
      expect(result).toBe(false)
    })

    it('rejects wrong-length credentials (timing-safe length check)', async () => {
      const credentials = btoa(`${apiToken}:short`)
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        headers: { Authorization: `Basic ${credentials}` },
        body: '{}',
      })

      const result = await adapter.validateWebhook(request)
      expect(result).toBe(false)
    })
  })

  // --- Webhook Parsing ---

  describe('parseIncomingWebhook', () => {
    it('parses callId and from fields', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: JSON.stringify({ callId: 'call-1', from: '+15559876543', to: '+15551234567' }),
        headers: { 'Content-Type': 'application/json' },
      })

      const result = await adapter.parseIncomingWebhook(request)
      expect(result.callSid).toBe('call-1')
      expect(result.callerNumber).toBe('+15559876543')
      expect(result.calledNumber).toBe('+15551234567')
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
    it('parses callId, from, and digits', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: JSON.stringify({ callId: 'call-1', from: '+15559876543', digits: '2' }),
        headers: { 'Content-Type': 'application/json' },
      })

      const result = await adapter.parseLanguageWebhook(request)
      expect(result.callSid).toBe('call-1')
      expect(result.callerNumber).toBe('+15559876543')
      expect(result.digits).toBe('2')
    })
  })

  describe('parseCaptchaWebhook', () => {
    it('parses digits and from', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: JSON.stringify({ digits: '7391', from: '+15559876543' }),
        headers: { 'Content-Type': 'application/json' },
      })

      const result = await adapter.parseCaptchaWebhook(request)
      expect(result.digits).toBe('7391')
      expect(result.callerNumber).toBe('+15559876543')
    })
  })

  describe('parseCallStatusWebhook', () => {
    it('returns initiated for initiate event', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: JSON.stringify({ eventType: 'initiate' }),
        headers: { 'Content-Type': 'application/json' },
      })

      const result = await adapter.parseCallStatusWebhook(request)
      expect(result.status).toBe('initiated')
    })

    it('returns answered for answer event', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: JSON.stringify({ eventType: 'answer' }),
        headers: { 'Content-Type': 'application/json' },
      })

      const result = await adapter.parseCallStatusWebhook(request)
      expect(result.status).toBe('answered')
    })

    it('maps disconnect causes correctly', async () => {
      const causes: Array<[string, string]> = [
        ['hangup', 'completed'],
        ['busy', 'busy'],
        ['cancel', 'failed'],
        ['rejected', 'failed'],
        ['forbidden', 'failed'],
        ['timeout', 'no-answer'],
        ['normal_clearing', 'completed'],
        ['unknown', 'failed'],
      ]

      for (const [cause, expected] of causes) {
        const request = new Request('https://example.com/webhook', {
          method: 'POST',
          body: JSON.stringify({ eventType: 'disconnect', cause }),
          headers: { 'Content-Type': 'application/json' },
        })

        const result = await adapter.parseCallStatusWebhook(request)
        expect(result.status).toBe(expected)
      }
    })

    it('returns failed for unknown event types', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: JSON.stringify({ eventType: 'somethingElse' }),
        headers: { 'Content-Type': 'application/json' },
      })

      const result = await adapter.parseCallStatusWebhook(request)
      expect(result.status).toBe('failed')
    })
  })

  describe('parseQueueWaitWebhook', () => {
    it('returns queueTime 0', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: JSON.stringify({}),
      })

      const result = await adapter.parseQueueWaitWebhook(request)
      expect(result.queueTime).toBe(0)
    })
  })

  describe('parseQueueExitWebhook', () => {
    it('returns bridged for transferComplete', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: JSON.stringify({ eventType: 'transferComplete' }),
        headers: { 'Content-Type': 'application/json' },
      })

      const result = await adapter.parseQueueExitWebhook(request)
      expect(result.result).toBe('bridged')
    })

    it('returns hangup for disconnect with hangup cause', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: JSON.stringify({ eventType: 'disconnect', cause: 'hangup' }),
        headers: { 'Content-Type': 'application/json' },
      })

      const result = await adapter.parseQueueExitWebhook(request)
      expect(result.result).toBe('hangup')
    })

    it('returns hangup for disconnect with cancel cause', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: JSON.stringify({ eventType: 'disconnect', cause: 'cancel' }),
        headers: { 'Content-Type': 'application/json' },
      })

      const result = await adapter.parseQueueExitWebhook(request)
      expect(result.result).toBe('hangup')
    })

    it('returns error for disconnect with other causes', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: JSON.stringify({ eventType: 'disconnect', cause: 'timeout' }),
        headers: { 'Content-Type': 'application/json' },
      })

      const result = await adapter.parseQueueExitWebhook(request)
      expect(result.result).toBe('error')
    })

    it('returns error for unknown event types', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: JSON.stringify({ eventType: 'unknown' }),
        headers: { 'Content-Type': 'application/json' },
      })

      const result = await adapter.parseQueueExitWebhook(request)
      expect(result.result).toBe('error')
    })
  })

  describe('parseRecordingWebhook', () => {
    it('returns completed for recordingAvailable', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: JSON.stringify({ eventType: 'recordingAvailable', recordingId: 'rec-1', callId: 'call-1' }),
        headers: { 'Content-Type': 'application/json' },
      })

      const result = await adapter.parseRecordingWebhook(request)
      expect(result.status).toBe('completed')
      expect(result.recordingSid).toBe('rec-1')
      expect(result.callSid).toBe('call-1')
    })

    it('returns completed for recordComplete', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: JSON.stringify({ eventType: 'recordComplete', recordingId: 'rec-2' }),
        headers: { 'Content-Type': 'application/json' },
      })

      const result = await adapter.parseRecordingWebhook(request)
      expect(result.status).toBe('completed')
      expect(result.recordingSid).toBe('rec-2')
    })

    it('returns failed for other event types', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        body: JSON.stringify({ eventType: 'recordingFailed' }),
        headers: { 'Content-Type': 'application/json' },
      })

      const result = await adapter.parseRecordingWebhook(request)
      expect(result.status).toBe('failed')
      expect(result.recordingSid).toBeUndefined()
    })
  })
})
