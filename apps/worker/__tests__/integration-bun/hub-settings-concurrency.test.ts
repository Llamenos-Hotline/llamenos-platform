/**
 * SettingsService hub-settings atomicity — real PostgreSQL, Bun-native driver (#1144).
 *
 * MUST run under `bun test`, NOT vitest:
 *   bun test apps/worker/__tests__/integration-bun/hub-settings-concurrency.test.ts
 *
 * Why this file is separate from apps/worker/__tests__/integration/ (which
 * runs under vitest via `bun run test:worker:integration`): `updateHubSettings`'s
 * atomic merge embeds the settings object directly in a `sql` fragment —
 * `sql\`COALESCE(${hubSettingsTable.settings}, '{}'::jsonb) || ${sanitized}::jsonb\``
 * — and relies on Bun's native SQL driver auto-serializing a JS object bound
 * to a jsonb-typed parameter position. vitest's integration tier runs under
 * Node with `drizzle-orm/postgres-js`, which does NOT do that auto-serialization
 * for a bare `sql` fragment (only for `.values()` writes, which go through the
 * column's own declared type). The first version of this fix "solved" that by
 * JSON.stringify-ing the value before interpolating it — which fixed the
 * vitest/postgres-js test but broke PRODUCTION: Bun's driver then
 * double-encodes the already-stringified value, so `||` sees an object on
 * the left and a JSON string *scalar* on the right, and jsonb's concatenation
 * operator boxes both into a 2-element array instead of merging keys. That
 * exact regression shipped and was only caught by the live backend BDD suite
 * ("Shift and fallback group are independent" / "Fallback group management" /
 * "A hub-specific override takes effect for that hub's IVR menu" — all three
 * silently lost whatever they wrote to hub_settings). This file exists so the
 * next change to this code path is checked against the driver it actually
 * runs under in production, not against a driver that happens to paper over
 * the bug.
 *
 * Requires postgres at DATABASE_URL (default: local dev postgres), with
 * migrations already applied (`bun scripts/worktree-db.ts use-isolated`, or
 * any DB this worktree's dev server already points at). Hubs created here
 * are deleted (cascades to hub_settings) on teardown.
 */
import { describe, it, expect, afterAll } from 'bun:test'
import { inArray } from 'drizzle-orm'
import '../../db/pg-array-patch'
import { createDatabase } from '../../db'
import { hubs } from '../../db/schema'
import { SettingsService } from '../../services/settings'

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

const db = createDatabase(DATABASE_URL)
const settings = new SettingsService(db)

const createdHubIds: string[] = []

async function freshHub(label: string): Promise<string> {
  const id = `hub-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await db.insert(hubs).values({ id, name: `Concurrency ${label}`, slug: id, createdBy: 'integration-test' })
  createdHubIds.push(id)
  return id
}

afterAll(async () => {
  if (createdHubIds.length > 0) {
    await db.delete(hubs).where(inArray(hubs.id, createdHubIds))
  }
})

describe('SettingsService.updateHubSettings under concurrency (#1144)', () => {
  it('persists every key from N concurrent writers touching disjoint keys', async () => {
    const hubId = await freshHub('disjoint')

    // Every allowed hub-setting key (ALLOWED_HUB_SETTINGS), each written by
    // its own concurrent caller with a distinguishable value. Before the
    // fix, each writer's read-modify-write raced against every other, and
    // only a handful of the 20 would survive the last-write-wins blob
    // overwrite.
    const writes: Array<[string, unknown]> = [
      ['hubName', 'Concurrent Hub'],
      ['timezone', 'America/New_York'],
      ['language', 'es'],
      ['welcomeMessage', 'welcome'],
      ['emergencyMessage', 'emergency'],
      ['maxConcurrentCalls', 7],
      ['callSettings', { queueTimeoutSeconds: 45 }],
      ['spamSettings', { rateLimitEnabled: true }],
      ['transcriptionEnabled', true],
      ['autoAssignment', true],
      ['fallbackGroup', ['pk-a', 'pk-b']],
      ['caseManagementEnabled', true],
      ['providerSetupComplete', true],
      ['channels', { sms: true }],
      ['quotas', { sms: 100 }],
      ['usage', [{ month: '2026-01', sms: 5 }]],
      ['subAccountEnabled', true],
      ['subAccountConfigId', 'sub-1'],
      ['heartbeatTimeout', 30],
      ['ivrLanguages', ['en', 'es']],
    ]

    await Promise.all(
      writes.map(([key, value]) => settings.updateHubSettings(hubId, { [key]: value })),
    )

    const finalSettings = await settings.getHubSettings(hubId)
    for (const [key, value] of writes) {
      expect(finalSettings[key]).toEqual(value)
    }
  })

  it('a concurrent write to one key does not clobber a concurrent write to another', async () => {
    const hubId = await freshHub('two-admins')

    const [a, b] = await Promise.all([
      settings.updateHubSettings(hubId, { fallbackGroup: ['pk-1', 'pk-2'] }),
      settings.updateHubSettings(hubId, { spamSettings: { rateLimitEnabled: false } }),
    ])

    // Both callers' own writes must be reflected in what they got back...
    expect(a.fallbackGroup).toEqual(['pk-1', 'pk-2'])
    expect(b.spamSettings).toEqual({ rateLimitEnabled: false })

    // ...and critically, the FINAL persisted state must contain BOTH keys —
    // neither admin's change was silently discarded by the other's write,
    // and the stored value is a plain object (not the 2-element
    // [{}, "<json string>"] array that the double-encoding bug produced).
    const finalSettings = await settings.getHubSettings(hubId)
    expect(finalSettings.fallbackGroup).toEqual(['pk-1', 'pk-2'])
    expect(finalSettings.spamSettings).toEqual({ rateLimitEnabled: false })
    expect(Array.isArray(finalSettings)).toBe(false)
  })

  it('repeated updates to the SAME key converge to one writer, never a merge of both', async () => {
    const hubId = await freshHub('same-key')

    await Promise.all([
      settings.updateHubSettings(hubId, { ivrLanguages: ['en'] }),
      settings.updateHubSettings(hubId, { ivrLanguages: ['es'] }),
    ])

    const finalSettings = await settings.getHubSettings(hubId)
    // Last-writer-wins on a genuinely shared key is still an acceptable
    // outcome (there's no way to "merge" two different language lists) —
    // what must NOT happen is silent loss of an *unrelated* key, covered
    // above. Here we just assert the result is one or the other, not an
    // impossible hybrid.
    const ivrLanguages = finalSettings.ivrLanguages as string[]
    expect(ivrLanguages).toHaveLength(1)
    expect(['en', 'es']).toContain(ivrLanguages[0])
  })
})

describe('SettingsService.incrementHubUsage under concurrency (#1144)', () => {
  it('no production caller today, but increments correctly under N concurrent callers', async () => {
    const hubId = await freshHub('usage-increment')
    const n = 20

    await Promise.all(
      Array.from({ length: n }, () => settings.incrementHubUsage(hubId, 'minutes', 1)),
    )

    const finalSettings = await settings.getHubSettings(hubId)
    const usage = finalSettings.usage as Array<{ month: string; minutes?: number }>
    expect(usage).toHaveLength(1)
    expect(usage[0].minutes).toBe(n)
  })
})
