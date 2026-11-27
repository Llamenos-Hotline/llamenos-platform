/**
 * `POST /api/test-seed` never edits a deployment-wide role (#3082, #3083).
 *
 * Its old `grantVolunteerCms` switch called `roles.updateRole('role-volunteer', …)`
 * with a hand-written permission list. A role with no `hubId` is shared by every
 * hub on the server, so the edit outlived the scenario that asked for it: on the
 * Android CI backend one CMS scenario ran first, and every later volunteer —
 * the M1 probe's `shifts`, `calls` and `notesFromCall` flows — had lost
 * `shifts:set-availability`, `calls:hangup` and `calls:read-own-history`. Each
 * flow passed alone and failed after the shard's Cucumber run.
 *
 * The role service here records every method called on it, so any role write
 * from any seed branch fails the test, not only the one that existed.
 */
import { describe, it, expect, vi } from 'vitest'

// apps/worker/routes/dev.ts imports apps/worker/db, which uses Bun's native SQL
// driver — unavailable under vitest's worker pool. Every service is stubbed.
vi.mock('@worker/db', () => ({
  createDatabase: vi.fn(),
  getDb: vi.fn(),
  closeDb: vi.fn(),
  schema: {},
}))

import { Hono } from 'hono'
import dev from '@worker/routes/dev'
import type { AppEnv } from '@worker/types'

const SECRET = 'test-reset-secret'
const HUB_ID = '11111111-1111-4111-8111-111111111111'
const ADMIN_SEED = 'b'.repeat(64)
const MEMBER = 'c'.repeat(64)
const ENV = { ENVIRONMENT: 'development', DEV_ROUTES_ENABLED: 'true', DEV_RESET_SECRET: SECRET }

function seedApp() {
  const roleCalls: string[] = []
  // Any property read on the role service is a method the route meant to call.
  const roles = new Proxy({}, {
    get: (_target, prop) => (..._args: unknown[]) => {
      roleCalls.push(String(prop))
      return Promise.resolve({ roles: [] })
    },
  })
  const caseManagement = vi.fn(async () => ({ enabled: true }))
  const setHubRole = vi.fn(async () => undefined)
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('services', {
      roles,
      settingsBootstrap: { ensureInit: vi.fn(async () => undefined) },
      hubSettings: { setCaseManagementEnabled: caseManagement },
      identity: { setHubRole },
    } as never)
    await next()
  })
  app.route('/', dev)
  const seed = (body: Record<string, unknown>) => app.request(
    '/test-seed',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Test-Secret': SECRET },
      body: JSON.stringify({ hubId: HUB_ID, adminSeed: ADMIN_SEED, ...body }),
    },
    ENV,
  )
  return { seed, roleCalls, caseManagement, setHubRole }
}

describe('test-seed leaves deployment-wide roles alone (#3082, #3083)', () => {
  it('enables case management for the hub without writing any role', async () => {
    const { seed, roleCalls, caseManagement } = seedApp()
    const res = await seed({ permissions: { enableCaseManagement: true } })

    expect(res.status).toBe(200)
    expect(caseManagement).toHaveBeenCalledWith({ enabled: true }, HUB_ID)
    expect(roleCalls).toEqual([])
  })

  it('assigns seeded members a hub role without editing the role itself', async () => {
    const { seed, roleCalls, setHubRole } = seedApp()
    const res = await seed({
      permissions: { enableCaseManagement: true },
      members: [{ pubkey: MEMBER, roleIds: ['role-volunteer'] }],
    })

    expect(res.status).toBe(200)
    expect(setHubRole).toHaveBeenCalledWith({ pubkey: MEMBER, hubId: HUB_ID, roleIds: ['role-volunteer'] })
    expect(roleCalls).toEqual([])
  })

  it('refuses the removed grantVolunteerCms switch instead of silently ignoring it', async () => {
    const { seed, roleCalls, caseManagement } = seedApp()
    const res = await seed({ permissions: { grantVolunteerCms: true, enableCaseManagement: true } })

    expect(res.status).toBe(400)
    expect(caseManagement).not.toHaveBeenCalled()
    expect(roleCalls).toEqual([])
  })
})
