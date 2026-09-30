/**
 * Shipped hub-template roles vs. the shift routes they exist to use (#1348).
 *
 * Every role a template ships that can answer calls must be able to clock in,
 * clock out, heartbeat and see the schedule — using exactly the permissions the
 * template grants, through the real route and the real permission guard.
 */
import { describe, it, expect, vi } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { AppEnv } from '@worker/types'
import shiftRoutes from '@worker/routes/shifts'
import { permissionGranted, isValidPermission } from '@shared/permissions'

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
const OTHER = 'b'.repeat(64)
const HUB = 'hub-1'

function appFor(permissions: string[], services: Record<string, unknown>) {
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('pubkey', SELF)
    c.set('permissions', [])
    // Template roles are hub-scoped: hubContext resolves them into hubPermissions.
    c.set('hubPermissions', permissions)
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

    it('sees the hub schedule, and sees who else is rostered only if it may read all shifts', async () => {
      const list = vi.fn().mockResolvedValue({
        shifts: [
          { id: 'mine', encryptedName: 'x', startTime: '09:00', endTime: '17:00', days: [1], ringGroupId: null, userPubkeys: [SELF, OTHER], createdAt: '2026-01-01T00:00:00.000Z' },
          { id: 'open', encryptedName: 'y', startTime: '17:00', endTime: '23:00', days: [1], ringGroupId: null, userPubkeys: [OTHER], createdAt: '2026-01-01T00:00:00.000Z' },
        ],
      })
      const app = appFor(permissions, { shifts: { list } })

      const res = await app.request('/shifts')
      expect(res.status, await res.clone().text()).toBe(200)
      const body = await res.json() as { shifts: Array<{ id: string; userPubkeys: string[] }> }
      expect(list).toHaveBeenCalledWith(HUB)
      expect(body.shifts.map(s => s.id)).toEqual(['mine', 'open'])

      const rosterVisible = permissionGranted(permissions, 'shifts:read')
      expect(body.shifts.find(s => s.id === 'mine')?.userPubkeys)
        .toEqual(rosterVisible ? [SELF, OTHER] : [SELF])
      expect(body.shifts.find(s => s.id === 'open')?.userPubkeys)
        .toEqual(rosterVisible ? [OTHER] : [])
    })
  })
})
