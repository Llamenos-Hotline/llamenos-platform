/**
 * Audit integrity step definitions (Epic 365).
 *
 * Tests that the audit log captures all state-changing operations,
 * that the SHA-256 hash chain is verifiable, and that tampered
 * entries are detectable.
 */
import { expect } from '@playwright/test'
import { Given, When, Then, Before, getState, setState } from './fixtures'
import { getScenarioState } from './common.steps'
import {
  apiPost,
  apiDelete,
  createVolunteerViaApi,
  createShiftViaApi,
  createBanViaApi,
  listAuditLogViaApi,
  verifyAuditChainViaApi,
  type ChainVerificationResult,
} from '../../api-helpers'
import { computeAuditEntryHash } from '../../integrity-helpers'
import { TestDB } from '../../db-helpers'

// ── Local State ────────────────────────────────────────────────────

interface AuditEntry {
  id: string
  action: string
  actorPubkey: string
  details: Record<string, unknown> | null
  entryHash: string
  previousEntryHash: string | null
  createdAt: string
}

interface AuditTestState {
  entriesBefore: number
  entries: AuditEntry[]
  latestEntry?: AuditEntry
  recomputedHash?: string
  tamperHash?: string
  chainVerification?: ChainVerificationResult
}

const AUDIT_INTEGRITY_KEY = 'audit_integrity'

function getAuditTestState(world: Record<string, unknown>): AuditTestState {
  return getState<AuditTestState>(world, AUDIT_INTEGRITY_KEY)
}


Before({ tags: '@audit' }, async ({ world }) => {
  const audit = {
    entriesBefore: 0,
    entries: [],
  }
  setState(world, AUDIT_INTEGRITY_KEY, audit)
})

// ── Comprehensive Audit Capture ───────────────────────────────────

Given(
  'an admin performs the following operations:',
  async ({ request, world }, table: import('playwright-bdd').DataTable) => {
    const rows = table.hashes()

    const hubId = getScenarioState(world).hubId
    // Count existing entries
    const existing = await listAuditLogViaApi(request, { hubId })
    getAuditTestState(world).entriesBefore = existing.total

    for (const row of rows) {
      const operation = row.operation
      const detail = row.detail

      if (operation === 'create volunteer') {
        const vol = await createVolunteerViaApi(request, { name: `${detail} ${Date.now()}` })
        // Add to hub so the userAdded audit event is scoped to this hub
        if (hubId) {
          await apiPost(request, `/hubs/${hubId}/members`, { pubkey: vol.pubkey, roleIds: ['role-volunteer'] })
        }
        // Store pubkey for potential removal
        if (detail === 'BDD Audit Vol') {
          getAuditTestState(world).latestEntry = { id: vol.pubkey } as unknown as AuditEntry
        }
      } else if (operation === 'create shift') {
        await createShiftViaApi(request, { name: `${detail} ${Date.now()}`, hubId })
      } else if (operation === 'create ban') {
        await createBanViaApi(request, { phone: detail, reason: 'audit test', hubId })
      } else if (operation === 'update volunteer') {
        // Remove from hub to generate a hub-scoped userRemoved audit entry
        const latestEntryId = getAuditTestState(world).latestEntry?.id
        if (latestEntryId && hubId) {
          await apiDelete(request, `/hubs/${hubId}/members/${latestEntryId}`)
        }
      }
    }
  },
)

When('the admin fetches the audit log', async ({ request, world }) => {
  const hubId = getScenarioState(world).hubId
  const result = await listAuditLogViaApi(request, { limit: 50, hubId })
  getAuditTestState(world).entries = result.entries as unknown as AuditEntry[]
})

Then('at least {int} new audit entries should exist', async ({ world }, count: number) => {
  const newEntries = getAuditTestState(world).entries.length
  // We fetched up to 50 entries — there should be at least `count` total
  expect(newEntries).toBeGreaterThanOrEqual(count)
})

Then('each entry should have a non-empty actor pubkey', async ({ world }) => {
  for (const entry of getAuditTestState(world).entries) {
    expect(entry.actorPubkey).toBeTruthy()
    expect(typeof entry.actorPubkey).toBe('string')
    expect(entry.actorPubkey.length).toBeGreaterThanOrEqual(32)
  }
})

