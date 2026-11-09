import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { TelnyxAdapter, TELNYX_VOICES } from '@worker/telephony/telnyx'
import { AllDialsFailedError } from '@worker/telephony/adapter'
import { holdMusicEntry } from '@worker/telephony/hold-music'
import { makeTelnyxSigner, publicKeyResponse, type TelnyxSigner } from '../helpers/telnyx-signing'

const HOLD_ORIGIN = 'https://hotline.example.org'
const HOLD = holdMusicEntry(HOLD_ORIGIN)
const HOLD_URL = `${HOLD_ORIGIN}/api/ivr-audio/hold-music.wav`

const API_KEY = 'test-api-key'
const CONNECTION_ID = 'conn-123'
const PHONE_NUMBER = '+15551234567'
const BASE = 'https://hotline.example.org'

/** The attribute's value from the first element carrying it, XML-unescaped */
function attr(xml: string, element: string, name: string): string {
  const tag = new RegExp(`<${element}\\b[^>]*>`).exec(xml)?.[0]
  const value = tag && new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1]
  if (value === undefined) throw new Error(`no ${element}@${name} in ${xml}`)
  return value.replace(/&amp;/g, '&')
}

const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString()
const formRequest = (fields: Record<string, string>) => new Request('https://hotline.example.org/api/telephony/x', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: form(fields),
})

