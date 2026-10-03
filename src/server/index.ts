/**
 * Bun server entry point.
 * Runs the Hono worker app as a pure API server using Bun's native HTTP.
 *
 * The frontend is served by Tauri's webview — this server handles
 * only API routes. Real-time events use the WebSocket relay.
 */
import 'reflect-metadata' // Required by @peculiar/x509 → tsyringe (transitive dep of @simplewebauthn/server)
import { Hono } from 'hono'
import { createDatabase, closeDb, getDb, schema } from '../../apps/worker/db'
import { eq, count } from 'drizzle-orm'
import { cleanupExpiredNonces } from '../../apps/worker/services/webhook-replay'
import { createServices, type Services } from '../../apps/worker/services'
import { createBlobStorage } from '../../apps/worker/lib/blob-storage'
import { createTranscriptionService } from '../../apps/worker/lib/transcription-client'
import { validateConfig } from '../../apps/worker/lib/config'
import { getMessagingAdapterFromService } from '../../apps/worker/lib/service-factories'
import { publishEvent, setEventOutbox, drainOutbox, cleanupOutbox } from '../../apps/worker/lib/ws-events'
import { initConnectionManager } from '../../apps/worker/lib/ws-manager'
import { EventOutbox } from '../../apps/worker/lib/event-outbox'
import { deriveServerKeypair } from '../../apps/worker/lib/server-identity'
import { createWsHandler, createConnectionData } from '../../apps/worker/routes/ws'
import type { WsConnectionData } from '../../apps/worker/routes/ws'
import type { AppEnv } from '../../apps/worker/types/infra'
import { KIND_BLAST_PROGRESS, KIND_BLAST_STATUS } from '../../packages/shared/event-kinds'
import type { MessagingChannelType } from '../../packages/shared/types'
import type { Env } from '../../apps/worker/types/infra'
import fs from 'node:fs'
import { ed25519AuthPubkey, hpkeRecipientPubkey } from '@worker/lib/hpke-recipient'

console.log('[llamenos] Starting Bun server...')

// Validate required env vars before initializing any services.
validateConfig()

// --- Read secrets ---
function readSecret(name: string, envKey?: string): string {
  const filePath = `/run/secrets/${name}`
  try {
    return fs.readFileSync(filePath, 'utf-8').trim()
  } catch {
    const key = envKey || name.toUpperCase().replace(/-/g, '_')
    return process.env[key] || ''
  }
}

// --- Initialize database ---
const databaseUrl = process.env.DATABASE_URL!
const db = createDatabase(databaseUrl)
console.log('[llamenos] Database initialized')

// --- Read secrets ---
const hmacSecret = readSecret('hmac-secret', 'HMAC_SECRET')
const serverSecret = readSecret('server-secret', 'SERVER_SECRET')
const firehoseSealKey = readSecret('firehose-agent-seal-key', 'FIREHOSE_AGENT_SEAL_KEY') || undefined

// --- Create services (pass HMAC secret for encryption operations) ---
const notifierUrl = process.env.NOTIFIER_URL || ''
const notifierApiKey = readSecret('notifier-api-key', 'NOTIFIER_API_KEY')
// notifierTokenSecret: defaults to hmacSecret so existing deployments require no config change
const notifierTokenSecret = readSecret('notifier-token-secret', 'NOTIFIER_TOKEN_SECRET') || hmacSecret
const services: Services = createServices(db, {
  hmacSecret,
  firehoseSealKey,
  notifierUrl,
  notifierApiKey,
  notifierTokenSecret,
  env: {
    ADMIN_PUBKEY: ed25519AuthPubkey(readSecret('admin-pubkey', 'ADMIN_PUBKEY')),
    ADMIN_DECRYPTION_PUBKEY: hpkeRecipientPubkey(process.env.ADMIN_DECRYPTION_PUBKEY),
    SERVER_SECRET: serverSecret || undefined,
    ENVIRONMENT: process.env.ENVIRONMENT || undefined,
    DOMAIN: process.env.DOMAIN || undefined,
  },
})
console.log('[llamenos] Services initialized')