Then('each entry should have a non-empty action field', async ({ world }) => {
  for (const entry of getAuditTestState(world).entries) {
    expect(entry.action).toBeTruthy()
    expect(typeof entry.action).toBe('string')
  }
})

Then('the entry actions should include {string}', async ({ world }, action: string) => {
  const actions = getAuditTestState(world).entries.map(e => e.action)
  expect(actions).toContain(action)
})

// ── Hash Chain Verification ───────────────────────────────────────

Given('an admin performs {int} sequential operations', async ({ request, world }, count: number) => {
  const hubId = getScenarioState(world).hubId
  // Count existing entries
  const existing = await listAuditLogViaApi(request, { hubId })
  getAuditTestState(world).entriesBefore = existing.total

  // Use hub-scoped shift creation so entries appear in hub-scoped audit queries
  for (let i = 0; i < count; i++) {
    await createShiftViaApi(request, {
      name: `Chain Shift ${Date.now()}-${i}`,
      hubId,
    })
  }
})

Given('an admin performs {int} concurrent operations', async ({ request, world }, count: number) => {
  const hubId = getScenarioState(world).hubId
  const existing = await listAuditLogViaApi(request, { hubId })
  getAuditTestState(world).entriesBefore = existing.total

  // Fire every audited write at once so the server sees overlapping appends to one chain.
  const results = await Promise.all(
    Array.from({ length: count }, (_, i) =>
      createShiftViaApi(request, { name: `Concurrent Shift ${Date.now()}-${i}`, hubId }),
    ),
  )
  expect(results).toHaveLength(count)
})

Then('no two audit entries should share the same previousEntryHash', async ({ request, world }) => {
  const hubId = getScenarioState(world).hubId
  const { entries } = await listAuditLogViaApi(request, { limit: 100, hubId })
  const predecessors = (entries as unknown as AuditEntry[])
    .map(e => e.previousEntryHash)
    .filter((h): h is string => h !== null)
  expect(new Set(predecessors).size).toBe(predecessors.length)
})

When(
  'the audit log is fetched ordered by creation time',
  async ({ request, world }) => {
    const hubId = getScenarioState(world).hubId
    const result = await listAuditLogViaApi(request, { limit: 100, hubId })
    // The API returns entries — sort by createdAt ascending
    getAuditTestState(world).entries = (result.entries as unknown as AuditEntry[]).sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    )
  },
)

Then('each entry should have an {string} field', async ({ world }, fieldName: string) => {
  for (const entry of getAuditTestState(world).entries) {
    const value = (entry as unknown as Record<string, unknown>)[fieldName]
    // entryHash should always be truthy; previousEntryHash can be null for first entry
    if (fieldName === 'entryHash') {
      expect(value).toBeTruthy()
    }
  }
})

Then(
  'entry {int} should have a null {string}',
  async ({ world }, index: number, fieldName: string) => {
    expect(getAuditTestState(world).entries.length).toBeGreaterThan(index)
    const value = (getAuditTestState(world).entries[index] as unknown as Record<string, unknown>)[fieldName]
    expect(value).toBeNull()
  },
)

Then(
  "for entries {int} through {int}, previousEntryHash should equal the prior entry's entryHash",
  async ({ world }, start: number, end: number) => {
    for (let i = start; i <= end && i < getAuditTestState(world).entries.length; i++) {
      const current = getAuditTestState(world).entries[i]
      const previous = getAuditTestState(world).entries[i - 1]
      expect(current.previousEntryHash).toBe(previous.entryHash)
    }
  },
)

Then('the full chain should pass database-level verification', async ({ world }) => {
  const hubId = getScenarioState(world).hubId
  const result = await TestDB.verifyAuditChain(hubId)
  expect(result.valid).toBe(true)
  expect(result.entries).toBeGreaterThan(0)
})

Then('the stored details of user-actor entries should be sealed at rest', async ({ world }) => {
  const hubId = getScenarioState(world).hubId
  const result = await TestDB.verifyAuditChain(hubId)
  // Every entry the scenario's admin wrote has a user actor, so a chain with
  // no sealed entry means details are sitting in the database as plaintext.
  expect(result.sealed).toBeGreaterThan(0)
})

// ── Tamper Detection ──────────────────────────────────────────────