describe('TelnyxAdapter (TeXML)', () => {
  let adapter: TelnyxAdapter
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    adapter = new TelnyxAdapter(API_KEY, CONNECTION_ID, PHONE_NUMBER, BASE)
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const incoming = { callSid: 'v3:call-1', callerNumber: '+15559876543', callerLanguage: 'en', hotlineName: 'Hotline', callRecordingEnabled: false }

  describe('handleLanguageMenu', () => {
    it('gathers one digit across every offerable language, in the hub\'s order, and names the next step', async () => {
      const res = await adapter.handleLanguageMenu({ callSid: 'v3:call-1', callerNumber: '+15559876543', hotlineName: 'H', enabledLanguages: ['en', 'es'], hubId: 'hub-1' })
      expect(res.contentType).toBe('text/xml')
      expect(res.body).toContain('<Gather numDigits="1"')
      expect(attr(res.body, 'Gather', 'action')).toBe(`${BASE}/api/telephony/language-selected?hub=hub-1`)
      expect(res.body.match(/<Say /g)).toHaveLength(2)
      expect(res.body).toContain(`voice="${TELNYX_VOICES.voiceFor('en')!.voice}"`)
      expect(res.body).toContain(`voice="${TELNYX_VOICES.voiceFor('es')!.voice}"`)
      // No input at all falls through to an automatic choice on the same route.
      expect(res.body).toContain(`<Redirect method="POST">${BASE}/api/telephony/language-selected?auto=1&amp;hub=hub-1</Redirect>`)
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('skips the menu for a single language and redirects with that language forced', async () => {
      const res = await adapter.handleLanguageMenu({ callSid: 'v3:call-1', callerNumber: '+15559876543', hotlineName: 'H', enabledLanguages: ['es'], hubId: 'hub-1' })
      expect(res.body).not.toContain('<Gather')
      expect(res.body).toContain(`${BASE}/api/telephony/language-selected?auto=1&amp;forceLang=es&amp;hub=hub-1`)
    })

    it('uses root-relative callbacks when no public base URL is configured', async () => {
      const bare = new TelnyxAdapter(API_KEY, CONNECTION_ID, PHONE_NUMBER)
      const res = await bare.handleLanguageMenu({ callSid: 'c', callerNumber: '+1', hotlineName: 'H', enabledLanguages: ['en', 'es'], hubId: 'hub-1' })
      expect(attr(res.body, 'Gather', 'action')).toBe('/api/telephony/language-selected?hub=hub-1')
    })
  })

  describe('handleIncomingCall', () => {
    it('greets, tells the caller to hold, and enqueues with wait and exit callbacks', async () => {
      const res = await adapter.handleIncomingCall({ ...incoming, voiceCaptchaEnabled: false, rateLimited: false, hubId: 'hub-1', audioUrls: HOLD })
      expect(res.body).toContain('<Say voice="AWS.Polly.Joanna-Neural"')
      expect(res.body).toContain('<Enqueue ')
      expect(res.body).toContain('>v3:call-1</Enqueue>')
      expect(attr(res.body, 'Enqueue', 'waitUrl')).toBe(`${BASE}/api/telephony/wait-music?lang=en&hub=hub-1`)
      expect(attr(res.body, 'Enqueue', 'action')).toBe(`${BASE}/api/telephony/queue-exit?callSid=v3%3Acall-1&lang=en&hub=hub-1`)
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('hangs up on a rate-limited caller', async () => {
      const res = await adapter.handleIncomingCall({ ...incoming, voiceCaptchaEnabled: false, rateLimited: true })
      expect(res.body).toContain('<Hangup/>')
      expect(res.body).not.toContain('<Enqueue')
    })

    it('gathers the CAPTCHA answer on /captcha, carrying the call, language, round and hub', async () => {
      const res = await adapter.handleIncomingCall({ ...incoming, voiceCaptchaEnabled: true, rateLimited: false, captchaDigits: '4821', hubId: 'hub-1' })
      const action = attr(res.body, 'Gather', 'action')
      expect(action).toBe(`${BASE}/api/telephony/captcha?callSid=v3%3Acall-1&lang=en&round=0&hub=hub-1`)
      expect(res.body).toContain('4, 8, 2, 1.')
      expect(res.body).not.toContain('<Enqueue')
      // A caller who says nothing is sent to the same route as a timeout.
      expect(res.body).toContain(`<Redirect method="POST">${action.replace(/&/g, '&amp;')}</Redirect>`)
    })

    it('discloses recording before the caller can be connected', async () => {
      const without = await adapter.handleIncomingCall({ ...incoming, voiceCaptchaEnabled: false, rateLimited: false })
      const withNotice = await adapter.handleIncomingCall({ ...incoming, callRecordingEnabled: true, voiceCaptchaEnabled: false, rateLimited: false })
      expect(withNotice.body.match(/<Say /g)!.length).toBe(without.body.match(/<Say /g)!.length + 1)
    })

    it('escapes a hotline name into valid XML', async () => {
      const res = await adapter.handleIncomingCall({ ...incoming, hotlineName: 'A & B <hotline>', voiceCaptchaEnabled: false, rateLimited: false })
      expect(res.body).toContain('A &amp; B &lt;hotline&gt;')
    })
  })

  describe('handleCaptchaResponse', () => {
    it('queues the caller on a pass', async () => {
      const res = await adapter.handleCaptchaResponse({ outcome: 'pass', callSid: 'v3:call-1', callerLanguage: 'en', hubId: 'hub-1', audioUrls: HOLD })
      expect(res.body).toContain('<Enqueue ')
      expect(attr(res.body, 'Enqueue', 'action')).toContain('/api/telephony/queue-exit?')
    })

    it('challenges again on a retry, on the next round', async () => {
      const res = await adapter.handleCaptchaResponse({ outcome: 'retry', callSid: 'v3:call-1', callerLanguage: 'en', hubId: 'hub-1', digitsToSpeak: '4821', round: 1 })
      expect(attr(res.body, 'Gather', 'action')).toBe(`${BASE}/api/telephony/captcha?callSid=v3%3Acall-1&lang=en&round=1&hub=hub-1`)
      expect(res.body).not.toContain('<Enqueue')
    })
  })

  describe('handleCallAnswered', () => {
    const answered = { parentCallSid: 'v3:parent-1', callbackUrl: HOLD_ORIGIN, userPubkey: 'pk', hubId: 'hub-1' }

    it('bridges the volunteer into the caller\'s queue without any recording attribute when recording is off', async () => {
      const res = await adapter.handleCallAnswered({ ...answered, recordCall: false })
      expect(res.body).toContain('<Dial>')
      expect(res.body).toContain('<Queue>v3:parent-1</Queue>')
      expect(res.body).not.toContain('record')
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('asks Telnyx to record, calling back on /call-recording, when this hub opted in', async () => {
      const res = await adapter.handleCallAnswered({ ...answered, recordCall: true })
      expect(attr(res.body, 'Dial', 'record')).toBe('record-from-answer')
      expect(attr(res.body, 'Dial', 'recordingStatusCallback')).toBe(`${HOLD_ORIGIN}/api/telephony/call-recording?parentCallSid=v3%3Aparent-1`)
    })
  })

  describe('handleVoicemail', () => {
    it('prompts, records with a completion route and a recording callback, and hangs up', async () => {
      const res = await adapter.handleVoicemail({ callSid: 'v3:call-1', callerLanguage: 'en', callbackUrl: HOLD_ORIGIN, hubId: 'hub-1', maxRecordingSeconds: 45 })
      expect(attr(res.body, 'Record', 'maxLength')).toBe('45')
      expect(attr(res.body, 'Record', 'action')).toBe(`${BASE}/api/telephony/voicemail-complete?callSid=v3%3Acall-1&lang=en&hub=hub-1`)
      expect(attr(res.body, 'Record', 'recordingStatusCallback')).toBe(`${HOLD_ORIGIN}/api/telephony/voicemail-recording?callSid=v3%3Acall-1&hub=hub-1`)
      expect(res.body).toContain('<Hangup/>')
    })

    it('plays the operator\'s uploaded voicemail greeting instead of speaking one (#1350)', async () => {
      const upload = `${HOLD_ORIGIN}/api/ivr-audio/voicemailPrompt/en`
      const res = await adapter.handleVoicemail({ callSid: 'v3:call-1', callerLanguage: 'en', callbackUrl: HOLD_ORIGIN, audioUrls: { 'voicemailPrompt:en': upload } })
      expect(res.body).toContain(`<Play>${upload}</Play>`)
      expect(res.body).not.toContain('<Say')
    })

    it('speaks the greeting when nothing was uploaded', async () => {
      const res = await adapter.handleVoicemail({ callSid: 'v3:call-1', callerLanguage: 'en', callbackUrl: HOLD_ORIGIN, audioUrls: {} })
      expect(res.body).toContain('<Say')
      expect(res.body).not.toContain('<Play')
    })
  })

  describe('handleWaitMusic', () => {
    it('plays the wait message and the worker\'s own hold track while under the timeout', async () => {
      const res = await adapter.handleWaitMusic('en', HOLD, 10, 90)
      expect(res.body).toContain(`<Play>${HOLD_URL}</Play>`)
      expect(res.body).not.toContain('<Leave')
    })

    it('leaves the queue — which sends the caller to voicemail — once the timeout is reached', async () => {
      expect((await adapter.handleWaitMusic('en', HOLD, 90, 90)).body).toBe('<Response><Leave/></Response>')
      expect((await adapter.handleWaitMusic('en', HOLD, 120, 90)).body).toContain('<Leave/>')
    })

    it('uses a default timeout of 90', async () => {
      expect((await adapter.handleWaitMusic('en', HOLD, 89)).body).not.toContain('<Leave')
      expect((await adapter.handleWaitMusic('en', HOLD, 90)).body).toContain('<Leave/>')
    })
  })

  describe('handleVoicemailComplete / rejectCall / hangupResponse / emptyResponse', () => {
    it('answers each with its TeXML verb', () => {
      expect(adapter.handleVoicemailComplete('en').body).toContain('<Hangup/>')
      expect(adapter.rejectCall().body).toBe('<Response><Reject reason="rejected"/></Response>')
      expect(adapter.hangupResponse().body).toBe('<Response><Hangup/></Response>')
      expect(adapter.emptyResponse().body).toBe('<Response/>')
      for (const res of [adapter.rejectCall(), adapter.hangupResponse(), adapter.emptyResponse()]) expect(res.contentType).toBe('text/xml')
    })
  })

  describe('hangupCall / cancelRinging', () => {
    const hangupUrl = (sid: string) => `https://api.telnyx.com/v2/calls/${encodeURIComponent(sid)}/actions/hangup`
    const hungUp = () => (fetchSpy.mock.calls as Array<[unknown, RequestInit?]>).map(c => String(c[0]))

    it('ends the leg by its CallSid, authenticated', async () => {
      await adapter.hangupCall('v3:call-1')
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
      expect(url).toBe(hangupUrl('v3:call-1'))
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`)
    })

    it('rejects when Telnyx refuses the hangup', async () => {
      fetchSpy.mockResolvedValue(new Response('no', { status: 500 }))
      await expect(adapter.hangupCall('v3:call-1')).rejects.toThrow(/Telnyx API error \(hangup\): 500/)
    })

    it('hangs up every ringing leg except the one that answered', async () => {
      await adapter.cancelRinging(['v3:a', 'v3:b', 'v3:c'], 'v3:b')
      expect(hungUp().sort()).toEqual([hangupUrl('v3:a'), hangupUrl('v3:c')])
    })

    it('hangs up all legs when none answered', async () => {
      await adapter.cancelRinging(['v3:a', 'v3:b'])
      expect(hungUp()).toHaveLength(2)
    })
  })

  describe('ringVolunteers (#1135)', () => {
    const volunteers = [
      { phone: '+15550000001', callToken: 'tok one' },
      { phone: '+15550000002', callToken: 'tok-two' },
    ]
    const params = { callSid: 'v3:call-1', callerNumber: '+15559876543', volunteers, callbackUrl: 'https://cb.example.org', hubId: 'hub-1' }
    const created = () => (fetchSpy.mock.calls as Array<[string, RequestInit]>).map(([url, init]) => ({ url, body: JSON.parse(String(init.body)) }))

    it('places each leg through the TeXML application with distinct answer and status URLs', async () => {
      let n = 0
      fetchSpy.mockImplementation(async () => Response.json({ call_sid: `v3:leg-${++n}`, status: 'queued' }))
      const sids = await adapter.ringVolunteers(params)

      expect(sids).toEqual(['v3:leg-1', 'v3:leg-2'])
      const [first] = created()
      expect(first.url).toBe(`https://api.telnyx.com/v2/texml/calls/${CONNECTION_ID}`)
      expect(first.body).toMatchObject({ To: '+15550000001', From: PHONE_NUMBER, Timeout: 30, MachineDetection: 'Enable', Method: 'POST' })
      // The answer URL is fetched on answer only; progress events go elsewhere.
      expect(first.body.Url).toBe('https://cb.example.org/api/telephony/user-answer?callToken=tok%20one&hub=hub-1')
      expect(first.body.StatusCallback).toBe('https://cb.example.org/api/telephony/call-status?callToken=tok%20one&hub=hub-1')
      expect(first.body.StatusCallback).not.toBe(first.body.Url)
      expect(first.body.StatusCallbackEvent).toBe('initiated ringing answered completed')
    })

    it('returns only the legs that were placed', async () => {
      fetchSpy
        .mockResolvedValueOnce(Response.json({ call_sid: 'v3:ok' }))
        .mockResolvedValueOnce(new Response('Invalid number', { status: 422 }))
      expect(await adapter.ringVolunteers(params)).toEqual(['v3:ok'])
    })

    it('throws when every leg failed', async () => {
      fetchSpy.mockImplementation(async () => new Response('down', { status: 500 }))
      await expect(adapter.ringVolunteers(params)).rejects.toBeInstanceOf(AllDialsFailedError)
    })

    it('does not mistake an answer with no call_sid for a placed leg', async () => {
      fetchSpy.mockImplementation(async () => Response.json({ status: 'queued' }))
      await expect(adapter.ringVolunteers(params)).rejects.toBeInstanceOf(AllDialsFailedError)
    })
  })

  describe('recordings', () => {
    it('getCallRecording is not supported', async () => {
      expect(await adapter.getCallRecording('x')).toBeNull()
    })

    it('fetches a recording by its RecordingSid: the resource, then its download URL', async () => {
      const audio = new ArrayBuffer(8)
      fetchSpy
        .mockResolvedValueOnce(Response.json({ data: { id: 'rec-1', download_urls: { mp3: 'https://recording.url/audio.mp3' } } }))
        .mockResolvedValueOnce(new Response(audio, { status: 200 }))
      expect(await adapter.getRecordingAudio('rec-1')).toStrictEqual(audio)
      expect(String(fetchSpy.mock.calls[0]![0])).toBe('https://api.telnyx.com/v2/recordings/rec-1')
    })

    it('returns null when the recording cannot be fetched', async () => {
      fetchSpy.mockResolvedValue(new Response('Not Found', { status: 404 }))
      expect(await adapter.getRecordingAudio('rec-1')).toBeNull()
    })

    it('deletes a recording by its RecordingSid; an already-gone one is deleted', async () => {
      await expect(adapter.deleteRecording('rec-1')).resolves.toBeUndefined()
      expect(fetchSpy.mock.calls[0]).toEqual(['https://api.telnyx.com/v2/recordings/rec-1', expect.objectContaining({ method: 'DELETE' })])
      fetchSpy.mockResolvedValue(new Response('', { status: 404 }))
      await expect(adapter.deleteRecording('rec-1')).resolves.toBeUndefined()
    })

    it('rejects when Telnyx refuses a deletion, or cannot be reached', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('boom', { status: 500 }))
      await expect(adapter.deleteRecording('rec-1')).rejects.toThrow(/Telnyx recording deletion failed: 500/)
      fetchSpy.mockRejectedValueOnce(new Error('network down'))
      await expect(adapter.deleteRecording('rec-1')).rejects.toThrow(/network down/)
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
        'https://api.telnyx.com/v2/recordings?': Response.json({ data: [{ id: 'leg-1', created_at: old }] }),
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

  // Real Ed25519 over `timestamp|body`: nothing about verification is stubbed.
  describe('validateWebhook', () => {
    let signer: TelnyxSigner
    const body = form({ CallSid: 'v3:call-1', From: '+15559876543', To: PHONE_NUMBER, ConnectionId: CONNECTION_ID })

    beforeEach(async () => {
      signer = await makeTelnyxSigner()
      fetchSpy.mockImplementation(async () => publicKeyResponse(signer))
    })

    const request = (headers: Record<string, string>, requestBody = body) =>
      new Request('https://hotline.example.org/api/telephony/incoming', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
        body: requestBody,
      })

    it('accepts a request signed by the account\'s key', async () => {
      expect(await adapter.validateWebhook(request(await signer.sign(body)))).toBe(true)
    })

    it('refuses a body altered after signing', async () => {
      const headers = await signer.sign(body)
      expect(await adapter.validateWebhook(request(headers, body.replace('CallSid=v3', 'CallSid=v4')))).toBe(false)
    })

    it('refuses a signature made by another key', async () => {
      const other = await makeTelnyxSigner()
      expect(await adapter.validateWebhook(request(await other.sign(body)))).toBe(false)
    })

    it('refuses a timestamp the signature does not cover', async () => {
      const headers = await signer.sign(body)
      expect(await adapter.validateWebhook(request({ ...headers, 'telnyx-timestamp': String(Number(headers['telnyx-timestamp']) + 1) }))).toBe(false)
    })

    it('refuses a stale signed request (replay window)', async () => {
      const stale = Math.floor(Date.now() / 1000) - 120
      expect(await adapter.validateWebhook(request(await signer.sign(body, stale)))).toBe(false)
    })

    it('refuses a request with no signature, no timestamp, or neither', async () => {
      const headers = await signer.sign(body)
      expect(await adapter.validateWebhook(request({ 'telnyx-timestamp': headers['telnyx-timestamp'] }))).toBe(false)
      expect(await adapter.validateWebhook(request({ 'telnyx-signature-ed25519': headers['telnyx-signature-ed25519'] }))).toBe(false)
      expect(await adapter.validateWebhook(request({}))).toBe(false)
    })

    it('refuses a non-numeric timestamp and a malformed signature', async () => {
      const headers = await signer.sign(body)
      expect(await adapter.validateWebhook(request({ ...headers, 'telnyx-timestamp': 'now' }))).toBe(false)
      expect(await adapter.validateWebhook(request({ ...headers, 'telnyx-signature-ed25519': '***not base64***' }))).toBe(false)
    })

    it('refuses an empty body, which a signature would cover only trivially', async () => {
      expect(await adapter.validateWebhook(request(await signer.sign(''), ''))).toBe(false)
    })

    it('refuses when the account\'s public key cannot be fetched — it never fails open', async () => {
      fetchSpy.mockResolvedValue(new Response('unauthorized', { status: 401 }))
      expect(await adapter.validateWebhook(request(await signer.sign(body)))).toBe(false)
    })

    it('fetches the public key once per adapter, not once per request', async () => {
      await adapter.validateWebhook(request(await signer.sign(body)))
      await adapter.validateWebhook(request(await signer.sign(body)))
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    it('keys replay protection on the signed timestamp and body, not the unsigned query', async () => {
      const headers = await signer.sign(body)
      const a = new Request('https://hotline.example.org/api/telephony/captcha?round=0', { method: 'POST', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' }, body })
      const b = new Request('https://hotline.example.org/api/telephony/captcha?round=1', { method: 'POST', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' }, body })
      expect(await adapter.webhookReplayKey(a)).toBe(await adapter.webhookReplayKey(b))
      expect(await adapter.webhookReplayKey(a)).toBe(`${headers['telnyx-timestamp']}\n${body}`)
    })
  })

  describe('webhookNamesOwnAccount', () => {
    it('reads the provider-populated ConnectionId; a body that is not ours, or repeats the field, is refused', async () => {
      expect(await adapter.webhookNamesOwnAccount(formRequest({ ConnectionId: CONNECTION_ID }))).toBe(true)
      expect(await adapter.webhookNamesOwnAccount(formRequest({ ConnectionId: 'conn-999' }))).toBe(false)
      expect(await adapter.webhookNamesOwnAccount(formRequest({ CallSid: 'x' }))).toBe(false)
      const twice = new Request('https://hotline.example.org/x', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `ConnectionId=${CONNECTION_ID}&ConnectionId=conn-999`,
      })
      expect(await adapter.webhookNamesOwnAccount(twice)).toBe(false)
      const json = new Request('https://hotline.example.org/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ConnectionId: CONNECTION_ID }) })
      expect(await adapter.webhookNamesOwnAccount(json)).toBe(false)
    })
  })

  describe('webhook parsing', () => {
    it('parseIncomingWebhook reads the call, the caller, the dialled number and whether a machine answered', async () => {
      expect(await adapter.parseIncomingWebhook(formRequest({ CallSid: 'v3:call-1', From: '+15559876543', To: PHONE_NUMBER }))).toEqual({
        callSid: 'v3:call-1',
        callerNumber: '+15559876543',
        calledNumber: PHONE_NUMBER,
        answeredByMachine: false,
      })
      for (const machine of ['machine_start', 'machine_end_beep', 'machine_end_silence', 'machine_end_other', 'fax']) {
        expect((await adapter.parseIncomingWebhook(formRequest({ CallSid: 'c', AnsweredBy: machine }))).answeredByMachine, machine).toBe(true)
      }
      for (const person of ['human', 'unknown']) {
        expect((await adapter.parseIncomingWebhook(formRequest({ CallSid: 'c', AnsweredBy: person }))).answeredByMachine, person).toBe(false)
      }
    })

    it('parseIncomingWebhook tolerates missing fields', async () => {
      expect(await adapter.parseIncomingWebhook(formRequest({}))).toMatchObject({ callSid: '', callerNumber: '', calledNumber: undefined })
    })

    it('parseLanguageWebhook and parseCaptchaWebhook read the gathered digits', async () => {
      expect(await adapter.parseLanguageWebhook(formRequest({ CallSid: 'v3:c', From: '+1555', Digits: '2' }))).toEqual({ callSid: 'v3:c', callerNumber: '+1555', digits: '2' })
      expect(await adapter.parseLanguageWebhook(formRequest({ CallSid: 'v3:c' }))).toMatchObject({ digits: '' })
      expect(await adapter.parseCaptchaWebhook(formRequest({ Digits: '4821', From: '+1555' }))).toEqual({ digits: '4821', callerNumber: '+1555' })
      expect(await adapter.parseCaptchaWebhook(formRequest({ From: '+1555' }))).toMatchObject({ digits: '' })
    })

    it('parseCallStatusWebhook maps every Telnyx call status, and an unknown one to failed', async () => {
      const expected: Record<string, string> = {
        initiated: 'initiated', ringing: 'ringing', 'in-progress': 'answered', completed: 'completed',
        busy: 'busy', 'no-answer': 'no-answer', failed: 'failed', canceled: 'failed', bogus: 'failed',
      }
      for (const [raw, status] of Object.entries(expected)) {
        expect(await adapter.parseCallStatusWebhook(formRequest({ CallStatus: raw })), raw).toEqual({ status })
      }
      expect(await adapter.parseCallStatusWebhook(formRequest({ DialCallStatus: 'completed' }))).toEqual({ status: 'completed' })
      expect(await adapter.parseCallStatusWebhook(formRequest({}))).toEqual({ status: 'failed' })
    })

    it('parseQueueWaitWebhook reads QueueTime', async () => {
      expect(await adapter.parseQueueWaitWebhook(formRequest({ QueueTime: '30' }))).toEqual({ queueTime: 30 })
      expect(await adapter.parseQueueWaitWebhook(formRequest({}))).toEqual({ queueTime: 0 })
    })

    it('parseQueueExitWebhook maps QueueResult, and anything else to error', async () => {
      for (const result of ['leave', 'queue-full', 'error', 'bridged', 'hangup']) {
        expect(await adapter.parseQueueExitWebhook(formRequest({ QueueResult: result })), result).toEqual({ result })
      }
      expect(await adapter.parseQueueExitWebhook(formRequest({ QueueResult: 'surprise' }))).toEqual({ result: 'error' })
      expect(await adapter.parseQueueExitWebhook(formRequest({}))).toEqual({ result: 'error' })
    })

    it('parseRecordingWebhook names the recording by its RecordingSid', async () => {
      expect(await adapter.parseRecordingWebhook(formRequest({ RecordingStatus: 'completed', RecordingSid: 'rec-1', CallSid: 'v3:c' }))).toEqual({
        status: 'completed', recordingSid: 'rec-1', callSid: 'v3:c',
      })
      expect(await adapter.parseRecordingWebhook(formRequest({ RecordingStatus: 'absent' }))).toMatchObject({ status: 'failed' })
      expect(await adapter.parseRecordingWebhook(formRequest({}))).toMatchObject({ status: 'failed', recordingSid: undefined })
    })
  })
})
