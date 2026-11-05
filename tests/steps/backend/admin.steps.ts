/**
 * Backend admin step definitions.
 * Verifies volunteer CRUD, shifts, bans, audit log, and settings mutations via API.
 */
import { expect } from '@playwright/test'
import { Given, When, Then, getState, setState, Before } from './fixtures'
import { getScenarioState } from './common.steps'
import {
  apiGet,
  createShiftViaApi,
  listAuditLogViaApi,
  uniqueName,
  type AuditEntry,
} from '../../api-helpers'
import { sha256 } from '@noble/hashes/sha2.js'
import { utf8ToBytes } from '@shared/encoding'
import { bytesToHex } from '@shared/encoding'

// ── Local admin test state ───────────────────────────────────────

interface AdminTestState {
  auditEntries: AuditEntry[]
  tamperedIndex?: number
  chainValid?: boolean
}

const ADMIN_TEST_KEY = 'admin_test'

function getAdminTestState(world: Record<string, unknown>): AdminTestState {
  return getState<AdminTestState>(world, ADMIN_TEST_KEY)
}

Before({ tags: '@backend' }, async ({ world }) => {
  setState(world, ADMIN_TEST_KEY, {
    auditEntries: [],
  })
})

// ── Audit Log: Hash Chain ────────────────────────────────────────
// Hub isolation: each worker has its own hub, so the audit log is per-hub.
// "An empty audit log" now means no entries in this worker's hub (new hub = no history).

Given('an empty audit log', async ({ world }) => {
  // Hub isolation provides a clean audit log: each worker's hub starts empty.
  getAdminTestState(world).auditEntries = []
})

When('the first entry is added', async ({ request, world }) => {
  // Trigger a hub-scoped audit event by creating a shift in this test's hub
  const hubId = getScenarioState(world).hubId
  await createShiftViaApi(request, { name: uniqueName('AuditFirst'), hubId })
  const { entries } = await listAuditLogViaApi(request, { limit: 1, hubId })
  getAdminTestState(world).auditEntries = entries
})

Then('the entry hash should be computed', async ({ world }) => {
  expect(getAdminTestState(world).auditEntries.length).toBeGreaterThan(0)
  const entry = getAdminTestState(world).auditEntries[0]
  expect(entry.entryHash).toBeTruthy()
})

Then('the previous entry hash should be null', async ({ world }) => {
  expect(getAdminTestState(world).auditEntries.length).toBeGreaterThan(0)
  const entry = getAdminTestState(world).auditEntries[0]
  // First entry in a clean log should have no previous hash (empty string from server)
  expect(entry.previousEntryHash).toBeFalsy()
})

Given('an audit log with {int} entry/entries', async ({ request, world }, count: number) => {
  // Hub isolation: hub starts clean; create hub-scoped shifts to generate audit entries
  const hubId = getScenarioState(world).hubId
  for (let i = 0; i < count; i++) {
    await createShiftViaApi(request, { name: uniqueName(`AuditChain${i}`), hubId })
  }
  const { entries } = await listAuditLogViaApi(request, { limit: count + 5, hubId })
  getAdminTestState(world).auditEntries = entries
})


When('a new entry is added', async ({ request, world }) => {
  const hubId = getScenarioState(world).hubId
  await createShiftViaApi(request, { name: uniqueName('AuditNew'), hubId })
  const { entries } = await listAuditLogViaApi(request, { limit: 20, hubId })
  getAdminTestState(world).auditEntries = entries
})

Then('the new entry should reference the previous entry hash', async ({ world }) => {
  expect(getAdminTestState(world).auditEntries.length).toBeGreaterThan(1)
  const latest = getAdminTestState(world).auditEntries[0]
  expect(latest.previousEntryHash).toBeTruthy()
})

When('the event field of entry {int} is modified', async ({ world }, index: number) => {
  getAdminTestState(world).tamperedIndex = index
  // Tampering is simulated client-side by modifying the fetched entry
  if (getAdminTestState(world).auditEntries.length >= index) {
    const entry = { ...getAdminTestState(world).auditEntries[index - 1] }
    entry.action = 'TAMPERED_EVENT'
    getAdminTestState(world).auditEntries[index - 1] = entry
  }
})

When('the actor field of entry {int} is modified', async ({ world }, index: number) => {
  getAdminTestState(world).tamperedIndex = index
  if (getAdminTestState(world).auditEntries.length >= index) {
    const entry = { ...getAdminTestState(world).auditEntries[index - 1] }
    entry.actorPubkey = 'deadbeef'.repeat(8)
    getAdminTestState(world).auditEntries[index - 1] = entry
  }
})

When('the timestamp of entry {int} is modified', async ({ world }, index: number) => {
  getAdminTestState(world).tamperedIndex = index
  if (getAdminTestState(world).auditEntries.length >= index) {
    const entry = { ...getAdminTestState(world).auditEntries[index - 1] }
    entry.createdAt = '2020-01-01T00:00:00.000Z'
    getAdminTestState(world).auditEntries[index - 1] = entry
  }
})

Then('chain verification should fail at entry {int}', async ({ world }, index: number) => {
  // Verify that recomputing the hash chain detects the tamper
  expect(getAdminTestState(world).tamperedIndex).toBe(index)
  // The tampered entry's recomputed hash won't match its stored hash
  const entry = getAdminTestState(world).auditEntries[index - 1]
  if (entry.entryHash) {
    // Recompute hash matching server's hashAuditEntry()
    const content = `${entry.id}:${entry.action}:${entry.actorPubkey}:${entry.createdAt}:${JSON.stringify(entry.details)}:${entry.previousEntryHash || ''}`
    const recomputed = bytesToHex(sha256(utf8ToBytes(content)))
    expect(recomputed).not.toBe(entry.entryHash)
  }
})

When('the chain is verified', async ({ world }) => {
  // Verify the chain integrity by checking each entry's hash
  // Entries are returned newest-first, so reverse for chronological order
  const entries = [...getAdminTestState(world).auditEntries].reverse()
  getAdminTestState(world).chainValid = true
  for (let i = 1; i < entries.length; i++) {
    const current = entries[i]
    const previous = entries[i - 1]
    if (current.previousEntryHash && previous.entryHash) {
      if (current.previousEntryHash !== previous.entryHash) {
        getAdminTestState(world).chainValid = false
        break
      }
    }
  }
})

Then('all entries should pass integrity checks', async ({ world }) => {
  expect(getAdminTestState(world).chainValid).toBeTruthy()
})

// ── Shift Status Query ─────────────────────────────────────────

When('I query the shift status', async ({ request, world }) => {
  const hubId = getScenarioState(world).hubId
  const path = `/hubs/${hubId}/shifts`
  const { status, data } = await apiGet<{ shifts: Array<{ userPubkeys: string[] }> }>(request, path)
  expect(status).toBe(200)
  getScenarioState(world).lastApiResponse = { status, data }
})

Then('{int} volunteers are reported as on-shift', async ({ world }, count: number) => {
  const data = getScenarioState(world).lastApiResponse?.data as { shifts: Array<{ id: string; userPubkeys: string[] }> }
  expect(data).toBeTruthy()
  // Count unique volunteer pubkeys only across THIS scenario's shifts (hub is shared per worker)
  const state = getScenarioState(world)
  const scenarioShiftIds = new Set(state.shiftIds)
  const uniqueVolunteers = new Set<string>()
  for (const shift of data.shifts) {
    if (scenarioShiftIds.has(shift.id)) {
      for (const pk of shift.userPubkeys) {
        uniqueVolunteers.add(pk)
      }
    }
  }
  expect(uniqueVolunteers.size).toBe(count)
})
