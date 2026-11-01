/**
 * B-INCIDENTS (#2341) unit tier: who is reached, what each channel carries,
 * and where the checks run. The lifecycle and rate rules are asserted against
 * real PostgreSQL in __tests__/integration/hub-incidents.test.ts.
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'

vi.mock('@worker/lib/ws-events', () => ({ publishEvent: vi.fn() }))

import { publishEvent } from '@worker/lib/ws-events'
import type { AppEnv } from '@worker/types'
import type { HubIncidentRow } from '@worker/db/schema/incidents'
import { KIND_HUB_INCIDENT } from '@shared/event-kinds'
import { DEFAULT_ROLES, PERMISSION_CATALOG, type Role } from '@shared/permissions'
import { incidentCategorySchema, type IncidentCategory } from '@protocol/schemas/incidents'
import { locales } from '@llamenos/i18n'
import { IncidentDelivery, resolveIncidentHolders } from '@worker/services/incidents-delivery'
import {
  INCIDENT_CATEGORIES,
  WORKER_FAILING_KIND,
  categoriesReachedBy,
  severityOf,
} from '@worker/services/incidents-categories'
import { renderAlertMessage } from '@worker/services/user-notifications'
import { WORKER_TICK_INTERVAL_MS } from '@worker/metrics/worker-liveness'
import { startIncidentChecksWorker, stopIncidentChecksWorker } from '@worker/lib/incident-checks-worker'
import incidentsRoutes from '@worker/routes/incidents'

/** Anything that looks like a phone number (spec §5.4 trap). */
const NUMBER_SHAPED = /\+?\d{7,}/

const HUB = 'hub-incidents-unit'

const ROLES: Role[] = [
  { id: 'role-super-admin', name: 'Super Admin', slug: 'super-admin', permissions: ['*'] },
  { id: 'role-spam-only', name: 'Spam desk', slug: 'spam-desk', permissions: ['settings:manage-spam'] },
  { id: 'role-providers-only', name: 'Providers', slug: 'providers', permissions: ['telephony:manage-providers'] },
  { id: 'role-volunteer', name: 'Volunteer', slug: 'volunteer', permissions: ['calls:answer', 'erasure:request-self'] },
] as Role[]

function user(pubkey: string, roleIds: string[], extra: Record<string, unknown> = {}) {
  return { pubkey, roles: [], hubRoles: [{ hubId: HUB, roleIds }], active: true, uiLanguage: 'en', ...extra }
}

function incidentRow(overrides: Partial<HubIncidentRow> = {}): HubIncidentRow {
  const t = new Date('2030-01-01T10:00:00Z')
  return {
    id: 'inc-1',
    hubId: HUB,
    category: 'spam',
    severity: 'notify',
    openedAt: t,
    lastSignalAt: t,
    closedAt: null,
    counts: { fail: 15 },
    peakPerMinute: 15,
    currentMinuteStart: t,
    currentMinuteCount: 15,
    oldestAgeSeconds: null,
    lastNotifiedAt: t,
    lastRelayedAt: t,
    ...overrides,
  }
}

function delivery(users: ReturnType<typeof user>[]) {
  const push = { sendToVolunteer: vi.fn(async () => undefined), sendToAllOnShift: vi.fn() }
  const userNotifications = { sendAlert: vi.fn(async () => ({ delivered: true })) }
  const d = new IncidentDelivery({
    env: { SERVER_SECRET: 'ab'.repeat(32) } as never,
    identity: { getUsers: vi.fn(async () => ({ users })) } as never,
    settings: { getRoles: vi.fn(async () => ({ roles: ROLES })) } as never,
    shifts: {} as never,
    userNotifications,
    pushDispatcher: push,
  })
  return { d, push, userNotifications }
}

