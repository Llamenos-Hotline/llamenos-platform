/**
 * Issue #1175: audit_log.seq carries append order; created_at records when
 * the event happened and nothing else. Proven against real PostgreSQL with
 * the real migrations:
 *
 *  1. Two entries stamped with an IDENTICAL created_at read back in append
 *     order, and the chain still verifies.
 *  2. An entry stamped EARLIER than the tip keeps its timestamp — the old
 *     code bumped it 1 ms past the tip and hashed the lie.
 *  3. seq is per-chain: each hub's chain and the platform chain count from 1.
 *  4. Concurrent appends to one chain (the #1068 fork case) get distinct,
 *     consecutive seq values and a linear chain.
 *  5. Mixed-version writers (#2634): the previous release's INSERT does not
 *     name seq and takes the sequence default; the interleaving old, new, old
 *     must never collide on the (hub_id, seq) unique index.
 *
 * Requires postgres at DATABASE_URL. Own database, dropped on teardown.
 */
// pg-array-patch must be imported before any schema is loaded.
import '../../db/pg-array-patch'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { desc, eq, sql } from 'drizzle-orm'
import * as schema from '../../db/schema'
import { computeEntryHash } from '../../services/audit'
import { freshHubDb } from './hub-shred-helpers'

const fresh = freshHubDb('audit_seq')

beforeAll(fresh.setup, 180_000)
afterAll(fresh.teardown, 60_000)

const ACTOR = 'ab'.repeat(32)

/** Stored rows of one chain, newest first, straight from the table. */
async function storedChain(hubId: string | null) {
  return await fresh.db
    .select()
    .from(schema.auditLog)
    .where(hubId ? eq(schema.auditLog.hubId, hubId) : sql`${schema.auditLog.hubId} IS NULL`)
    .orderBy(desc(schema.auditLog.seq))
}

