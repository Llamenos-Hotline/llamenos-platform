import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { SipBridgeAdapter } from '@worker/telephony/sip-bridge-adapter'
import { AsteriskAdapter } from '@worker/telephony/asterisk'
import { FreeSwitchAdapter } from '@worker/telephony/freeswitch'
import { getPrompt, getVoicemailThanks } from '@shared/voice-prompts'

class TestSipBridgeAdapter extends SipBridgeAdapter {
  getEndpointFormat(phone: string): string {
    return `TEST/${phone}@trunk`
  }
  getPbxType(): string {
    return 'test'
  }
  async handleLanguageMenu(): Promise<ReturnType<typeof this.json>> {
    return this.json([{ action: 'noop' }])
  }
  async handleIncomingCall(): Promise<ReturnType<typeof this.json>> {
    return this.json([{ action: 'noop' }])
  }
  async handleCaptchaResponse(): Promise<ReturnType<typeof this.json>> {
    return this.json([{ action: 'noop' }])
  }
  async handleCallAnswered(): Promise<ReturnType<typeof this.json>> {
    return this.json([{ action: 'noop' }])
  }
  async handleVoicemail(): Promise<ReturnType<typeof this.json>> {
    return this.json([{ action: 'noop' }])
  }
  async handleWaitMusic(): Promise<ReturnType<typeof this.json>> {
    return this.json([{ action: 'noop' }])
  }
  rejectCall() {
    return this.json([{ action: 'hangup' }])
  }
  handleVoicemailComplete() {
    return this.json([{ action: 'hangup' }])
  }
  emptyResponse() {
    return this.json([])
  }
}

async function signBridgePayload(
  body: object,
  secret: string,
  timestamp?: number,
  url = 'https://example.com/webhook',
): Promise<{ signature: string; timestamp: string }> {
  const ts = timestamp ?? Date.now()
  const bodyStr = JSON.stringify(body)
  const payload = `${ts}.${url}.${bodyStr}`
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payload))
  const signature = btoa(String.fromCharCode(...new Uint8Array(sig)))
  return { signature, timestamp: ts.toString() }
}

