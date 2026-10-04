/**
 * WebSocket relay route — handles upgrade, challenge-response auth,
 * subscriptions, replay, and keepalive.
 *
 * This module exports the Bun WebSocket handler and the upgrade middleware.
 * The actual upgrade happens in the Bun server entry point (src/server/index.ts).
 */
import { ed25519Verify } from '@llamenos/crypto/ffi'
import { randomBytes } from '@llamenos/crypto/ffi'
import { hexToBytes, bytesToHex, utf8ToBytes } from '@shared/encoding'
import { LABEL_WS_CHALLENGE } from '@shared/crypto-labels'
import { wsClientMessageSchema } from '@protocol/schemas/ws-messages'
import type { ConnectionState } from '../lib/ws-manager'
import { getConnectionManager } from '../lib/ws-manager'
import { createLogger } from '../lib/logger'
import { isRevokedSigningKey } from '../lib/revoked-signing-keys'

const log = createLogger('ws')

/** Maximum client message size (64 KiB) */
const MAX_MESSAGE_SIZE = 64 * 1024

/** Auth timeout: 10 seconds after challenge sent */
const AUTH_TIMEOUT_MS = 10_000

/** Timestamp freshness window for auth (10 seconds) */
const AUTH_TIMESTAMP_WINDOW_MS = 10_000

/** Interval at which authenticated connections re-validate user status and hub memberships */
export const MEMBERSHIP_REVALIDATION_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes

export interface WsConnectionData {
  nonce: string
  nonceCreatedAt: number
  authenticated: boolean
  connState: ConnectionState | null
  authTimeout: ReturnType<typeof setTimeout> | null
  /** Periodic interval that re-validates the user's account status and hub memberships */
  validationInterval: ReturnType<typeof setInterval> | null
  lookupUser: (pubkey: string) => Promise<{ hubs: string[] } | null>
}

/**
 * Generate a challenge nonce for a new connection.
 * Returns the nonce hex string and connection data.
 */
export function createConnectionData(
  lookupUser: (pubkey: string) => Promise<{ hubs: string[] } | null>,
): WsConnectionData {
  const nonce = bytesToHex(randomBytes(32))
  return {
    nonce,
    nonceCreatedAt: Date.now(),
    authenticated: false,
    connState: null,
    authTimeout: null,
    validationInterval: null,
    lookupUser,
  }
}

/**
 * Bun WebSocket handler for the relay.
 * Attach to `Bun.serve({ websocket: createWsHandler() })`.
 */
export function createWsHandler() {
  return {
    maxPayloadLength: MAX_MESSAGE_SIZE,
    idleTimeout: 120, // 2 minutes
    perMessageDeflate: false, // JSON is small, compression overhead not worth it

    open(ws: import('bun').ServerWebSocket<WsConnectionData>) {
      const data = ws.data
      // Send challenge immediately
      ws.sendText(JSON.stringify({ type: 'challenge', nonce: data.nonce }))

      // Set auth timeout — close if not authenticated in 10s
      data.authTimeout = setTimeout(() => {
        if (!data.authenticated) {
          log.debug('Auth timeout, closing connection')
          ws.close(4001, 'Auth timeout')
        }
      }, AUTH_TIMEOUT_MS)
    },

    message(ws: import('bun').ServerWebSocket<WsConnectionData>, message: string | Uint8Array) {
      const data = ws.data
      const raw = typeof message === 'string' ? message : new TextDecoder().decode(message)

      // Parse message
      const parsed = wsClientMessageSchema.safeParse((() => {
        try { return JSON.parse(raw) } catch { return null }
      })())

      if (!parsed.success) {
        ws.sendText(JSON.stringify({ type: 'error', code: 'invalid_message', message: 'Invalid message format' }))
        return
      }

      const msg = parsed.data

      // Handle auth message (before authenticated)
      if (msg.type === 'auth') {
        if (data.authenticated) {
          ws.sendText(JSON.stringify({ type: 'error', code: 'already_authenticated', message: 'Already authenticated' }))
          return
        }
        handleAuth(ws, data, msg).catch((err) => {
          log.error('Auth error', { error: err instanceof Error ? err.message : String(err) })
          ws.sendText(JSON.stringify({ type: 'error', code: 'auth_failed', message: 'Authentication failed' }))
          ws.close(4001, 'Auth failed')
        })
        return
      }

      // All other messages require authentication
      if (!data.authenticated || !data.connState) {
        ws.sendText(JSON.stringify({ type: 'error', code: 'not_authenticated', message: 'Authenticate first' }))
        return
      }

      const manager = getConnectionManager()
      if (!manager) {
        ws.sendText(JSON.stringify({ type: 'error', code: 'server_error', message: 'Server not ready' }))
        return
      }

      switch (msg.type) {
        case 'subscribe': {
          // Validate hub membership
          if (!data.connState.hubs.has(msg.hubId)) {
            ws.sendText(JSON.stringify({ type: 'error', code: 'not_member', message: `Not a member of hub ${msg.hubId}` }))
            return
          }
          manager.subscribe(data.connState, msg.hubId, msg.kinds)
          ws.sendText(JSON.stringify({ type: 'subscribed', hubId: msg.hubId, kinds: msg.kinds }))
          break
        }

        case 'unsubscribe': {
          manager.unsubscribe(data.connState.pubkey, msg.hubId)
          ws.sendText(JSON.stringify({ type: 'unsubscribed', hubId: msg.hubId }))
          break
        }

        case 'replay': {
          if (!data.connState.hubs.has(msg.hubId)) {
            ws.sendText(JSON.stringify({ type: 'error', code: 'not_member', message: `Not a member of hub ${msg.hubId}` }))
            return
          }
          const ok = manager.replay(data.connState, msg.hubId, msg.since)
          if (!ok) {
            ws.sendText(JSON.stringify({ type: 'error', code: 'rate_limited', message: 'Replay rate limited' }))
          }
          break
        }

        case 'ping': {
          ws.sendText(JSON.stringify({ type: 'pong' }))
          break
        }
      }
    },

    close(ws: import('bun').ServerWebSocket<WsConnectionData>) {
      const data = ws.data
      if (data.authTimeout) {
        clearTimeout(data.authTimeout)
      }
      if (data.validationInterval) {
        clearInterval(data.validationInterval)
        data.validationInterval = null
      }
      if (data.connState) {
        const manager = getConnectionManager()
        if (manager) {
          manager.unregister(data.connState)
        }
      }
    },
  }
}