describe('audit_log seq (#1175)', () => {
  it('reads two entries with an identical created_at back in append order', async () => {
    const hub = 'hub-seq-same-ts'
    const stamp = new Date('2026-02-02T12:00:00.000Z')

    const first = await fresh.audit.log('shiftCreated', ACTOR, { n: 1 }, hub, stamp)
    const second = await fresh.audit.log('shiftCreated', ACTOR, { n: 2 }, hub, stamp)

    expect(second.createdAt.getTime()).toBe(first.createdAt.getTime())
    expect(second.seq).toBe(first.seq + 1)
    expect(second.previousEntryHash).toBe(first.entryHash)

    const chain = await storedChain(hub)
    expect(chain.map((r) => (r.details as Record<string, unknown>).n)).toEqual([2, 1])
    expect(chain[0].createdAt.getTime()).toBe(chain[1].createdAt.getTime())

    const verified = await fresh.audit.verifyChain(hub)
    expect(verified.valid).toBe(true)
    expect(verified.checkedEntries).toBe(2)
  })

  it('never falsifies created_at: an earlier-than-tip timestamp is stored as given', async () => {
    const hub = 'hub-seq-no-bump'

    const later = await fresh.audit.log('shiftCreated', ACTOR, {}, hub, new Date('2026-03-01T00:00:00.000Z'))
    const earlier = await fresh.audit.log('shiftUpdated', ACTOR, {}, hub, new Date('2026-01-01T00:00:00.000Z'))

    expect(earlier.createdAt.toISOString()).toBe('2026-01-01T00:00:00.000Z')
    expect(earlier.seq).toBe(later.seq + 1)
    expect(earlier.previousEntryHash).toBe(later.entryHash)

    // Append order (seq), not chronological order (created_at), is the chain.
    const chain = await storedChain(hub)
    expect(chain.map((r) => r.action)).toEqual(['shiftUpdated', 'shiftCreated'])
    expect((await fresh.audit.verifyChain(hub)).valid).toBe(true)
  })

  it('numbers each chain independently from 1', async () => {
    const hubA = 'hub-seq-a'
    const hubB = 'hub-seq-b'

    const a1 = await fresh.audit.log('shiftCreated', ACTOR, {}, hubA)
    const b1 = await fresh.audit.log('shiftCreated', ACTOR, {}, hubB)
    const p1 = await fresh.audit.log('settingsUpdated', 'system', {}, null)
    const a2 = await fresh.audit.log('shiftUpdated', ACTOR, {}, hubA)

    expect(a1.seq).toBe(1)
    expect(b1.seq).toBe(1)
    expect(p1.seq).toBe(1)
    expect(a2.seq).toBe(2)
    // Chains do not share predecessors.
    expect(b1.previousEntryHash).toBeNull()
    expect(p1.previousEntryHash).toBeNull()
  })

  it('keeps concurrent appends linear with distinct consecutive seq values', async () => {
    const hub = 'hub-seq-concurrent'
    const COUNT = 10

    const entries = await Promise.all(
      Array.from({ length: COUNT }, (_, i) =>
        fresh.audit.log('shiftCreated', ACTOR, { i }, hub)),
    )

    const seqs = entries.map((e) => e.seq).sort((a, b) => a - b)
    expect(seqs).toEqual(Array.from({ length: COUNT }, (_, i) => i + 1))

    const verified = await fresh.audit.verifyChain(hub)
    expect(verified.valid).toBe(true)
    expect(verified.checkedEntries).toBe(COUNT)

    // The tip the chain reads as latest is the highest seq, and its hash is
    // what the next append would chain from.
    const chain = await storedChain(hub)
    expect(await fresh.audit.getLatestHash(hub)).toBe(chain[0].entryHash)
  })

  /**
   * The previous release's AuditService.log, verbatim in what matters: it
   * chains from the tip's hash and INSERTs without naming seq, so the column
   * takes its DEFAULT nextval('audit_log_seq_default_seq').
   */
  async function previousReleaseAppend(hubId: string, n: number) {
    const [tip] = await fresh.db
      .select({ entryHash: schema.auditLog.entryHash })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.hubId, hubId))
      .orderBy(desc(schema.auditLog.seq))
      .limit(1)
    const id = crypto.randomUUID()
    const createdAt = new Date().toISOString()
    const previousEntryHash = tip?.entryHash ?? null
    const entryHash = computeEntryHash({
      id, action: 'shiftCreated', actorPubkey: 'system', createdAt, details: { n }, previousEntryHash,
    })
    const [row] = await fresh.db
      .insert(schema.auditLog)
      .values({
        id, hubId, action: 'shiftCreated', actorPubkey: 'system', details: { n },
        previousEntryHash, entryHash, createdAt: new Date(createdAt),
      })
      .returning({ seq: schema.auditLog.seq })
    return row.seq
  }

  it('never collides with a previous-release append, whichever writer goes first (#2634)', async () => {
    const hub = 'hub-seq-mixed-versions'

    // 1. old writer: seq comes from the sequence default (>= 2^32).
    const old1 = await previousReleaseAppend(hub, 1)
    expect(old1).toBeGreaterThanOrEqual(2 ** 32)

    // 2. new writer: the tip is in the default's issue space, so its seq must
    //    come from that sequence too, not from tip + 1.
    const mid = await fresh.audit.log('shiftUpdated', ACTOR, { n: 2 }, hub)
    expect(mid.seq).toBeGreaterThan(old1)

    // 3. old writer again: with tip + 1 in step 2 this took nextval() ==
    //    mid.seq and aborted on the (hub_id, seq) unique index.
    const old2 = await previousReleaseAppend(hub, 3)
    expect(old2).toBeGreaterThan(mid.seq)

    // The new writer keeps working on a chain whose tip the old one wrote.
    const last = await fresh.audit.log('shiftUpdated', ACTOR, { n: 4 }, hub)
    expect(last.seq).toBeGreaterThan(old2)

    const verified = await fresh.audit.verifyChain(hub)
    expect(verified.valid).toBe(true)
    expect(verified.checkedEntries).toBe(4)
  })
})
