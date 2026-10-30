import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { TelnyxAdapter } from '@worker/telephony/telnyx'
import { holdMusicEntry } from '@worker/telephony/hold-music'

const HOLD_ORIGIN = 'https://hotline.example.org'
const HOLD = holdMusicEntry(HOLD_ORIGIN)
const HOLD_URL = `${HOLD_ORIGIN}/api/ivr-audio/hold-music.wav`

describe('TelnyxAdapter', () => {
  let adapter: TelnyxAdapter
  let fetchSpy: ReturnType<typeof vi.spyOn>
  let subtleVerifySpy: ReturnType<typeof vi.spyOn>

  const API_KEY = 'test-api-key'
  const CONNECTION_ID = 'conn-123'
  const PHONE_NUMBER = '+15551234567'

  beforeEach(() => {
    adapter = new TelnyxAdapter(API_KEY, CONNECTION_ID, PHONE_NUMBER)
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200 }),
    )
    subtleVerifySpy = vi.spyOn(crypto.subtle, 'verify').mockResolvedValue(true)
    vi.spyOn(crypto.subtle, 'importKey').mockResolvedValue({} as CryptoKey)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function assertCommandFetch(
    callControlId: string,
    action: string,
    body?: Record<string, unknown>,
  ) {
    const url = `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/${action}`
    const matchingCall = fetchSpy.mock.calls.find((call: unknown[]) => call[0] === url)
    expect(matchingCall, `expected fetch to be called for ${action} on ${callControlId}`).toBeTruthy()

    const init = matchingCall![1] as RequestInit
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`)
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')

    if (body) {
      if (typeof body === 'object' && Object.keys(body).length === 0) {
        expect(init.body).toBe('{}')
      } else if (body && typeof body === 'object' && Object.keys(body).length > 0) {
        const actualBody = JSON.parse(init.body as string)
        for (const [key, value] of Object.entries(body)) {
          if (value && typeof value === 'object' && 'asymmetricMatch' in value) {
            expect(actualBody).toHaveProperty(key)
          } else {
            expect(actualBody[key]).toEqual(value)
          }
        }
      }
    } else {
      expect(init.body).toBe('{}')
    }
  }

  function assertCommandFetchAnyBody(callControlId: string, action: string) {
    const url = `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/${action}`
    const matchingCall = fetchSpy.mock.calls.find((call: unknown[]) => call[0] === url)
    expect(matchingCall, `expected fetch to be called for ${action} on ${callControlId}`).toBeTruthy()

    const init = matchingCall![1] as RequestInit
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`)
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect(init.body).toBeTruthy()
    const parsed = JSON.parse(init.body as string)
    expect(typeof parsed).toBe('object')
  }

  describe('handleLanguageMenu', () => {
    it('answers call and issues gather_using_speak for multiple languages', async () => {
      const result = await adapter.handleLanguageMenu({
        callSid: 'call-001',
        callerNumber: '+15559876543',
        hotlineName: 'Test Hotline',
        enabledLanguages: ['en', 'es'],
        hubId: 'hub-1',
      })

      expect(result.contentType).toBe('application/json')
      expect(result.body).toBe('{}')
      assertCommandFetchAnyBody('call-001', 'answer')
      assertCommandFetchAnyBody('call-001', 'gather_using_speak')
    })

    it('skips menu for single language and issues speak', async () => {
      const result = await adapter.handleLanguageMenu({
        callSid: 'call-002',
        callerNumber: '+15559876543',
        hotlineName: 'Test Hotline',
        enabledLanguages: ['en'],
        hubId: 'hub-1',
      })

      expect(result.body).toBe('{}')
      assertCommandFetchAnyBody('call-002', 'answer')
      assertCommandFetchAnyBody('call-002', 'speak')
      expect(fetchSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('/actions/gather_using_speak'),
        expect.anything(),
      )
    })
  })

  describe('handleIncomingCall', () => {
    it('plays greeting + hold music for normal call', async () => {
      const result = await adapter.handleIncomingCall({
        callRecordingEnabled: false,
        callSid: 'call-003',
        callerNumber: '+15559876543',
        voiceCaptchaEnabled: false,
        rateLimited: false,
        callerLanguage: 'en',
        hotlineName: 'Test Hotline',
        hubId: 'hub-1',
        audioUrls: HOLD,
      })

      expect(result.body).toBe('{}')
      assertCommandFetchAnyBody('call-003', 'speak')
      assertCommandFetch('call-003', 'playback_start', { audio_url: HOLD_URL, loop: 'infinity' })
    })

    it('hangs up for rate-limited calls', async () => {
      const result = await adapter.handleIncomingCall({
        callRecordingEnabled: false,
        callSid: 'call-004',
        callerNumber: '+15559876543',
        voiceCaptchaEnabled: false,
        rateLimited: true,
        callerLanguage: 'en',
        hotlineName: 'Test Hotline',
      })

      expect(result.body).toBe('{}')
      assertCommandFetchAnyBody('call-004', 'speak')
      assertCommandFetch('call-004', 'hangup', {})
    })

    it('plays captcha prompt when captcha enabled', async () => {
      const result = await adapter.handleIncomingCall({
        callRecordingEnabled: false,
        callSid: 'call-005',
        callerNumber: '+15559876543',
        voiceCaptchaEnabled: true,
        rateLimited: false,
        callerLanguage: 'en',
        hotlineName: 'Test Hotline',
        captchaDigits: '1234',
      })

      expect(result.body).toBe('{}')
      assertCommandFetchAnyBody('call-005', 'speak')
      assertCommandFetchAnyBody('call-005', 'gather_using_speak')
    })
  })

  describe('handleCaptchaResponse', () => {
    it('queues caller on pass', async () => {
      const result = await adapter.handleCaptchaResponse({
        outcome: 'pass', callSid: 'call-006', callerLanguage: 'en', hubId: 'hub-1', audioUrls: HOLD,
      })

      expect(result.body).toBe('{}')
      assertCommandFetchAnyBody('call-006', 'speak')
      assertCommandFetch('call-006', 'playback_start', { audio_url: HOLD_URL, loop: 'infinity' })
    })

    it('gathers again on retry', async () => {
      const result = await adapter.handleCaptchaResponse({
        outcome: 'retry', digitsToSpeak: '1234', round: 1, callSid: 'call-007', callerLanguage: 'en',
      })

      expect(result.body).toBe('{}')
      assertCommandFetchAnyBody('call-007', 'gather_using_speak')
    })
  })

  // #1505 — provider-side recording is opt-in per hub and OFF by default.
  describe('handleCallAnswered', () => {
    /** Did the adapter ask Telnyx to start recording this call at all? */
    function recordStartRequested(callControlId: string): boolean {
      const url = `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/record_start`
      return fetchSpy.mock.calls.some((call: unknown[]) => call[0] === url)
    }

    it('bridges the call but never issues record_start when recording is off', async () => {
      const result = await adapter.handleCallAnswered({
        recordCall: false,
        parentCallSid: 'call-008',
        callbackUrl: 'https://example.com',
        userPubkey: 'pubkey-1',
        hubId: 'hub-1',
      })

      expect(result.body).toBe('{}')
      assertCommandFetch('call-008', 'bridge', {
        call_control_id: 'call-008',
      })
      // No record_start command means Telnyx never writes the audio to disk.
      expect(recordStartRequested('call-008')).toBe(false)
    })

    it('bridges the call and starts recording when recording is on', async () => {
      const result = await adapter.handleCallAnswered({
        recordCall: true,
        parentCallSid: 'call-008',
        callbackUrl: 'https://example.com',
        userPubkey: 'pubkey-1',
        hubId: 'hub-1',
      })

      expect(result.body).toBe('{}')
      assertCommandFetch('call-008', 'bridge', {
        call_control_id: 'call-008',
      })
      assertCommandFetchAnyBody('call-008', 'record_start')
    })
  })

  describe('handleVoicemail', () => {
    it('speaks prompt and starts recording', async () => {
      const result = await adapter.handleVoicemail({
        callSid: 'call-009',
        callerLanguage: 'en',
        callbackUrl: 'https://example.com',
        hubId: 'hub-1',
        maxRecordingSeconds: 60,
      })

      expect(result.body).toBe('{}')
      assertCommandFetchAnyBody('call-009', 'speak')
      assertCommandFetch('call-009', 'record_start', {
        format: 'mp3',
        play_beep: true,
        max_length_secs: 60,
      })
    })
  })

  describe('handleWaitMusic', () => {
    it('returns empty response when under timeout', async () => {
      const result = await adapter.handleWaitMusic('en', undefined, 30, 90)
      expect(result.body).toBe('{}')
    })

    it('returns leave true when queueTime exceeds timeout', async () => {
      const result = await adapter.handleWaitMusic('en', undefined, 95, 90)
      expect(result.body).toBe(JSON.stringify({ leave: true }))
    })

    it('uses default timeout of 90', async () => {
      const result = await adapter.handleWaitMusic('en', undefined, 100)
      expect(result.body).toBe(JSON.stringify({ leave: true }))
    })
  })

  describe('hangupCall', () => {
    it('issues hangup command', async () => {
      await adapter.hangupCall('call-010')
      assertCommandFetch('call-010', 'hangup', {})
    })
  })

  describe('ringVolunteers', () => {
    it('creates outbound calls with correct parameters', async () => {
      fetchSpy.mockResolvedValue(
        new Response(
          JSON.stringify({
            data: {
              call_control_id: 'cc-vol-1',
              call_leg_id: 'leg-1',
              call_session_id: 'sess-1',
            },
          }),
          { status: 200 },
        ),
      )

      const result = await adapter.ringVolunteers({
        callSid: 'call-parent',
        callerNumber: '+15559876543',
        volunteers: [
          { phone: '+15551111111', callToken: 'token-a' },
          { phone: '+15552222222', callToken: 'token-b' },
        ],
        callbackUrl: 'https://example.com/cb',
        hubId: 'hub-1',
      })

      expect(result).toEqual(['cc-vol-1'])
      expect(fetchSpy).toHaveBeenCalledTimes(2)

      const calls = fetchSpy.mock.calls.filter((call: unknown[]) =>
        (call[0] as string).includes('/v2/calls'),
      )
      expect(calls).toHaveLength(2)

      for (const [, init] of calls) {
        const body = JSON.parse((init as RequestInit).body as string)
        expect(body.from).toBe(PHONE_NUMBER)
        expect(body.connection_id).toBe(CONNECTION_ID)
        expect(body.webhook_url_method).toBe('POST')
        expect(body.timeout_secs).toBe(30)
        expect(body.client_state).toBeTruthy()
      }
    })

    it('returns only successful call_control_ids', async () => {
      fetchSpy
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              data: {
                call_control_id: 'cc-ok',
                call_leg_id: 'leg-1',
                call_session_id: 'sess-1',
              },
            }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(
          new Response('Bad Request', { status: 400 }),
        )

      const result = await adapter.ringVolunteers({
        callSid: 'call-parent',
        callerNumber: '+15559876543',
        volunteers: [
          { phone: '+15551111111', callToken: 'token-a' },
          { phone: '+15552222222', callToken: 'token-b' },
        ],
        callbackUrl: 'https://example.com/cb',
      })

      expect(result).toEqual(['cc-ok'])
    })
  })

  describe('cancelRinging', () => {
    it('hangs up all calls except the answered one', async () => {
      await adapter.cancelRinging(['call-a', 'call-b', 'call-c'], 'call-b')

      assertCommandFetch('call-a', 'hangup', {})
      assertCommandFetch('call-c', 'hangup', {})

      expect(fetchSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('/actions/hangup'),
        expect.objectContaining({
          body: expect.stringContaining('call-b'),
        }),
      )
    })

    it('hangs up all calls when no exceptSid', async () => {
      await adapter.cancelRinging(['call-a', 'call-b'])
      assertCommandFetch('call-a', 'hangup', {})
      assertCommandFetch('call-b', 'hangup', {})
    })
  })

  describe('getCallRecording', () => {
    it('returns null (stub)', async () => {
      const result = await adapter.getCallRecording('call-011')
      expect(result).toBeNull()
    })
  })

  // The handle is the recorded call LEG: call.recording.saved carries no
  // recording id, and its URLs expire in ten minutes (#2297).
  describe('getRecordingAudio', () => {
    it('lists the leg\'s recordings, then fetches the first one\'s audio', async () => {
      const buffer = new ArrayBuffer(8)
      fetchSpy
        .mockResolvedValueOnce(Response.json({ data: [{ id: 'rec-1', call_leg_id: 'leg-1', download_urls: { mp3: 'https://recording.url/audio.mp3' } }] }))
        .mockResolvedValueOnce(new Response(buffer, { status: 200 }))

      const result = await adapter.getRecordingAudio('leg-1')
      expect(result).toStrictEqual(buffer)
      expect(String(fetchSpy.mock.calls[0]![0])).toBe('https://api.telnyx.com/v2/recordings?filter[call_leg_id]=leg-1&page[size]=50')
      expect(fetchSpy).toHaveBeenLastCalledWith(
        'https://recording.url/audio.mp3',
        expect.objectContaining({
          headers: { Authorization: `Bearer ${API_KEY}` },
        }),
      )
    })

    it('returns null on error', async () => {
      fetchSpy.mockResolvedValue(new Response('Not Found', { status: 404 }))
      const result = await adapter.getRecordingAudio('leg-1')
      expect(result).toBeNull()
    })
  })

  // #2297: provider-side deletion — fail loudly, never a silent no-op.
  describe('deleteRecording', () => {
    it('deletes every recording of the leg', async () => {
      fetchSpy
        .mockResolvedValueOnce(Response.json({ data: [{ id: 'rec-1' }, { id: 'rec-2' }] }))
        .mockResolvedValueOnce(Response.json({ data: {} }))
        .mockResolvedValueOnce(Response.json({ data: {} }))
      await expect(adapter.deleteRecording('leg-1')).resolves.toBeUndefined()
      const deletes = (fetchSpy.mock.calls as Array<[unknown, RequestInit | undefined]>).filter(c => c[1]?.method === 'DELETE').map(c => String(c[0]))
      expect(deletes).toEqual(['https://api.telnyx.com/v2/recordings/rec-1', 'https://api.telnyx.com/v2/recordings/rec-2'])
    })

    it('resolves when the leg has no recording left', async () => {
      fetchSpy.mockResolvedValueOnce(Response.json({ data: [] }))
      await expect(adapter.deleteRecording('leg-1')).resolves.toBeUndefined()
    })

    it('rejects when the recordings cannot be listed', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
      await expect(adapter.deleteRecording('leg-1')).rejects.toThrow(/Telnyx recording deletion failed: 401/)
    })

    it('rejects when Telnyx refuses a deletion', async () => {
      fetchSpy
        .mockResolvedValueOnce(Response.json({ data: [{ id: 'rec-1' }] }))
        .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      await expect(adapter.deleteRecording('leg-1')).rejects.toThrow(/Telnyx recording deletion failed: 500/)
    })
  })

  describe('enforceRecordingPosture (#2309)', () => {
    function route(map: Record<string, Response>) {
      fetchSpy.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
        const key = `${init?.method ?? 'GET'} ${String(url)}`
        for (const [prefix, res] of Object.entries(map)) {
          if (key.startsWith(prefix)) return res.clone()
        }
        return new Response('unexpected', { status: 599 })
      })
    }
    const number = { 'GET https://api.telnyx.com/v2/phone_numbers?': Response.json({ data: [{ id: 'pn-1' }] }) }

    it('PATCHes inbound recording off on a number that records', async () => {
      route({
        ...number,
        'GET https://api.telnyx.com/v2/phone_numbers/pn-1/voice': Response.json({ data: { call_recording: { inbound_call_recording_enabled: true } } }),
        'PATCH https://api.telnyx.com/v2/phone_numbers/pn-1/voice': Response.json({ data: {} }),
      })
      const actions = await adapter.enforceRecordingPosture()
      expect(actions.map(a => [a.setting, a.outcome])).toEqual([['recording', 'disabled'], ['transcription', 'not-settable']])
      const patch = fetchSpy.mock.calls.find((c: unknown[]) => (c[1] as RequestInit | undefined)?.method === 'PATCH')!
      expect(JSON.parse(String((patch[1] as RequestInit).body))).toEqual({ call_recording: { inbound_call_recording_enabled: false } })
    })

    it('writes nothing when the number already does not record', async () => {
      route({
        ...number,
        'GET https://api.telnyx.com/v2/phone_numbers/pn-1/voice': Response.json({ data: { call_recording: { inbound_call_recording_enabled: false } } }),
      })
      const [recording] = await adapter.enforceRecordingPosture()
      expect(recording.outcome).toBe('already-off')
      expect(fetchSpy.mock.calls.some((c: unknown[]) => (c[1] as RequestInit | undefined)?.method === 'PATCH')).toBe(false)
    })

    it('reports a refused PATCH as failed, never as disabled', async () => {
      route({
        ...number,
        'GET https://api.telnyx.com/v2/phone_numbers/pn-1/voice': Response.json({ data: { call_recording: { inbound_call_recording_enabled: true } } }),
        'PATCH https://api.telnyx.com/v2/phone_numbers/pn-1/voice': new Response('', { status: 422 }),
      })
      const [recording] = await adapter.enforceRecordingPosture()
      expect(recording).toMatchObject({ outcome: 'failed', reason: expect.stringMatching(/Telnyx answered 422/) })
    })
  })

  describe('probeRecordingPosture', () => {
    const context = (tracked: string[]) => ({ trackedRecordings: async (h: string[]) => new Set(h.filter(x => tracked.includes(x))) })
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString()

    function route(map: Record<string, Response>) {
      fetchSpy.mockImplementation(async (url: string | URL | Request) => {
        const u = String(url)
        for (const [prefix, res] of Object.entries(map)) {
          if (u.startsWith(prefix)) return res.clone()
        }
        return new Response('unexpected', { status: 599 })
      })
    }

    it('reports recording on when the number records every inbound call', async () => {
      route({
        'https://api.telnyx.com/v2/phone_numbers?': Response.json({ data: [{ id: 'pn-1' }] }),
        'https://api.telnyx.com/v2/phone_numbers/pn-1/voice': Response.json({ data: { call_recording: { inbound_call_recording_enabled: true } } }),
        'https://api.telnyx.com/v2/recordings?': Response.json({ data: [] }),
        'https://api.telnyx.com/v2/recording_transcriptions': Response.json({ data: [] }),
      })
      const posture = await adapter.probeRecordingPosture(context([]))
      expect(posture.recording).toMatchObject({ state: 'on' })
      expect(posture.transcription.state).toBe('off')
    })

    it('reports recording off only when the setting AND the inventory say so', async () => {
      route({
        'https://api.telnyx.com/v2/phone_numbers?': Response.json({ data: [{ id: 'pn-1' }] }),
        'https://api.telnyx.com/v2/phone_numbers/pn-1/voice': Response.json({ data: { call_recording: { inbound_call_recording_enabled: false } } }),
        'https://api.telnyx.com/v2/recordings?': Response.json({ data: [{ id: 'r', call_leg_id: 'leg-1', created_at: old }] }),
        'https://api.telnyx.com/v2/recording_transcriptions': Response.json({ data: [] }),
      })
      const posture = await adapter.probeRecordingPosture(context(['leg-1']))
      expect(posture.recording.state).toBe('off')
    })

    it('reports unknown — never off — when the number settings cannot be read', async () => {
      route({
        'https://api.telnyx.com/v2/phone_numbers?': new Response('', { status: 403 }),
        'https://api.telnyx.com/v2/recordings?': Response.json({ data: [] }),
        'https://api.telnyx.com/v2/recording_transcriptions': new Response('', { status: 403 }),
      })
      const posture = await adapter.probeRecordingPosture(context([]))
      expect(posture.recording).toMatchObject({ state: 'unknown' })
      expect(posture.transcription).toMatchObject({ state: 'unknown' })
    })

    it('reports transcription on when Telnyx holds a transcription', async () => {
      route({
        'https://api.telnyx.com/v2/phone_numbers?': Response.json({ data: [{ id: 'pn-1' }] }),
        'https://api.telnyx.com/v2/phone_numbers/pn-1/voice': Response.json({ data: { call_recording: { inbound_call_recording_enabled: false } } }),
        'https://api.telnyx.com/v2/recordings?': Response.json({ data: [] }),
        'https://api.telnyx.com/v2/recording_transcriptions': Response.json({ data: [{ id: 't' }] }),
      })
      const posture = await adapter.probeRecordingPosture(context([]))
      expect(posture.transcription).toMatchObject({ state: 'on' })
    })
  })

  describe('validateWebhook', () => {
    it('returns true for valid signature and timestamp', async () => {
      const now = Math.floor(Date.now() / 1000)
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        headers: {
          'telnyx-signature-ed25519': btoa('valid-sig'),
          'telnyx-timestamp': String(now),
          'Content-Type': 'application/json',
        },
        body: '{}',
      })

      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: { public_key: btoa('pubkey-bytes') } }),
          { status: 200 },
        ),
      )

      const result = await adapter.validateWebhook(request)
      expect(result).toBe(true)
    })

    it('returns false when crypto.subtle.verify returns false', async () => {
      const now = Math.floor(Date.now() / 1000)
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        headers: {
          'telnyx-signature-ed25519': btoa('bad-sig'),
          'telnyx-timestamp': String(now),
          'Content-Type': 'application/json',
        },
        body: '{}',
      })

      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: { public_key: btoa('pubkey-bytes') } }),
          { status: 200 },
        ),
      )
      subtleVerifySpy.mockResolvedValueOnce(false)

      const result = await adapter.validateWebhook(request)
      expect(result).toBe(false)
    })

    it('rejects expired timestamps (> 300 seconds)', async () => {
      const oldTs = Math.floor(Date.now() / 1000) - 400
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        headers: {
          'telnyx-signature-ed25519': btoa('valid-sig'),
          'telnyx-timestamp': String(oldTs),
          'Content-Type': 'application/json',
        },
        body: '{}',
      })

      const result = await adapter.validateWebhook(request)
      expect(result).toBe(false)
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(subtleVerifySpy).not.toHaveBeenCalled()
    })

    it('rejects missing signature header', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        headers: {
          'telnyx-timestamp': String(Math.floor(Date.now() / 1000)),
          'Content-Type': 'application/json',
        },
        body: '{}',
      })

      const result = await adapter.validateWebhook(request)
      expect(result).toBe(false)
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('rejects missing timestamp header', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        headers: {
          'telnyx-signature-ed25519': btoa('valid-sig'),
          'Content-Type': 'application/json',
        },
        body: '{}',
      })

      const result = await adapter.validateWebhook(request)
      expect(result).toBe(false)
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('rejects invalid timestamp (NaN)', async () => {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        headers: {
          'telnyx-signature-ed25519': btoa('valid-sig'),
          'telnyx-timestamp': 'not-a-number',
          'Content-Type': 'application/json',
        },
        body: '{}',
      })

      const result = await adapter.validateWebhook(request)
      expect(result).toBe(false)
    })

    it('rejects invalid signature after verification', async () => {
      const now = Math.floor(Date.now() / 1000)
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        headers: {
          'telnyx-signature-ed25519': btoa('invalid-sig'),
          'telnyx-timestamp': String(now),
          'Content-Type': 'application/json',
        },
        body: '{}',
      })

      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: { public_key: btoa('pubkey-bytes') } }),
          { status: 200 },
        ),
      )
      subtleVerifySpy.mockResolvedValueOnce(false)

      const result = await adapter.validateWebhook(request)
      expect(result).toBe(false)
    })

    it('caches public key and reuses it', async () => {
      const now = Math.floor(Date.now() / 1000)
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        headers: {
          'telnyx-signature-ed25519': btoa('sig-1'),
          'telnyx-timestamp': String(now),
          'Content-Type': 'application/json',
        },
        body: '{}',
      })

      fetchSpy.mockResolvedValue(
        new Response(
          JSON.stringify({ data: { public_key: btoa('pubkey-bytes') } }),
          { status: 200 },
        ),
      )

      // First validation
      await adapter.validateWebhook(request)
      expect(fetchSpy).toHaveBeenCalledTimes(1)

      const request2 = new Request('https://example.com/webhook', {
        method: 'POST',
        headers: {
          'telnyx-signature-ed25519': btoa('sig-2'),
          'telnyx-timestamp': String(now),
          'Content-Type': 'application/json',
        },
        body: '{}',
      })
      await adapter.validateWebhook(request2)
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })
  })

  function makeWebhookRequest(payload: unknown): Request {
    return new Request('https://example.com/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  }

  describe('parseIncomingWebhook', () => {
    it('parses call.initiated webhook', async () => {
      const request = makeWebhookRequest({
        data: {
          event_type: 'call.initiated',
          payload: {
            call_control_id: 'call-012',
            from: '+15559876543',
            to: '+15551234567',
          },
        },
      })

      const result = await adapter.parseIncomingWebhook(request)
      expect(result.callSid).toBe('call-012')
      expect(result.callerNumber).toBe('+15559876543')
      expect(result.calledNumber).toBe('+15551234567')
    })

    it('handles missing fields gracefully', async () => {
      const request = makeWebhookRequest({ data: {} })
      const result = await adapter.parseIncomingWebhook(request)
      expect(result.callSid).toBe('')
      expect(result.callerNumber).toBe('')
      expect(result.calledNumber).toBeUndefined()
    })
  })

  describe('parseLanguageWebhook', () => {
    it('parses language selection with digits', async () => {
      const clientState = btoa(JSON.stringify({ callSid: 'call-013', hubId: 'hub-1' }))
      const request = makeWebhookRequest({
        data: {
          event_type: 'call.gather.ended',
          payload: {
            call_control_id: 'call-013',
            from: '+15559876543',
            digits: '1',
            client_state: clientState,
          },
        },
      })

      const result = await adapter.parseLanguageWebhook(request)
      expect(result.callSid).toBe('call-013')
      expect(result.callerNumber).toBe('+15559876543')
      expect(result.digits).toBe('1')
    })

    it('falls back to client_state callSid when payload missing', async () => {
      const clientState = btoa(JSON.stringify({ callSid: 'call-014' }))
      const request = makeWebhookRequest({
        data: {
          payload: {
            from: '+15559876543',
            digits: '2',
            client_state: clientState,
          },
        },
      })

      const result = await adapter.parseLanguageWebhook(request)
      expect(result.callSid).toBe('call-014')
      expect(result.digits).toBe('2')
    })
  })

  describe('parseCaptchaWebhook', () => {
    it('parses captcha digits', async () => {
      const request = makeWebhookRequest({
        data: {
          payload: {
            digits: '1234',
            from: '+15559876543',
          },
        },
      })

      const result = await adapter.parseCaptchaWebhook(request)
      expect(result.digits).toBe('1234')
      expect(result.callerNumber).toBe('+15559876543')
    })
  })

  describe('parseCallStatusWebhook', () => {
    it('returns initiated for call.initiated', async () => {
      const request = makeWebhookRequest({
        data: { event_type: 'call.initiated', payload: {} },
      })
      const result = await adapter.parseCallStatusWebhook(request)
      expect(result.status).toBe('initiated')
    })

    it('returns answered for call.answered', async () => {
      const request = makeWebhookRequest({
        data: { event_type: 'call.answered', payload: {} },
      })
      const result = await adapter.parseCallStatusWebhook(request)
      expect(result.status).toBe('answered')
    })

    it('maps hangup causes correctly', async () => {
      const causes: Array<{ cause: string; expected: string }> = [
        { cause: 'normal_clearing', expected: 'completed' },
        { cause: 'originator_cancel', expected: 'failed' },
        { cause: 'timeout', expected: 'no-answer' },
        { cause: 'busy', expected: 'busy' },
        { cause: 'user_busy', expected: 'busy' },
        { cause: 'call_rejected', expected: 'failed' },
        { cause: 'no_user_response', expected: 'no-answer' },
        { cause: 'no_answer', expected: 'no-answer' },
        { cause: 'subscriber_absent', expected: 'no-answer' },
        { cause: 'normal_unspecified', expected: 'completed' },
        { cause: 'unallocated_number', expected: 'failed' },
        { cause: 'network_out_of_order', expected: 'failed' },
        { cause: 'recovery_on_timer_expire', expected: 'no-answer' },
        { cause: 'interworking', expected: 'failed' },
        { cause: 'unknown_cause', expected: 'failed' },
      ]

      for (const { cause, expected } of causes) {
        const request = makeWebhookRequest({
          data: {
            event_type: 'call.hangup',
            payload: { hangup_cause: cause },
          },
        })
        const result = await adapter.parseCallStatusWebhook(request)
        expect(result.status).toBe(expected)
      }
    })

    it('returns failed for unknown event types', async () => {
      const request = makeWebhookRequest({
        data: { event_type: 'call.unknown', payload: {} },
      })
      const result = await adapter.parseCallStatusWebhook(request)
      expect(result.status).toBe('failed')
    })
  })

  describe('parseQueueWaitWebhook', () => {
    it('returns queueTime 0', async () => {
      const request = makeWebhookRequest({})
      const result = await adapter.parseQueueWaitWebhook(request)
      expect(result.queueTime).toBe(0)
    })
  })

  describe('parseQueueExitWebhook', () => {
    it('returns bridged for call.bridged', async () => {
      const request = makeWebhookRequest({
        data: { event_type: 'call.bridged', payload: {} },
      })
      const result = await adapter.parseQueueExitWebhook(request)
      expect(result.result).toBe('bridged')
    })

    it('returns hangup for normal clearing', async () => {
      const request = makeWebhookRequest({
        data: {
          event_type: 'call.hangup',
          payload: { hangup_cause: 'normal_clearing' },
        },
      })
      const result = await adapter.parseQueueExitWebhook(request)
      expect(result.result).toBe('hangup')
    })

    it('returns hangup for originator cancel', async () => {
      const request = makeWebhookRequest({
        data: {
          event_type: 'call.hangup',
          payload: { hangup_cause: 'originator_cancel' },
        },
      })
      const result = await adapter.parseQueueExitWebhook(request)
      expect(result.result).toBe('hangup')
    })

    it('returns error for other hangup causes', async () => {
      const request = makeWebhookRequest({
        data: {
          event_type: 'call.hangup',
          payload: { hangup_cause: 'timeout' },
        },
      })
      const result = await adapter.parseQueueExitWebhook(request)
      expect(result.result).toBe('error')
    })

    it('returns error for unknown event types', async () => {
      const request = makeWebhookRequest({
        data: { event_type: 'call.random', payload: {} },
      })
      const result = await adapter.parseQueueExitWebhook(request)
      expect(result.result).toBe('error')
    })
  })

  describe('parseRecordingWebhook', () => {
    it('returns completed with mp3 URL', async () => {
      const request = makeWebhookRequest({
        data: {
          payload: {
            call_control_id: 'call-015',
            call_leg_id: 'leg-015',
            recording_urls: { mp3: 'https://rec.url/file.mp3' },
          },
        },
      })

      const result = await adapter.parseRecordingWebhook(request)
      expect(result.status).toBe('completed')
      // The leg, not the URL: the URL expires in ten minutes and cannot address a deletion.
      expect(result.recordingSid).toBe('leg-015')
      expect(result.callSid).toBe('call-015')
    })

    it('returns failed when no mp3 URL', async () => {
      const request = makeWebhookRequest({
        data: {
          payload: {
            call_control_id: 'call-016',
            recording_urls: {},
          },
        },
      })

      const result = await adapter.parseRecordingWebhook(request)
      expect(result.status).toBe('failed')
      expect(result.recordingSid).toBeUndefined()
    })

    it('returns failed when recording_urls missing', async () => {
      const request = makeWebhookRequest({
        data: { payload: { call_control_id: 'call-017' } },
      })

      const result = await adapter.parseRecordingWebhook(request)
      expect(result.status).toBe('failed')
    })
  })
})

describe('TelnyxAdapter.webhookNamesOwnAccount (#2330)', () => {
  const adapter = new TelnyxAdapter('test-api-key', 'conn-123', '+15551234567')
  const json = (body: string) => new Request('http://localhost/api/telephony/incoming', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })

  it('reads the provider-populated connection_id; a malformed body is not ours', async () => {
    const event = (connection_id: string) => JSON.stringify({ data: { event_type: 'call.initiated', payload: { connection_id } } })
    expect(await adapter.webhookNamesOwnAccount(json(event('conn-123')))).toBe(true)
    expect(await adapter.webhookNamesOwnAccount(json(event('conn-999')))).toBe(false)
    expect(await adapter.webhookNamesOwnAccount(json('[]'))).toBe(false)
    expect(await adapter.webhookNamesOwnAccount(json('{not json'))).toBe(false)
  })
})