// --- Seed defaults and the configured admin before anything serves ---
// Settings first: the roles table must be populated before the admin user
// exists, or a request authenticating in between resolves role-super-admin
// against an empty table and is refused (see the ordering note in
// routes/dev.ts test-reset). Both only fill what is missing, so they are safe
// on every boot against an existing database. Mode-specific seeding (demo
// accounts, a pre-completed setup) stays with the demo/dev flows that own it.
// A failure here must stop the boot: a server without roles cannot authorise.
await services.settings.ensureInit()
await services.identity.ensurePlatformAdmin()
console.log('[llamenos] Default settings, roles and platform admin ensured')

// --- Startup: warn if any plaintext (un-encrypted) contacts exist ---
try {
  const [result] = await db
    .select({ count: count() })
    .from(schema.contacts)
    .where(eq(schema.contacts.needsReencryption, true))
  const plaintextCount = result?.count ?? 0
  if (plaintextCount > 0) {
    console.warn(
      `[llamenos] SECURITY WARNING: ${plaintextCount} contact(s) flagged as plaintext ` +
        '(needs_reencryption=true). These contacts were stored before E2EE was implemented ' +
        'and must be re-encrypted. Clients will be prompted to re-encrypt on next access.',
    )
  }
} catch (err) {
  console.warn('[llamenos] Could not check for plaintext contacts:', err)
}

const env: Record<string, unknown> = {
  // The only place a raw env string becomes a typed key. Past this point the
  // Ed25519 identity key and the X25519 HPKE recipient are different types and
  // cannot be substituted for one another (apps/worker/lib/hpke-recipient.ts).
  ADMIN_PUBKEY: ed25519AuthPubkey(readSecret('admin-pubkey', 'ADMIN_PUBKEY')),
  ADMIN_DECRYPTION_PUBKEY: hpkeRecipientPubkey(process.env.ADMIN_DECRYPTION_PUBKEY),
  HMAC_SECRET: hmacSecret,
  HOTLINE_NAME: process.env.HOTLINE_NAME || 'Hotline',
  ENVIRONMENT: process.env.ENVIRONMENT || 'production',
  TWILIO_ACCOUNT_SID: readSecret('twilio-account-sid', 'TWILIO_ACCOUNT_SID'),
  TWILIO_AUTH_TOKEN: readSecret('twilio-auth-token', 'TWILIO_AUTH_TOKEN'),
  TWILIO_PHONE_NUMBER: process.env.TWILIO_PHONE_NUMBER || '',
  DEMO_MODE: process.env.DEMO_MODE || undefined,
  DEMO_MODE_CONFIRM: process.env.DEMO_MODE_CONFIRM || undefined,
  // Read by apps/worker/routes/config.ts:101 to report the demo reset schedule.
  DEMO_RESET_CRON: process.env.DEMO_RESET_CRON || undefined,
  AI: createTranscriptionService(),
  BLOB_STORAGE: createBlobStorage(),
  STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT || undefined,
  SERVER_SECRET: serverSecret || undefined,
  GLITCHTIP_DSN: process.env.GLITCHTIP_DSN || undefined,
  DEV_RESET_SECRET: process.env.DEV_RESET_SECRET || undefined,
  E2E_TEST_SECRET: process.env.E2E_TEST_SECRET || undefined,
  DEV_ROUTES_ENABLED: process.env.DEV_ROUTES_ENABLED || undefined,
  DEV_AUTH_BYPASS: process.env.DEV_AUTH_BYPASS || undefined,
  DOMAIN: process.env.DOMAIN || undefined,
  WEBHOOK_BASE_URL: process.env.WEBHOOK_BASE_URL || undefined,
  CORS_ALLOWED_ORIGINS: process.env.CORS_ALLOWED_ORIGINS || undefined,
  METRICS_SCRAPE_TOKEN: process.env.METRICS_SCRAPE_TOKEN || undefined,
  SIP_BRIDGE_URL: process.env.SIP_BRIDGE_URL || undefined,
  SIGNAL_NOTIFIER_URL: process.env.SIGNAL_NOTIFIER_URL || notifierUrl || undefined,
  SIGNAL_NOTIFIER_BEARER_TOKEN: process.env.SIGNAL_NOTIFIER_BEARER_TOKEN || notifierApiKey || undefined,
  NOTIFIER_URL: notifierUrl || undefined,
  NOTIFIER_API_KEY: notifierApiKey || undefined,
  NOTIFIER_TOKEN_SECRET: notifierTokenSecret || undefined,
  CERT_PIN_HASHES: process.env.CERT_PIN_HASHES || undefined,
  FIREHOSE_AGENT_SEAL_KEY: firehoseSealKey,
  // --- Push delivery ---
  // This object IS the request env: anything absent here is permanently
  // undefined to every route, no matter what the deploy writes into the
  // container. These eight were written by the deploy templates and read by
  // the push code, but never bridged, so both push transports were inert on
  // every deployment. `validateConfig()` could not surface it either — it
  // reads process.env directly, so startup reported push as configured while
  // the routes saw nothing. Keep this literal explicit (no ...process.env
  // spread, which would widen what routes can read) and add a key here
  // whenever a route starts reading a new variable.
  //
  // iOS APNs — apps/worker/lib/voip-push.ts:37,76-78,
  //            apps/worker/lib/push-dispatch.ts:82,209-211
  APNS_KEY_P8: process.env.APNS_KEY_P8 || undefined,
  APNS_KEY_ID: process.env.APNS_KEY_ID || undefined,
  APNS_TEAM_ID: process.env.APNS_TEAM_ID || undefined,
  // Android UnifiedPush/ntfy — apps/worker/lib/voip-push.ts:38,115,
  //   apps/worker/lib/push-dispatch.ts:83,143-144,
  //   apps/worker/lib/ntfy-origin.ts:74-79 (device endpoints are accepted only
  //   on these origins, so without NTFY_PUBLIC_URL every device registered on
  //   the public vhost is rejected).
  NTFY_URL: process.env.NTFY_URL || undefined,
  NTFY_AUTH_TOKEN: process.env.NTFY_AUTH_TOKEN || undefined,
  NTFY_PUBLIC_URL: process.env.NTFY_PUBLIC_URL || undefined,
  NTFY_ALLOWED_ORIGINS: process.env.NTFY_ALLOWED_ORIGINS || undefined,
}

