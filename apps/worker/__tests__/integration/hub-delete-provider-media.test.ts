/**
 * `SettingsService.deleteHub` and caller audio the telephony provider holds
 * (#2364 part 1), against real PostgreSQL.
 *
 * `deleteHub` used to drop the hub — and, through the `provider_configs`
 * cascade, the credentials its provider can only be reached with — without ever
 * asking the provider to delete the recordings it holds. That audio is then
 * permanently unreachable. The ordering rule is #2304's: delete the media
 * before dropping the thing that lets you find it.
 *
 * Every assertion is on the PROVIDER call and on what is still stored — not on
 * whether the hub row is gone, which passes against the defect.
 */
import { and, eq, isNull } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { insertHubFounder } from '../helpers/hub-founder'
import * as schema from '../../db/schema'

vi.mock('@llamenos/crypto/ffi', async () => await import('../mocks/llamenos-crypto-ffi'))
import { freshHubDb } from './hub-shred-helpers'

const fresh = freshHubDb('hub_delete_provider_media')

beforeAll(fresh.setup, 180_000)
afterAll(fresh.teardown, 60_000)
beforeEach(async () => {
  await fresh.db.delete(schema.providerRecordings)
})

const account = { providerAccountId: () => 'twilio:AC-delete-hub' }

