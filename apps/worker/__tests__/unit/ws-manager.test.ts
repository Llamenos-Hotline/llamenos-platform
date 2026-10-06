import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ConnectionManager } from '../../lib/ws-manager'
import type { ConnectionState } from '../../lib/ws-manager'
import { KIND_CALL_RING, KIND_CALL_UPDATE, KIND_CALL_VOICEMAIL, KIND_MESSAGE_NEW } from '@shared/event-kinds'
import { incCounter } from '../../routes/metrics'

vi.mock('../../routes/metrics', () => ({
  incCounter: vi.fn(),
}))

// Mock server key (32 bytes)
const SERVER_KEY = new Uint8Array(32).fill(1)

function makeMockWs() {
  return { send: vi.fn(), close: vi.fn() } as unknown as WebSocket
}

function makeConn(pubkey: string, hubs: string[]): ConnectionState {
  return {
    pubkey,
    ws: makeMockWs(),
    hubs: new Set(hubs),
    subscribedHubs: new Set(),
    lastReplayAt: 0,
  }
}

describe('ConnectionManager.unsubscribe', () => {
  let manager: ConnectionManager

  beforeEach(() => {
    manager = new ConnectionManager(SERVER_KEY)
  })

  it('does not remove hub from membership (hubs) when unsubscribing', () => {
    const conn = makeConn('pubkey-a', ['hub-1', 'hub-2'])
    manager.register(conn)
    manager.subscribe(conn, 'hub-1', [1000])

    manager.unsubscribe('pubkey-a', 'hub-1')

    // Membership must be preserved — user can re-subscribe
    expect(conn.hubs.has('hub-1')).toBe(true)
    expect(conn.hubs.has('hub-2')).toBe(true)
  })

  it('removes hub from subscribedHubs when unsubscribing', () => {
    const conn = makeConn('pubkey-a', ['hub-1'])
    manager.register(conn)
    manager.subscribe(conn, 'hub-1', [1000])
    expect(conn.subscribedHubs.has('hub-1')).toBe(true)

    manager.unsubscribe('pubkey-a', 'hub-1')

    expect(conn.subscribedHubs.has('hub-1')).toBe(false)
  })

  it('allows re-subscribing to a hub after unsubscribing', () => {
    const conn = makeConn('pubkey-a', ['hub-1'])
    manager.register(conn)
    manager.subscribe(conn, 'hub-1', [1000])
    manager.unsubscribe('pubkey-a', 'hub-1')

    // hub membership still intact — can subscribe again
    expect(conn.hubs.has('hub-1')).toBe(true)
    manager.subscribe(conn, 'hub-1', [1000])
    expect(conn.subscribedHubs.has('hub-1')).toBe(true)
  })

  it('does not affect other hubs when unsubscribing from one', () => {
    const conn = makeConn('pubkey-a', ['hub-1', 'hub-2'])
    manager.register(conn)
    manager.subscribe(conn, 'hub-1', [1000])
    manager.subscribe(conn, 'hub-2', [1001])

    manager.unsubscribe('pubkey-a', 'hub-1')

    expect(conn.hubs.has('hub-2')).toBe(true)
    expect(conn.subscribedHubs.has('hub-2')).toBe(true)
  })
})

describe('ConnectionManager.evictMember', () => {
  let manager: ConnectionManager

  beforeEach(() => {
    manager = new ConnectionManager(SERVER_KEY)
  })

  it('removes hub from membership and sends unsubscribed message', () => {
    const conn = makeConn('pubkey-a', ['hub-1'])
    manager.register(conn)
    manager.subscribe(conn, 'hub-1', [1000])

    manager.evictMember('pubkey-a', 'hub-1')

    expect(conn.hubs.has('hub-1')).toBe(false)
    expect((conn.ws.send as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0)
    const lastCall = (conn.ws.send as ReturnType<typeof vi.fn>).mock.calls.at(-1) ?? []
    const lastMsg = JSON.parse(lastCall[0] as string)
    expect(lastMsg.type).toBe('unsubscribed')
    expect(lastMsg.reason).toBe('membership_revoked')
  })
})

describe('ConnectionManager.unregister', () => {
  let manager: ConnectionManager

  beforeEach(() => {
    manager = new ConnectionManager(SERVER_KEY)
  })

  it('cleans up subscriptions using subscribedHubs (not hubs)', () => {
    const conn = makeConn('pubkey-a', ['hub-1', 'hub-2'])
    manager.register(conn)
    manager.subscribe(conn, 'hub-1', [1000])
    // hub-2 is in membership but NOT subscribed

    manager.unregister(conn)

    // After unregister, no fan-out entries should remain for pubkey-a in hub-1
    // Verify by trying to publish — no send calls on the already-closed conn
    conn.ws.send = vi.fn()
    manager.publishToHub('hub-1', 1000, 'payload', 0)
    expect((conn.ws.send as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })
})

// #1136: a hub sustaining a real call surge (~33 calls/min, ~3 events per call) must
// never have its call:ring/update/voicemail events shed by the per-kind-group rate
// limit the way a blast-progress tick would be — a dropped ring is a crisis line that
// silently stops working.
describe('ConnectionManager.publishToHub — call event rate limiting (#1136)', () => {
  let manager: ConnectionManager

  beforeEach(() => {
    vi.clearAllMocks()
    manager = new ConnectionManager(SERVER_KEY)
  })

  it('never rate-limits call:ring events even far above the old 100/min "calls" cap', () => {
    for (let i = 0; i < 250; i++) {
      expect(manager.publishToHub('hub-1', KIND_CALL_RING, 'payload', 0)).toBe(true)
    }
    expect(incCounter).not.toHaveBeenCalled()
  })

  it('never rate-limits call:update or call:voicemail events either', () => {
    for (let i = 0; i < 150; i++) {
      expect(manager.publishToHub('hub-1', KIND_CALL_UPDATE, 'payload', 0)).toBe(true)
      expect(manager.publishToHub('hub-1', KIND_CALL_VOICEMAIL, 'payload', 0)).toBe(true)
    }
  })

  it('still rate-limits a non-call kind group (messages) and returns false on drop', () => {
    let lastResult = true
    for (let i = 0; i < 201; i++) {
      lastResult = manager.publishToHub('hub-1', KIND_MESSAGE_NEW, 'payload', 0)
    }
    expect(lastResult).toBe(false)
    expect(incCounter).toHaveBeenCalledWith('llamenos_relay_events_dropped_total', { reason: 'rate_limited', kindGroup: 'messages' })
  })

  it('returns true for a normal, non-rate-limited publish', () => {
    expect(manager.publishToHub('hub-1', KIND_MESSAGE_NEW, 'payload', 0)).toBe(true)
  })
})