function makeJsonRequest(body: object, headers?: Record<string, string>): Request {
  return new Request('https://example.com/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

describe('SipBridgeAdapter', () => {
  let adapter: TestSipBridgeAdapter
  let fetchMock: ReturnType<typeof vi.fn>
  const bridgeSecret = 'bridge-secret-123'
  const bridgeCallbackUrl = 'https://bridge.example.com'

  beforeEach(() => {
    adapter = new TestSipBridgeAdapter('+15551234567', bridgeCallbackUrl, bridgeSecret)
    fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('validateWebhook', () => {
    it('accepts valid signature', async () => {
      const body = { event: 'test', callSid: 'CA123' }
      const { signature, timestamp } = await signBridgePayload(body, bridgeSecret)
      const request = makeJsonRequest(body, {
        'X-Bridge-Signature': signature,
        'X-Bridge-Timestamp': timestamp,
      })
      const result = await adapter.validateWebhook(request)
      expect(result).toBe(true)
    })

    it('rejects invalid signature', async () => {
      const body = { event: 'test' }
      const request = makeJsonRequest(body, {
        'X-Bridge-Signature': '0000000000000000000000000000000000000000000000000000000000000000',
        'X-Bridge-Timestamp': Date.now().toString(),
      })
      const result = await adapter.validateWebhook(request)
      expect(result).toBe(false)
    })

    it('rejects missing signature header', async () => {
      const request = makeJsonRequest({ event: 'test' }, {
        'X-Bridge-Timestamp': Date.now().toString(),
      })
      const result = await adapter.validateWebhook(request)
      expect(result).toBe(false)
    })

    it('rejects expired timestamp (>5 minutes old)', async () => {
      const body = { event: 'test' }
      const oldTs = Date.now() - 400_000
      const { signature } = await signBridgePayload(body, bridgeSecret, oldTs)
      const request = makeJsonRequest(body, {
        'X-Bridge-Signature': signature,
        'X-Bridge-Timestamp': oldTs.toString(),
      })
      const result = await adapter.validateWebhook(request)
      expect(result).toBe(false)
    })

    it('rejects timestamp too far in the future', async () => {
      const body = { event: 'test' }
      const futureTs = Date.now() + 400_000
      const { signature } = await signBridgePayload(body, bridgeSecret, futureTs)
      const request = makeJsonRequest(body, {
        'X-Bridge-Signature': signature,
        'X-Bridge-Timestamp': futureTs.toString(),
      })
      const result = await adapter.validateWebhook(request)
      expect(result).toBe(false)
    })

    it('rejects missing timestamp header', async () => {
      const body = { event: 'test' }
      const { signature } = await signBridgePayload(body, bridgeSecret)
      const request = makeJsonRequest(body, {
        'X-Bridge-Signature': signature,
      })
      const result = await adapter.validateWebhook(request)
      expect(result).toBe(false)
    })
  })

  describe('parseIncomingWebhook', () => {
    it('parses channelId and callerNumber', async () => {
      const request = makeJsonRequest({ channelId: 'ch-1', callerNumber: '+15551111111', calledNumber: '+15552222222' })
      const result = await adapter.parseIncomingWebhook(request)
      expect(result.callSid).toBe('ch-1')
      expect(result.callerNumber).toBe('+15551111111')
      expect(result.calledNumber).toBe('+15552222222')
    })

    it('falls back to callSid and from fields', async () => {
      const request = makeJsonRequest({ callSid: 'cs-1', from: '+15553333333', to: '+15554444444' })
      const result = await adapter.parseIncomingWebhook(request)
      expect(result.callSid).toBe('cs-1')
      expect(result.callerNumber).toBe('+15553333333')
      expect(result.calledNumber).toBe('+15554444444')
    })

    it('uses empty strings when fields missing', async () => {
      const request = makeJsonRequest({})
      const result = await adapter.parseIncomingWebhook(request)
      expect(result.callSid).toBe('')
      expect(result.callerNumber).toBe('')
      expect(result.calledNumber).toBeUndefined()
    })

    it('fails when request body already consumed (BUG: no clone)', async () => {
      const request = makeJsonRequest({ channelId: 'ch-1' })
      await request.json()
      await expect(adapter.parseIncomingWebhook(request)).rejects.toThrow()
    })
  })

  describe('parseLanguageWebhook', () => {
    it('parses digits and call info', async () => {
      const request = makeJsonRequest({ channelId: 'ch-1', callerNumber: '+15551111111', digits: '2' })
      const result = await adapter.parseLanguageWebhook(request)
      expect(result.callSid).toBe('ch-1')
      expect(result.callerNumber).toBe('+15551111111')
      expect(result.digits).toBe('2')
    })

    it('fails when body already consumed (BUG: no clone)', async () => {
      const request = makeJsonRequest({ digits: '1' })
      await request.json()
      await expect(adapter.parseLanguageWebhook(request)).rejects.toThrow()
    })
  })

  describe('parseCaptchaWebhook', () => {
    it('parses digits and callerNumber', async () => {
      const request = makeJsonRequest({ digits: '1234', callerNumber: '+15551111111' })
      const result = await adapter.parseCaptchaWebhook(request)
      expect(result.digits).toBe('1234')
      expect(result.callerNumber).toBe('+15551111111')
    })

    it('falls back to from field', async () => {
      const request = makeJsonRequest({ digits: '5678', from: '+15552222222' })
      const result = await adapter.parseCaptchaWebhook(request)
      expect(result.callerNumber).toBe('+15552222222')
    })

    it('fails when body already consumed (BUG: no clone)', async () => {
      const request = makeJsonRequest({ digits: '1' })
      await request.json()
      await expect(adapter.parseCaptchaWebhook(request)).rejects.toThrow()
    })
  })

  describe('parseCallStatusWebhook', () => {
    it('maps bridge statuses correctly', async () => {
      const tests: Array<{ raw: string; expected: string }> = [
        { raw: 'ring', expected: 'ringing' },
        { raw: 'ringing', expected: 'ringing' },
        { raw: 'up', expected: 'answered' },
        { raw: 'answered', expected: 'answered' },
        { raw: 'down', expected: 'completed' },
        { raw: 'hangup', expected: 'completed' },
        { raw: 'completed', expected: 'completed' },
        { raw: 'busy', expected: 'busy' },
        { raw: 'noanswer', expected: 'no-answer' },
        { raw: 'no-answer', expected: 'no-answer' },
        { raw: 'congestion', expected: 'failed' },
        { raw: 'failed', expected: 'failed' },
        { raw: 'unknown', expected: 'initiated' },
      ]

      for (const t of tests) {
        const request = makeJsonRequest({ state: t.raw })
        const result = await adapter.parseCallStatusWebhook(request)
        expect(result.status).toBe(t.expected)
      }
    })

    it('falls back to status field when state absent', async () => {
      const request = makeJsonRequest({ status: 'busy' })
      const result = await adapter.parseCallStatusWebhook(request)
      expect(result.status).toBe('busy')
    })
  })

  describe('parseQueueWaitWebhook', () => {
    it('parses queueTime', async () => {
      const request = makeJsonRequest({ queueTime: 42 })
      const result = await adapter.parseQueueWaitWebhook(request)
      expect(result.queueTime).toBe(42)
    })

    it('defaults to 0 when missing', async () => {
      const request = makeJsonRequest({})
      const result = await adapter.parseQueueWaitWebhook(request)
      expect(result.queueTime).toBe(0)
    })
  })

  describe('parseQueueExitWebhook', () => {
    it('maps queue results correctly', async () => {
      const tests: Array<{ raw: string; expected: string }> = [
        { raw: 'bridged', expected: 'bridged' },
        { raw: 'answered', expected: 'bridged' },
        { raw: 'leave', expected: 'leave' },
        { raw: 'timeout', expected: 'leave' },
        { raw: 'full', expected: 'queue-full' },
        { raw: 'queue-full', expected: 'queue-full' },
        { raw: 'hangup', expected: 'hangup' },
        { raw: 'caller-hangup', expected: 'hangup' },
        { raw: 'unknown', expected: 'error' },
      ]

      for (const t of tests) {
        const request = makeJsonRequest({ result: t.raw })
        const result = await adapter.parseQueueExitWebhook(request)
        expect(result.result).toBe(t.expected)
      }
    })

    it('falls back to reason field', async () => {
      const request = makeJsonRequest({ reason: 'timeout' })
      const result = await adapter.parseQueueExitWebhook(request)
      expect(result.result).toBe('leave')
    })
  })

  describe('parseRecordingWebhook', () => {
    it('parses completed recording', async () => {
      const request = makeJsonRequest({
        recordingStatus: 'done',
        recordingName: 'rec-1',
        channelId: 'ch-1',
      })
      const result = await adapter.parseRecordingWebhook(request)
      expect(result.status).toBe('completed')
      expect(result.recordingSid).toBe('rec-1')
      expect(result.callSid).toBe('ch-1')
    })

    it('parses failed recording', async () => {
      const request = makeJsonRequest({ recordingStatus: 'failed' })
      const result = await adapter.parseRecordingWebhook(request)
      expect(result.status).toBe('failed')
    })

    it('falls back to recordingSid field', async () => {
      const request = makeJsonRequest({ recordingStatus: 'done', recordingSid: 'rec-2' })
      const result = await adapter.parseRecordingWebhook(request)
      expect(result.recordingSid).toBe('rec-2')
    })

    it('falls back to callSid field', async () => {
      const request = makeJsonRequest({ recordingStatus: 'done', callSid: 'cs-1' })
      const result = await adapter.parseRecordingWebhook(request)
      expect(result.callSid).toBe('cs-1')
    })
  })

  describe('hangupCall', () => {
    it('POSTs hangup command to bridge', async () => {
      fetchMock.mockResolvedValue({ ok: true, headers: { get: () => '' } } as unknown as Response)
      await adapter.hangupCall('ch-1')
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe(`${bridgeCallbackUrl}/hangup`)
      expect(init.method).toBe('POST')
      expect(JSON.parse(init.body)).toEqual({ channelId: 'ch-1' })
      expect(init.headers['X-Bridge-Signature']).toBeDefined()
      expect(init.headers['X-Bridge-Timestamp']).toBeDefined()
    })
  })

  describe('ringVolunteers', () => {
    it('POSTs ring command and returns callSids', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({ channelIds: ['cs-v1', 'cs-v2'] }),
      } as unknown as Response)

      const sids = await adapter.ringVolunteers({
        callSid: 'cs-parent',
        callerNumber: '+15551111111',
        volunteers: [
          { phone: '+15552222222', callToken: 'token-a' },
          { phone: '+15553333333', callToken: 'token-b' },
        ],
        callbackUrl: 'https://example.com/callback',
        hubId: 'hub-1',
      })

      expect(sids).toEqual(['cs-v1', 'cs-v2'])
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe(`${bridgeCallbackUrl}/ring`)
      const body = JSON.parse(init.body)
      expect(body.parentCallSid).toBe('cs-parent')
      expect(body.callerNumber).toBe('+15551111111')
      expect(body.volunteers).toHaveLength(2)
      expect(body.callbackUrl).toBe('https://example.com/callback')
      expect(body.hubId).toBe('hub-1')
    })

    it('returns empty array when bridge returns no callSids', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({}),
      } as unknown as Response)

      const sids = await adapter.ringVolunteers({
        callSid: 'cs-parent',
        callerNumber: '+15551111111',
        volunteers: [{ phone: '+15552222222', callToken: 'token-a' }],
        callbackUrl: 'https://example.com/callback',
      })

      expect(sids).toEqual([])
    })

    it('throws when bridge request fails', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      } as Response)

      await expect(
        adapter.ringVolunteers({
          callSid: 'cs-parent',
          callerNumber: '+15551111111',
          volunteers: [{ phone: '+15552222222', callToken: 'token-a' }],
          callbackUrl: 'https://example.com/callback',
        })
      ).rejects.toThrow('test bridge request failed: 500 Internal Server Error')
    })
  })

  describe('cancelRinging', () => {
    it('POSTs cancel-ringing command', async () => {
      fetchMock.mockResolvedValue({ ok: true, headers: { get: () => '' } } as unknown as Response)
      await adapter.cancelRinging(['cs-1', 'cs-2'], 'cs-2')
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe(`${bridgeCallbackUrl}/cancel-ringing`)
      const body = JSON.parse(init.body)
      expect(body.channelIds).toEqual(['cs-1', 'cs-2'])
      expect(body.exceptId).toBe('cs-2')
    })
  })

  describe('getCallRecording', () => {
    it('fetches recording by callSid and returns ArrayBuffer', async () => {
      const audioBase64 = btoa('fake-audio-data')
      fetchMock.mockResolvedValue({
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({ audio: audioBase64 }),
      } as unknown as Response)

      const result = await adapter.getCallRecording('cs-1')
      expect(result).not.toBeNull()
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url] = fetchMock.mock.calls[0]
      expect(url).toBe(`${bridgeCallbackUrl}/recordings/call/cs-1`)
    })

    it('returns null when bridge returns non-JSON', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        headers: { get: () => 'text/plain' },
      } as unknown as Response)

      const result = await adapter.getCallRecording('cs-1')
      expect(result).toBeNull()
    })

    it('returns null on fetch error', async () => {
      fetchMock.mockRejectedValue(new Error('network error'))
      const result = await adapter.getCallRecording('cs-1')
      expect(result).toBeNull()
    })
  })

  describe('getRecordingAudio', () => {
    it('fetches recording by recordingSid', async () => {
      const audioBase64 = btoa('more-fake-audio')
      fetchMock.mockResolvedValue({
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({ audio: audioBase64 }),
      } as unknown as Response)

      const result = await adapter.getRecordingAudio('rec-1')
      expect(result).not.toBeNull()
      const [url] = fetchMock.mock.calls[0]
      expect(url).toBe(`${bridgeCallbackUrl}/recordings/rec-1`)
    })
  })
})

