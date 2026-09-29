import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CommandHandler, legStatusFromCause } from './command-handler'
import type { BridgeClient, BridgeEvent } from './bridge-client'
import type { WebhookSender } from './webhook-sender'
import type { BridgeCommand, BridgeConfig, WebhookPayload } from './types'
import { formatMediaPath } from './tts-engine'

vi.mock('./tts-engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tts-engine')>()
  return {
    ...actual,
    createTtsEngine: (config: { engine: string }) =>
      config.engine === 'none' ? null : { synthesize: async (text: string) => `/tts/${text.length}.wav` },
  }
})

// ---- Fake BridgeClient: records every call, hands out predictable IDs ----

interface Call {
  method: string
  args: unknown[]
}

function fakeClient() {
  const calls: Call[] = []
  let seq = 0
  const track =
    (method: string, result?: () => unknown) =>
    async (...args: unknown[]) => {
      calls.push({ method, args })
      return result?.()
    }
  const client: BridgeClient = {
    connect: track('connect') as BridgeClient['connect'],
    disconnect: () => {},
    isConnected: () => true,
    onEvent: () => {},
    offEvent: () => {},
    originate: track('originate', () => ({ id: `leg-${++seq}` })) as BridgeClient['originate'],
    hangup: track('hangup') as BridgeClient['hangup'],
    answer: track('answer') as BridgeClient['answer'],
    bridge: track('bridge', () => 'bridge-1') as BridgeClient['bridge'],
    destroyBridge: track('destroyBridge') as BridgeClient['destroyBridge'],
    playMedia: track('playMedia', () => `pb-${++seq}`) as BridgeClient['playMedia'],
    stopPlayback: track('stopPlayback') as BridgeClient['stopPlayback'],
    startMoh: track('startMoh') as BridgeClient['startMoh'],
    stopMoh: track('stopMoh') as BridgeClient['stopMoh'],
    recordChannel: track('recordChannel') as BridgeClient['recordChannel'],
    recordBridge: track('recordBridge') as BridgeClient['recordBridge'],
    stopRecording: track('stopRecording') as BridgeClient['stopRecording'],
    getRecordingFile: track('getRecordingFile', () => null) as BridgeClient['getRecordingFile'],
    deleteRecording: track('deleteRecording') as BridgeClient['deleteRecording'],
    setChannelVar: track('setChannelVar') as BridgeClient['setChannelVar'],
    getChannelVar: track('getChannelVar', () => '') as BridgeClient['getChannelVar'],
    healthCheck: track('healthCheck', () => ({ ok: true, latencyMs: 1 })) as BridgeClient['healthCheck'],
    listChannels: track('listChannels', () => []) as BridgeClient['listChannels'],
    listBridges: track('listBridges', () => []) as BridgeClient['listBridges'],
  }
  const of = (method: string) => calls.filter((c) => c.method === method).map((c) => c.args)
  return { client, calls, of }
}

// ---- Fake worker: answers each route with scripted commands (null = refuse) ----

interface Sent {
  path: string
  payload: WebhookPayload
  query?: Record<string, string>
}

function fakeWorker() {
  const sent: Sent[] = []
  const replies = new Map<string, BridgeCommand[] | null>()
  const webhook = {
    sendWebhookForCommands: async (path: string, payload: WebhookPayload, query?: Record<string, string>) => {
      sent.push({ path, payload, query })
      const reply = replies.get(path)
      return reply === undefined ? [] : reply
    },
  } as unknown as WebhookSender
  return {
    webhook,
    sent,
    reply(path: string, commands: BridgeCommand[] | null) {
      replies.set(path, commands)
    },
    to: (path: string) => sent.filter((s) => s.path === path),
  }
}

const config: BridgeConfig = {
  pbxType: 'asterisk',
  ariUrl: '',
  ariRestUrl: '',
  ariUsername: '',
  ariPassword: '',
  eslHost: '',
  eslPort: 8021,
  eslPassword: '',
  kamailioJsonrpcUrl: '',
  workerWebhookUrl: 'http://worker:3000',
  bridgeSecret: 'secret',
  bridgePort: 3000,
  bridgeHost: '0.0.0.0',
  stasisApp: 'llamenos',
  connectionTimeoutMs: 300_000,
  ttsConfig: { engine: 'espeak', cacheDir: '/tmp/tts' },
}

