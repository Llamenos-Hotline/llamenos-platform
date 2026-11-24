import {
  eq,
  and,
  sql,
  ne,
} from 'drizzle-orm'
import type { Database } from '../db'
import { hubs as hubsTable, hubKeys } from '../db/schema'
import { markHubKeyRotationDue } from '../lib/hub-key'
import { HubNotFoundError, ServiceError } from './service-error'

/**
 * A hub's wrapped hub-key envelopes (`hub_keys`).
 */
export class HubKeyService {
  constructor(protected db: Database) {}

  async getHubKeyEnvelopes(hubId: string): Promise<{
    envelopes: Array<{
      pubkey: string
      enc: string
      ct: string
    }>
    /** Generation of the hub key these wraps belong to (hubs.hub_key_generation). */
    generation: number
  }> {
    const [hub] = await this.db
      .select({ generation: hubsTable.hubKeyGeneration })
      .from(hubsTable)
      .where(eq(hubsTable.id, hubId))
    const rows = await this.db
      .select()
      .from(hubKeys)
      .where(eq(hubKeys.hubId, hubId))

    return {
      envelopes: rows.map((r) => ({
        pubkey: r.recipientPubkey,
        enc: r.enc,
        ct: r.ct,
      })),
      generation: hub?.generation ?? 0,
    }
  }

  /**
   * Replace all hub-key envelopes — compare-and-set on the generation.
   *
   * `expectedGeneration` is the generation the writer read. The write succeeds
   * only if the hub is still at it, and moves the generation forward by one in
   * the same statement, so of two writers that read the same generation exactly
   * one wins and the other gets a 409 and re-reads. That is what keeps two
   * managers who each generated a first key at once from leaving the hub split
   * between two keys, and what stops a replayed write re-installing a key a
   * rotation or a crypto-shred replaced (the shred bumps the generation too).
   */
  async setHubKeyEnvelopes(
    hubId: string,
    data: {
      envelopes: Array<{
        pubkey: string
        enc: string
        ct: string
      }>
      expectedGeneration: number
    },
  ): Promise<{ ok: true; generation: number }> {
    return this.db.transaction(async (tx) => {
      const [bumped] = await tx
        .update(hubsTable)
        .set({ hubKeyGeneration: sql`${hubsTable.hubKeyGeneration} + 1` })
        .where(and(
          eq(hubsTable.id, hubId),
          eq(hubsTable.hubKeyGeneration, data.expectedGeneration),
          ne(hubsTable.status, 'shredded'),
        ))
        .returning({ generation: hubsTable.hubKeyGeneration })

      if (!bumped) {
        const [hub] = await tx
          .select({ status: hubsTable.status, generation: hubsTable.hubKeyGeneration })
          .from(hubsTable)
          .where(eq(hubsTable.id, hubId))
        if (!hub) throw new HubNotFoundError()
        if (hub.status === 'shredded') {
          throw new ServiceError(409, 'Hub is shredded — hub key writes are refused')
        }
        throw new ServiceError(
          409,
          `Hub key generation mismatch: expected ${data.expectedGeneration}, current ${hub.generation}`,
        )
      }

      const replaced = await tx
        .delete(hubKeys)
        .where(eq(hubKeys.hubId, hubId))
        .returning({ recipientPubkey: hubKeys.recipientPubkey })
      if (data.envelopes.length > 0) {
        await tx.insert(hubKeys).values(data.envelopes.map(envelope => ({
          hubId,
          recipientPubkey: envelope.pubkey,
          enc: envelope.enc,
          ct: envelope.ct,
        })))
      }
      // Someone who held a wrap and is not in the new set still knows the key
      // this set wraps: record that it has to be rotated (PROTOCOL.md §2.7).
      const kept = new Set(data.envelopes.map(e => e.pubkey))
      if (replaced.some(w => !kept.has(w.recipientPubkey))) {
        await markHubKeyRotationDue(tx, [hubId])
      }
      return { ok: true as const, generation: bumped.generation }
    })
  }
}
