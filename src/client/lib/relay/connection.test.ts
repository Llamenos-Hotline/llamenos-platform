/**
 * Remote wipe over the relay (#1093).
 *
 * Drives a real `RelayConnection` through a scripted socket: challenge → auth →
 * authenticated, then server frames. Server signatures are real Ed25519 over the
 * exact strings the server signs (`apps/worker/lib/ws-manager.ts`), and
 * `ed25519Verify` is backed by @noble/curves, so a forged or misdirected
 * signature fails exactly as it would through the Rust verifier.
 *
 * The wipe is observed through its effects: `wipeKey()` called and the
 * `device:wiped` window event dispatched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ed25519 } from '@noble/curves/ed25519.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@shared/encoding'
import { WS_PROTOCOL_VERSION } from '@protocol/schemas/ws-messages'

const wipeKey = vi.fn(async () => {})

vi.mock('../key-manager', () => ({ wipeKey }))

vi.mock('../platform', () => ({
  ed25519Sign: vi.fn(async () => '00'.repeat(64)),
  ed25519Verify: vi.fn(async (messageHex: string, sigHex: string, pubkeyHex: string) => {
    try {
      return ed25519.verify(hexToBytes(sigHex), hexToBytes(messageHex), hexToBytes(pubkeyHex))
    } catch {
      return false
    }
  }),
  // The scripted server sends event payloads in the clear: "decryption" is the
  // identity, so a test controls exactly what content the client sees.
  decryptServerEvent: vi.fn(async (payload: string) => payload),
}))

class ScriptedSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readyState = ScriptedSocket.CONNECTING
  readonly sent: string[] = []

  constructor() {
    super()
    queueMicrotask(() => {
      this.readyState = ScriptedSocket.OPEN
      this.dispatchEvent(new Event('open'))
    })
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    if (this.readyState === ScriptedSocket.CLOSED) return
    this.readyState = ScriptedSocket.CLOSED
    this.dispatchEvent(new Event('close'))
  }

  /** Deliver a server frame to the client. */
  receive(frame: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }))
  }
}

const sockets: ScriptedSocket[] = []

vi.mock('../net', () => ({
  createRelaySocket: vi.fn(() => {
    const socket = new ScriptedSocket()
    sockets.push(socket)
    return socket
  }),
}))

const { RelayConnection } = await import('./connection')

const serverSecret = ed25519.utils.randomSecretKey()
const serverPubkey = bytesToHex(ed25519.getPublicKey(serverSecret))
const attackerSecret = ed25519.utils.randomSecretKey()
const devicePubkey = bytesToHex(ed25519.getPublicKey(ed25519.utils.randomSecretKey()))
const otherDevicePubkey = bytesToHex(ed25519.getPublicKey(ed25519.utils.randomSecretKey()))

function sign(secret: Uint8Array, message: string): string {
  return bytesToHex(ed25519.sign(utf8ToBytes(message), secret))
}

/** The frame `sendSignedWipeToUser(target, payload)` puts on the wire. */
function signedWipeFrame(
  target: string,
  opts: { ts?: number; secret?: Uint8Array; extra?: Record<string, unknown> } = {},
) {
  const ts = opts.ts ?? Date.now()
  const sig = sign(opts.secret ?? serverSecret, `${WS_PROTOCOL_VERSION}:device:wipe:${target}:${ts}`)
  return {
    type: 'device:wipe',
    reason: 'admin-erasure',
    timestamp: new Date(ts).toISOString(),
    ...opts.extra,
    sig,
    ts,
  }
}

/** A hub event the server genuinely signed, whose decrypted content is `content`. */
function signedHubEvent(hubId: string, kind: number, content: unknown) {
  const ts = Date.now()
  const payload = JSON.stringify(content)
  const epoch = 1
  const sig = sign(serverSecret, `${WS_PROTOCOL_VERSION}:${hubId}:${kind}:${epoch}:${payload}:${ts}`)
  return { type: 'event', v: WS_PROTOCOL_VERSION, hubId, kind, payload, epoch, ts, sig }
}

