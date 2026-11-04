/**
 * SignalIdentityService — manages Signal identity trust verification.
 *
 * Signal uses "safety numbers" to verify contact identity. When a contact's
 * identity key changes (new device, reinstall), Signal alerts the user.
 * This service manages trust decisions through the signal-cli-rest-api bridge:
 *
 * Trust levels:
 * - UNTRUSTED: Identity key changed, not yet acknowledged
 * - TRUSTED_UNVERIFIED: Acknowledged but not verified via safety number
 * - TRUSTED_VERIFIED: Safety number verified (in-person or out-of-band)
 *
 * The service also tracks identity key change events for audit logging
 * and stores trust decisions in PostgreSQL for persistence across restarts.
 */

import { eq, and, desc } from 'drizzle-orm'
import type { Database } from '../../db'
import { signalIdentities } from '../../db/schema'
import type { SignalConfig, SignalTrustMode } from '@shared/types'
import { createLogger } from '../../lib/logger'
import { safeFetch } from '../../lib/safe-fetch'
import { assertDatabase } from '../../lib/assert-database'

const logger = createLogger('signal-identity')

export type TrustLevel = 'UNTRUSTED' | 'TRUSTED_UNVERIFIED' | 'TRUSTED_VERIFIED'

export interface IdentityRecord {
  id: string
  hubId: string
  number: string
  uuid: string
  fingerprint: string
  trustLevel: TrustLevel
  verifiedBy: string | null     // pubkey of admin who verified
  verifiedAt: Date | null
  firstSeenAt: Date
  lastSeenAt: Date
  keyChangeCount: number        // how many times the identity key has changed
}

export interface IdentityKeyChangeEvent {
  number: string
  uuid: string
  oldFingerprint: string | null
  newFingerprint: string
  timestamp: string
}

export class SignalIdentityService {
  private readonly db: Database

  constructor(db: Database) {
    // An opt-out reads this service (router.subscriberHashesFor): a stand-in
    // db must fail here, not as a TypeError inside a subscriber's STOP (#2447).
    this.db = assertDatabase(db, 'SignalIdentityService')
  }

  /**
   * Record or update an identity from a Signal webhook.
   * Called when we receive a message from a contact — tracks their identity state.
   *
   * Trust mode determines behavior:
   * - 'auto': Always trust identity keys (TRUSTED_UNVERIFIED), even on change
   * - 'tofu': Trust on first contact, mark UNTRUSTED on key change (default)
   * - 'manual': Always queue new identities for admin review (UNTRUSTED)
   */
  async recordIdentity(params: {
    hubId: string
    number: string
    uuid: string
    fingerprint?: string
    trustMode?: SignalTrustMode
  }): Promise<{ isNew: boolean; keyChanged: boolean }> {
    const { hubId, number, uuid } = params
    const fingerprint = params.fingerprint ?? ''
    const trustMode: SignalTrustMode = params.trustMode ?? 'tofu'
    const now = new Date()

    // Check for existing identity
    const existing = await this.db
      .select()
      .from(signalIdentities)
      .where(
        and(
          eq(signalIdentities.hubId, hubId),
          eq(signalIdentities.uuid, uuid),
        ),
      )
      .limit(1)

    if (existing.length === 0) {
      // New identity — trust level depends on trustMode
      const initialTrustLevel: TrustLevel = trustMode === 'manual' ? 'UNTRUSTED' : 'TRUSTED_UNVERIFIED'

      await this.db.insert(signalIdentities).values({
        id: crypto.randomUUID(),
        hubId,
        number,
        uuid,
        fingerprint,
        trustLevel: initialTrustLevel,
        firstSeenAt: now,
        lastSeenAt: now,
        keyChangeCount: 0,
      })

      logger.info('New Signal identity recorded', { uuid: uuid.slice(0, 8), hubId, trustMode, trustLevel: initialTrustLevel })
      return { isNew: true, keyChanged: false }
    }

    const record = existing[0]

    // Check if the identity key (fingerprint) changed
    if (fingerprint && record.fingerprint && fingerprint !== record.fingerprint) {
      // Trust level after key change depends on trustMode
      const trustLevelAfterChange: TrustLevel = trustMode === 'auto' ? 'TRUSTED_UNVERIFIED' : 'UNTRUSTED'

      await this.db
        .update(signalIdentities)
        .set({
          fingerprint,
          trustLevel: trustLevelAfterChange,
          lastSeenAt: now,
          keyChangeCount: (record.keyChangeCount ?? 0) + 1,
          verifiedBy: null,
          verifiedAt: null,
        })
        .where(eq(signalIdentities.id, record.id))

      logger.warn('Signal identity key changed', {
        uuid: uuid.slice(0, 8),
        hubId,
        trustMode,
        newTrustLevel: trustLevelAfterChange,
        changes: (record.keyChangeCount ?? 0) + 1,
      })

      return { isNew: false, keyChanged: true }
    }

    // Just update lastSeenAt
    await this.db
      .update(signalIdentities)
      .set({ lastSeenAt: now, number })
      .where(eq(signalIdentities.id, record.id))

    return { isNew: false, keyChanged: false }
  }

