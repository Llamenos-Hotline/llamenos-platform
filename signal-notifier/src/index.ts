import { Hono } from 'hono'
import { IdentifierStore } from './store'
import { buildRoutes, type AuthConfig } from './routes'
import { AuditLogger } from './audit'
import { createConnection } from './db/connection'
import { signalIdentifiers } from './db/schema'
import type { BridgeConfig } from './signal-client'
import { sql } from 'drizzle-orm'

const port = Number(process.env.PORT ?? 3100)
const apiKey = process.env.NOTIFIER_API_KEY ?? ''
const apiKeyPrevious = process.env.NOTIFIER_API_KEY_PREVIOUS ?? ''
const tokenSecret = process.env.NOTIFIER_TOKEN_SECRET ?? ''
const databaseUrl = process.env.DATABASE_URL ?? ''
const bridgeUrl = process.env.SIGNAL_BRIDGE_URL ?? 'http://signal-cli-rest-api:8080'
const bridgeApiKey = process.env.SIGNAL_BRIDGE_API_KEY ?? ''
const registeredNumber = process.env.SIGNAL_REGISTERED_NUMBER ?? ''

if (!apiKey) {
  console.error('[signal-notifier] NOTIFIER_API_KEY is required')
  process.exit(1)
}
if (!tokenSecret) {
  console.error('[signal-notifier] NOTIFIER_TOKEN_SECRET is required')
  process.exit(1)
}
if (!databaseUrl) {
  console.error('[signal-notifier] DATABASE_URL is required')
  process.exit(1)
}
if (!registeredNumber) {
  console.warn('[signal-notifier] SIGNAL_REGISTERED_NUMBER not set — notifications will fail')
}

const { sql: pgClient, db } = createConnection(databaseUrl)

// Auto-create tables on startup
async function migrate() {
  await pgClient`
    CREATE TABLE IF NOT EXISTS signal_identifiers (
      hash TEXT PRIMARY KEY,
      ciphertext TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('phone', 'username')),
      created_at BIGINT NOT NULL
    )
  `
  await pgClient`
    CREATE TABLE IF NOT EXISTS signal_audit_log (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      action TEXT NOT NULL,
      identifier_hash TEXT,
      success TEXT NOT NULL CHECK (success IN ('true', 'false')),
      error_message TEXT,
      metadata TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `
  await pgClient`
    CREATE INDEX IF NOT EXISTS idx_signal_audit_log_created_at ON signal_audit_log (created_at)
  `
  await pgClient`
    CREATE INDEX IF NOT EXISTS idx_signal_audit_log_identifier_hash ON signal_audit_log (identifier_hash)
  `
}

const store = new IdentifierStore(db, apiKey)
const audit = new AuditLogger(db)

const authConfig: AuthConfig = { apiKey, apiKeyPrevious: apiKeyPrevious || undefined }
const bridgeCfg: BridgeConfig = { bridgeUrl, bridgeApiKey, registeredNumber }

const app = new Hono()

// Health check — verifies PostgreSQL connectivity; does not expose operational metrics
app.get('/health', async (c) => {
  try {
    await db.select({ n: sql<number>`1` }).from(signalIdentifiers).limit(0)
    return c.json({ ok: true })
  } catch (err) {
    return c.json(
      { ok: false, error: err instanceof Error ? err.message : 'database connection failed' },
      503
    )
  }
})

// Notifier endpoints
const notifierRoutes = buildRoutes(authConfig, tokenSecret, store, bridgeCfg, audit)
app.route('/api', notifierRoutes)

// Run migration first, then start server — prevents health check from querying
// tables that don't exist yet (race condition if server started before migration).
migrate()
  .then(() => {
    console.log(`[signal-notifier] tables ready, starting on port ${port}`)
    Bun.serve({ port, fetch: app.fetch })
    console.log(`[signal-notifier] listening on port ${port}`)
  })
  .catch((err) => {
    console.error('[signal-notifier] migration failed:', err)
    process.exit(1)
  })