/** Let every in-flight verification settle: all mocks resolve without I/O. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}

let wipedEvents: Array<{ reason: string }>
const onWiped = (e: Event) => wipedEvents.push((e as CustomEvent<{ reason: string }>).detail)

async function connectAuthenticated() {
  const connection = new RelayConnection({ relayUrl: 'ws://relay.test/ws', serverPubkey, devicePubkey })
  await connection.connect()
  const socket = sockets[sockets.length - 1]
  socket.receive({ type: 'challenge', nonce: 'ab'.repeat(32) })
  socket.receive({ type: 'authenticated', hubs: ['hub-1'] })
  await vi.waitFor(() => expect(connection.getState()).toBe('connected'))
  return { connection, socket }
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', ScriptedSocket)
  sockets.length = 0
  wipeKey.mockClear()
  wipedEvents = []
  window.addEventListener('device:wiped', onWiped)
  localStorage.setItem('wipe-test-sentinel', '1')
})

afterEach(() => {
  window.removeEventListener('device:wiped', onWiped)
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('RelayConnection remote wipe', () => {
  it('wipes on a server-signed top-level device:wipe frame aimed at this device', async () => {
    const { connection, socket } = await connectAuthenticated()

    socket.receive(signedWipeFrame(devicePubkey, { extra: { targetUserId: devicePubkey, reason: 'user-erasure' } }))

    await vi.waitFor(() => expect(wipeKey).toHaveBeenCalledTimes(1))
    expect(wipedEvents).toEqual([{ reason: 'user-erasure' }])
    expect(localStorage.getItem('wipe-test-sentinel')).toBeNull()
    // The connection is torn down for good: no reconnect with a wiped key.
    expect(connection.getState()).toBe('disconnected')
    expect(socket.readyState).toBe(ScriptedSocket.CLOSED)
    await settle()
    expect(sockets).toHaveLength(1)
  })

  it('honours a device-revocation wipe that names this device', async () => {
    const { socket } = await connectAuthenticated()

    socket.receive(signedWipeFrame(devicePubkey, {
      extra: { targetDevicePubkey: devicePubkey, reason: 'device-revocation' },
    }))

    await vi.waitFor(() => expect(wipeKey).toHaveBeenCalledTimes(1))
    expect(wipedEvents).toEqual([{ reason: 'device-revocation' }])
  })

  it('never derives a wipe from encrypted hub-event content, however well signed', async () => {
    const { connection, socket } = await connectAuthenticated()
    const delivered: unknown[] = []
    connection.subscribe('hub-1', [1], (_kind, content) => delivered.push(content))

    socket.receive(signedHubEvent('hub-1', 1, { type: 'device:wipe', reason: 'admin-erasure' }))
    await settle()

    expect(wipeKey).not.toHaveBeenCalled()
    expect(wipedEvents).toEqual([])
    expect(localStorage.getItem('wipe-test-sentinel')).toBe('1')
    expect(connection.getState()).toBe('connected')
    // It is an ordinary (unknown-type) event, not swallowed by a wipe branch.
    expect(delivered).toEqual([{ type: 'device:wipe', reason: 'admin-erasure' }])
  })

  it('ignores a correctly signed wipe for a different device', async () => {
    const { connection, socket } = await connectAuthenticated()

    socket.receive(signedWipeFrame(otherDevicePubkey))
    socket.receive(signedWipeFrame(otherDevicePubkey, { extra: { targetDevicePubkey: otherDevicePubkey } }))
    await settle()

    expect(wipeKey).not.toHaveBeenCalled()
    expect(wipedEvents).toEqual([])
    expect(connection.getState()).toBe('connected')
  })

  it('ignores a validly signed wipe whose explicit target names another device', async () => {
    const { socket } = await connectAuthenticated()

    socket.receive(signedWipeFrame(devicePubkey, { extra: { targetDevicePubkey: otherDevicePubkey } }))
    socket.receive(signedWipeFrame(devicePubkey, { extra: { targetUserId: otherDevicePubkey } }))
    await settle()

    expect(wipeKey).not.toHaveBeenCalled()
    expect(wipedEvents).toEqual([])
  })

  it('ignores unsigned, forged and malformed wipe frames', async () => {
    const { socket } = await connectAuthenticated()

    socket.receive({ type: 'device:wipe', reason: 'admin-erasure', ts: Date.now() })
    socket.receive({ type: 'device:wipe', reason: 'admin-erasure', ts: Date.now(), sig: '' })
    socket.receive(signedWipeFrame(devicePubkey, { secret: attackerSecret }))
    socket.receive({ ...signedWipeFrame(devicePubkey), ts: Date.now() + 1 })
    socket.receive({ ...signedWipeFrame(devicePubkey), ts: String(Date.now()) })
    await settle()

    expect(wipeKey).not.toHaveBeenCalled()
    expect(wipedEvents).toEqual([])
  })

  it('ignores a genuinely signed wipe that is stale or from the future', async () => {
    const { socket } = await connectAuthenticated()

    socket.receive(signedWipeFrame(devicePubkey, { ts: Date.now() - 6 * 60 * 1000 }))
    socket.receive(signedWipeFrame(devicePubkey, { ts: Date.now() + 60 * 1000 }))
    await settle()

    expect(wipeKey).not.toHaveBeenCalled()
    expect(wipedEvents).toEqual([])
  })

  it('ignores a wipe that arrives before the socket authenticated', async () => {
    const connection = new RelayConnection({ relayUrl: 'ws://relay.test/ws', serverPubkey, devicePubkey })
    await connection.connect()
    const socket = sockets[sockets.length - 1]

    socket.receive(signedWipeFrame(devicePubkey))
    await settle()

    expect(wipeKey).not.toHaveBeenCalled()
    expect(wipedEvents).toEqual([])
    connection.close()
  })

  it('wipes once even if the server sends the frame twice', async () => {
    const { socket } = await connectAuthenticated()
    const frame = signedWipeFrame(devicePubkey)

    socket.receive(frame)
    socket.receive(frame)
    await vi.waitFor(() => expect(wipeKey).toHaveBeenCalledTimes(1))
    await settle()

    expect(wipeKey).toHaveBeenCalledTimes(1)
    expect(wipedEvents).toHaveLength(1)
  })
})
