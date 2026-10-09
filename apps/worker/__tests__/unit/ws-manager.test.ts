import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  ConnectionManager,
  WS_CLOSE_REASON_SERVER_SHUTDOWN,
  WS_CLOSE_SERVER_SHUTDOWN,
} from '../../lib/ws-manager'
import type { ConnectionState } from '../../lib/ws-manager'

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

describe('ConnectionManager.closeAll', () => {
  it('closes every connection of every user with the given code and reason', () => {
    const manager = new ConnectionManager(SERVER_KEY)
    const a1 = makeConn('pubkey-a', ['hub-1'])
    const a2 = makeConn('pubkey-a', ['hub-1'])
    const b = makeConn('pubkey-b', ['hub-1'])
    for (const c of [a1, a2, b]) manager.register(c)
    manager.subscribe(a1, 'hub-1', [1000])

    const closed = manager.closeAll(WS_CLOSE_SERVER_SHUTDOWN, WS_CLOSE_REASON_SERVER_SHUTDOWN)

    expect(closed).toBe(3)
    for (const c of [a1, a2, b]) {
      expect(c.ws.close).toHaveBeenCalledWith(1001, 'server_shutting_down')
    }
  })

  it('keeps closing the remaining connections when one socket throws', () => {
    const manager = new ConnectionManager(SERVER_KEY)
    const dead = makeConn('pubkey-a', ['hub-1'])
    ;(dead.ws.close as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('already closed')
    })
    const live = makeConn('pubkey-b', ['hub-1'])
    manager.register(dead)
    manager.register(live)

    expect(manager.closeAll(1001, 'x')).toBe(1)
    expect(live.ws.close).toHaveBeenCalledWith(1001, 'x')
  })

  it('leaves no registered connections behind, so new registrations start clean', () => {
    const manager = new ConnectionManager(SERVER_KEY)
    manager.register(makeConn('pubkey-a', ['hub-1']))
    manager.closeAll(1001, 'x')
    expect(manager.closeAll(1001, 'x')).toBe(0)
  })
})

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
