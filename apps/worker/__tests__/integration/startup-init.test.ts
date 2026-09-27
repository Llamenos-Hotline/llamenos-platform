/**
 * Server startup initialisation (#1138) — boots the real entry point.
 *
 * Every other test path reaches initialisation through `/api/test-reset` or the
 * demo seeder, both of which call `ensureInit` themselves. Production has
 * neither, so a fresh deployment came up with no settings row, no roles and no
 * admin — ADMIN_PUBKEY was inert. These tests boot `src/server/index.ts` as a
 * subprocess against a freshly migrated, never-seeded database and inspect what
 * the boot alone left behind. Initialisation now runs on every boot, so they
 * also pin that a reboot never overwrites what an operator has changed.
 *
 * Each test gets its own database, dropped on teardown.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import postgres from 'postgres'
import { DEFAULT_ROLES } from '@shared/permissions'

const REPO_ROOT = path.resolve(__dirname, '../../../..')

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

const ADMIN_PUBKEY = 'c'.repeat(64)
const BOOT_TIMEOUT_MS = 60_000

const createdDatabases: string[] = []

function databaseUrlFor(name: string): string {
  const url = new URL(DATABASE_URL)
  url.pathname = `/${name}`
  return url.toString()
}

/** Create an empty database and apply every migration — nothing seeded. */
async function freshMigratedDatabase(): Promise<string> {
  const name = `boot_init_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const admin = postgres(DATABASE_URL, { max: 1 })
  try {
    await admin.unsafe(`CREATE DATABASE ${name}`)
  } finally {
    await admin.end()
  }
  createdDatabases.push(name)

  const url = databaseUrlFor(name)
  const migrate = spawnSync('bun', ['--no-env-file', 'scripts/run-migrations.ts'], {
    cwd: REPO_ROOT,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: url },
    encoding: 'utf-8',
    timeout: BOOT_TIMEOUT_MS,
  })
  if (migrate.status !== 0) {
    throw new Error(`migrations failed:\n${migrate.stdout}\n${migrate.stderr}`)
  }
  return url
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      if (address === null || typeof address === 'string') {
        srv.close()
        reject(new Error('could not allocate a port'))
        return
      }
      srv.close(() => resolve(address.port))
    })
  })
}

/**
 * Boot the production entry point, wait until it serves, then shut it down.
 *
 * Serving begins only after the module's top-level awaits resolve, so a
 * response proves the whole startup sequence has run. `--no-env-file` keeps the
 * repo's `.env` out: the server sees exactly the environment given here.
 */
async function bootServer(databaseUrl: string, adminPubkey: string | undefined): Promise<void> {
  const port = await freePort()
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    DATABASE_URL: databaseUrl,
    PORT: String(port),
    HMAC_SECRET: 'a'.repeat(64),
    SERVER_SECRET: 'b'.repeat(64),
    HOTLINE_NAME: 'Boot Test',
    ENVIRONMENT: 'production',
    WEBHOOK_BASE_URL: 'https://boot-test.invalid',
    // Blob storage is constructed at boot but never contacted by these tests.
    STORAGE_ENDPOINT: 'http://127.0.0.1:1',
    STORAGE_ACCESS_KEY: 'boot-test',
    STORAGE_SECRET_KEY: 'boot-test',
  }
  if (adminPubkey) env.ADMIN_PUBKEY = adminPubkey
  if (process.env.LLAMENOS_CRYPTO_LIB) env.LLAMENOS_CRYPTO_LIB = process.env.LLAMENOS_CRYPTO_LIB

  const child = spawn('bun', ['--no-env-file', 'src/server/index.ts'], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  let exitCode: number | null | undefined
  const exited = new Promise<void>((resolve) => {
    child.once('exit', (code) => {
      exitCode = code
      resolve()
    })
  })

  try {
    const deadline = Date.now() + BOOT_TIMEOUT_MS
    for (;;) {
      if (exitCode !== undefined) {
        throw new Error(`server exited (code ${exitCode}) before serving:\n${output}`)
      }
      if (Date.now() > deadline) {
        throw new Error(`server did not start serving within ${BOOT_TIMEOUT_MS}ms:\n${output}`)
      }
      const live = await fetch(`http://127.0.0.1:${port}/api/health/live`).catch(() => null)
      if (live?.ok) return
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  } finally {
    if (exitCode === undefined) child.kill('SIGTERM')
    await exited
  }
}

async function withDb<T>(databaseUrl: string, fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(databaseUrl, { max: 1 })
  try {
    return await fn(sql)
  } finally {
    await sql.end()
  }
}

afterEach(async () => {
  const admin = postgres(DATABASE_URL, { max: 1 })
  try {
    for (const name of createdDatabases.splice(0)) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
    }
  } finally {
    await admin.end()
  }
})