let hubCounter = 0
async function createHub(): Promise<string> {
  const id = `hub-dhm-${++hubCounter}-${Math.random().toString(36).slice(2, 8)}`
  await fresh.settings.createHub({
    id,
    name: `Hub ${id}`,
    slug: id,
    status: 'active',
    createdBy: 'integration-test',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never, await insertHubFounder(fresh.db))
  await fresh.db.insert(schema.providerConfigs).values({
    id: `cfg-${id}`,
    hubId: id,
    providerType: 'twilio',
    credentials: 'sealed-credentials',
    status: 'connected',
  })
  return id
}

const credentialsOf = (hubId: string) =>
  fresh.db.select().from(schema.providerConfigs).where(eq(schema.providerConfigs.hubId, hubId))
const hubRows = (hubId: string) =>
  fresh.db.select().from(schema.hubs).where(eq(schema.hubs.id, hubId))
const openProviderMediaIncidents = (hubId: string) =>
  fresh.db.select().from(schema.hubIncidents).where(and(
    eq(schema.hubIncidents.hubId, hubId),
    eq(schema.hubIncidents.category, 'provider-media'),
    isNull(schema.hubIncidents.closedAt),
  ))

describe('SettingsService.deleteHub — provider-held media (#2364)', () => {
  it('asks the provider to delete every recording BEFORE the credentials are dropped', async () => {
    const hubId = await createHub()
    await fresh.recordings.track({ hubId, callId: 'call-a', recordingSid: 'RE-vm', kind: 'voicemail', adapter: account })
    await fresh.recordings.track({ hubId, callId: 'call-b', recordingSid: 'RE-call', kind: 'call', adapter: account })

    // Observed from inside the provider call: at the moment the provider is
    // asked, the credentials that reach it must still exist.
    const asked: Array<{ sid: string; credentialsStillStored: boolean; hubStillStored: boolean }> = []
    fresh.useTelephonyAdapter({
      ...account,
      deleteRecording: async (sid) => {
        asked.push({
          sid,
          credentialsStillStored: (await credentialsOf(hubId)).length === 1,
          hubStillStored: (await hubRows(hubId)).length === 1,
        })
      },
    })
    try {
      await fresh.settings.deleteHub(hubId, fresh.providerMedia)
    } finally {
      fresh.useTelephonyAdapter(null)
    }

    expect(asked.map(a => a.sid).sort()).toEqual(['RE-call', 'RE-vm'])
    expect(asked.every(a => a.credentialsStillStored && a.hubStillStored),
      'the provider must be asked while the hub\'s credentials still exist').toBe(true)
    expect(await hubRows(hubId)).toEqual([])
    expect(await credentialsOf(hubId)).toEqual([])
    expect(await fresh.recordings.listHeld(hubId)).toEqual([])
  })

  it('refuses when the provider will not delete: nothing is dropped, the handle stays, someone is told', async () => {
    const hubId = await createHub()
    await fresh.recordings.track({ hubId, callId: 'call-c', recordingSid: 'RE-stuck', kind: 'call', adapter: account })
    const attempts: string[] = []
    fresh.useTelephonyAdapter({
      ...account,
      deleteRecording: async (sid) => {
        attempts.push(sid)
        throw new Error('Twilio recording deletion failed: 503')
      },
    })
    const beforeDrop = vi.fn(async () => {})
    try {
      await expect(fresh.settings.deleteHub(hubId, fresh.providerMedia, { beforeDrop })).rejects.toMatchObject({ status: 502 })
    } finally {
      fresh.useTelephonyAdapter(null)
    }

    expect(attempts).toEqual(['RE-stuck'])
    expect(beforeDrop, 'nothing hub-scoped may be torn down once the provider refused').not.toHaveBeenCalled()
    expect(await hubRows(hubId)).toHaveLength(1)
    expect(await credentialsOf(hubId), 'the credentials are the only way to retry the deletion').toHaveLength(1)
    const held = await fresh.recordings.listHeld(hubId)
    expect(held).toHaveLength(1)
    expect(held[0]!.lastError).toContain('503')
    expect(await openProviderMediaIncidents(hubId), 'a refusal must reach a person, not only a log').toHaveLength(1)
  })

  it('refuses on handle-less residue it cannot delete, and drops nothing', async () => {
    const hubId = await createHub()
    await fresh.recordings.trackUnaddressable({ hubId, callId: 'call-u', kind: 'voicemail', adapter: account })
    const deleteRecording = vi.fn(async () => {})
    fresh.useTelephonyAdapter({ ...account, deleteRecording })
    try {
      await expect(fresh.settings.deleteHub(hubId, fresh.providerMedia)).rejects.toMatchObject({ status: 502 })
    } finally {
      fresh.useTelephonyAdapter(null)
    }
    expect(deleteRecording).not.toHaveBeenCalled()
    expect(await hubRows(hubId)).toHaveLength(1)
    expect(await credentialsOf(hubId)).toHaveLength(1)
  })

  it('refuses when no provider is configured to ask, rather than dropping a handle it cannot use', async () => {
    const hubId = await createHub()
    await fresh.recordings.track({ hubId, callId: 'call-n', recordingSid: 'RE-orphan', kind: 'voicemail', adapter: account })
    await expect(fresh.settings.deleteHub(hubId, fresh.providerMedia)).rejects.toMatchObject({ status: 502 })
    expect(await hubRows(hubId)).toHaveLength(1)
    expect(await fresh.recordings.listHeld(hubId)).toHaveLength(1)
  })

  it('deletes a hub that holds no provider media without asking any provider', async () => {
    const hubId = await createHub()
    const deleteRecording = vi.fn(async () => {})
    fresh.useTelephonyAdapter({ ...account, deleteRecording })
    try {
      await fresh.settings.deleteHub(hubId, fresh.providerMedia)
    } finally {
      fresh.useTelephonyAdapter(null)
    }
    expect(deleteRecording).not.toHaveBeenCalled()
    expect(await hubRows(hubId)).toEqual([])
  })

  it('runs the caller-supplied teardown after the provider confirmed and before the hub is dropped', async () => {
    const hubId = await createHub()
    await fresh.recordings.track({ hubId, callId: 'call-d', recordingSid: 'RE-ok', kind: 'voicemail', adapter: account })
    const order: string[] = []
    fresh.useTelephonyAdapter({ ...account, deleteRecording: async () => { order.push('provider') } })
    try {
      await fresh.settings.deleteHub(hubId, fresh.providerMedia, {
        beforeDrop: async () => { order.push(`teardown(hub stored: ${(await hubRows(hubId)).length === 1})`) },
      })
    } finally {
      fresh.useTelephonyAdapter(null)
    }
    expect(order).toEqual(['provider', 'teardown(hub stored: true)'])
    expect(await hubRows(hubId)).toEqual([])
  })
})