describe('AsteriskAdapter', () => {
  let adapter: AsteriskAdapter
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    adapter = new AsteriskAdapter(
      'http://ari.example.com',
      'ari-user',
      'ari-pass',
      '+15551234567',
      'https://bridge.example.com',
      'bridge-secret',
    )
    fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('getEndpointFormat', () => {
    it('returns PJSIP endpoint format', () => {
      expect(adapter.getEndpointFormat('+15552222222')).toBe('PJSIP/+15552222222@trunk')
    })
  })

  describe('getPbxType', () => {
    it('returns asterisk', () => {
      expect(adapter.getPbxType()).toBe('asterisk')
    })
  })

  describe('handleLanguageMenu', () => {
    it('returns auto-redirect when only 1 language enabled', async () => {
      const res = await adapter.handleLanguageMenu({
        callSid: 'CA123',
        callerNumber: '+15559876543',
        hotlineName: 'Test Hotline',
        enabledLanguages: ['en'],
      })
      expect(res.contentType).toBe('application/json')
      const body = JSON.parse(res.body)
      expect(body.commands).toHaveLength(2)
      expect(body.commands[0]).toEqual({ action: 'speak', text: ' ', language: 'en-US' })
      expect(body.commands[1]).toMatchObject({
        action: 'gather',
        numDigits: 0,
        timeout: 0,
        callbackEvent: 'language_selected',
        metadata: { auto: '1', forceLang: 'en' },
      })
    })

    it('returns gather with speak commands for multiple languages', async () => {
      const res = await adapter.handleLanguageMenu({
        callSid: 'CA123',
        callerNumber: '+15559876543',
        hotlineName: 'Test Hotline',
        enabledLanguages: ['en', 'es'],
      })
      expect(res.contentType).toBe('application/json')
      const body = JSON.parse(res.body)
      expect(body.commands.length).toBeGreaterThanOrEqual(2)
      const gather = body.commands.find((c: { action: string }) => c.action === 'gather')
      expect(gather).toBeDefined()
      expect(gather.numDigits).toBe(1)
      expect(gather.timeout).toBe(8)
      const speaks = body.commands.filter((c: { action: string }) => c.action === 'speak')
      expect(speaks.length).toBeGreaterThanOrEqual(1)
    })

    it('uses custom audio URLs in incoming call when provided', async () => {
      const res = await adapter.handleIncomingCall({
        callSid: 'CA123',
        callerNumber: '+15559876543',
        voiceCaptchaEnabled: false,
        rateLimited: true,
        callerLanguage: 'en',
        hotlineName: 'Test',
        audioUrls: { 'rateLimited:en': 'https://example.com/rate-limited.mp3' },
      })
      const body = JSON.parse(res.body)
      const playCmd = body.commands.find((c: { action: string }) => c.action === 'play')
      expect(playCmd).toBeDefined()
      expect(playCmd.url).toBe('https://example.com/rate-limited.mp3')
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
      const body = JSON.parse(res.body)
      // Greeting, then the rate-limit message, then hang up.
      expect(body.commands).toHaveLength(3)
      expect(body.commands[2]).toEqual({ action: 'hangup' })
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
      const body = JSON.parse(res.body)
      // Greeting, the CAPTCHA prompt, the digits, then collect them.
      expect(body.commands).toHaveLength(4)
      expect(body.commands[2]).toMatchObject({ action: 'speak', text: '1 2 3 4' })
      const gather = body.commands[3]
      expect(gather.action).toBe('gather')
      expect(gather.numDigits).toBe(4)
      expect(gather.timeout).toBe(10)
      expect(gather.callbackEvent).toBe('captcha_response')
      expect(gather.metadata.callSid).toBe('CA123')
    })

    it('returns queue command for normal call', async () => {
      const res = await adapter.handleIncomingCall({
        callSid: 'CA123',
        callerNumber: '+15559876543',
        voiceCaptchaEnabled: false,
        rateLimited: false,
        callerLanguage: 'en',
        hotlineName: 'Test',
      })
      const body = JSON.parse(res.body)
      const queue = body.commands.find((c: { action: string }) => c.action === 'queue')
      expect(queue).toBeDefined()
      expect(queue.queueName).toBe('CA123')
      expect(queue.waitMusicEvent).toBe('wait_music')
      expect(queue.exitEvent).toBe('queue_exit')
    })

    it('uses custom audio URLs when provided', async () => {
      const res = await adapter.handleIncomingCall({
        callSid: 'CA123',
        callerNumber: '+15559876543',
        voiceCaptchaEnabled: false,
        rateLimited: false,
        callerLanguage: 'en',
        hotlineName: 'Test',
        audioUrls: { 'greeting:en': 'https://example.com/greeting.wav', 'pleaseHold:en': 'https://example.com/hold.wav' },
      })
      const body = JSON.parse(res.body)
      const plays = body.commands.filter((c: { action: string }) => c.action === 'play')
      expect(plays.map((p: { url: string }) => p.url)).toEqual(['https://example.com/greeting.wav', 'https://example.com/hold.wav'])
    })
  })

  describe('handleCaptchaResponse', () => {
    it('returns queue on correct digits', async () => {
      const res = await adapter.handleCaptchaResponse({
        callSid: 'CA123',
        digits: '5678',
        expectedDigits: '5678',
        callerLanguage: 'en',
      })
      const body = JSON.parse(res.body)
      const queue = body.commands.find((c: { action: string }) => c.action === 'queue')
      expect(queue).toBeDefined()
      expect(body.commands.some((c: { action: string }) => c.action === 'hangup')).toBe(false)
    })

    it('returns hangup on incorrect digits', async () => {
      const res = await adapter.handleCaptchaResponse({
        callSid: 'CA123',
        digits: '0000',
        expectedDigits: '5678',
        callerLanguage: 'en',
      })
      const body = JSON.parse(res.body)
      expect(body.commands[0]).toMatchObject({ action: 'speak', text: getPrompt('captchaFail', 'en') })
      expect(body.commands[0].text).not.toBe('')
      expect(body.commands.some((c: { action: string }) => c.action === 'hangup')).toBe(true)
      expect(body.commands.some((c: { action: string }) => c.action === 'queue')).toBe(false)
    })
  })

  describe('handleCallAnswered', () => {
    it('returns bridge command with recording enabled', async () => {
      const res = await adapter.handleCallAnswered({
        parentCallSid: 'CA-parent',
        callbackUrl: 'https://example.com',
        userPubkey: 'pk123',
      })
      const body = JSON.parse(res.body)
      expect(body.commands).toHaveLength(1)
      expect(body.commands[0]).toEqual({
        action: 'bridge',
        queueName: 'CA-parent',
        record: true,
      })
    })
  })

  describe('handleVoicemail', () => {
    it('returns record command with default maxDuration', async () => {
      const res = await adapter.handleVoicemail({
        callSid: 'CA123',
        callerLanguage: 'en',
        callbackUrl: 'https://example.com',
      })
      const body = JSON.parse(res.body)
      const record = body.commands.find((c: { action: string }) => c.action === 'record')
      expect(record).toBeDefined()
      expect(record.maxDuration).toBe(120)
      expect(record.finishOnKey).toBe('#')
      expect(record.callbackEvent).toBe('recording_complete')
    })

    it('uses custom maxRecordingSeconds', async () => {
      const res = await adapter.handleVoicemail({
        callSid: 'CA123',
        callerLanguage: 'en',
        callbackUrl: 'https://example.com',
        maxRecordingSeconds: 300,
      })
      const body = JSON.parse(res.body)
      const record = body.commands.find((c: { action: string }) => c.action === 'record')
      expect(record.maxDuration).toBe(300)
    })
  })

  describe('handleWaitMusic', () => {
    it('returns leave_queue when queueTime exceeds timeout', async () => {
      const res = await adapter.handleWaitMusic('en', undefined, 100, 90)
      const body = JSON.parse(res.body)
      expect(body.commands).toEqual([{ action: 'leave_queue' }])
    })

    it('returns hold music when within timeout', async () => {
      const res = await adapter.handleWaitMusic('en', undefined, 30, 90)
      const body = JSON.parse(res.body)
      expect(body.commands.length).toBe(1)
      expect(body.commands[0].action).toBe('speak')
    })

    it('uses custom audio URL for the wait message', async () => {
      const res = await adapter.handleWaitMusic('en', { 'waitMessage:en': 'https://example.com/hold.mp3' }, 30, 90)
      const body = JSON.parse(res.body)
      expect(body.commands[0].action).toBe('play')
      expect(body.commands[0].url).toBe('https://example.com/hold.mp3')
    })
  })

  describe('rejectCall', () => {
    it('returns hangup with reason', () => {
      const res = adapter.rejectCall()
      const body = JSON.parse(res.body)
      expect(body.commands).toEqual([{ action: 'hangup', reason: 'rejected' }])
    })
  })

  describe('handleVoicemailComplete', () => {
    it('returns thank you and hangup', () => {
      const res = adapter.handleVoicemailComplete('en')
      const body = JSON.parse(res.body)
      expect(body.commands).toHaveLength(2)
      expect(body.commands[0]).toMatchObject({ action: 'speak', text: getVoicemailThanks('en') })
      expect(body.commands[0].text).not.toBe('')
      expect(body.commands[1]).toEqual({ action: 'hangup' })
    })
  })

  describe('emptyResponse', () => {
    it('returns empty commands array', () => {
      const res = adapter.emptyResponse()
      const body = JSON.parse(res.body)
      expect(body.commands).toEqual([])
    })
  })
})