const DEFAULT_ROLE_IDS = DEFAULT_ROLES.map((r) => r.id).sort()

describe('server startup initialisation', () => {
  it('a never-seeded database boots with the configured admin and the default roles', async () => {
    const url = await freshMigratedDatabase()

    await bootServer(url, ADMIN_PUBKEY)

    await withDb(url, async (sql) => {
      const admins = await sql<{ roles: string[]; active: boolean }[]>`
        SELECT roles, active FROM users WHERE pubkey = ${ADMIN_PUBKEY}`
      expect(admins).toHaveLength(1)
      expect(admins[0].roles).toContain('role-super-admin')
      expect(admins[0].active).toBe(true)

      const roles = await sql<{ id: string }[]>`SELECT id FROM roles ORDER BY id`
      expect(roles.map((r) => r.id)).toEqual(DEFAULT_ROLE_IDS)

      const settings = await sql<{ spam_settings: Record<string, unknown>; ivr_languages: string[] }[]>`
        SELECT spam_settings, ivr_languages FROM system_settings`
      expect(settings).toHaveLength(1)
      expect(Object.keys(settings[0].spam_settings).length).toBeGreaterThan(0)
      expect(settings[0].ivr_languages.length).toBeGreaterThan(0)
    })
  }, BOOT_TIMEOUT_MS * 3)

  it('without ADMIN_PUBKEY the roles are seeded but no user is created, leaving the bootstrap flow open', async () => {
    const url = await freshMigratedDatabase()

    await bootServer(url, undefined)

    await withDb(url, async (sql) => {
      const [{ count: userCount }] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM users`
      expect(userCount).toBe(0)
      const roles = await sql<{ id: string }[]>`SELECT id FROM roles ORDER BY id`
      expect(roles.map((r) => r.id)).toEqual(DEFAULT_ROLE_IDS)
    })
  }, BOOT_TIMEOUT_MS * 3)

  it('rebooting preserves operator changes to settings, roles and the configured admin', async () => {
    const url = await freshMigratedDatabase()
    await bootServer(url, ADMIN_PUBKEY)

    const customSpam = { voiceCaptchaEnabled: true, rateLimitEnabled: false, maxCallsPerMinute: 9, blockDurationMinutes: 5 }
    await withDb(url, async (sql) => {
      await sql`UPDATE system_settings SET spam_settings = ${sql.json(customSpam)}, ivr_languages = ${['fr']}`
      await sql`UPDATE roles SET description = 'edited by operator' WHERE id = 'role-volunteer'`
      await sql`DELETE FROM roles WHERE id = 'role-reporter'`
      await sql`INSERT INTO roles (id, name, slug, permissions) VALUES ('role-custom', 'Custom', 'custom', ${['calls:read']})`
      // An admin deliberately deactivated the configured admin and gave it a second role.
      await sql`UPDATE users SET active = false, roles = ${['role-super-admin', 'role-volunteer']} WHERE pubkey = ${ADMIN_PUBKEY}`
    })

    await bootServer(url, ADMIN_PUBKEY)

    await withDb(url, async (sql) => {
      const [settings] = await sql<{ spam_settings: Record<string, unknown>; ivr_languages: string[] }[]>`
        SELECT spam_settings, ivr_languages FROM system_settings`
      expect(settings.spam_settings).toEqual(customSpam)
      expect(settings.ivr_languages).toEqual(['fr'])

      const roles = await sql<{ id: string; description: string }[]>`SELECT id, description FROM roles ORDER BY id`
      const roleIds = roles.map((r) => r.id)
      expect(roleIds).toContain('role-custom')
      expect(roleIds).not.toContain('role-reporter')
      expect(roles.find((r) => r.id === 'role-volunteer')?.description).toBe('edited by operator')

      const [admin] = await sql<{ roles: string[]; active: boolean }[]>`
        SELECT roles, active FROM users WHERE pubkey = ${ADMIN_PUBKEY}`
      expect(admin.active).toBe(false)
      expect(admin.roles).toEqual(['role-super-admin', 'role-volunteer'])
    })
  }, BOOT_TIMEOUT_MS * 4)

  it('rebooting restores role-super-admin to the configured admin without discarding its other roles', async () => {
    const url = await freshMigratedDatabase()
    await bootServer(url, ADMIN_PUBKEY)
    await withDb(url, async (sql) => {
      await sql`UPDATE users SET roles = ${['role-volunteer']} WHERE pubkey = ${ADMIN_PUBKEY}`
    })

    await bootServer(url, ADMIN_PUBKEY)

    await withDb(url, async (sql) => {
      const [admin] = await sql<{ roles: string[] }[]>`SELECT roles FROM users WHERE pubkey = ${ADMIN_PUBKEY}`
      expect(admin.roles).toEqual(['role-volunteer', 'role-super-admin'])
    })
  }, BOOT_TIMEOUT_MS * 4)
})