const CALLER = 'caller-1'
const ts = '2026-09-29T00:00:00.000Z'
const CONTEXT = { callSid: CALLER, lang: 'es', hub: 'hub-1' }

const incoming = (channelId = CALLER, args: string[] = []): BridgeEvent => ({
  type: 'channel_create',
  channelId,
  callerNumber: '+15557770001',
  calledNumber: '+15550100',
  args,
  timestamp: ts,
})
const answered = (legId: string, token: string, parent = CALLER): BridgeEvent => ({
  type: 'channel_create',
  channelId: legId,
  callerNumber: '+15557770001',
  calledNumber: 's',
  args: ['dialed', parent, token],
  timestamp: ts,
})
const hangup = (channelId: string, cause = 16): BridgeEvent => ({ type: 'channel_hangup', channelId, cause, causeText: '', timestamp: ts })
const dtmf = (digit: string, channelId = CALLER): BridgeEvent => ({ type: 'dtmf_received', channelId, digit, durationMs: 100, timestamp: ts })
const playbackDone = (playbackId: string, channelId = CALLER): BridgeEvent => ({ type: 'playback_finished', channelId, playbackId, timestamp: ts })

const queueCmd: BridgeCommand = { action: 'queue', queueName: CALLER, waitMusicEvent: 'wait_music', exitEvent: 'queue_exit', metadata: CONTEXT }