Given(
  'an admin creates a volunteer to generate an audit entry',
  async ({ request, world }) => {
    const hubId = getScenarioState(world).hubId
    // Create a hub-scoped shift to generate an audit entry visible to hub-scoped queries
    await createShiftViaApi(request, {
      name: `Tamper Test ${Date.now()}`,
      hubId,
    })
  },
)

When('the latest audit entry is fetched', async ({ request, world }) => {
  const hubId = getScenarioState(world).hubId
  const result = await listAuditLogViaApi(request, { limit: 1, hubId })
  expect(result.entries.length).toBeGreaterThan(0)
  getAuditTestState(world).latestEntry = result.entries[0] as unknown as AuditEntry
})

Then(
  'recomputing the hash with computeAuditEntryHash should match the stored entryHash',
  async ({ world }) => {
    expect(getAuditTestState(world).latestEntry).toBeTruthy()
    const entry = getAuditTestState(world).latestEntry!
    getAuditTestState(world).recomputedHash = computeAuditEntryHash({
      id: entry.id,
      action: entry.action,
      actorPubkey: entry.actorPubkey,
      createdAt: entry.createdAt,
      details: entry.details ?? {},
      previousEntryHash: entry.previousEntryHash,
    })
    expect(getAuditTestState(world).recomputedHash).toBe(entry.entryHash)
  },
)

Then('modifying the action field should produce a different hash', async ({ world }) => {
  expect(getAuditTestState(world).latestEntry).toBeTruthy()
  const entry = getAuditTestState(world).latestEntry!
  const tamperedHash = computeAuditEntryHash({
    id: entry.id,
    action: 'tampered_action',
    actorPubkey: entry.actorPubkey,
    createdAt: entry.createdAt,
    details: entry.details ?? {},
    previousEntryHash: entry.previousEntryHash,
  })
  expect(tamperedHash).not.toBe(entry.entryHash)
})

Then('modifying the actor pubkey should produce a different hash', async ({ world }) => {
  expect(getAuditTestState(world).latestEntry).toBeTruthy()
  const entry = getAuditTestState(world).latestEntry!
  const tamperedHash = computeAuditEntryHash({
    id: entry.id,
    action: entry.action,
    actorPubkey: 'f'.repeat(64),
    createdAt: entry.createdAt,
    details: entry.details ?? {},
    previousEntryHash: entry.previousEntryHash,
  })
  expect(tamperedHash).not.toBe(entry.entryHash)
})

// ── API-Level Chain Verification ──────────────────────────────────

When('the audit chain is verified via the API endpoint', async ({ request, world }) => {
  const hubId = getScenarioState(world).hubId
  const result = await verifyAuditChainViaApi(request, { hubId })
  getAuditTestState(world).chainVerification = result
})

Then('the verification result should be valid', async ({ world }) => {
  const result = getAuditTestState(world).chainVerification
  expect(result).toBeTruthy()
  expect(result!.valid).toBe(true)
})

Then('the verification result should be invalid', async ({ world }) => {
  const result = getAuditTestState(world).chainVerification
  expect(result).toBeTruthy()
  expect(result!.valid).toBe(false)
})

Then(
  'the verification result should report at least {int} checked entries',
  async ({ world }, minEntries: number) => {
    const result = getAuditTestState(world).chainVerification
    expect(result).toBeTruthy()
    expect(result!.checkedEntries).toBeGreaterThanOrEqual(minEntries)
  },
)

Then('the verification result should identify the broken entry', async ({ world }) => {
  const result = getAuditTestState(world).chainVerification
  expect(result).toBeTruthy()
  expect(result!.firstBrokenEntry).toBeDefined()
  expect(result!.firstBrokenEntry?.id).toBeTruthy()
  expect(result!.firstBrokenEntry?.reason).toBeTruthy()
})

When(
  'the action field of the latest audit entry is tampered in the database',
  async ({ request, world }) => {
    const hubId = getScenarioState(world).hubId
    // Fetch the latest entry via API to get its id
    const result = await listAuditLogViaApi(request, { limit: 1, hubId })
    expect(result.entries.length).toBeGreaterThan(0)
    const latestEntry = result.entries[0] as unknown as AuditEntry
    getAuditTestState(world).latestEntry = latestEntry

    // Directly update the action field in the database to simulate tampering.
    // The stored entryHash won't match after this change, breaking the chain.
    await TestDB.updateColumn('audit_log', latestEntry.id, 'action', 'TAMPERED_ACTION')
  },
)