describe('incident categories', () => {
  it('declares a policy for exactly the protocol categories', () => {
    expect(Object.keys(INCIDENT_CATEGORIES).sort()).toEqual([...incidentCategorySchema.options].sort())
  })

  it.each(Object.entries(INCIDENT_CATEGORIES))('%s is reached by a real permission, never a role', (_c, policy) => {
    expect(Object.keys(PERMISSION_CATALOG)).toContain(policy.permission)
    expect(policy.permission).not.toMatch(/^role-/)
  })

  it('maps each category to the permission the spec names', () => {
    expect(INCIDENT_CATEGORIES.spam.permission).toBe('settings:manage-spam')
    expect(INCIDENT_CATEGORIES['provider-media'].permission).toBe('telephony:manage-providers')
    expect(INCIDENT_CATEGORIES['erasure-deadline'].permission).toBe('erasure:admin')
    expect(INCIDENT_CATEGORIES['ban-expiry'].permission).toBe('system:view-bans')
    expect(INCIDENT_CATEGORIES['channel-disabled'].permission).toBe('hubs:configure')
  })

  it.each(Object.entries(INCIDENT_CATEGORIES))('%s accepts worker_failing as notify, and outlives an incident-checks interval', (category, policy) => {
    expect(severityOf(category as IncidentCategory, WORKER_FAILING_KIND)).toBe('notify')
    // A level check re-observes every tick; a shorter quiet period would close
    // a standing backlog between ticks and re-open it (re-notifying) each time.
    expect(policy.quietPeriodMs).toBeGreaterThan(2 * WORKER_TICK_INTERVAL_MS['incident-checks'])
  })

  it('erasure-deadline is NOT reached by erasure:request-self, which every volunteer holds', () => {
    const reached = categoriesReachedBy((p) => ['erasure:request-self'].includes(p))
    expect(reached).toEqual([])
  })

  it('a wildcard grant reaches through permissionGranted semantics', () => {
    const hubAdmin = DEFAULT_ROLES.find((r) => r.slug === 'hub-admin')!
    const reached = categoriesReachedBy((p) =>
      hubAdmin.permissions.includes(p) || hubAdmin.permissions.includes(`${p.split(':')[0]}:*`))
    expect(reached).toContain('spam')
    expect(reached).toContain('erasure-deadline')
  })
})

describe('resolveIncidentHolders', () => {
  it('reaches holders of the category permission in THIS hub only, and skips inactive accounts', async () => {
    const users = [
      user('spam', ['role-spam-only']),
      user('prov', ['role-providers-only']),
      user('vol', ['role-volunteer']),
      user('gone', ['role-spam-only'], { active: false }),
      // Holds the permission — but in another hub. Not reached here.
      { ...user('elsewhere', []), hubRoles: [{ hubId: 'other-hub', roleIds: ['role-spam-only'] }] },
      // An instance super-admin who is not a member: may read, is not paged.
      { ...user('platform', []), roles: ['role-super-admin'], hubRoles: [] },
      // A super-admin who IS a member of this hub is a holder like anyone else.
      { ...user('member-admin', ['role-volunteer']), roles: ['role-super-admin'] },
    ]
    const identity = { getUsers: vi.fn(async () => ({ users })) }
    const settings = { getRoles: vi.fn(async () => ({ roles: ROLES })) }

    const spam = await resolveIncidentHolders(identity as never, settings as never, HUB, 'spam')
    const provider = await resolveIncidentHolders(identity as never, settings as never, HUB, 'provider-media')

    expect(spam.map((h) => h.pubkey)).toEqual(['spam', 'member-admin'])
    expect(provider.map((h) => h.pubkey)).toEqual(['prov', 'member-admin'])
    expect(identity.getUsers).toHaveBeenCalledWith(HUB)
  })
})

describe('IncidentDelivery', () => {
  beforeEach(() => vi.mocked(publishEvent).mockClear())

  it('relays {incidentId, state} and nothing else — no category, counts or severity can be read from it', async () => {
    const { d } = delivery([])
    await d.relay(incidentRow(), 'opened')

    expect(publishEvent).toHaveBeenCalledTimes(1)
    const [, kind, content, hubId] = vi.mocked(publishEvent).mock.calls[0]!
    expect(kind).toBe(KIND_HUB_INCIDENT)
    expect(hubId).toBe(HUB)
    expect(content).toEqual({ incidentId: 'inc-1', state: 'opened' })
    // Try to read detail out of it.
    const asText = JSON.stringify(content)
    expect(asText).not.toContain('spam')
    expect(asText).not.toContain('fail')
    expect(asText).not.toContain('15')
    expect(asText).not.toContain('notify')
  })

  it('interrupts only holders, with a content-free push and a hub_incident Signal alert in their language', async () => {
    const { d, push, userNotifications } = delivery([
      user('spam', ['role-spam-only'], { uiLanguage: 'es' }),
      user('vol', ['role-volunteer']),
    ])
    await d.interrupt(incidentRow(), 'opened')

    expect(push.sendToVolunteer).toHaveBeenCalledTimes(1)
    const [recipient, wake, full] = push.sendToVolunteer.mock.calls[0] as unknown as [string, Record<string, unknown>, Record<string, unknown>]
    expect(recipient).toBe('spam')
    expect(wake).toEqual({ hubId: HUB, type: 'incident' })
    expect(full).toEqual({ hubId: HUB, type: 'incident' })

    expect(userNotifications.sendAlert).toHaveBeenCalledTimes(1)
    expect(userNotifications.sendAlert).toHaveBeenCalledWith('spam', { type: 'hub_incident', category: 'spam', state: 'opened' }, 'es')
  })

  it('a holder whose push fails still gets the Signal alert', async () => {
    const { d, push, userNotifications } = delivery([user('spam', ['role-spam-only'])])
    push.sendToVolunteer.mockRejectedValueOnce(new Error('apns down'))
    await d.interrupt(incidentRow(), 'closed')
    expect(userNotifications.sendAlert).toHaveBeenCalledTimes(1)
  })
})