async function handleAuth(
  ws: import('bun').ServerWebSocket<WsConnectionData>,
  data: WsConnectionData,
  msg: { pubkey: string; nonce: string; ts: number; sig: string },
): Promise<void> {
  // Verify nonce matches
  if (msg.nonce !== data.nonce) {
    ws.sendText(JSON.stringify({ type: 'error', code: 'auth_failed', message: 'Nonce mismatch' }))
    ws.close(4001, 'Auth failed')
    return
  }

  // Verify timestamp freshness
  const now = Date.now()
  if (Math.abs(now - msg.ts) > AUTH_TIMESTAMP_WINDOW_MS) {
    ws.sendText(JSON.stringify({ type: 'error', code: 'auth_failed', message: 'Timestamp expired' }))
    ws.close(4001, 'Auth failed')
    return
  }

  if (typeof msg.pubkey !== 'string' || isRevokedSigningKey(msg.pubkey)) {
    ws.sendText(JSON.stringify({ type: 'error', code: 'auth_failed', message: 'Invalid signature' }))
    ws.close(4001, 'Auth failed')
    return
  }

  // Construct the signed message: "llamenos:ws-auth:{pubkey}:{nonce}:{timestamp}"
  const signedMessage = `${LABEL_WS_CHALLENGE}:${msg.pubkey}:${msg.nonce}:${msg.ts}`
  const messageBytes = utf8ToBytes(signedMessage)
  const sigBytes = hexToBytes(msg.sig)
  const pubkeyBytes = hexToBytes(msg.pubkey)

  // Verify Ed25519 signature
  const valid = ed25519Verify(pubkeyBytes, messageBytes, sigBytes)
  if (!valid) {
    ws.sendText(JSON.stringify({ type: 'error', code: 'auth_failed', message: 'Invalid signature' }))
    ws.close(4001, 'Auth failed')
    return
  }

  // Look up user and get hub memberships
  const user = await data.lookupUser(msg.pubkey)
  if (!user) {
    ws.sendText(JSON.stringify({ type: 'error', code: 'auth_failed', message: 'User not found' }))
    ws.close(4001, 'Auth failed')
    return
  }

  // Authentication successful
  if (data.authTimeout) {
    clearTimeout(data.authTimeout)
    data.authTimeout = null
  }
  data.authenticated = true

  const connState: ConnectionState = {
    pubkey: msg.pubkey,
    ws: ws as unknown as WebSocket,
    hubs: new Set(user.hubs),
    subscribedHubs: new Set(),
    lastReplayAt: 0,
  }
  data.connState = connState

  const manager = getConnectionManager()
  if (manager) {
    const accepted = manager.register(connState)
    if (!accepted) {
      ws.sendText(JSON.stringify({ type: 'error', code: 'connection_limit', message: 'Too many concurrent connections' }))
      ws.close(4008, 'Connection limit exceeded')
      return
    }
  }

  ws.sendText(JSON.stringify({ type: 'authenticated', hubs: user.hubs }))
  log.debug('Client authenticated', { pubkey: msg.pubkey, hubs: user.hubs.length })

  // Periodically re-validate the user's account status and hub memberships.
  // If the account is deactivated or hubs change, terminate or update accordingly.
  data.validationInterval = setInterval(() => {
    revalidateMembership(ws, data).catch((err) => {
      log.error('Membership revalidation error', { error: err instanceof Error ? err.message : String(err) })
    })
  }, MEMBERSHIP_REVALIDATION_INTERVAL_MS)
}

/**
 * Re-validate an authenticated connection's user status and hub memberships.
 * Terminates the connection if the user is no longer active.
 * Evicts subscriptions for hubs the user has been removed from.
 */
async function revalidateMembership(
  ws: import('bun').ServerWebSocket<WsConnectionData>,
  data: WsConnectionData,
): Promise<void> {
  if (!data.authenticated || !data.connState) return

  const pubkey = data.connState.pubkey
  const updated = await data.lookupUser(pubkey)

  if (!updated) {
    // User account deactivated or deleted — terminate connection
    log.debug('Membership revalidation: user no longer active, closing', { pubkey })
    ws.close(4001, 'Account deactivated')
    return
  }

  const manager = getConnectionManager()
  const newHubs = new Set(updated.hubs)
  const currentHubs = data.connState.hubs

  // Evict subscriptions for hubs the user has been removed from
  for (const hubId of currentHubs) {
    if (!newHubs.has(hubId)) {
      log.debug('Membership revalidation: evicting hub', { pubkey, hubId })
      if (manager) {
        manager.evictMember(pubkey, hubId)
      }
      currentHubs.delete(hubId)
    }
  }

  // Add any newly-joined hubs
  for (const hubId of newHubs) {
    currentHubs.add(hubId)
  }
}
