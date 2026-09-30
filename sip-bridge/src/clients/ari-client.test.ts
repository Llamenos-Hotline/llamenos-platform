import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AriClient } from './ari-client'
import type { BridgeEvent } from '../bridge-client'
import type { BridgeConfig } from '../types'

// ---- Fake WebSocket: records every socket, lets a test drive its lifecycle ----

type Listener = (event: unknown) => void

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static sockets: FakeWebSocket[] = []
  /** Every new socket fails its handshake (Asterisk down / wrong password) */
  static refuseAll = false

  readonly url: string
  readyState = FakeWebSocket.CONNECTING
  private readonly listeners = new Map<string, Listener[]>()

  constructor(url: string) {
    this.url = url
    FakeWebSocket.sockets.push(this)
    if (FakeWebSocket.refuseAll) queueMicrotask(() => this.fail())
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    this.emit('close', { code: 1000, reason: 'closed by client' })
  }

  // ---- test controls ----
  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.emit('open', {})
  }

  /** A failed handshake: `error`, then `close` — what a 401 from Asterisk looks like */
  fail(): void {
    this.emit('error', {})
    this.readyState = FakeWebSocket.CLOSED
    this.emit('close', { code: 1002, reason: 'Expected 101 status code' })
  }

  drop(): void {
    this.readyState = FakeWebSocket.CLOSED
    this.emit('close', { code: 1006, reason: 'connection lost' })
  }

  message(data: unknown): void {
    this.emit('message', { data: typeof data === 'string' ? data : JSON.stringify(data) })
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

// ---- Fake ARI REST API: records requests, answers from a route table ----

interface RecordedRequest {
  method: string
  path: string
  query: URLSearchParams
  body: unknown
  authorization: string | null
}

type Route = (req: RecordedRequest) => Response | undefined

function fakeAri(routes: Route[] = []) {
  const requests: RecordedRequest[] = []
  const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const headers = new Headers(init?.headers)
    const req: RecordedRequest = {
      method: init?.method ?? 'GET',
      path: url.pathname.replace(/^\/ari/, ''),
      query: url.searchParams,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      authorization: headers.get('Authorization'),
    }
    requests.push(req)
    for (const route of routes) {
      const res = route(req)
      if (res) return res
    }
    return new Response(null, { status: 204 })
  })
  return { requests, fetchImpl }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const config: BridgeConfig = {
  pbxType: 'asterisk',
  ariUrl: 'ws://asterisk:8088/ari/events',
  ariRestUrl: 'http://asterisk:8088/ari',
  ariUsername: 'llamenos',
  // What `openssl rand -base64` produces: + and / must survive the query string.
  ariPassword: 'p+ss/w=rd',
  eslHost: '',
  eslPort: 8021,
  eslPassword: '',
  kamailioJsonrpcUrl: '',
  workerWebhookUrl: 'http://worker:3000',
  bridgeSecret: 'secret',
  bridgePort: 3000,
  bridgeHost: '0.0.0.0',
  stasisApp: 'llamenos',
  connectionTimeoutMs: 60_000,
}

const channel = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  name: `PJSIP/trunk-${id}`,
  state: 'Up',
  caller: { name: '', number: '+15557770001' },
  connected: { name: '', number: '' },
  accountcode: '',
  dialplan: { context: 'from-trunk', exten: '+15550100', priority: 3 },
  creationtime: '2026-09-29T00:00:00.000+0000',
  language: 'en',
  ...overrides,
})

const lastSocket = () => FakeWebSocket.sockets[FakeWebSocket.sockets.length - 1]

async function connected(client: AriClient): Promise<FakeWebSocket> {
  const done = client.connect()
  const ws = lastSocket()
  ws.open()
  await done
  return ws
}

