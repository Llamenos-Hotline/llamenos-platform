/**
 * Messaging channel credentials are sealed at rest and never returned (#3031),
 * against real PostgreSQL, Bun-native driver, through the real settings router.
 *
 * MUST run under `bun test`, NOT vitest:
 *   bun test apps/worker/__tests__/integration-bun/messaging-secrets-at-rest.test.ts
 *
 * Every case reads the stored column itself (`messaging_config::text`), because
 * a test that only went through the service would pass against a service that
 * decrypts a column holding plaintext.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import '../../db/pg-array-patch'
import { createDatabase } from '../../db'
import { systemSettings } from '../../db/schema'
import { AuditService } from '../../services/audit'
import { ServiceError } from '../../services/service-error'
import { createSettingsDomain } from '../../services/settings-domain'
import settingsRoutes from '../../routes/settings'
import type { AppEnv } from '../../types'
import { DEFAULT_ROLES, resolvePermissions, type Role } from '@shared/permissions'
import { requireDatabaseUrl } from '../helpers/database-url'

const db = createDatabase(requireDatabaseUrl())
const SERVER_KEK = 'cd'.repeat(32)
const svc = { ...createSettingsDomain(db, SERVER_KEK), audit: new AuditService(db) }

const ALL_ROLES: Role[] = DEFAULT_ROLES.map(r => ({
  ...r,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}))
const ADMIN = { pubkey: 'ab'.repeat(32), roles: ['role-super-admin'], hubRoles: [] }

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const SECRETS = {
  waAccess: `wa-access-${suffix}`,
  waApp: `wa-app-${suffix}`,
  waVerify: `wa-verify-${suffix}`,
  sigKey: `sig-key-${suffix}`,
  sigHook: `sig-hook-${suffix}`,
  rcsKey: `rcs-key-${suffix}`,
  rcsHook: `rcs-hook-${suffix}`,
  tgToken: `tg-token-${suffix}`,
  tgHook: `tg-hook-${suffix}`,
}

const CONFIG = {
  whatsapp: {
    integrationMode: 'direct',
    phoneNumberId: '1234',
    accessToken: SECRETS.waAccess,
    appSecret: SECRETS.waApp,
    verifyToken: SECRETS.waVerify,
    autoResponse: 'wa auto response',
  },
  signal: {
    bridgeUrl: 'https://signal-bridge.internal:8080',
    bridgeApiKey: SECRETS.sigKey,
    webhookSecret: SECRETS.sigHook,
    registeredNumber: '+15550001111',
  },
  rcs: {
    agentId: 'agent-1',
    serviceAccountKey: SECRETS.rcsKey,
    webhookSecret: SECRETS.rcsHook,
    fallbackToSms: false,
  },
  telegram: { enabled: true, botToken: SECRETS.tgToken, webhookSecret: SECRETS.tgHook, botUsername: 'hotline_bot' },
  inactivityTimeout: 45,
}

function app() {
  const a = new Hono<AppEnv>()
  a.onError((err, c) => {
    if (err instanceof ServiceError) return c.json({ error: err.message }, err.status as 400 | 500)
    throw err
  })
  a.use('*', async (c, next) => {
    c.set('pubkey', ADMIN.pubkey)
    c.set('user', { ...ADMIN } as unknown as AppEnv['Variables']['user'])
    c.set('allRoles', ALL_ROLES)
    c.set('permissions', resolvePermissions(ADMIN.roles, ALL_ROLES))
    c.set('services', svc as unknown as AppEnv['Variables']['services'])
    await next()
  })
  a.route('/api/settings', settingsRoutes)
  return a
}

async function call(method: string, body?: unknown) {
  const res = await app().request(
    '/api/settings/messaging',
    { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) },
    { ENVIRONMENT: 'test', HMAC_SECRET: 'f'.repeat(64) },
  )
  return { status: res.status, text: await res.text() }
}

/** The column exactly as Postgres stores it. */
async function storedText(): Promise<string> {
  const rows = await db.execute(sql`SELECT messaging_config::text AS cfg FROM system_settings WHERE id = 1`)
  return String((rows as unknown as { cfg: string }[])[0].cfg)
}

let saved = ''
beforeAll(async () => {
  await svc.spamSettings.getSpamSettings()
  saved = await storedText()
})
const restore = () =>
  db.execute(sql`UPDATE system_settings SET messaging_config = ${saved}::jsonb WHERE id = 1`)
afterEach(restore)
afterAll(restore)

