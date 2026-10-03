/**
 * Shipped hub-template roles vs. the shift routes they exist to use (#1348).
 *
 * Every role a template ships that can answer calls must be importable and able
 * to clock in, heartbeat and clock out — using exactly the permissions the
 * template grants, through the real route and the real permission guard.
 */
import { describe, it, expect, vi } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { AppEnv } from '@worker/types'
import shiftRoutes from '@worker/routes/shifts'
import { permissionGranted, isValidPermission, DEFAULT_ROLES } from '@shared/permissions'

const TEMPLATES_DIR = join(import.meta.dirname, '../../../../../packages/protocol/templates')

interface TemplateRole {
  template: string
  role: string
  permissions: string[]
}

function callAnsweringTemplateRoles(): TemplateRole[] {
  const roles: TemplateRole[] = []
  for (const file of readdirSync(TEMPLATES_DIR).filter(f => f.endsWith('.json')).sort()) {
    const template = JSON.parse(readFileSync(join(TEMPLATES_DIR, file), 'utf8')) as {
      id: string
      suggestedRoles?: Array<{ name: string; permissions: string[] }>
    }
    for (const role of template.suggestedRoles ?? []) {
      if (permissionGranted(role.permissions, 'calls:answer')) {
        roles.push({ template: template.id, role: role.name, permissions: role.permissions })
      }
    }
  }
  return roles
}

const SELF = 'a'.repeat(64)
const HUB = 'hub-1'

function appFor(permissions: string[], services: Record<string, unknown>, scope: 'hub' | 'global' = 'hub') {
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('pubkey', SELF)
    // Template roles are hub-scoped: hubContext resolves them into hubPermissions.
    // DEFAULT_ROLES are global, and arrive on `permissions` instead — the two
    // paths are different, so a role that works in one can still 403 in the other.
    c.set('permissions', scope === 'global' ? permissions : [])
    c.set('hubPermissions', scope === 'global' ? [] : permissions)
    c.set('hubId', HUB)
    c.set('services', services as unknown as AppEnv['Variables']['services'])
    c.set('allRoles', [])
    await next()
  })
  app.route('/shifts', shiftRoutes)
  return app
}

const roles = callAnsweringTemplateRoles()

describe('shipped template roles that can answer calls (#1348)', () => {
  it('the templates directory ships call-answering roles (guards against an empty matrix)', () => {
    expect(roles.length).toBeGreaterThan(0)
  })

  describe.each(roles)('$template / $role', ({ permissions }) => {
    it('is importable — POST /roles/from-template rejects any permission outside the catalog', () => {
      expect(permissions.filter(p => !isValidPermission(p))).toEqual([])
    })

    it('clocks in, heartbeats and clocks out as itself in its hub', async () => {
      const activeShifts = {
        clockIn: vi.fn().mockResolvedValue(undefined),
        heartbeat: vi.fn().mockResolvedValue(undefined),
        clockOut: vi.fn().mockResolvedValue(undefined),
      }
      const app = appFor(permissions, { activeShifts })

      for (const action of ['clock-in', 'heartbeat', 'clock-out'] as const) {
        const res = await app.request(`/shifts/${action}`, { method: 'POST' })
        expect(res.status, `${action} → ${await res.clone().text()}`).toBe(200)
        expect(await res.json()).toEqual({ ok: true })
      }
      expect(activeShifts.clockIn).toHaveBeenCalledWith(SELF, HUB)
      expect(activeShifts.heartbeat).toHaveBeenCalledWith(SELF, HUB)
      expect(activeShifts.clockOut).toHaveBeenCalledWith(SELF, HUB)
    })
  })
})

/**
 * The same invariant for the GLOBAL default roles (#1342).
 *
 * #1406 fixed the hub TEMPLATE roles (#1348) by granting them
 * `shifts:set-availability`. It did not touch `DEFAULT_ROLES` in
 * packages/shared/permissions.ts, so the role an ordinary volunteer actually
 * gets on a default install still 403'd on clock-in: verified against a live
 * database, `role-volunteer` had `calls:answer` and no
 * `shifts:set-availability`.
 *
 * A role that can answer a call but cannot say it is available is not a
 * coherent role, whichever list it is shipped in.
 */
describe('shipped DEFAULT_ROLES that can answer calls (#1342)', () => {
  const answering = DEFAULT_ROLES.filter(r => permissionGranted(r.permissions, 'calls:answer'))

  it('the default role list ships call-answering roles (guards against an empty matrix)', () => {
    expect(answering.map(r => r.id)).toContain('role-volunteer')
  })

  describe.each(answering.map(r => ({ id: r.id, permissions: r.permissions })))('$id', ({ permissions }) => {
    it('clocks in, heartbeats and clocks out as itself', async () => {
      const activeShifts = {
        clockIn: vi.fn().mockResolvedValue(undefined),
        heartbeat: vi.fn().mockResolvedValue(undefined),
        clockOut: vi.fn().mockResolvedValue(undefined),
      }
      const app = appFor(permissions, { activeShifts }, 'global')

      for (const action of ['clock-in', 'heartbeat', 'clock-out'] as const) {
        const res = await app.request(`/shifts/${action}`, { method: 'POST' })
        expect(res.status, `${action} → ${await res.clone().text()}`).toBe(200)
      }
      expect(activeShifts.clockIn).toHaveBeenCalledWith(SELF, HUB)
    })
  })
})