describe('the hub_incident Signal alert', () => {
  const categories = incidentCategorySchema.options
  const states = ['opened', 'updated', 'closed'] as const

  it.each(Object.keys(locales))('renders in %s with no number-shaped string and no placeholder left', (locale) => {
    for (const category of categories) {
      for (const state of states) {
        const text = renderAlertMessage({ type: 'hub_incident', category, state }, locale)
        expect(text).not.toMatch(NUMBER_SHAPED)
        expect(text).not.toContain('{{')
        expect(text.length).toBeGreaterThan(0)
      }
    }
  })

  it('is localized, not English, where a translation exists', () => {
    const en = renderAlertMessage({ type: 'hub_incident', category: 'spam', state: 'opened' }, 'en')
    const es = renderAlertMessage({ type: 'hub_incident', category: 'spam', state: 'opened' }, 'es')
    expect(en).toContain('Spam and unwanted calls')
    expect(es).not.toBe(en)
  })

  it('names category and state', () => {
    expect(renderAlertMessage({ type: 'hub_incident', category: 'provider-media', state: 'closed' }, 'en'))
      .toBe('Hotline alert — Recordings left at the phone provider: Ended. Open the app for details.')
  })
})

describe('where L1 checks run', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    stopIncidentChecksWorker()
    vi.useRealTimers()
  })

  it('the incident-checks worker runs them, every interval', async () => {
    const runChecks = vi.fn(async () => ({ evaluated: 0, failed: 0 }))
    startIncidentChecksWorker({ runChecks })
    await vi.advanceTimersByTimeAsync(0)
    expect(runChecks).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(WORKER_TICK_INTERVAL_MS['incident-checks'])
    expect(runChecks).toHaveBeenCalledTimes(2)
  })

  it('nothing but the incident-checks worker runs them — not the worker whose backlog a check measures', () => {
    // A check run inside erasure-expiry could not report erasure-expiry being
    // stopped or wedged (#2323). So `runChecks(` may have exactly one caller in
    // production code, and it is the dedicated worker.
    // A filesystem walk, not `git grep`: the review gate runs in a .git-less export.
    const root = path.resolve(__dirname, '../../../..')
    const callers: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const rel = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__' && entry.name !== 'node_modules') walk(rel)
        } else if (rel.endsWith('.ts') && readFileSync(path.join(root, rel), 'utf8').includes('.runChecks(')) {
          callers.push(rel)
        }
      }
    }
    walk('apps/worker')
    walk('src/server')
    expect(callers).toEqual(['apps/worker/lib/incident-checks-worker.ts'])
  })
})

describe('GET /hubs/:hubId/incidents', () => {
  function app(permissions: string[]) {
    const listForHub = vi.fn(async () => [])
    const a = new Hono<AppEnv>()
    a.use('*', async (c, next) => {
      c.set('permissions', permissions)
      c.set('hubId', HUB)
      c.set('services', { incidents: { listForHub } } as unknown as AppEnv['Variables']['services'])
      await next()
    })
    a.route('/', incidentsRoutes)
    return { a, listForHub }
  }

  it('asks only for the categories the caller holds permission for', async () => {
    const { a, listForHub } = app(['settings:manage-spam', 'calls:answer'])
    const res = await a.request('/?open=true')
    expect(res.status).toBe(200)
    expect(listForHub).toHaveBeenCalledWith(HUB, ['spam'], { openOnly: true })
  })

  it('a member with none of the permissions asks for nothing', async () => {
    const { a, listForHub } = app(['calls:answer', 'erasure:request-self'])
    const res = await a.request('/')
    expect(res.status).toBe(200)
    expect(listForHub).toHaveBeenCalledWith(HUB, [], { openOnly: false })
  })

  it('honours wildcards', async () => {
    const { a, listForHub } = app(['*'])
    await a.request('/?open=true')
    expect(listForHub).toHaveBeenCalledWith(HUB, [...incidentCategorySchema.options], { openOnly: true })
  })

  it('rejects a malformed open flag', async () => {
    const { a } = app(['*'])
    expect((await a.request('/?open=yes')).status).toBe(400)
  })
})