describe('FreeSwitchAdapter', () => {
  let adapter: FreeSwitchAdapter
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    adapter = new FreeSwitchAdapter(
      '+15551234567',
      'https://bridge.example.com',
      'bridge-secret',
      'https://api.example.com',
    )
    fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('getEndpointFormat', () => {
    it('returns sofia endpoint format', () => {
      expect(adapter.getEndpointFormat('+15552222222')).toBe('sofia/internal/+15552222222@trunk')
    })
  })

  describe('getPbxType', () => {
    it('returns freeswitch', () => {
      expect(adapter.getPbxType()).toBe('freeswitch')
    })
  })

  describe('handleLanguageMenu', () => {
    it('returns auto-redirect when only 1 language enabled', async () => {
      const res = await adapter.handleLanguageMenu({
        callSid: 'CA123',
        callerNumber: '+15559876543',
        hotlineName: 'Test Hotline',
        enabledLanguages: ['en'],
      })
      expect(res.contentType).toBe('text/xml')
      expect(res.body).toContain('caller_lang=en')
      expect(res.body).toContain('call_phase=language_selected')
      expect(res.body).toContain('/api/telephony/incoming')
    })

    it('appends hub param when hubId provided', async () => {
      const res = await adapter.handleLanguageMenu({
        callSid: 'CA123',
        callerNumber: '+15559876543',
        hotlineName: 'Test Hotline',
        enabledLanguages: ['en'],
        hubId: 'hub-123',
      })
      expect(res.body).toContain('hub=hub-123')
    })

    it('forces English instead of a menu for [en, es] — Flite has no Spanish voice (#657)', async () => {
      const res = await adapter.handleLanguageMenu({
        callSid: 'CA123',
        callerNumber: '+15559876543',
        hotlineName: 'Test Hotline',
        enabledLanguages: ['en', 'es'],
      })
      expect(res.contentType).toBe('text/xml')
      expect(res.body).not.toContain('<bind')
      expect(res.body).not.toContain('<speak')
      expect(res.body).toContain('caller_lang=en')
      expect(res.body).toContain('/api/telephony/incoming')
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
      expect(res.contentType).toBe('text/xml')
      expect(res.body).toContain('<hangup/>')
    })

    it('returns CAPTCHA bind when voiceCaptchaEnabled and captchaDigits provided', async () => {
      const res = await adapter.handleIncomingCall({
        callSid: 'CA123',
        callerNumber: '+15559876543',
        voiceCaptchaEnabled: true,
        rateLimited: false,
        callerLanguage: 'en',
        hotlineName: 'Test',
        captchaDigits: '1234',
      })
      expect(res.contentType).toBe('text/xml')
      expect(res.body).toContain('<bind')
      expect(res.body).toContain('/api/telephony/captcha')
      expect(res.body).toContain('value="captcha"')
    })

    it('returns park for normal call', async () => {
      const res = await adapter.handleIncomingCall({
        callSid: 'CA123',
        callerNumber: '+15559876543',
        voiceCaptchaEnabled: false,
        rateLimited: false,
        callerLanguage: 'en',
        hotlineName: 'Test',
      })
      expect(res.contentType).toBe('text/xml')
      expect(res.body).toContain('<execute application="park"/>')
      expect(res.body).toContain('value="queue"')
      expect(res.body).toContain('value="CA123"')
    })

    it('uses custom audio URLs when provided', async () => {
      const res = await adapter.handleIncomingCall({
        callSid: 'CA123',
        callerNumber: '+15559876543',
        voiceCaptchaEnabled: false,
        rateLimited: false,
        callerLanguage: 'en',
        hotlineName: 'Test',
        audioUrls: { 'greeting:en': 'https://example.com/greeting.wav', 'pleaseHold:en': 'https://example.com/hold.wav' },
      })
      expect(res.body).toContain('playback file="https://example.com/greeting.wav"')
      expect(res.body).toContain('playback file="https://example.com/hold.wav"')
    })
  })

  describe('handleCaptchaResponse', () => {
    it('returns park on correct digits', async () => {
      const res = await adapter.handleCaptchaResponse({
        callSid: 'CA123',
        digits: '5678',
        expectedDigits: '5678',
        callerLanguage: 'en',
      })
      expect(res.contentType).toBe('text/xml')
      expect(res.body).toContain('<execute application="park"/>')
      expect(res.body).not.toContain('<hangup/>')
    })

    it('returns hangup on incorrect digits', async () => {
      const res = await adapter.handleCaptchaResponse({
        callSid: 'CA123',
        digits: '0000',
        expectedDigits: '5678',
        callerLanguage: 'en',
      })
      expect(res.contentType).toBe('text/xml')
      expect(res.body).toContain('<hangup/>')
      expect(res.body).not.toContain('<execute application="park"/>')
    })
  })

  describe('handleCallAnswered', () => {
    it('returns intercept command', async () => {
      const res = await adapter.handleCallAnswered({
        parentCallSid: 'CA-parent',
        callbackUrl: 'https://example.com',
        userPubkey: 'pk123',
      })
      expect(res.contentType).toBe('text/xml')
      expect(res.body).toContain('<execute application="intercept"')
      expect(res.body).toContain('CA-parent')
    })
  })

  describe('handleVoicemail', () => {
    it('returns record command with default limit', async () => {
      const res = await adapter.handleVoicemail({
        callSid: 'CA123',
        callerLanguage: 'en',
        callbackUrl: 'https://example.com',
      })
      expect(res.contentType).toBe('text/xml')
      expect(res.body).toContain('<record')
      expect(res.body).toContain('limit="120"')
      expect(res.body).toContain('/api/telephony/voicemail-recording')
    })

    it('uses custom maxRecordingSeconds', async () => {
      const res = await adapter.handleVoicemail({
        callSid: 'CA123',
        callerLanguage: 'en',
        callbackUrl: 'https://example.com',
        maxRecordingSeconds: 300,
      })
      expect(res.body).toContain('limit="300"')
    })
  })

  describe('handleWaitMusic', () => {
    it('returns transfer to voicemail when queueTime exceeds timeout', async () => {
      const res = await adapter.handleWaitMusic('en', undefined, 100, 90)
      expect(res.contentType).toBe('text/xml')
      expect(res.body).toContain('<execute application="transfer"')
      expect(res.body).toContain('voicemail')
    })

    it('returns wait message when within timeout', async () => {
      const res = await adapter.handleWaitMusic('en', undefined, 30, 90)
      expect(res.contentType).toBe('text/xml')
      expect(res.body).toContain('<speak')
    })

    it('uses custom audio URL for wait music', async () => {
      const res = await adapter.handleWaitMusic('en', { 'waitMessage:en': 'https://example.com/wait.mp3' }, 30, 90)
      expect(res.body).toContain('playback file="https://example.com/wait.mp3"')
    })
  })

  describe('rejectCall', () => {
    it('returns hangup with CALL_REJECTED cause', () => {
      const res = adapter.rejectCall()
      expect(res.contentType).toBe('text/xml')
      expect(res.body).toContain('cause="CALL_REJECTED"')
    })
  })

  describe('handleVoicemailComplete', () => {
    it('returns thank you and hangup', () => {
      const res = adapter.handleVoicemailComplete('en')
      expect(res.contentType).toBe('text/xml')
      // The voicemail thank-you, not the CAPTCHA "please hold while we connect you".
      expect(res.body).toContain(`>${getVoicemailThanks('en')}</speak>`)
      expect(res.body).toContain('<hangup/>')
    })
  })

  describe('emptyResponse', () => {
    it('returns empty XML document', () => {
      const res = adapter.emptyResponse()
      expect(res.contentType).toBe('text/xml')
      expect(res.body).toContain('<document type="xml/freeswitch-httapi">')
    })
  })
})
