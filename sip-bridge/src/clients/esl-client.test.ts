import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EslClient } from './esl-client'
import type { BridgeEvent } from '../bridge-client'

// ---- Fake FreeSWITCH Event Socket -------------------------------------------------
// vitest runs under Node, so Bun.connect is stubbed with a fake socket the test drives
// by hand — it plays the role of FreeSWITCH.

interface SocketHandlers {
  open(socket: FakeSocket): void
  data(socket: FakeSocket, data: Uint8Array): void
  close(socket: FakeSocket): void
  error(socket: FakeSocket, error: Error): void
  connectError(socket: FakeSocket, error: Error): void
}

class FakeSocket {
  readonly written: string[] = []
  ended = false
  constructor(private readonly handlers: SocketHandlers) {}

  write(text: string): void {
    this.written.push(text)
  }
  end(): void {
    this.ended = true
    this.handlers.close(this)
  }

  /** FreeSWITCH -> client */
  receive(raw: string): void {
    this.handlers.data(this, new TextEncoder().encode(raw))
  }
  /** FreeSWITCH drops the TCP connection */
  drop(): void {
    this.handlers.close(this)
  }

  authRequest(): void {
    this.receive('Content-Type: auth/request\n\n')
  }
  reply(text: string): void {
    this.receive(`Content-Type: command/reply\nReply-Text: ${text}\n\n`)
  }
  apiResponse(body: string): void {
    this.receive(`Content-Type: api/response\nContent-Length: ${body.length}\n\n${body}`)
  }
  event(headers: Record<string, string>): void {
    const body = `${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n`
    this.receive(`Content-Type: text/event-plain\nContent-Length: ${body.length}\n\n${body}`)
  }
  /** Run the full auth + subscribe handshake */
  handshake(): void {
    this.authRequest()
    this.reply('+OK accepted')
    this.reply('+OK event listener enabled plain')
  }
}

const SUBSCRIBE = 'event plain CHANNEL_CREATE CHANNEL_ANSWER CHANNEL_HANGUP_COMPLETE RECORD_STOP DTMF\n\n'

let sockets: FakeSocket[] = []

function stubBun(): void {
  vi.stubGlobal('Bun', {
    connect: vi.fn(async (opts: { socket: SocketHandlers }) => {
      const sock = new FakeSocket(opts.socket)
      sockets.push(sock)
      opts.socket.open(sock)
      return sock
    }),
  })
}