describe('CommandHandler', () => {
  let pbx: ReturnType<typeof fakeClient>
  let worker: ReturnType<typeof fakeWorker>
  let handler: CommandHandler

  beforeEach(() => {
    vi.useFakeTimers()
    pbx = fakeClient()
    worker = fakeWorker()
    handler = new CommandHandler(pbx.client, worker.webhook, config)
  })

  afterEach(() => {
    handler.dispose()
    vi.useRealTimers()
  })

  /** A caller whose incoming webhook answered with a queue: they are holding, volunteers can be rung */
  async function queuedCaller(): Promise<void> {
    worker.reply('/api/telephony/incoming', [queueCmd])
    await handler.handleEvent(incoming())
  }

  describe('an incoming call', () => {
    it('is answered and announced to the worker, whose commands run on that channel', async () => {
      worker.reply('/api/telephony/incoming', [{ action: 'play', url: 'https://hub/audio/greeting.mp3' }])

      await handler.handleEvent(incoming())

      expect(pbx.of('answer')).toEqual([[CALLER]])
      expect(worker.to('/api/telephony/incoming')).toEqual([
        {
          path: '/api/telephony/incoming',
          payload: { event: 'incoming', channelId: CALLER, callerNumber: '+15557770001', calledNumber: '+15550100' },
          query: undefined,
        },
      ])
      // Remote audio is a `sound:` URI with the URL; a bare URL is not a valid ARI media URI.
      expect(pbx.of('playMedia')).toEqual([[CALLER, 'sound:https://hub/audio/greeting.mp3']])
    })

    it('is hung up when the worker refuses or cannot be reached — never left in silence', async () => {
      worker.reply('/api/telephony/incoming', null)
      await handler.handleEvent(incoming())
      expect(pbx.of('hangup')).toEqual([[CALLER]])
      expect(handler.getStatus().activeCalls).toBe(1) // until its hangup event arrives
      await handler.handleEvent(hangup(CALLER))
      expect(handler.getStatus().activeCalls).toBe(0)
    })

    it('speaks prompts through the TTS engine', async () => {
      worker.reply('/api/telephony/incoming', [{ action: 'speak', text: 'Hola', language: 'es' }])
      await handler.handleEvent(incoming())
      expect(pbx.of('playMedia')).toEqual([[CALLER, formatMediaPath('/tts/4.wav', 'asterisk')]])
    })

    it('skips a spoken prompt when no TTS engine is configured', async () => {
      const silent = new CommandHandler(pbx.client, worker.webhook, { ...config, ttsConfig: { engine: 'none', cacheDir: '' } })
      worker.reply('/api/telephony/incoming', [{ action: 'speak', text: 'Hola', language: 'es' }])
      await silent.handleEvent(incoming())
      expect(pbx.of('playMedia')).toEqual([])
      silent.dispose()
    })

    it('logs and skips a command it does not understand instead of dropping it silently', async () => {
      worker.reply('/api/telephony/incoming', [
        { action: 'playback', channelId: CALLER, media: 'x' } as unknown as BridgeCommand,
        { action: 'hangup' },
      ])
      await handler.handleEvent(incoming())
      // The command after the unknown one still runs.
      expect(pbx.of('hangup')).toEqual([[CALLER]])
    })
  })

  describe('gathering digits', () => {
    it('starts the input timeout only after the menu prompts finish, then posts no digits', async () => {
      worker.reply('/api/telephony/incoming', [
        { action: 'speak', text: 'Para español, marque uno', language: 'es' },
        { action: 'speak', text: 'For English, press two', language: 'en-US' },
        { action: 'gather', numDigits: 1, timeout: 8, callbackEvent: 'language_selected', metadata: { hub: 'hub-1' } },
      ])
      await handler.handleEvent(incoming())
      expect(pbx.of('playMedia')).toHaveLength(2)

      // Prompts take a while: the 8 s have not started yet.
      await vi.advanceTimersByTimeAsync(20_000)
      expect(worker.to('/api/telephony/language-selected')).toEqual([])

      await handler.handleEvent(playbackDone('pb-1'))
      await handler.handleEvent(playbackDone('pb-2'))
      await vi.advanceTimersByTimeAsync(7_999)
      expect(worker.to('/api/telephony/language-selected')).toEqual([])
      await vi.advanceTimersByTimeAsync(1)

      expect(worker.to('/api/telephony/language-selected')).toEqual([
        {
          path: '/api/telephony/language-selected',
          payload: { event: 'language-selected', channelId: CALLER, callerNumber: '+15557770001', calledNumber: '+15550100', digits: '' },
          query: { hub: 'hub-1' },
        },
      ])
    })

    it('lets the caller barge in: the first digit stops the prompts and a full entry posts at once', async () => {
      worker.reply('/api/telephony/incoming', [
        { action: 'speak', text: 'Menu', language: 'en-US' },
        { action: 'gather', numDigits: 1, timeout: 8, callbackEvent: 'language_selected', metadata: { hub: 'hub-1' } },
      ])
      worker.reply('/api/telephony/language-selected', [queueCmd])
      await handler.handleEvent(incoming())

      await handler.handleEvent(dtmf('2'))

      expect(pbx.of('stopPlayback')).toEqual([['pb-1']])
      expect(worker.to('/api/telephony/language-selected')[0].payload.digits).toBe('2')
      // …and the worker's answer runs on the caller's channel.
      expect(pbx.of('startMoh')).toEqual([[CALLER]])
    })

    it('posts at once when there is nothing to collect (single-language hotline)', async () => {
      worker.reply('/api/telephony/incoming', [
        { action: 'speak', text: ' ', language: 'es' },
        { action: 'gather', numDigits: 0, timeout: 0, callbackEvent: 'language_selected', metadata: { auto: '1', forceLang: 'es' } },
      ])
      await handler.handleEvent(incoming())
      expect(worker.to('/api/telephony/language-selected')).toMatchObject([{ payload: { digits: '' }, query: { auto: '1', forceLang: 'es' } }])
    })

    it('collects all four captcha digits and posts them with the call context', async () => {
      worker.reply('/api/telephony/incoming', [
        { action: 'gather', numDigits: 4, timeout: 10, callbackEvent: 'captcha_response', metadata: CONTEXT },
      ])
      await handler.handleEvent(incoming())

      for (const d of '483') await handler.handleEvent(dtmf(d))
      expect(worker.to('/api/telephony/captcha')).toEqual([])
      await handler.handleEvent(dtmf('7'))

      expect(worker.to('/api/telephony/captcha')).toEqual([
        {
          path: '/api/telephony/captcha',
          payload: { event: 'captcha', channelId: CALLER, callerNumber: '+15557770001', calledNumber: '+15550100', digits: '4837' },
          query: CONTEXT,
        },
      ])
    })

    it('a new gather replaces a pending one: the old timeout never fires', async () => {
      worker.reply('/api/telephony/incoming', [
        { action: 'gather', numDigits: 1, timeout: 5, callbackEvent: 'language_selected', metadata: { hub: 'hub-1' } },
      ])
      await handler.handleEvent(incoming())
      await handler.executeCommands(CALLER, [
        { action: 'gather', numDigits: 4, timeout: 10, callbackEvent: 'captcha_response', metadata: CONTEXT },
      ])

      await vi.advanceTimersByTimeAsync(9_999)
      expect(worker.sent.map((s) => s.path)).toEqual(['/api/telephony/incoming'])
      await vi.advanceTimersByTimeAsync(1)
      expect(worker.sent.map((s) => s.path)).toEqual(['/api/telephony/incoming', '/api/telephony/captcha'])
    })

    it('ignores digits when nothing is being gathered', async () => {
      await handler.handleEvent(incoming())
      await handler.handleEvent(dtmf('1'))
      expect(worker.sent.map((s) => s.path)).toEqual(['/api/telephony/incoming'])
    })
  })

  describe('the queue', () => {
    it('holds the caller on music and polls wait-music with the time waited', async () => {
      await queuedCaller()

      expect(pbx.of('startMoh')).toEqual([[CALLER]])
      expect(worker.to('/api/telephony/wait-music')).toMatchObject([{ payload: { event: 'wait-music', queueTime: 0 }, query: CONTEXT }])

      await vi.advanceTimersByTimeAsync(10_000)
      expect(worker.to('/api/telephony/wait-music')).toHaveLength(2)
      expect(worker.to('/api/telephony/wait-music')[1].payload.queueTime).toBe(10)
    })

    it('leaves the queue for voicemail when the worker says so', async () => {
      worker.reply('/api/telephony/queue-exit', [
        { action: 'record', maxDuration: 120, finishOnKey: '#', callbackEvent: 'recording_complete', metadata: CONTEXT },
      ])
      await queuedCaller()
      const legs = await handler.ringVolunteers({ parentCallSid: CALLER, callerNumber: '+15557770001', volunteers: [{ pubkey: 'tok-a', phone: '+15550200' }] })

      worker.reply('/api/telephony/wait-music', [{ action: 'leave_queue' }])
      await vi.advanceTimersByTimeAsync(10_000)

      expect(pbx.of('stopMoh')).toEqual([[CALLER]])
      expect(pbx.of('hangup')).toEqual([[legs[0]]]) // nobody keeps ringing for a caller in voicemail
      expect(worker.to('/api/telephony/queue-exit')).toMatchObject([{ payload: { event: 'queue-exit', result: 'leave' }, query: CONTEXT }])
      expect(pbx.of('recordChannel')).toEqual([
        [CALLER, { name: `voicemail-${CALLER}`, format: 'wav', maxDurationSeconds: 120, beep: true, terminateOn: '#' }],
      ])

      // No more wait-music polls once the caller has left the queue.
      const polls = worker.to('/api/telephony/wait-music').length
      await vi.advanceTimersByTimeAsync(60_000)
      expect(worker.to('/api/telephony/wait-music')).toHaveLength(polls)
    })

    it('a caller hanging up in the queue is reported as a hangup and their ringing stops', async () => {
      await queuedCaller()
      const legs = await handler.ringVolunteers({
        parentCallSid: CALLER,
        callerNumber: '+15557770001',
        volunteers: [
          { pubkey: 'tok-a', phone: '+15550200' },
          { pubkey: 'tok-b', phone: '+15550201' },
        ],
      })

      await handler.handleEvent(hangup(CALLER))

      expect(worker.to('/api/telephony/queue-exit')).toMatchObject([{ payload: { result: 'hangup' }, query: CONTEXT }])
      expect(pbx.of('hangup')).toEqual(legs.map((id) => [id]))
      // The cancelled legs' own hangups report nothing to the worker.
      for (const id of legs) await handler.handleEvent(hangup(id))
      expect(worker.to('/api/telephony/call-status')).toEqual([])
      expect(handler.getStatus()).toMatchObject({ activeCalls: 0, activeQueues: 0, ringingChannels: 0 })
    })
  })

  describe('ringing volunteers', () => {
    it('originates one leg per volunteer phone through the trunk, carrying the parent call and token', async () => {
      await queuedCaller()
      const legs = await handler.ringVolunteers({
        parentCallSid: CALLER,
        callerNumber: '+15557770001',
        volunteers: [
          { pubkey: 'tok-a', phone: '+15550200' },
          { pubkey: 'tok-b', phone: '+15550201' },
        ],
      })

      expect(legs).toHaveLength(2)
      expect(pbx.of('originate')).toEqual([
        [{ endpoint: 'PJSIP/+15550200@trunk', callerId: '+15557770001', timeout: 30, appArgs: `dialed,${CALLER},tok-a` }],
        [{ endpoint: 'PJSIP/+15550201@trunk', callerId: '+15557770001', timeout: 30, appArgs: `dialed,${CALLER},tok-b` }],
      ])
      expect(handler.getStatus().ringingChannels).toBe(2)
    })

    it('rings nobody for a caller who already hung up', async () => {
      expect(await handler.ringVolunteers({ parentCallSid: 'gone', callerNumber: '+1', volunteers: [{ pubkey: 't', phone: '+2' }] })).toEqual([])
      expect(pbx.of('originate')).toEqual([])
    })

    it('reports an unanswered leg with the status its hangup cause means', async () => {
      await queuedCaller()
      const [busy, noAnswer] = await handler.ringVolunteers({
        parentCallSid: CALLER,
        callerNumber: '+15557770001',
        volunteers: [
          { pubkey: 'tok-a', phone: '+15550200' },
          { pubkey: 'tok-b', phone: '+15550201' },
        ],
      })

      await handler.handleEvent(hangup(busy, 17))
      await handler.handleEvent(hangup(noAnswer, 19))

      expect(worker.to('/api/telephony/call-status')).toMatchObject([
        { payload: { event: 'call-status', channelId: busy, status: 'busy' }, query: { callToken: 'tok-a' } },
        { payload: { event: 'call-status', channelId: noAnswer, status: 'no-answer' }, query: { callToken: 'tok-b' } },
      ])
    })

    it('cancelRinging hangs up every leg but the one kept', async () => {
      await queuedCaller()
      const [a, b, c] = await handler.ringVolunteers({
        parentCallSid: CALLER,
        callerNumber: '+1',
        volunteers: ['a', 'b', 'c'].map((t) => ({ pubkey: t, phone: `+1555020${t}` })),
      })
      handler.cancelRinging([a, b, c], b)
      await vi.advanceTimersByTimeAsync(0)
      expect(pbx.of('hangup')).toEqual([[a], [c]])
    })
  })

  describe('a volunteer answering', () => {
    let legs: string[]

    beforeEach(async () => {
      await queuedCaller()
      legs = await handler.ringVolunteers({
        parentCallSid: CALLER,
        callerNumber: '+15557770001',
        volunteers: [
          { pubkey: 'tok-a', phone: '+15550200' },
          { pubkey: 'tok-b', phone: '+15550201' },
        ],
      })
    })

    it('is accepted by the worker, bridged with the caller, recorded, and every other phone stops ringing', async () => {
      worker.reply('/api/telephony/user-answer', [{ action: 'bridge', queueName: CALLER, record: true }])
      const [winner, other] = legs

      await handler.handleEvent(answered(winner, 'tok-a'))

      expect(worker.to('/api/telephony/user-answer')).toMatchObject([
        { payload: { event: 'volunteer-answer', channelId: winner, callerNumber: '+15557770001' }, query: { callToken: 'tok-a' } },
      ])
      expect(pbx.of('stopMoh')).toEqual([[CALLER]])
      expect(pbx.of('hangup')).toEqual([[other]])
      expect(pbx.of('bridge')).toEqual([[CALLER, winner, { type: 'mixing', record: false }]])
      expect(pbx.of('recordBridge')).toEqual([['bridge-1', { name: `call-${CALLER}`, format: 'wav' }]])
      expect(handler.getStatus()).toMatchObject({ activeQueues: 0, activeBridges: 1 })

      // Bridged callers are no longer polled for wait music.
      const polls = worker.to('/api/telephony/wait-music').length
      await vi.advanceTimersByTimeAsync(60_000)
      expect(worker.to('/api/telephony/wait-music')).toHaveLength(polls)
    })

    it('hangs up the leg when the worker refuses the answer (someone else got the call)', async () => {
      worker.reply('/api/telephony/user-answer', null)
      await handler.handleEvent(answered(legs[0], 'tok-a'))
      expect(pbx.of('hangup')).toEqual([[legs[0]]])
      expect(pbx.of('bridge')).toEqual([])
    })

    it('hangs up the volunteer if the caller left before the bridge', async () => {
      worker.reply('/api/telephony/user-answer', [{ action: 'bridge', queueName: 'someone-else', record: true }])
      await handler.handleEvent(answered(legs[0], 'tok-a'))
      expect(pbx.of('hangup')).toEqual([[legs[0]]])
      expect(pbx.of('bridge')).toEqual([])
    })

    describe('once bridged', () => {
      beforeEach(async () => {
        worker.reply('/api/telephony/user-answer', [{ action: 'bridge', queueName: CALLER, record: true }])
        await handler.handleEvent(answered(legs[0], 'tok-a'))
        pbx.calls.length = 0
      })

      it('the volunteer hanging up releases the caller and reports the leg completed', async () => {
        await handler.handleEvent(hangup(legs[0]))

        // The recording is stopped while the bridge still exists — its finish
        // event is published on the bridge and is lost once it is destroyed.
        expect(pbx.calls.map((c) => c.method)).toEqual(['stopRecording', 'hangup', 'destroyBridge'])
        expect(pbx.of('hangup')).toEqual([[CALLER]])
        expect(worker.to('/api/telephony/call-status')).toMatchObject([
          { payload: { channelId: legs[0], status: 'completed' }, query: { callToken: 'tok-a' } },
        ])
      })

      it('the caller hanging up takes the volunteer down, whose hangup then reports completed', async () => {
        await handler.handleEvent(hangup(CALLER))
        expect(pbx.of('hangup')).toEqual([[legs[0]]])
        expect(pbx.of('destroyBridge')).toEqual([['bridge-1']])
        expect(worker.to('/api/telephony/queue-exit')).toEqual([]) // they had left the queue

        await handler.handleEvent(hangup(legs[0]))
        expect(worker.to('/api/telephony/call-status')).toMatchObject([{ payload: { status: 'completed' }, query: { callToken: 'tok-a' } }])
        expect(handler.getStatus()).toMatchObject({ activeCalls: 0, activeBridges: 0 })
      })

      it('reports the finished call recording to call-recording', async () => {
        await handler.handleEvent(hangup(legs[0]))
        await handler.handleEvent({ type: 'recording_complete', channelId: 'bridge-1', recordingName: `call-${CALLER}`, timestamp: ts })

        expect(worker.to('/api/telephony/call-recording')).toMatchObject([
          {
            payload: { event: 'call-recording', channelId: CALLER, recordingStatus: 'done', recordingName: `call-${CALLER}` },
            query: { parentCallSid: CALLER },
          },
        ])
        expect(handler.getStatus().pendingRecordings).toBe(0)
      })
    })
  })

  describe('voicemail', () => {
    beforeEach(async () => {
      worker.reply('/api/telephony/incoming', [
        { action: 'record', maxDuration: 60, finishOnKey: '#', callbackEvent: 'recording_complete', metadata: CONTEXT },
      ])
      await handler.handleEvent(incoming())
    })

    it('a finished voicemail is reported, then the closing prompt plays and the call ends', async () => {
      worker.reply('/api/telephony/voicemail-complete', [
        { action: 'speak', text: 'Gracias', language: 'es' },
        { action: 'hangup' },
      ])

      await handler.handleEvent({ type: 'recording_complete', channelId: CALLER, recordingName: `voicemail-${CALLER}`, timestamp: ts })

      expect(worker.to('/api/telephony/voicemail-recording')).toMatchObject([
        { payload: { event: 'voicemail-recording', recordingStatus: 'done', recordingName: `voicemail-${CALLER}` }, query: CONTEXT },
      ])
      expect(worker.to('/api/telephony/voicemail-complete')).toMatchObject([{ query: CONTEXT }])
      expect(pbx.of('hangup')).toEqual([[CALLER]])
    })

    it('still reports the voicemail when the caller hung up to finish it', async () => {
      await handler.handleEvent(hangup(CALLER))
      await handler.handleEvent({ type: 'recording_complete', channelId: CALLER, recordingName: `voicemail-${CALLER}`, timestamp: ts })

      expect(worker.to('/api/telephony/voicemail-recording')).toMatchObject([{ payload: { recordingStatus: 'done' }, query: CONTEXT }])
      expect(worker.to('/api/telephony/voicemail-complete')).toEqual([]) // nobody left to thank
    })

    it('reports a failed recording as failed', async () => {
      await handler.handleEvent({ type: 'recording_failed', channelId: CALLER, recordingName: `voicemail-${CALLER}`, timestamp: ts })
      expect(worker.to('/api/telephony/voicemail-recording')).toMatchObject([{ payload: { recordingStatus: 'failed' } }])
    })
  })

  describe('Tier 5 SFrame calls', () => {
    beforeEach(async () => {
      worker.reply('/api/telephony/incoming', [queueCmd])
      await handler.handleEvent(incoming(CALLER, ['sframe']))
    })

    it('are bridged passthrough and never recorded, even when the worker asks', async () => {
      const [leg] = await handler.ringVolunteers({ parentCallSid: CALLER, callerNumber: '+1', volunteers: [{ pubkey: 'tok', phone: '+2' }] })
      worker.reply('/api/telephony/user-answer', [{ action: 'bridge', queueName: CALLER, record: true }])

      await handler.handleEvent(answered(leg, 'tok'))

      expect(pbx.of('bridge')).toEqual([[CALLER, leg, { type: 'passthrough', record: false }]])
      expect(pbx.of('recordBridge')).toEqual([])
    })

    it('refuse voicemail recording', async () => {
      await handler.executeCommands(CALLER, [{ action: 'record', maxDuration: 60, finishOnKey: '#', callbackEvent: 'recording_complete' }])
      expect(pbx.of('recordChannel')).toEqual([])
    })
  })

  it('an unknown channel is never recorded (fails closed)', async () => {
    await handler.executeCommands('unknown', [{ action: 'record', maxDuration: 60, finishOnKey: '#', callbackEvent: 'recording_complete' }])
    expect(pbx.of('recordChannel')).toEqual([])
  })

  it('an answered leg without its parent call and token is hung up', async () => {
    await handler.handleEvent(answered('leg-x', ''))
    expect(pbx.of('hangup')).toEqual([['leg-x']])
    expect(worker.sent).toEqual([])
  })
})

describe('legStatusFromCause', () => {
  it('maps Q.850 causes of unanswered legs', () => {
    expect(legStatusFromCause(17)).toBe('busy')
    expect(legStatusFromCause(18)).toBe('no-answer')
    expect(legStatusFromCause(19)).toBe('no-answer')
    expect(legStatusFromCause(21)).toBe('failed')
    expect(legStatusFromCause(34)).toBe('failed')
  })
})
