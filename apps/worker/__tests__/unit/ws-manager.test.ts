import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ConnectionManager } from '../../lib/ws-manager'
import type { ConnectionState } from '../../lib/ws-manager'

// Mock server key (32 bytes)
const SERVER_KEY = new Uint8Array(32).fill(1)

/**
 * A relay socket that records every event frame the server sends it.
 *
 * Subscriptions are asserted through DELIVERY, never through a field on the
 * connection: a per-connection `subscribedHubs` set used to be the assertion
 * target here, and it described a scoping the fan-out never applied (#1655).
 */
function makeConn(pubkey: string, hubs: string[]): ConnectionState & {
  sent: () => Array<Record<string, unknown>>
} {
  const frames: string[] = []
  const state = {
    pubkey,
    ws: {
      send: vi.fn((m: string) => { frames.push(m) }),
      close: vi.fn(),
    } as unknown as WebSocket,
    hubs: new Set(hubs),
    lastReplayAt: 0,
    sent: () => frames.map(f => JSON.parse(f) as Record<string, unknown>),
  }
  return state
}

/** Event frames (not control frames) a connection received, by hubId. */
function eventHubs(conn: { sent: () => Array<Record<string, unknown>> }): string[] {
  return conn.sent().filter(m => m.type === 'event').map(m => m.hubId as string)
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

  it('stops delivering a hub to the user after unsubscribing', () => {
    const conn = makeConn('pubkey-a', ['hub-1'])
    manager.register(conn)
    manager.subscribe(conn, 'hub-1', [1000])
    manager.publishToHub('hub-1', 1000, 'before', 0)
    expect(eventHubs(conn)).toEqual(['hub-1'])

    manager.unsubscribe('pubkey-a', 'hub-1')
    manager.publishToHub('hub-1', 1000, 'after', 0)

    expect(eventHubs(conn)).toEqual(['hub-1'])
  })

  it('allows re-subscribing to a hub after unsubscribing', () => {
    const conn = makeConn('pubkey-a', ['hub-1'])
    manager.register(conn)
    manager.subscribe(conn, 'hub-1', [1000])
    manager.unsubscribe('pubkey-a', 'hub-1')

    // hub membership still intact — can subscribe again
    expect(conn.hubs.has('hub-1')).toBe(true)
    manager.subscribe(conn, 'hub-1', [1000])
    manager.publishToHub('hub-1', 1000, 'payload', 0)

    expect(eventHubs(conn)).toEqual(['hub-1'])
  })

  it('does not affect other hubs when unsubscribing from one', () => {
    const conn = makeConn('pubkey-a', ['hub-1', 'hub-2'])
    manager.register(conn)
    manager.subscribe(conn, 'hub-1', [1000])
    manager.subscribe(conn, 'hub-2', [1000])

    manager.unsubscribe('pubkey-a', 'hub-1')
    manager.publishToHub('hub-1', 1000, 'gone', 0)
    manager.publishToHub('hub-2', 1000, 'still here', 0)

    expect(conn.hubs.has('hub-2')).toBe(true)
    expect(eventHubs(conn)).toEqual(['hub-2'])
  })

  it('unsubscribes the user on every connection they hold', () => {
    // Per-user subscriptions are the architecture (#1655): one channel per
    // client carrying every hub the user subscribed. Dropping a hub therefore
    // drops it everywhere, which is why unsubscribe takes a pubkey.
    const first = makeConn('pubkey-a', ['hub-1'])
    const second = makeConn('pubkey-a', ['hub-1'])
    manager.register(first)
    manager.register(second)
    manager.subscribe(first, 'hub-1', [1000])

    manager.unsubscribe('pubkey-a', 'hub-1')
    manager.publishToHub('hub-1', 1000, 'payload', 0)

    expect(eventHubs(first)).toEqual([])
    expect(eventHubs(second)).toEqual([])
  })
})

