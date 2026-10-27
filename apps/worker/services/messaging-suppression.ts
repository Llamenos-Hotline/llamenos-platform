/**
 * MessagingSuppressionService — the opt-out record for messaging identifiers.
 *
 * A STOP is a fact about the identifier that sent it, recorded whether or not any
 * subscriber exists for it, and authoritative over everything downstream:
 *
 *  - the bulk importer files a suppressed identifier as `unsubscribed`;
 *  - every outbound send asks {@link MessagingSuppressionService.blocksOutbound}
 *    first (the adapter factory wires it in — `messaging/suppression-guard.ts`), so
 *    a bug anywhere upstream still cannot message a suppressed identifier;
 *  - only an explicit opt-in from the person (the subscribe keyword) clears it.
 *
 * Deployment-wide, not per hub: see `SUPPRESSION_SCOPE`. Identifiers are stored
 * only as keyed hashes; see `db/schema/messaging-suppressions.ts`.
 */
import { eq, inArray, sql } from 'drizzle-orm'
import type { Database } from '../db'
import { messagingSuppressions, messagingSuppressionIdentifiers } from '../db/schema'
import { suppressionHashes } from '../lib/messaging-contact-hash'
import { createLogger } from '../lib/logger'
import { ServiceError } from './settings'

const logger = createLogger('messaging-suppression')

/** Serialises opt-out writes, so two STOPs from one person cannot open two records. */
const SUPPRESSION_LOCK_KEY = 'messaging_suppressions'

export interface SuppressInput {
  channel: string
  /** Every identifier the opt-out carried or is known by (sender, aliases, recorded number). */
  identifiers: readonly string[]
  /** Hub whose webhook received it; undefined for the hub-less webhook. */
  sourceHubId?: string
  /** Provider message id of the inbound STOP. */
  sourceExternalId?: string
}

export class MessagingSuppressionService {
  constructor(
    protected db: Database,
    protected messagingHashKey?: string,
  ) {}

  private hashes(channel: string, identifiers: readonly string[]): string[] {
    if (!this.messagingHashKey) {
      // Fail closed: without the key nothing can be matched, and a send or import
      // that went ahead regardless could reach someone who opted out.
      throw new ServiceError(500, 'Messaging hash key missing: the opt-out record cannot be checked')
    }
    return suppressionHashes(channel, identifiers.filter(Boolean), this.messagingHashKey)
  }

  /**
   * Record an opt-out. Reuses the record any of these identifiers already reaches,
   * and files every identifier under it, so each shape the person reaches us by
   * resolves to the one record. Returns the record id.
   */
  async suppress(input: SuppressInput): Promise<string> {
    const hashes = this.hashes(input.channel, input.identifiers)
    if (hashes.length === 0) throw new ServiceError(400, 'An opt-out needs an identifier')

    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${SUPPRESSION_LOCK_KEY}))`)

      const [existing] = await tx
        .select({ suppressionId: messagingSuppressionIdentifiers.suppressionId })
        .from(messagingSuppressionIdentifiers)
        .where(inArray(messagingSuppressionIdentifiers.identifierHash, hashes))
        .limit(1)

      const source = {
        channel: input.channel,
        sourceHubId: input.sourceHubId ?? null,
        sourceExternalId: input.sourceExternalId ?? null,
        receivedAt: new Date(),
      }

      let suppressionId: string
      if (existing) {
        suppressionId = existing.suppressionId
        await tx.update(messagingSuppressions).set(source).where(eq(messagingSuppressions.id, suppressionId))
      } else {
        const [created] = await tx.insert(messagingSuppressions).values(source).returning({ id: messagingSuppressions.id })
        suppressionId = created.id
      }

      await tx
        .insert(messagingSuppressionIdentifiers)
        .values(hashes.map((identifierHash) => ({ identifierHash, suppressionId })))
        .onConflictDoNothing()

      return suppressionId
    })
  }

  /** Whether any of these identifiers is suppressed. */
  async isSuppressed(channel: string, identifiers: readonly string[]): Promise<boolean> {
    return (await this.findSuppressionId(channel, identifiers)) !== null
  }

  /**
   * Remove the record any of these identifiers reaches — the whole record, every
   * identifier filed under it. Call ONLY for an explicit opt-in sent by the person
   * (the subscribe keyword), with the identifiers that message itself carried: an
   * import, a new subscriber row, or any other reply is not consent.
   */
  async clear(channel: string, identifiers: readonly string[]): Promise<boolean> {
    const hashes = this.hashes(channel, identifiers)
    if (hashes.length === 0) return false
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${SUPPRESSION_LOCK_KEY}))`)
      const rows = await tx
        .select({ suppressionId: messagingSuppressionIdentifiers.suppressionId })
        .from(messagingSuppressionIdentifiers)
        .where(inArray(messagingSuppressionIdentifiers.identifierHash, hashes))
      if (rows.length === 0) return false
      // The identifier rows go with their record (ON DELETE CASCADE).
      await tx
        .delete(messagingSuppressions)
        .where(inArray(messagingSuppressions.id, [...new Set(rows.map((r) => r.suppressionId))]))
      return true
    })
  }

  /**
   * The outbound backstop: true when the recipient is suppressed, in which case
   * the refused attempt is counted on the record and logged (no identifier, no
   * hash), so a refused send can be told apart from one that never happened.
   */
  async blocksOutbound(channel: string, recipientIdentifier: string): Promise<boolean> {
    const suppressionId = await this.findSuppressionId(channel, [recipientIdentifier])
    if (suppressionId === null) return false
    await this.db
      .update(messagingSuppressions)
      .set({ blockedCount: sql`${messagingSuppressions.blockedCount} + 1`, lastBlockedAt: new Date() })
      .where(eq(messagingSuppressions.id, suppressionId))
    logger.warn('Outbound message refused: recipient has opted out', { channel, suppressionId })
    return true
  }

  /** The suppression record behind a blocked send, for tests and diagnostics. */
  async getRecord(channel: string, identifiers: readonly string[]) {
    const suppressionId = await this.findSuppressionId(channel, identifiers)
    if (suppressionId === null) return null
    const [row] = await this.db
      .select()
      .from(messagingSuppressions)
      .where(eq(messagingSuppressions.id, suppressionId))
      .limit(1)
    return row ?? null
  }

  private async findSuppressionId(channel: string, identifiers: readonly string[]): Promise<string | null> {
    const hashes = this.hashes(channel, identifiers)
    if (hashes.length === 0) return null
    const [row] = await this.db
      .select({ suppressionId: messagingSuppressionIdentifiers.suppressionId })
      .from(messagingSuppressionIdentifiers)
      .where(inArray(messagingSuppressionIdentifiers.identifierHash, hashes))
      .limit(1)
    return row?.suppressionId ?? null
  }

  /** The secret-gated dev reset surface only. */
  async reset(): Promise<void> {
    await this.db.delete(messagingSuppressions)
  }
}