describe('AriClient', () => {
  let ari: ReturnType<typeof fakeAri>
  let client: AriClient
  let events: BridgeEvent[]

  beforeEach(() => {
    FakeWebSocket.sockets = []
    FakeWebSocket.refuseAll = false
    vi.stubGlobal('WebSocket', FakeWebSocket)
    ari = fakeAri()
    vi.stubGlobal('fetch', ari.fetchImpl)
    client = new AriClient(config)
    events = []
    client.onEvent((e) => events.push(e))
  })

  afterEach(() => {
    client.disconnect()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  describe('connecting', () => {
    it('subscribes to the Stasis app with URL-encoded credentials', async () => {
      await connected(client)

      const url = new URL(lastSocket().url)
      expect(`${url.origin}${url.pathname}`).toBe('ws://asterisk:8088/ari/events')
      expect(url.searchParams.get('app')).toBe('llamenos')
      // A raw `+` would arrive as a space and Asterisk would answer 401.
      expect(url.searchParams.get('api_key')).toBe('llamenos:p+ss/w=rd')
      expect(lastSocket().url).not.toContain('p+ss')
      expect(client.isConnected()).toBe(true)
    })

    it('rejects the first attempt when the handshake fails', async () => {
      const done = client.connect()
      lastSocket().fail()
      await expect(done).rejects.toThrow('Failed to connect to ARI WebSocket')
      expect(client.isConnected()).toBe(false)
    })
  })

  describe('reconnecting', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    it('schedules exactly one retry per failed attempt, backing off', async () => {
      const done = client.connect()
      lastSocket().fail()
      await expect(done).rejects.toThrow()

      // One failure → one pending retry after 1 s (it used to be two, and the
      // number of parallel attempts doubled every round).
      await vi.advanceTimersByTimeAsync(1000)
      expect(FakeWebSocket.sockets).toHaveLength(2)
      lastSocket().fail()

      // Backoff doubled to 2 s: nothing at 1 s, one new attempt at 2 s.
      await vi.advanceTimersByTimeAsync(1000)
      expect(FakeWebSocket.sockets).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(1000)
      expect(FakeWebSocket.sockets).toHaveLength(3)
      lastSocket().fail()

      await vi.advanceTimersByTimeAsync(4000)
      expect(FakeWebSocket.sockets).toHaveLength(4)
    })

    it('reconnects after a dropped connection, and resets the backoff once connected', async () => {
      const first = await connected(client)
      first.drop()
      expect(client.isConnected()).toBe(false)

      await vi.advanceTimersByTimeAsync(1000)
      const second = lastSocket()
      expect(second).not.toBe(first)
      second.open()
      expect(client.isConnected()).toBe(true)

      second.drop()
      await vi.advanceTimersByTimeAsync(1000)
      expect(FakeWebSocket.sockets).toHaveLength(3)
    })

    it('ignores events from a superseded socket', async () => {
      const first = await connected(client)
      first.drop()
      await vi.advanceTimersByTimeAsync(1000)
      const second = lastSocket()
      second.open()

      // The old socket closing late must not tear down its replacement.
      first.drop()
      expect(client.isConnected()).toBe(true)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(FakeWebSocket.sockets).toHaveLength(2)
    })

    it('stops reconnecting after disconnect()', async () => {
      const ws = await connected(client)
      ws.drop()
      client.disconnect()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(FakeWebSocket.sockets).toHaveLength(1)
    })

    it('exits when Asterisk never became reachable before the deadline', async () => {
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
      FakeWebSocket.refuseAll = true
      await expect(client.connect()).rejects.toThrow()

      await vi.advanceTimersByTimeAsync(config.connectionTimeoutMs - 1000)
      expect(exit).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(exit).toHaveBeenCalledWith(1)
    })
  })

  describe('event translation', () => {
    let ws: FakeWebSocket

    beforeEach(async () => {
      ws = await connected(client)
    })

    it('StasisStart → channel_create with caller, dialled number and app args', () => {
      ws.message({ type: 'StasisStart', application: 'llamenos', timestamp: 't', args: ['dialed', 'parent-1', 'tok'], channel: channel('ch-1') })
      expect(events).toEqual([
        { type: 'channel_create', channelId: 'ch-1', callerNumber: '+15557770001', calledNumber: '+15550100', args: ['dialed', 'parent-1', 'tok'], timestamp: 't' },
      ])
    })

    it('StasisStart holds a subscription to the channel so its hangup is still reported after StasisEnd', async () => {
      ws.message({ type: 'StasisStart', application: 'llamenos', timestamp: 't', args: [], channel: channel('ch-1') })
      await vi.waitFor(() => expect(ari.requests).toHaveLength(1))
      const [sub] = ari.requests
      expect(sub.method).toBe('POST')
      expect(sub.path).toBe('/applications/llamenos/subscription')
      expect(sub.query.get('eventSource')).toBe('channel:ch-1')
      expect(sub.authorization).toBe(`Basic ${btoa('llamenos:p+ss/w=rd')}`)
    })

    it('ChannelDestroyed → channel_hangup with the Q.850 cause', () => {
      ws.message({ type: 'ChannelDestroyed', application: 'llamenos', timestamp: 't', cause: 17, cause_txt: 'User busy', channel: channel('ch-2') })
      expect(events).toEqual([{ type: 'channel_hangup', channelId: 'ch-2', cause: 17, causeText: 'User busy', timestamp: 't' }])
    })

    it('ChannelDtmfReceived → dtmf_received', () => {
      ws.message({ type: 'ChannelDtmfReceived', application: 'llamenos', timestamp: 't', digit: '5', duration_ms: 120, channel: channel('ch-1') })
      expect(events).toEqual([{ type: 'dtmf_received', channelId: 'ch-1', digit: '5', durationMs: 120, timestamp: 't' }])
    })

    it('PlaybackFinished → playback_finished on the target channel', () => {
      ws.message({ type: 'PlaybackFinished', application: 'llamenos', timestamp: 't', playback: { id: 'pb-1', media_uri: 'sound:x', target_uri: 'channel:ch-1', language: 'en', state: 'done' } })
      expect(events).toEqual([{ type: 'playback_finished', channelId: 'ch-1', playbackId: 'pb-1', timestamp: 't' }])
    })

    it('RecordingFinished / RecordingFailed → recording_complete / recording_failed', () => {
      ws.message({ type: 'RecordingFinished', application: 'llamenos', timestamp: 't', recording: { name: 'voicemail-ch-1', format: 'wav', state: 'done', target_uri: 'channel:ch-1', duration: 9 } })
      ws.message({ type: 'RecordingFailed', application: 'llamenos', timestamp: 't', recording: { name: 'call-ch-1', format: 'wav', state: 'failed', target_uri: 'bridge:b-1', cause: 'disk' } })
      expect(events).toEqual([
        { type: 'recording_complete', channelId: 'ch-1', recordingName: 'voicemail-ch-1', duration: 9, timestamp: 't' },
        { type: 'recording_failed', channelId: 'bridge:b-1', recordingName: 'call-ch-1', cause: 'disk', timestamp: 't' },
      ])
    })

    it('ChannelStateChange → channel_answer only when the channel goes Up', () => {
      ws.message({ type: 'ChannelStateChange', application: 'llamenos', timestamp: 't', channel: channel('ch-1', { state: 'Ringing' }) })
      ws.message({ type: 'ChannelStateChange', application: 'llamenos', timestamp: 't', channel: channel('ch-1', { state: 'Up' }) })
      expect(events).toEqual([{ type: 'channel_answer', channelId: 'ch-1', timestamp: 't' }])
    })

    it('passes every event to raw handlers but translates only the ones calls need', () => {
      const raw: string[] = []
      client.onRawEvent((e) => raw.push(e.type))
      ws.message({ type: 'ChannelVarset', application: 'llamenos', timestamp: 't' })
      expect(raw).toEqual(['ChannelVarset'])
      expect(events).toEqual([])
    })

    it('survives malformed frames and a throwing handler', () => {
      const after: BridgeEvent[] = []
      client.onEvent(() => {
        throw new Error('handler bug')
      })
      client.onEvent((e) => after.push(e))

      ws.message('{not json')
      ws.message({ type: 'ChannelDtmfReceived', application: 'llamenos', timestamp: 't', digit: '1', duration_ms: 1, channel: channel('ch-1') })
      expect(after).toHaveLength(1)
    })

    it('offEvent stops delivery', () => {
      const handler = vi.fn()
      client.onEvent(handler)
      client.offEvent(handler)
      ws.message({ type: 'ChannelDtmfReceived', application: 'llamenos', timestamp: 't', digit: '1', duration_ms: 1, channel: channel('ch-1') })
      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe('call control over REST', () => {
    it('originate rings an endpoint into the Stasis app and returns the new channel', async () => {
      ari = fakeAri([(req) => (req.method === 'POST' && req.path === '/channels' ? json(channel('leg-1')) : undefined)])
      vi.stubGlobal('fetch', ari.fetchImpl)

      const leg = await client.originate({
        endpoint: 'PJSIP/+15550200@trunk',
        callerId: '+15557770001',
        timeout: 30,
        appArgs: 'dialed,parent-1,token-1',
      })

      expect(leg).toEqual({ id: 'leg-1' })
      expect(ari.requests[0].body).toEqual({
        endpoint: 'PJSIP/+15550200@trunk',
        app: 'llamenos',
        timeout: 30,
        callerId: '+15557770001',
        appArgs: 'dialed,parent-1,token-1',
      })
      expect(ari.requests[0].authorization).toBe(`Basic ${btoa('llamenos:p+ss/w=rd')}`)
    })

    it('answer / startMoh / stopMoh / playMedia hit the channel resources', async () => {
      ari = fakeAri([(req) => (req.path.endsWith('/play') ? json({ id: 'pb-9' }) : undefined)])
      vi.stubGlobal('fetch', ari.fetchImpl)

      await client.answer('ch-1')
      await client.startMoh('ch-1')
      await client.stopMoh('ch-1')
      const playbackId = await client.playMedia('ch-1', 'sound:/tts/abc', 'gather-ch-1')

      expect(playbackId).toBe('pb-9')
      expect(ari.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
        'POST /channels/ch-1/answer',
        'POST /channels/ch-1/moh',
        'DELETE /channels/ch-1/moh',
        'POST /channels/ch-1/play',
      ])
      expect(ari.requests[1].query.get('mohClass')).toBe('default')
      expect(ari.requests[3].query.get('media')).toBe('sound:/tts/abc')
      expect(ari.requests[3].query.get('playbackId')).toBe('gather-ch-1')
    })

    it('hangup of a channel that is already gone does not throw', async () => {
      ari = fakeAri([() => json({ message: 'Channel not found' }, 404)])
      vi.stubGlobal('fetch', ari.fetchImpl)

      await expect(client.hangup('gone')).resolves.toBeUndefined()
      expect(ari.requests[0].method).toBe('DELETE')
      expect(ari.requests[0].path).toBe('/channels/gone')
      expect(ari.requests[0].query.get('reason')).toBe('normal')
    })

    it('bridge() puts both channels in one mixing bridge', async () => {
      ari = fakeAri([(req) => (req.method === 'POST' && req.path === '/bridges' ? json({ id: 'b-1', channels: [] }) : undefined)])
      vi.stubGlobal('fetch', ari.fetchImpl)

      await expect(client.bridge('caller', 'volunteer')).resolves.toBe('b-1')
      expect(ari.requests.map((r) => `${r.method} ${r.path} ${r.query.get('channel') ?? ''}`.trim())).toEqual([
        'POST /bridges',
        'POST /bridges/b-1/addChannel caller',
        'POST /bridges/b-1/addChannel volunteer',
      ])
      expect(ari.requests[0].body).toEqual({ type: 'mixing' })
    })

    it('a passthrough (SFrame) bridge is created as a valid ARI type, never `simple_bridge`', async () => {
      // `simple_bridge` is a bridge technology; ARI answers a 500 when asked for it as a type.
      ari = fakeAri([(req) => (req.method === 'POST' && req.path === '/bridges' ? json({ id: 'b-2', channels: [] }) : undefined)])
      vi.stubGlobal('fetch', ari.fetchImpl)

      await client.bridge('caller', 'volunteer', { type: 'passthrough' })
      expect(ari.requests[0].body).toEqual({ type: 'mixing' })
      await expect(client.bridge('a', 'b', { type: 'passthrough', record: true })).rejects.toThrow('must not be recorded')
    })

    it('records a channel with the finish key and time limit, and a bridge', async () => {
      await client.recordChannel('ch-1', { name: 'voicemail-ch-1', maxDurationSeconds: 120, beep: true, terminateOn: '#' })
      await client.recordBridge('b-1', { name: 'call-ch-1' })

      expect(ari.requests[0].path).toBe('/channels/ch-1/record')
      expect(ari.requests[0].body).toEqual({ name: 'voicemail-ch-1', format: 'wav', maxDurationSeconds: 120, beep: true, terminateOn: '#' })
      expect(ari.requests[1].path).toBe('/bridges/b-1/record')
      expect(ari.requests[1].body).toEqual({ name: 'call-ch-1', format: 'wav', maxDurationSeconds: 0, beep: false, terminateOn: 'none' })
    })

    it('stopRecording stops the live recording and tolerates one that already ended', async () => {
      ari = fakeAri([() => json({ message: 'Recording not found' }, 404)])
      vi.stubGlobal('fetch', ari.fetchImpl)
      await expect(client.stopRecording('call-ch-1')).resolves.toBeUndefined()
      expect(`${ari.requests[0].method} ${ari.requests[0].path}`).toBe('POST /recordings/live/call-ch-1/stop')
    })

    it('getRecordingFile returns the stored audio, or null when there is none', async () => {
      const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3])
      ari = fakeAri([
        (req) => (req.path === '/recordings/stored/call-ch-1/file' ? new Response(wav, { status: 200 }) : undefined),
        () => json({ message: 'Recording not found' }, 404),
      ])
      vi.stubGlobal('fetch', ari.fetchImpl)

      const audio = await client.getRecordingFile('call-ch-1')
      expect(audio && new Uint8Array(audio)).toEqual(wav)
      await expect(client.getRecordingFile('missing')).resolves.toBeNull()
    })

    it('a failed request surfaces the status and ARI message', async () => {
      ari = fakeAri([() => json({ message: 'Channel not in Stasis application' }, 409)])
      vi.stubGlobal('fetch', ari.fetchImpl)
      await expect(client.answer('ch-1')).rejects.toThrow('ARI POST /channels/ch-1/answer failed: 409')
    })
  })

  describe('healthCheck', () => {
    it('reports Asterisk info when ARI answers, and not ok when it does not', async () => {
      ari = fakeAri([(req) => (req.path === '/asterisk/info' ? json({ system: { version: '22.8.2' } }) : undefined)])
      vi.stubGlobal('fetch', ari.fetchImpl)
      await expect(client.healthCheck()).resolves.toMatchObject({ ok: true, details: { system: { version: '22.8.2' } } })

      vi.stubGlobal('fetch', vi.fn(async () => json({ message: 'Unauthorized' }, 401)))
      await expect(client.healthCheck()).resolves.toMatchObject({ ok: false })
    })
  })
})