  /**
   * Set the trust level for a Signal identity.
   * Only admins can verify identities (TRUSTED_VERIFIED).
   */
  async setTrustLevel(params: {
    hubId: string
    uuid: string
    trustLevel: TrustLevel
    verifierPubkey?: string
  }): Promise<boolean> {
    const updateData: Partial<typeof signalIdentities.$inferInsert> = {
      trustLevel: params.trustLevel,
    }

    if (params.trustLevel === 'TRUSTED_VERIFIED' && params.verifierPubkey) {
      updateData.verifiedBy = params.verifierPubkey
      updateData.verifiedAt = new Date()
    }

    const result = await this.db
      .update(signalIdentities)
      .set(updateData)
      .where(
        and(
          eq(signalIdentities.hubId, params.hubId),
          eq(signalIdentities.uuid, params.uuid),
        ),
      )
      .returning({ id: signalIdentities.id })

    if (result.length > 0) {
      logger.info('Signal identity trust updated', {
        uuid: params.uuid.slice(0, 8),
        trustLevel: params.trustLevel,
      })
    }

    return result.length > 0
  }

  /**
   * Trust an identity on the bridge (tell signal-cli to trust the key).
   */
  async trustOnBridge(config: SignalConfig, params: {
    number: string
    trustAllKnownKeys?: boolean
    verifiedSafetyNumber?: string
  }): Promise<{ success: boolean; error?: string }> {
    const bridgeUrl = config.bridgeUrl.replace(/\/+$/, '')

    try {
      const body: Record<string, unknown> = {
        recipient: params.number,
      }

      if (params.trustAllKnownKeys) {
        body.trust_all_known_keys = true
      }
      if (params.verifiedSafetyNumber) {
        body.verified_safety_number = params.verifiedSafetyNumber
      }

      const response = await safeFetch(
        `${bridgeUrl}/v1/identities/${encodeURIComponent(config.registeredNumber)}/trust/${encodeURIComponent(params.number)}`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.bridgeApiKey}`,
          },
          body: JSON.stringify(body),
          timeoutMs: 10_000,
          ssrfGuard: false,
        },
      )

      if (!response.ok) {
        const errorText = await response.text()
        return {
          success: false,
          error: `Trust request failed: HTTP ${response.status} — ${errorText}`,
        }
      }

      return { success: true }
    } catch (err) {
      return {
        success: false,
        error: `Bridge unreachable: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  /**
   * Get all identities for a hub, optionally filtered by trust level.
   */
  async getIdentities(hubId: string, trustLevel?: TrustLevel): Promise<IdentityRecord[]> {
    const conditions = [eq(signalIdentities.hubId, hubId)]
    if (trustLevel) {
      conditions.push(eq(signalIdentities.trustLevel, trustLevel))
    }

    const rows = await this.db
      .select()
      .from(signalIdentities)
      .where(and(...conditions))
      .orderBy(desc(signalIdentities.lastSeenAt))

    return rows.map(row => ({
      id: row.id,
      hubId: row.hubId,
      number: row.number,
      uuid: row.uuid,
      fingerprint: row.fingerprint ?? '',
      trustLevel: (row.trustLevel ?? 'UNTRUSTED') as TrustLevel,
      verifiedBy: row.verifiedBy,
      verifiedAt: row.verifiedAt,
      firstSeenAt: row.firstSeenAt,
      lastSeenAt: row.lastSeenAt,
      keyChangeCount: row.keyChangeCount ?? 0,
    }))
  }

  /**
   * Get untrusted identities (identity key changed and not yet acknowledged).
   * These require admin attention.
   */
  async getUntrustedIdentities(hubId: string): Promise<IdentityRecord[]> {
    return this.getIdentities(hubId, 'UNTRUSTED')
  }

  /**
   * Get identity by UUID within a hub.
   */
  async getIdentityByUuid(hubId: string, uuid: string): Promise<IdentityRecord | null> {
    const rows = await this.db
      .select()
      .from(signalIdentities)
      .where(
        and(
          eq(signalIdentities.hubId, hubId),
          eq(signalIdentities.uuid, uuid),
        ),
      )
      .limit(1)

    if (rows.length === 0) return null

    const row = rows[0]
    return {
      id: row.id,
      hubId: row.hubId,
      number: row.number,
      uuid: row.uuid,
      fingerprint: row.fingerprint ?? '',
      trustLevel: (row.trustLevel ?? 'UNTRUSTED') as TrustLevel,
      verifiedBy: row.verifiedBy,
      verifiedAt: row.verifiedAt,
      firstSeenAt: row.firstSeenAt,
      lastSeenAt: row.lastSeenAt,
      keyChangeCount: row.keyChangeCount ?? 0,
    }
  }
}