describe('messaging credentials at rest (#3031)', () => {
  it('stores none of the secret values in the column, and keeps the non-secret settings readable', async () => {
    const res = await call('PATCH', CONFIG)
    expect(res.status).toBe(200)

    const stored = await storedText()
    for (const secret of Object.values(SECRETS)) expect(stored).not.toContain(secret)
    // Settings an operator reads back stay as they were.
    expect(stored).toContain('wa auto response')
    expect(stored).toContain('hotline_bot')
    expect(stored).toContain('https://signal-bridge.internal:8080')
    expect(stored).toContain('sealedSecrets')
  })

  it('the adapters still get the secrets', async () => {
    await call('PATCH', CONFIG)
    const config = await svc.messagingConfig.getMessagingConfig()
    expect(config.whatsapp?.accessToken).toBe(SECRETS.waAccess)
    expect(config.whatsapp?.appSecret).toBe(SECRETS.waApp)
    expect(config.whatsapp?.verifyToken).toBe(SECRETS.waVerify)
    expect(config.signal?.bridgeApiKey).toBe(SECRETS.sigKey)
    expect(config.signal?.webhookSecret).toBe(SECRETS.sigHook)
    expect(config.rcs?.serviceAccountKey).toBe(SECRETS.rcsKey)
    expect(config.rcs?.webhookSecret).toBe(SECRETS.rcsHook)
    expect(config.telegram?.botToken).toBe(SECRETS.tgToken)
    expect(config.telegram?.webhookSecret).toBe(SECRETS.tgHook)
  })

  it('GET and PATCH responses carry no secret, only whether each is set', async () => {
    const patched = await call('PATCH', CONFIG)
    const got = await call('GET')
    for (const res of [patched, got]) {
      expect(res.status).toBe(200)
      for (const secret of Object.values(SECRETS)) expect(res.text).not.toContain(secret)
      const body = JSON.parse(res.text)
      expect(body.whatsapp.accessTokenSet).toBe(true)
      expect(body.whatsapp.autoResponse).toBe('wa auto response')
      expect(body.signal.bridgeApiKeySet).toBe(true)
      expect(body.rcs.serviceAccountKeySet).toBe(true)
      expect(body.telegram.botTokenSet).toBe(true)
      expect(body.telegram.botUsername).toBe('hotline_bot')
      expect(body.sealedSecrets).toBeUndefined()
    }
  })

  it('a PATCH that leaves a secret out keeps the stored one, and one that sends it replaces it', async () => {
    await call('PATCH', CONFIG)
    const redacted = JSON.parse((await call('GET')).text)
    // What a client holding only the redacted view sends back, edited.
    const edited = { ...redacted.telegram, botUsername: 'renamed_bot' }
    expect((await call('PATCH', { telegram: edited })).status).toBe(200)
    let config = await svc.messagingConfig.getMessagingConfig()
    expect(config.telegram?.botUsername).toBe('renamed_bot')
    expect(config.telegram?.botToken).toBe(SECRETS.tgToken)
    expect(config.telegram?.webhookSecret).toBe(SECRETS.tgHook)
    expect(await storedText()).not.toContain('botTokenSet')

    const rotated = `tg-rotated-${suffix}`
    expect((await call('PATCH', { telegram: { ...edited, botToken: rotated } })).status).toBe(200)
    config = await svc.messagingConfig.getMessagingConfig()
    expect(config.telegram?.botToken).toBe(rotated)
    expect(await storedText()).not.toContain(rotated)
  })

  it('an unrelated edit leaves every sealed secret in place', async () => {
    await call('PATCH', CONFIG)
    expect((await call('PATCH', { inactivityTimeout: 90 })).status).toBe(200)
    const config = await svc.messagingConfig.getMessagingConfig()
    expect(config.inactivityTimeout).toBe(90)
    expect(config.signal?.bridgeApiKey).toBe(SECRETS.sigKey)
  })

  it('boot re-seals a config an older release stored in the clear', async () => {
    const legacy = { ...CONFIG, enabledChannels: ['whatsapp', 'signal', 'rcs', 'telegram'], autoAssign: true, maxConcurrentPerUser: 3 }
    await db.update(systemSettings).set({ messagingConfig: legacy }).where(eq(systemSettings.id, 1))
    expect(await storedText()).toContain(SECRETS.tgToken)

    expect(await svc.messagingConfig.sealStoredSecrets()).toBe(true)

    const stored = await storedText()
    for (const secret of Object.values(SECRETS)) expect(stored).not.toContain(secret)
    const config = await svc.messagingConfig.getMessagingConfig()
    expect(config.telegram?.botToken).toBe(SECRETS.tgToken)
    expect(config.whatsapp?.accessToken).toBe(SECRETS.waAccess)
    // Idempotent: nothing left to seal.
    expect(await svc.messagingConfig.sealStoredSecrets()).toBe(false)
  })

  it('refuses to store credentials it cannot seal', async () => {
    const keyless = createSettingsDomain(db)
    await expect(keyless.messagingConfig.updateMessagingConfig(CONFIG as never)).rejects.toMatchObject({ status: 500 })
    for (const secret of Object.values(SECRETS)) expect(await storedText()).not.toContain(secret)
  })
})