/** Let promise continuations run without advancing fake timers. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

async function connected(client: EslClient): Promise<FakeSocket> {
  const p = client.connect()
  await flush()
  const sock = sockets[sockets.length - 1]
  sock.handshake()
  await p
  return sock
}

describe('EslClient', () => {
  let client: EslClient

  beforeEach(() => {
    vi.useFakeTimers()
    sockets = []
    stubBun()
    client = new EslClient({ password: 'pw' })
  })

  afterEach(() => {
    client.disconnect()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('authenticates, subscribes to events once, and reports connected', async () => {
    const sock = await connected(client)
    expect(sock.written).toEqual(['auth pw\n\n', SUBSCRIBE])
    expect(client.isConnected()).toBe(true)
  })

  it('re-sends the event subscription after a dropped connection and reports connected again', async () => {
    const first = await connected(client)
    expect(first.written).toContain(SUBSCRIBE)

    first.drop()
    expect(client.isConnected()).toBe(false)

    await vi.advanceTimersByTimeAsync(1_500)
    expect(sockets).toHaveLength(2)
    const second = sockets[1]
    second.authRequest()
    expect(second.written).toEqual(['auth pw\n\n'])
    second.reply('+OK accepted')
    // The regression: this subscription used to be skipped on every reconnect.
    expect(second.written).toEqual(['auth pw\n\n', SUBSCRIBE])
    second.reply('+OK event listener enabled plain')

    expect(client.isConnected()).toBe(true)

    // ...and events on the new connection actually reach handlers
    const seen: BridgeEvent[] = []
    client.onEvent((e) => seen.push(e))
    second.event({ 'Event-Name': 'CHANNEL_CREATE', 'Unique-ID': 'abc', 'Caller-Caller-ID-Number': '+15550001' })
    expect(seen).toEqual([expect.objectContaining({ type: 'channel_create', channelId: 'abc' })])
  })

  it('does not let the auth +OK on a reconnect resolve an unrelated queued command', async () => {
    const first = await connected(client)
    first.drop()
    await vi.advanceTimersByTimeAsync(1_500)
    const second = sockets[1]

    // A command issued while the new connection is still handshaking must fail fast,
    // not sit in the queue where the auth +OK would resolve it.
    await expect(client.answer('uuid-1')).rejects.toThrow(/Not connected/)
    second.authRequest()
    second.reply('+OK accepted')
    second.reply('+OK event listener enabled plain')

    const pending = client.getChannelVar('uuid-1', 'x')
    second.apiResponse('value')
    await expect(pending).resolves.toBe('value')
  })

  it('emits connection_reset every time a handshake completes so the handler can reconcile', async () => {
    const seen: BridgeEvent['type'][] = []
    client.onEvent((e) => seen.push(e.type))
    const first = await connected(client)
    expect(seen).toEqual(['connection_reset'])

    first.drop()
    await vi.advanceTimersByTimeAsync(1_500)
    sockets[1].handshake()
    expect(seen).toEqual(['connection_reset', 'connection_reset'])
  })

  it('resets the reconnect backoff once a connection succeeds', async () => {
    const first = await connected(client)

    // Fail two reconnect attempts to grow the backoff (1s -> 2s -> 4s)...
    first.drop()
    await vi.advanceTimersByTimeAsync(1_500)
    sockets[1].drop()
    await vi.advanceTimersByTimeAsync(2_600)
    expect(sockets).toHaveLength(3)
    // ...then succeed.
    sockets[2].handshake()
    expect(client.isConnected()).toBe(true)

    // The next drop must reconnect after ~1s again, not stay at the grown delay.
    sockets[2].drop()
    await vi.advanceTimersByTimeAsync(1_300)
    expect(sockets).toHaveLength(4)
  })

  it('discards a partial frame from the dead connection instead of mis-framing the new stream', async () => {
    const first = await connected(client)
    // Half a frame: headers announce a 100-byte body that never arrives.
    first.receive('Content-Type: api/response\nContent-Length: 100\n\npartial')
    first.drop()

    await vi.advanceTimersByTimeAsync(1_500)
    const second = sockets[1]
    second.handshake() // would be swallowed by the stale buffer before the fix
    expect(client.isConnected()).toBe(true)
    expect(second.written).toContain(SUBSCRIBE)
  })

  it('rejects in-flight commands when the connection closes', async () => {
    const sock = await connected(client)
    const pending = client.getChannelVar('uuid-1', 'x')
    const assertion = expect(pending).rejects.toThrow(/closed/)
    sock.drop()
    await assertion
  })

  it('times out a command that never gets a reply, and does not misattribute the late reply', async () => {
    const sock = await connected(client)
    const slow = client.getChannelVar('uuid-1', 'slow')
    const slowAssertion = expect(slow).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(10_001)
    await slowAssertion

    const next = client.getChannelVar('uuid-1', 'next')
    sock.apiResponse('late-reply-for-slow') // belongs to the timed-out command
    sock.apiResponse('reply-for-next')
    await expect(next).resolves.toBe('reply-for-next')
  })

  it('does not reconnect after an explicit disconnect()', async () => {
    await connected(client)
    client.disconnect()
    expect(client.isConnected()).toBe(false)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sockets).toHaveLength(1)
  })

  it('a late close from a superseded socket does not tear down the live connection', async () => {
    const first = await connected(client)
    first.drop()
    await vi.advanceTimersByTimeAsync(1_500)
    const second = sockets[1]
    second.handshake()
    expect(client.isConnected()).toBe(true)

    first.drop() // duplicate/late close of the old socket
    expect(client.isConnected()).toBe(true)
  })

  it('does not reconnect after an authentication failure', async () => {
    const p = client.connect()
    const assertion = expect(p).rejects.toThrow(/Authentication failed/)
    await flush()
    sockets[0].authRequest()
    sockets[0].reply('-ERR invalid')
    await assertion
    sockets[0].drop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sockets).toHaveLength(1)
  })

  it('listChannels parses FreeSWITCH `show channels as json`, including the empty reply', async () => {
    const sock = await connected(client)
    const p = client.listChannels()
    sock.apiResponse(JSON.stringify({ row_count: 1, rows: [{ uuid: 'u1', state: 'CS_EXECUTE', cid_num: '+1555' }] }))
    await expect(p).resolves.toEqual([{ id: 'u1', state: 'CS_EXECUTE', caller: '+1555' }])

    const empty = client.listChannels()
    sock.apiResponse('{"row_count":0}')
    await expect(empty).resolves.toEqual([])
  })
})
