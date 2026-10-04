/**
 * Hub-scoped IVR speakability constraint against real PostgreSQL (#1260).
 *
 * `SettingsService.getHubTelephonyProvider` used to read the row itself and
 * `JSON.parse(row.credentials)`. Every writer stores ciphertext and the
 * provider type lives in the `provider_type` COLUMN, so it returned null for
 * every configured hub. The IVR speakability check then fell through to the
 * instance-wide provider, and the hub-scoped constraint was dead.
 *
 * Nothing caught it: the unit tests for this constraint stub
 * `getHubTelephonyProvider`, so they exercised the comparison logic and never
 * the resolution, and the BDD scenario used a language NO provider speaks —
 * which cannot distinguish "the hub's provider rejected it" from "the global
 * provider rejected it". These tests close both gaps by storing the row the way
 * production stores it — provider type in the column, credentials as an opaque
 * hex ciphertext blob — and by choosing a language the hub's provider cannot
 * speak but the global one can.
 *
 * The credentials blob is a literal rather than a real `encryptCredentials`
 * call: that helper reaches `packages/crypto/ffi.ts`, which needs `bun:ffi` and
 * cannot load in this node-based tier. Nothing here depends on the ciphertext's
 * contents — the property under test is precisely that the reader takes the
 * provider type from the column and never parses this string (the old code
 * `JSON.parse`d it, which is why it always returned null). A hex blob is what
 * `encryptCredentials` produces, and it is equally unparseable as JSON.
 *
 * Requires postgres at DATABASE_URL. Each run gets its own database, dropped on
 * teardown.
 */

// pg-array-patch must be imported before any schema is loaded.
import '../../db/pg-array-patch'

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import type { Database } from '../../db'
import * as schema from '../../db/schema'
import { SettingsService } from '../../services/settings'

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

const DB_NAME = `ivr_hub_provider_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
/** Shaped like `encryptCredentials` output: opaque hex, not JSON. */
const OPAQUE_CIPHERTEXT = 'a3f10c'.repeat(16)

function urlFor(name: string): string {
  const url = new URL(DATABASE_URL)
  url.pathname = `/${name}`
  return url.toString()
}

let sql: ReturnType<typeof postgres>
let db: Database
let settings: SettingsService

/** Store a provider row exactly as ProviderSetup.configure does. */
async function configureProvider(providerType: string, hubId: string | null): Promise<void> {
  await settings.upsertProviderConfig({
    hubId,
    providerType,
    credentials: OPAQUE_CIPHERTEXT,
    status: 'connected',
    capabilities: [],
    phoneNumbers: [],
    error: null,
    lastCheckedAt: new Date(),
  })
}

async function createHub(id: string): Promise<void> {
  await settings.createHub({
    id,
    name: `Hub ${id}`,
    slug: id,
    status: 'active',
    createdBy: 'integration-test',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never)
}

beforeAll(async () => {
  const admin = postgres(DATABASE_URL, { max: 1 })
  try {
    await admin.unsafe(`CREATE DATABASE ${DB_NAME}`)
  } finally {
    await admin.end()
  }

  const migrate = spawnSync('bun', ['--no-env-file', 'scripts/run-migrations.ts'], {
    cwd: REPO_ROOT,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: urlFor(DB_NAME) },
    encoding: 'utf-8',
    timeout: 120_000,
  })
  if (migrate.status !== 0) {
    throw new Error(`migrations failed:\n${migrate.stdout}\n${migrate.stderr}`)
  }

  sql = postgres(urlFor(DB_NAME), { max: 4 })
  db = drizzle(sql, { schema }) as unknown as Database
  settings = new SettingsService(db)
}, 180_000)

afterAll(async () => {
  await sql?.end()
  const admin = postgres(DATABASE_URL, { max: 1 })
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`)
  } finally {
    await admin.end()
  }
  // `DROP DATABASE ... WITH (FORCE)` exceeds vitest's 10s default when the
  // box is under parallel test load — the tests all pass and only the
  // teardown times out, which surfaces as a bogus file-level failure.
  // Observed locally; budget it rather than leave a latent CI flake.
}, 60_000)

describe('getHubTelephonyProvider reads a really-stored row', () => {
  it('returns the provider type a hub was actually configured with', async () => {
    const hubId = 'hub-reads-row'
    await createHub(hubId)
    await configureProvider('telnyx', hubId)

    const config = await settings.getHubTelephonyProvider(hubId)

    expect(config).not.toBeNull()
    expect(config!.type).toBe('telnyx')
  })

  it('returns null only when the hub really has no provider row', async () => {
    const hubId = 'hub-no-provider'
    await createHub(hubId)
    expect(await settings.getHubTelephonyProvider(hubId)).toBeNull()
  })
})

describe('updateIvrLanguages constrains by the HUB provider, not the global one', () => {
  it("rejects a language the hub's provider cannot speak even though the global provider can", async () => {
    const hubId = 'hub-telnyx'
    await createHub(hubId)
    // Instance-wide provider speaks Vietnamese; the hub's does not. If the
    // constraint resolves the global provider, 'vi' is accepted and this fails.
    await configureProvider('twilio', null)
    await configureProvider('telnyx', hubId)

    await expect(
      settings.updateIvrLanguages({ enabledLanguages: ['en', 'vi'] }, hubId),
    ).rejects.toMatchObject({ status: 400 })
  })

  it("accepts a language the hub's provider can speak", async () => {
    const hubId = 'hub-telnyx-ok'
    await createHub(hubId)
    await configureProvider('telnyx', hubId)

    const result = await settings.updateIvrLanguages({ enabledLanguages: ['en', 'es'] }, hubId)
    expect(result.enabledLanguages).toEqual(['en', 'es'])
  })

  it('falls back to the global provider only when the hub has none', async () => {
    const hubId = 'hub-inherits-global'
    await createHub(hubId)
    await configureProvider('twilio', null)

    // Twilio speaks 'vi', so the same list the telnyx hub rejects is accepted here.
    const result = await settings.updateIvrLanguages({ enabledLanguages: ['en', 'vi'] }, hubId)
    expect(result.enabledLanguages).toEqual(['en', 'vi'])
  })
})