// --- Initialize WebSocket relay ---
if (serverSecret) {
  const keypair = deriveServerKeypair(serverSecret)
  initConnectionManager(keypair.secretKey)
  console.log('[llamenos] WebSocket relay initialized (server pubkey:', keypair.pubkeyHex.slice(0, 8) + '...)')
}

// --- Initialize event outbox (persistent delivery queue) ---
const eventOutbox = new EventOutbox(db)
setEventOutbox(eventOutbox)

// Initial drain after 3s — pick up events from previous process life
setTimeout(() => {
  drainOutbox().catch((err) => {
    console.error('[llamenos] Initial outbox drain failed:', err)
  })
}, 3000)

// Periodic drain every 30s and cleanup every 5 min
const outboxDrainTimer = setInterval(() => {
  drainOutbox().catch((err) => {
    console.error('[llamenos] Outbox drain failed:', err)
  })
}, 30_000)

const outboxCleanupTimer = setInterval(() => {
  cleanupOutbox().catch((err) => {
    console.error('[llamenos] Outbox cleanup failed:', err)
  })
}, 300_000)

console.log('[llamenos] Event outbox initialized (drain: 30s, cleanup: 5m)')

// --- Start scheduled task poller with blast delivery worker ---
services.scheduler.start({
  blastsService: services.blasts,
  settingsService: services.settings,
  auditService: services.audit,
  identityService: services.identity,
  resolveAdapter: async (channel: MessagingChannelType) => {
    try {
      return await getMessagingAdapterFromService(channel, services.settings, hmacSecret)
    } catch {
      return null
    }
  },
  resolveIdentifier: (subscriberId: string) =>
    services.blasts.resolveSubscriberIdentifier(subscriberId),
  onBlastProgress: (blastId, hubId, stats) => {
    publishEvent(env as unknown as Env, KIND_BLAST_PROGRESS, {
      type: 'blast:progress',
      blastId,
      ...stats,
    }, hubId)
  },
  onBlastStatusChange: (blastId, hubId, status) => {
    publishEvent(env as unknown as Env, KIND_BLAST_STATUS, {
      type: 'blast:status',
      blastId,
      status,
    }, hubId)
  },
})

