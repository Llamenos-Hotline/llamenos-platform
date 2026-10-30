/**
 * IncidentService against real PostgreSQL (B-INCIDENTS, #2341).
 *
 * The rate rules, the open/update/close lifecycle, escalation, level checks
 * and the L1/L2 failure paths, with an injected clock — so "50 signals in one
 * window produce one open notification" is asserted against the real
 * transaction, advisory lock and partial unique index, not a mock of them.
 *
 * Requires postgres at DATABASE_URL; creates and drops its own database.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { and, eq, isNull } from 'drizzle-orm'
import { insertHubFounder } from '../helpers/hub-founder'
import * as schema from '../../db/schema'
import type { HubIncidentRow } from '../../db/schema/incidents'
import type { IncidentState } from '@protocol/schemas/incidents'

vi.mock('@llamenos/crypto/ffi', async () => await import('../mocks/llamenos-crypto-ffi'))
import { freshHubDb } from './hub-shred-helpers'
import { IncidentService, WORKER_FAILURE_THRESHOLD, type IncidentNotifier } from '../../services/incidents'
import { INCIDENT_CATEGORIES } from '../../services/incidents-categories'

const fresh = freshHubDb('hub_incidents')

beforeAll(fresh.setup, 180_000)
afterAll(fresh.teardown, 60_000)

const T0 = new Date('2030-01-01T10:00:00.000Z')
const MINUTE = 60_000

let clock = T0
const at = (ms: number) => {
  clock = new Date(T0.getTime() + ms)
}

interface Sent {
  channel: 'relay' | 'interrupt'
  incidentId: string
  state: IncidentState
}

function recorder(): IncidentNotifier & { sent: Sent[] } {
  const sent: Sent[] = []
  return {
    sent,
    async relay(incident: HubIncidentRow, state: IncidentState) {
      sent.push({ channel: 'relay', incidentId: incident.id, state })
    },
    async interrupt(incident: HubIncidentRow, state: IncidentState) {
      sent.push({ channel: 'interrupt', incidentId: incident.id, state })
    },
  }
}

let hubCounter = 0
async function createHub(): Promise<string> {
  const id = `hub-inc-${++hubCounter}-${Math.random().toString(36).slice(2, 8)}`
  await fresh.settings.createHub({
    id,
    name: `Hub ${id}`,
    slug: id,
    status: 'active',
    createdBy: 'integration-test',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never, await insertHubFounder(fresh.db))
  return id
}

let service: IncidentService
let notifier: ReturnType<typeof recorder>

beforeEach(() => {
  clock = T0
  service = new IncidentService(fresh.db, fresh.audit, { now: () => clock })
  notifier = recorder()
  service.setNotifier(notifier)
})

async function openRows(hubId: string) {
  return fresh.db
    .select()
    .from(schema.hubIncidents)
    .where(and(eq(schema.hubIncidents.hubId, hubId), isNull(schema.hubIncidents.closedAt)))
}

describe('signal()', () => {
  it('50 signals in one window: one incident row, one open notification, no update', async () => {
    const hubId = await createHub()
    for (let i = 0; i < 50; i++) {
      at(i * 1000) // 50 seconds, well inside spam's 10-minute window
      await service.signal(hubId, 'spam', 'fail')
    }

    const rows = await openRows(hubId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.counts).toEqual({ fail: 50 })
    expect(rows[0]!.peakPerMinute).toBe(50)
    expect(notifier.sent).toEqual([
      { channel: 'relay', incidentId: rows[0]!.id, state: 'opened' },
      { channel: 'interrupt', incidentId: rows[0]!.id, state: 'opened' },
    ])
  })

  it('sends at most one update per category window', async () => {
    const hubId = await createHub()
    const window = INCIDENT_CATEGORIES.spam.updateWindowMs
    await service.signal(hubId, 'spam', 'fail')
    at(window - 1)
    await service.signal(hubId, 'spam', 'fail')
    at(window)
    await service.signal(hubId, 'spam', 'fail') // window elapsed → one update
    at(window + 1000)
    await service.signal(hubId, 'spam', 'fail') // inside the next window → nothing

    expect(notifier.sent.map((s) => `${s.channel}:${s.state}`)).toEqual([
      'relay:opened',
      'interrupt:opened',
      'relay:updated',
      'interrupt:updated',
    ])
  })

  it('tracks the per-minute peak across minutes', async () => {
    const hubId = await createHub()
    await service.signal(hubId, 'spam', 'fail', 3)
    at(MINUTE)
    await service.signal(hubId, 'spam', 'fail', 7)
    at(MINUTE + 30_000)
    await service.signal(hubId, 'spam', 'challenge', 2)
    at(3 * MINUTE)
    const incident = await service.signal(hubId, 'spam', 'fail', 1)
    expect(incident.peakPerMinute).toBe(9)
    expect(incident.counts).toEqual({ fail: 11, challenge: 2 })
    expect(incident.totalCount).toBe(13)
  })

  it('a record-severity kind is visible but interrupts nobody', async () => {
    const hubId = await createHub()
    const incident = await service.signal(hubId, 'spam', 'challenge', 4)
    expect(incident.severity).toBe('record')
    expect(notifier.sent).toEqual([{ channel: 'relay', incidentId: incident.id, state: 'opened' }])
    const listed = await service.listForHub(hubId, ['spam'], { openOnly: true })
    expect(listed.map((i) => i.id)).toEqual([incident.id])
  })

  it('escalates record → notify at once, interrupting with "opened" (nobody was woken before)', async () => {
    const hubId = await createHub()
    const opened = await service.signal(hubId, 'spam', 'challenge')
    at(5_000) // inside the window: only the escalation may announce
    const escalated = await service.signal(hubId, 'spam', 'fail')
    expect(escalated.severity).toBe('notify')
    expect(notifier.sent).toEqual([
      { channel: 'relay', incidentId: opened.id, state: 'opened' },
      { channel: 'relay', incidentId: opened.id, state: 'updated' },
      { channel: 'interrupt', incidentId: opened.id, state: 'opened' },
    ])
    // ...and never downgrades.
    at(6_000)
    expect((await service.signal(hubId, 'spam', 'challenge')).severity).toBe('notify')
  })

  it('keeps hubs and categories apart', async () => {
    const hubA = await createHub()
    const hubB = await createHub()
    await service.signal(hubA, 'spam', 'fail')
    await service.signal(hubB, 'spam', 'fail')
    await service.signal(hubA, 'provider-media', 'delete_failed')
    expect((await openRows(hubA)).map((r) => r.category).sort()).toEqual(['provider-media', 'spam'])
    expect((await openRows(hubB)).map((r) => r.category)).toEqual(['spam'])
    expect(await service.listForHub(hubA, ['spam'], { openOnly: true })).toHaveLength(1)
    expect(await service.listForHub(hubA, [], { openOnly: true })).toEqual([])
  })

  it('concurrent signals for one hub and category still yield exactly one open incident', async () => {
    const hubId = await createHub()
    await Promise.all(Array.from({ length: 20 }, () => service.signal(hubId, 'spam', 'fail')))
    const rows = await openRows(hubId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.counts).toEqual({ fail: 20 })
    expect(notifier.sent.filter((s) => s.state === 'opened' && s.channel === 'relay')).toHaveLength(1)
  })

  it('refuses a kind the category does not declare, and a non-positive count', async () => {
    const hubId = await createHub()
    await expect(service.signal(hubId, 'spam', 'delete_failed')).rejects.toThrow(/not declared/)
    await expect(service.signal(hubId, 'spam', 'fail', 0)).rejects.toThrow()
    await expect(service.signal(hubId, 'spam', 'fail', -2)).rejects.toThrow()
    expect(await openRows(hubId)).toEqual([])
  })

  it('audits open and close with actor system and counts — no identifiers', async () => {
    const hubId = await createHub()
    await service.signal(hubId, 'spam', 'fail', 2)
    at(INCIDENT_CATEGORIES.spam.quietPeriodMs)
    await service.closeQuiet()
    const { entries } = await fresh.audit.list(hubId)
    const opened = entries.find((e) => e.action === 'incidentOpened')
    const closed = entries.find((e) => e.action === 'incidentClosed')
    expect(opened).toBeDefined()
    expect(closed).toBeDefined()
    expect(opened!.actorPubkey).toBe('system')
    expect(JSON.stringify(closed!.details)).toContain('"fail":2')
  })
})

describe('closeQuiet()', () => {
  it('closes after the quiet period and tells whoever was woken', async () => {
    const hubId = await createHub()
    const incident = await service.signal(hubId, 'spam', 'fail')
    at(INCIDENT_CATEGORIES.spam.quietPeriodMs - 1)
    expect(await service.closeQuiet()).toEqual({ closed: 0, updated: 0 })
    at(INCIDENT_CATEGORIES.spam.quietPeriodMs)
    expect((await service.closeQuiet()).closed).toBe(1)
    expect(notifier.sent.slice(-2)).toEqual([
      { channel: 'relay', incidentId: incident.id, state: 'closed' },
      { channel: 'interrupt', incidentId: incident.id, state: 'closed' },
    ])
    expect(await service.listForHub(hubId, ['spam'], { openOnly: true })).toEqual([])
    const history = await service.listForHub(hubId, ['spam'], { openOnly: false })
    expect(history[0]!.closedAt).toBe(clock.toISOString())
  })

  it('closing a record-only incident wakes nobody', async () => {
    const hubId = await createHub()
    await service.signal(hubId, 'spam', 'challenge')
    at(INCIDENT_CATEGORIES.spam.quietPeriodMs)
    await service.closeQuiet()
    expect(notifier.sent.filter((s) => s.channel === 'interrupt')).toEqual([])
  })

  it('a new signal after close opens a new incident', async () => {
    const hubId = await createHub()
    const first = await service.signal(hubId, 'spam', 'fail')
    at(INCIDENT_CATEGORIES.spam.quietPeriodMs)
    await service.closeQuiet()
    at(INCIDENT_CATEGORIES.spam.quietPeriodMs + 1000)
    const second = await service.signal(hubId, 'spam', 'fail')
    expect(second.id).not.toBe(first.id)
    expect(second.counts).toEqual({ fail: 1 })
  })

  it('flushes the trailing update for signals that arrived inside the last window', async () => {
    const hubId = await createHub()
    const window = INCIDENT_CATEGORIES.spam.updateWindowMs
    const incident = await service.signal(hubId, 'spam', 'fail')
    at(60_000)
    await service.signal(hubId, 'spam', 'fail') // inside the window: not announced
    at(window - 1)
    expect((await service.closeQuiet()).updated).toBe(0)
    at(window)
    expect((await service.closeQuiet()).updated).toBe(1)
    expect(notifier.sent.slice(-2)).toEqual([
      { channel: 'relay', incidentId: incident.id, state: 'updated' },
      { channel: 'interrupt', incidentId: incident.id, state: 'updated' },
    ])
    at(window + MINUTE)
    expect((await service.closeQuiet()).updated).toBe(0) // nothing new since
  })

  it('scoped to one hub, it leaves other hubs alone', async () => {
    const hubA = await createHub()
    const hubB = await createHub()
    await service.signal(hubA, 'spam', 'fail')
    await service.signal(hubB, 'spam', 'fail')
    await service.closeQuiet({ hubId: hubA, asOf: new Date(T0.getTime() + INCIDENT_CATEGORIES.spam.quietPeriodMs) })
    expect(await openRows(hubA)).toEqual([])
    expect(await openRows(hubB)).toHaveLength(1)
  })
})

describe('L1 checks and L2 worker failures', () => {
  it('registerCheck stores a check without running it; runChecks observes a level, never accumulating it', async () => {
    const hubId = await createHub()
    const check = vi.fn(async (h: string) => (h === hubId ? { count: 4, oldestAgeSeconds: 7200 } : { count: 0, oldestAgeSeconds: null }))
    service.registerCheck({ category: 'erasure-deadline', kind: 'overdue', name: 'erasure-overdue', check })
    expect(check).not.toHaveBeenCalled()

    await service.runChecks()
    at(5 * MINUTE)
    await service.runChecks()

    const [row] = await openRows(hubId)
    expect(row!.category).toBe('erasure-deadline')
    expect(row!.counts).toEqual({ overdue: 4 }) // a level, not 8
    expect(row!.oldestAgeSeconds).toBe(7200)
  })

  it('an empty check result opens nothing', async () => {
    const hubId = await createHub()
    service.registerCheck({
      category: 'erasure-deadline',
      kind: 'overdue',
      name: 'empty',
      check: async () => ({ count: 0, oldestAgeSeconds: null }),
    })
    await service.runChecks()
    expect(await openRows(hubId)).toEqual([])
  })

  it('a check that throws three times raises worker_failing — never a zero count', async () => {
    const hubId = await createHub()
    service.registerCheck({
      category: 'erasure-deadline',
      kind: 'overdue',
      name: 'broken',
      check: async () => {
        throw new Error('relation does not exist')
      },
    })
    for (let i = 1; i < WORKER_FAILURE_THRESHOLD; i++) {
      expect((await service.runChecks()).failed).toBeGreaterThan(0)
      expect(await openRows(hubId)).toEqual([])
    }
    await service.runChecks()
    const [row] = await openRows(hubId)
    expect(row!.category).toBe('erasure-deadline')
    expect(row!.counts).toEqual({ worker_failing: 1 })
    expect(row!.severity).toBe('notify')
  })

  it('runWorkerTick: a success resets the streak; the error is rethrown unchanged', async () => {
    const hubId = await createHub()
    const fail = () => service.runWorkerTick('erasure-expiry', 'erasure-deadline', async () => {
      throw new Error('db down')
    }, { hubId })
    await expect(fail()).rejects.toThrow('db down')
    await expect(fail()).rejects.toThrow('db down')
    await expect(service.runWorkerTick('erasure-expiry', 'erasure-deadline', async () => 'ok', { hubId })).resolves.toBe('ok')
    await expect(fail()).rejects.toThrow('db down')
    await expect(fail()).rejects.toThrow('db down')
    expect(await openRows(hubId)).toEqual([]) // streak was reset: only 2 in a row
    await expect(fail()).rejects.toThrow('db down')
    expect((await openRows(hubId))[0]!.counts).toEqual({ worker_failing: 1 })
  })

  it('runWorkerTick without a hub signals every hub — a worker serving all hubs failing is every hub\'s incident', async () => {
    const hubA = await createHub()
    const hubB = await createHub()
    for (let i = 0; i < WORKER_FAILURE_THRESHOLD; i++) {
      await expect(service.runWorkerTick('provider-recording-sweep', 'provider-media', async () => {
        throw new Error('boom')
      })).rejects.toThrow('boom')
    }
    expect((await openRows(hubA)).map((r) => r.category)).toEqual(['provider-media'])
    expect((await openRows(hubB)).map((r) => r.category)).toEqual(['provider-media'])
  })
})

describe('the table holds no identifier', () => {
  it('has only category, timestamp and integer columns', async () => {
    const columns = await fresh.raw<{ column_name: string; data_type: string }[]>`
      SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'hub_incidents' ORDER BY column_name`
    expect(columns.map((c) => c.column_name).sort()).toEqual([
      'category', 'closed_at', 'counts', 'current_minute_count', 'current_minute_start', 'hub_id', 'id',
      'last_notified_at', 'last_relayed_at', 'last_signal_at', 'oldest_age_seconds', 'opened_at',
      'peak_per_minute', 'severity',
    ])
    for (const c of columns) {
      expect(c.column_name).not.toMatch(/phone|number|digest|hash|sid|caller|record_id|recording|call_id|pubkey/)
    }
  })
})