describe('ConnectionManager.publishToHub', () => {
  let manager: ConnectionManager

  beforeEach(() => {
    manager = new ConnectionManager(SERVER_KEY)
  })

  it('delivers a hub event to every connection of a subscribed user', () => {
    // The multi-hub routing axiom (CLAUDE.md): a member must receive a hub's
    // events on its channel regardless of which socket asked for that hub, so
    // a device never misses a ring for a hub it belongs to. A per-connection
    // hub filter in the fan-out would break this assertion.
    const asked = makeConn('pubkey-a', ['hub-1'])
    const silent = makeConn('pubkey-a', ['hub-1'])
    manager.register(asked)
    manager.register(silent)
    manager.subscribe(asked, 'hub-1', [1000])

    manager.publishToHub('hub-1', 1000, 'payload', 0)

    expect(eventHubs(asked)).toEqual(['hub-1'])
    expect(eventHubs(silent)).toEqual(['hub-1'])
  })

  it('carries every subscribed hub on one channel, not just the one it asked for', () => {
    const channel = makeConn('pubkey-a', ['hub-1', 'hub-2'])
    const other = makeConn('pubkey-a', ['hub-1', 'hub-2'])
    manager.register(channel)
    manager.register(other)
    manager.subscribe(channel, 'hub-1', [1000])
    manager.subscribe(other, 'hub-2', [1000])

    manager.publishToHub('hub-2', 1000, 'payload', 0)

    // The socket that only ever asked for hub-1 still receives hub-2
    expect(eventHubs(channel)).toEqual(['hub-2'])
  })

  it('never delivers a hub the user has not subscribed to', () => {
    const conn = makeConn('pubkey-a', ['hub-1', 'hub-2'])
    manager.register(conn)
    manager.subscribe(conn, 'hub-1', [1000])

    manager.publishToHub('hub-2', 1000, 'payload', 0)

    expect(eventHubs(conn)).toEqual([])
  })

  it('never delivers to a different user', () => {
    const mine = makeConn('pubkey-a', ['hub-1'])
    const theirs = makeConn('pubkey-b', ['hub-1'])
    manager.register(mine)
    manager.register(theirs)
    manager.subscribe(mine, 'hub-1', [1000])

    manager.publishToHub('hub-1', 1000, 'payload', 0)

    expect(eventHubs(mine)).toEqual(['hub-1'])
    expect(eventHubs(theirs)).toEqual([])
  })

  it('respects the subscribed kinds', () => {
    const conn = makeConn('pubkey-a', ['hub-1'])
    manager.register(conn)
    manager.subscribe(conn, 'hub-1', [1000])

    manager.publishToHub('hub-1', 1001, 'payload', 0)

    expect(eventHubs(conn)).toEqual([])
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
    const last = conn.sent().at(-1)
    expect(last?.type).toBe('unsubscribed')
    expect(last?.reason).toBe('membership_revoked')
  })

  it('stops delivery to a socket that was open when membership was revoked', () => {
    // The stale-socket case: membership goes away while the socket stays open.
    const conn = makeConn('pubkey-a', ['hub-1'])
    manager.register(conn)
    manager.subscribe(conn, 'hub-1', [1000])

    manager.evictMember('pubkey-a', 'hub-1')
    manager.publishToHub('hub-1', 1000, 'payload', 0)

    expect(eventHubs(conn)).toEqual([])
  })
})

describe('ConnectionManager.unregister', () => {
  let manager: ConnectionManager

  beforeEach(() => {
    manager = new ConnectionManager(SERVER_KEY)
  })

  it('keeps the user subscribed while another of their connections is open', () => {
    const closing = makeConn('pubkey-a', ['hub-1'])
    const staying = makeConn('pubkey-a', ['hub-1'])
    manager.register(closing)
    manager.register(staying)
    manager.subscribe(closing, 'hub-1', [1000])

    manager.unregister(closing)
    manager.publishToHub('hub-1', 1000, 'payload', 0)

    expect(eventHubs(staying)).toEqual(['hub-1'])
  })

  it('drops the subscription once the last connection closes', () => {
    const conn = makeConn('pubkey-a', ['hub-1'])
    manager.register(conn)
    manager.subscribe(conn, 'hub-1', [1000])

    manager.unregister(conn)

    // A fresh connection for the same user must receive nothing until it
    // subscribes again — a surviving hubSubscriptions entry would deliver.
    const reconnect = makeConn('pubkey-a', ['hub-1'])
    manager.register(reconnect)
    manager.publishToHub('hub-1', 1000, 'payload', 0)

    expect(eventHubs(reconnect)).toEqual([])
  })

  it('drops hubs subscribed on a connection that was not the last to close', () => {
    // The per-connection set leaked exactly here: hub-2 was recorded only on
    // `first`, so when `second` closed last, hub-2's subscription survived for
    // the lifetime of the process (#1655).
    const first = makeConn('pubkey-a', ['hub-1', 'hub-2'])
    const second = makeConn('pubkey-a', ['hub-1', 'hub-2'])
    manager.register(first)
    manager.register(second)
    manager.subscribe(first, 'hub-2', [1000])
    manager.subscribe(second, 'hub-1', [1000])

    manager.unregister(first)
    manager.unregister(second)

    const reconnect = makeConn('pubkey-a', ['hub-1', 'hub-2'])
    manager.register(reconnect)
    manager.publishToHub('hub-1', 1000, 'payload', 0)
    manager.publishToHub('hub-2', 1000, 'payload', 0)

    expect(eventHubs(reconnect)).toEqual([])
  })
})

describe('ConnectionManager.terminateUser', () => {
  let manager: ConnectionManager

  beforeEach(() => {
    manager = new ConnectionManager(SERVER_KEY)
  })

  it('closes every connection with the given reason and drops subscriptions', () => {
    const conn = makeConn('pubkey-a', ['hub-1'])
    manager.register(conn)
    manager.subscribe(conn, 'hub-1', [1000])

    manager.terminateUser('pubkey-a', 'logged_out')

    expect(conn.ws.close).toHaveBeenCalledWith(4001, 'logged_out')
    expect(manager.connectionCount).toBe(0)

    // The logged-out session's subscription must not outlive it: a socket that
    // reconnects and has not re-subscribed receives nothing.
    const reconnect = makeConn('pubkey-a', ['hub-1'])
    manager.register(reconnect)
    manager.publishToHub('hub-1', 1000, 'payload', 0)
    expect(eventHubs(reconnect)).toEqual([])
  })

  it('defaults the close reason to account_erased', () => {
    const conn = makeConn('pubkey-a', ['hub-1'])
    manager.register(conn)

    manager.terminateUser('pubkey-a')

    expect(conn.ws.close).toHaveBeenCalledWith(4001, 'account_erased')
  })
})