// --- Periodic webhook nonce cleanup (every 60s) ---
setInterval(async () => {
  try {
    await cleanupExpiredNonces(getDb())
  } catch (e) {
    console.error('[llamenos] Failed to cleanup webhook nonces:', e)
  }
}, 60_000)

// --- Initialize firehose agents (if seal key is configured) ---
if (services.firehoseAgent) {
  services.firehoseAgent.init().catch((err) => {
    console.error('[llamenos] Firehose agent init failed:', err)
  })
  console.log('[llamenos] Firehose agent service initialized')
}

// --- Build Hono app ---
const { default: workerApp } = await import('../../apps/worker/app')

const app = new Hono<AppEnv>()

// Inject env bindings and services into every request
/* eslint-disable @typescript-eslint/no-explicit-any -- Hono context type bridging across module boundaries */
app.use('*', async (c, next) => {
  // Dev server bootstrap: env is built from process.env, not from Hono bindings
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(c as unknown as { env: Record<string, unknown> }).env = env
  c.set('services', services)
  await next()
})
/* eslint-enable @typescript-eslint/no-explicit-any */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
app.route('/', workerApp as unknown as Hono<AppEnv>)
app.all('*', (c) => c.json({ error: 'Not Found' }, 404))

const port = parseInt(process.env.PORT || '3000')

// --- WebSocket handler ---
const wsHandler = createWsHandler()

/** Look up user hub memberships for WS auth */
async function lookupUserHubs(pubkey: string): Promise<{ hubs: string[] } | null> {
  const user = await services.identity.getUserInternal(pubkey)
  if (!user || !user.active) return null
  // Get all hubs and filter to those the user is a member of
  const { hubs } = await services.settings.getHubs()
  // User's hubRoles indicate hub membership
  const memberHubIds = (user.hubRoles ?? []).map(hr => hr.hubId)
  const activeHubIds = hubs
    .filter(h => h.status === 'active' && memberHubIds.includes(h.id))
    .map(h => h.id)
  // Membership is the isolation boundary for relay subscriptions: every event
  // is published to the hub that owns it, so a user may subscribe only to hubs
  // they belong to. There is no catch-all pseudo-hub.
  return { hubs: activeHubIds }
}

export default {
  port,
  // Disable idle timeout so long-running dev/test operations (e.g. DB reset) can complete.
  // Default Bun HTTP idle timeout is 10s, which kills test-reset before it finishes.
  idleTimeout: 0,
  fetch(req: Request, server: import('bun').Server<WsConnectionData>): Response | Promise<Response> {
    // Handle WebSocket upgrade requests
    const url = new URL(req.url)
    if (url.pathname === '/ws' && req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      const data = createConnectionData(lookupUserHubs)
      const upgraded = server.upgrade(req, { data })
      if (upgraded) return new Response(null, { status: 101 })
      return new Response('WebSocket upgrade failed', { status: 500 })
    }
    return app.fetch(req, server)
  },
  websocket: wsHandler,
}

console.log(`[llamenos] Server running at http://localhost:${port}`)

// --- OpenAPI snapshot in development ---
if (process.env.ENVIRONMENT === 'development') {
  try {
    const { resolve } = await import('path')
    const snapshotPath = resolve(process.cwd(), 'packages/protocol/openapi-snapshot.json')
    const response = await app.fetch(new Request(`http://localhost:${port}/api/openapi.json`))
    const spec = await response.json()
    await Bun.write(snapshotPath, JSON.stringify(spec, null, 2) + '\n')
    console.log('[llamenos] OpenAPI snapshot written')
  } catch (err) {
    console.warn(`[llamenos] Failed to write OpenAPI snapshot: ${err}`)
  }
}

// --- Graceful shutdown ---
const shutdown = async () => {
  console.log('[llamenos] Shutting down...')
  clearInterval(outboxDrainTimer)
  clearInterval(outboxCleanupTimer)
  services.firehoseAgent?.shutdown()
  services.scheduler.stop()
  await closeDb()
  console.log('[llamenos] Server stopped')
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
