/**
 * A2pRegistrationService — manages A2P/10DLC brand and campaign registration
 * for SMS providers that require it (currently Twilio only).
 *
 * Brand state machine:  not_submitted -> pending -> approved | failed
 * Campaign state machine: not_submitted -> pending -> approved | failed
 *                         (campaign submission requires brand to be approved first)
 *
 * SIDs returned by the provider are sensitive — encrypted before storage.
 * Phone numbers are never stored here (live in signal_registrations or provider_configs).
 */

import { eq } from 'drizzle-orm'
import { randomBytes } from 'node:crypto'
import type { Database } from '../../db'
import { a2pRegistrations } from '../../db/schema'
import { encryptCredentials, decryptCredentials } from './crypto'

// ── Types ─────────────────────────────────────────────────────────────────

export type BrandStatus = 'not_submitted' | 'pending' | 'approved' | 'failed' | 'skipped'
export type CampaignStatus = 'not_submitted' | 'pending' | 'approved' | 'failed' | 'skipped'

export interface A2pRegistration {
  id: string
  hubId: string
  providerType: string
  brandStatus: BrandStatus
  campaignStatus: CampaignStatus
  /** Masked brand SID — last 4 chars only */
  brandSidMasked: string | null
  /** Masked campaign SID — last 4 chars only */
  campaignSidMasked: string | null
  error: string | null
  submittedAt: string | null
  approvedAt: string | null
  createdAt: string
  updatedAt: string
}

/**
 * Brand registration info — contains PII (phone, EIN, address).
 * This data is ephemeral: sent directly to the provider API and never persisted to the DB.
 * If brand info is ever stored for audit purposes, it MUST be encrypted at rest.
 */
export interface BrandInfo {
  entityType: 'PRIVATE_PROFIT' | 'PUBLIC_PROFIT' | 'NON_PROFIT' | 'GOVERNMENT'
  companyName: string
  ein: string
  phone: string
  street: string
  city: string
  state: string
  postalCode: string
  country: string
  email: string
  website?: string
  vertical?:
    | 'AGRICULTURE'
    | 'COMMUNICATION'
    | 'CONSTRUCTION'
    | 'EDUCATION'
    | 'EMERGENCY_SERVICES'
    | 'ENTERTAINMENT'
    | 'FINANCIAL'
    | 'GAMBLING'
    | 'GOVERNMENT'
    | 'HEALTHCARE'
    | 'HUMAN_RESOURCES'
    | 'INSURANCE'
    | 'LEGAL'
    | 'MANUFACTURING'
    | 'NGO'
    | 'POLITICAL'
    | 'POSTAL'
    | 'PROFESSIONAL'
    | 'REAL_ESTATE'
    | 'RETAIL'
    | 'TECHNOLOGY'
    | 'TRANSPORTATION'
}

export interface CampaignInfo {
  useCase:
    | 'LOW_VOLUME'
    | '2FA'
    | 'ACCOUNT_NOTIFICATION'
    | 'CUSTOMER_CARE'
    | 'DELIVERY_NOTIFICATION'
    | 'FRAUD_ALERT'
    | 'HIGHER_EDUCATION'
    | 'K12'
    | 'MARKETING'
    | 'MIXED'
    | 'POLITICAL'
    | 'PUBLIC_SERVICE_ANNOUNCEMENT'
    | 'SECURITY_ALERT'
    | 'SOCIAL'
    | 'SWEEPSTAKE'
  description: string
  helpMessage: string
  optinMessage: string
  optoutMessage: string
  sampleMessages: string[]
  embeddedLink?: boolean
  embeddedPhone?: boolean
  subscriberOptin?: boolean
  subscriberOptout?: boolean
  subscriberHelp?: boolean
}

/** Providers that support A2P/10DLC registration. */
const A2P_SUPPORTED_PROVIDERS = ['twilio'] as const
type A2pSupportedProvider = typeof A2P_SUPPORTED_PROVIDERS[number]

function isA2pSupportedProvider(p: string): p is A2pSupportedProvider {
  return (A2P_SUPPORTED_PROVIDERS as readonly string[]).includes(p)
}

/** Valid brand state transitions. */
const BRAND_TRANSITIONS: Record<BrandStatus, BrandStatus[]> = {
  not_submitted: ['pending', 'skipped'],
  pending: ['approved', 'failed', 'skipped'],
  approved: [],
  failed: ['pending', 'skipped'],
  skipped: [],
}

/** Valid campaign state transitions. */
const CAMPAIGN_TRANSITIONS: Record<CampaignStatus, CampaignStatus[]> = {
  not_submitted: ['pending', 'skipped'],
  pending: ['approved', 'failed', 'skipped'],
  approved: [],
  failed: ['pending', 'skipped'],
  skipped: [],
}

// ── Service ───────────────────────────────────────────────────────────────

export class A2pRegistrationService {
  constructor(
    private readonly db: Database,
    private readonly serverKek: string,
  ) {}

  /**
   * Submit a brand registration to the provider.
   *
   * Only supported for Twilio. The returned brand SID is encrypted before storage.
   * Requires telephony:manage-a2p permission (enforced at route level).
   */
  async submitBrand(
    providerType: string,
    brandInfo: BrandInfo,
    hubId: string,
  ): Promise<A2pRegistration> {
    if (!isA2pSupportedProvider(providerType)) {
      throw new A2pRegistrationError(
        `Provider "${providerType}" does not support A2P registration`,
        400,
      )
    }

    const existing = await this.getRegistrationForHub(hubId)
    if (existing) {
      this.enforceBrandTransition(existing.brandStatus as BrandStatus, 'pending')
    }

    const brandSid = await this.callTwilioSubmitBrand(brandInfo)
    const encryptedBrandSid = encryptCredentials({ sid: brandSid }, this.serverKek)

    if (existing) {
      await this.db
        .update(a2pRegistrations)
        .set({
          brandStatus: 'pending',
          brandSid: encryptedBrandSid,
          error: null,
          submittedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(a2pRegistrations.id, existing.id))
      const row = await this.loadRow(existing.id)
      return this.toPublic(row)
    }

    const id = randomBytes(16).toString('hex')
    await this.db.insert(a2pRegistrations).values({
      id,
      hubId,
      providerType,
      brandStatus: 'pending',
      campaignStatus: 'not_submitted',
      brandSid: encryptedBrandSid,
      submittedAt: new Date(),
    })

    const row = await this.loadRow(id)
    return this.toPublic(row)
  }

  /**
   * Submit a campaign registration.
   *
   * Requires brand to be in 'approved' state. The returned campaign SID
   * is encrypted before storage.
   */
  async submitCampaign(
    registrationId: string,
    campaignInfo: CampaignInfo,
  ): Promise<A2pRegistration> {
    const row = await this.loadRow(registrationId)

    if (row.brandStatus !== 'approved') {
      throw new A2pRegistrationError(
        `Cannot submit campaign — brand status is "${row.brandStatus}", must be "approved"`,
        400,
      )
    }

    this.enforceCampaignTransition(row.campaignStatus as CampaignStatus, 'pending')

    const brandSid = row.brandSid
      ? (decryptCredentials(row.brandSid, this.serverKek).sid as string)
      : ''

    const campaignSid = await this.callTwilioSubmitCampaign(brandSid, campaignInfo)
    const encryptedCampaignSid = encryptCredentials({ sid: campaignSid }, this.serverKek)

    await this.db
      .update(a2pRegistrations)
      .set({
        campaignStatus: 'pending',
        campaignSid: encryptedCampaignSid,
        error: null,
        updatedAt: new Date(),
      })
      .where(eq(a2pRegistrations.id, registrationId))

    const updated = await this.loadRow(registrationId)
    return this.toPublic(updated)
  }

  /**
   * Poll the provider for current brand and campaign status, update DB.
   */
  async checkStatus(registrationId: string): Promise<A2pRegistration> {
    const row = await this.loadRow(registrationId)

    if (!isA2pSupportedProvider(row.providerType)) {
      return this.toPublic(row)
    }

    const updates: Partial<typeof a2pRegistrations.$inferInsert> = {}

    // Poll brand status if still pending
    if (row.brandStatus === 'pending' && row.brandSid) {
      const brandSid = decryptCredentials(row.brandSid, this.serverKek).sid as string
      const brandStatusFromProvider = await this.pollTwilioBrandStatus(brandSid)
      if (brandStatusFromProvider === 'APPROVED') {
        updates.brandStatus = 'approved'
        updates.approvedAt = new Date()
      } else if (brandStatusFromProvider === 'FAILED') {
        updates.brandStatus = 'failed'
        updates.error = 'Brand registration rejected by provider'
      }
    }

    // Poll campaign status if still pending
    if (row.campaignStatus === 'pending' && row.campaignSid) {
      const campaignSid = decryptCredentials(row.campaignSid, this.serverKek).sid as string
      const campaignStatusFromProvider = await this.pollTwilioCampaignStatus(campaignSid)
      if (campaignStatusFromProvider === 'REGISTERED') {
        updates.campaignStatus = 'approved'
      } else if (campaignStatusFromProvider === 'FAILED') {
        updates.campaignStatus = 'failed'
        updates.error = updates.error ?? 'Campaign registration rejected by provider'
      }
    }

    if (Object.keys(updates).length > 0) {
      updates.updatedAt = new Date()
      await this.db
        .update(a2pRegistrations)
        .set(updates)
        .where(eq(a2pRegistrations.id, registrationId))
    }

    const updated = await this.loadRow(registrationId)
    return this.toPublic(updated)
  }

  /**
   * Mark A2P registration as not needed for this hub.
   *
   * Creates a record with both statuses set to 'skipped' if none exists,
   * or updates an existing record.
   */
  async skip(hubId: string, providerType = 'twilio'): Promise<A2pRegistration> {
    const existing = await this.getRegistrationForHub(hubId)

    if (existing) {
      // Enforce state transitions — cannot skip if already approved
      this.enforceBrandTransition(existing.brandStatus as BrandStatus, 'skipped')
      this.enforceCampaignTransition(existing.campaignStatus as CampaignStatus, 'skipped')

      await this.db
        .update(a2pRegistrations)
        .set({ brandStatus: 'skipped', campaignStatus: 'skipped', updatedAt: new Date() })
        .where(eq(a2pRegistrations.id, existing.id))
      const row = await this.loadRow(existing.id)
      return this.toPublic(row)
    }

    const id = randomBytes(16).toString('hex')
    await this.db.insert(a2pRegistrations).values({
      id,
      hubId,
      providerType,
      brandStatus: 'skipped',
      campaignStatus: 'skipped',
    })
    const row = await this.loadRow(id)
    return this.toPublic(row)
  }

  /**
   * Get the current A2P registration for a hub, if any.
   */
  async getRegistrationForHub(hubId: string): Promise<(typeof a2pRegistrations.$inferSelect) | null> {
    const [row] = await this.db
      .select()
      .from(a2pRegistrations)
      .where(eq(a2pRegistrations.hubId, hubId))
      .limit(1)
    return row ?? null
  }

  /**
   * Test-only: directly transition a brand to "approved" state.
   * Used by BDD fixtures that need an approved brand to test campaign submission.
   */
  async testApproveBrand(registrationId: string): Promise<A2pRegistration> {
    await this.db
      .update(a2pRegistrations)
      .set({ brandStatus: 'approved', approvedAt: new Date(), updatedAt: new Date() })
      .where(eq(a2pRegistrations.id, registrationId))
    const row = await this.loadRow(registrationId)
    return this.toPublic(row)
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private async loadRow(id: string) {
    const [row] = await this.db
      .select()
      .from(a2pRegistrations)
      .where(eq(a2pRegistrations.id, id))
    if (!row) throw new A2pRegistrationError('A2P registration not found', 404)
    return row
  }

  private enforceBrandTransition(current: BrandStatus, next: BrandStatus): void {
    const allowed = BRAND_TRANSITIONS[current]
    if (!allowed.includes(next)) {
      throw new A2pRegistrationError(
        `Invalid brand state transition: ${current} -> ${next}`,
        409,
      )
    }
  }

  private enforceCampaignTransition(current: CampaignStatus, next: CampaignStatus): void {
    const allowed = CAMPAIGN_TRANSITIONS[current]
    if (!allowed.includes(next)) {
      throw new A2pRegistrationError(
        `Invalid campaign state transition: ${current} -> ${next}`,
        409,
      )
    }
  }

  /**
   * Submit brand registration to Twilio A2P API.
   *
   * In the absence of real Twilio credentials (test environment),
   * returns a synthetic SID so the state machine can proceed.
   */
  private async callTwilioSubmitBrand(_brandInfo: BrandInfo): Promise<string> {
    // Real Twilio call would be:
    // POST https://messaging.twilio.com/v1/a2p/BrandRegistrations
    // For now, return a synthetic SID — real implementation requires Twilio creds
    // that come from the provider_configs table (fetched by the route layer).
    return `BN${randomBytes(16).toString('hex').toUpperCase()}`
  }

  private async callTwilioSubmitCampaign(_brandSid: string, _campaignInfo: CampaignInfo): Promise<string> {
    // Real Twilio call would be:
    // POST https://messaging.twilio.com/v1/Services/{brandSid}/AlphaSenders
    return `CM${randomBytes(16).toString('hex').toUpperCase()}`
  }

  private async pollTwilioBrandStatus(_brandSid: string): Promise<string | null> {
    // Real call: GET https://messaging.twilio.com/v1/a2p/BrandRegistrations/{brandSid}
    // Returns null if unable to determine status
    return null
  }

  private async pollTwilioCampaignStatus(_campaignSid: string): Promise<string | null> {
    // Real call: GET https://messaging.twilio.com/v1/a2p/UseCases/{campaignSid}
    return null
  }

  private toPublic(row: typeof a2pRegistrations.$inferSelect): A2pRegistration {
    return {
      id: row.id,
      hubId: row.hubId,
      providerType: row.providerType,
      brandStatus: row.brandStatus as BrandStatus,
      campaignStatus: row.campaignStatus as CampaignStatus,
      brandSidMasked: row.brandSid ? maskSid(decryptCredentials(row.brandSid, this.serverKek).sid as string) : null,
      campaignSidMasked: row.campaignSid ? maskSid(decryptCredentials(row.campaignSid, this.serverKek).sid as string) : null,
      error: row.error,
      submittedAt: row.submittedAt?.toISOString() ?? null,
      approvedAt: row.approvedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }
  }
}

// ── Error class ───────────────────────────────────────────────────────────

export class A2pRegistrationError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message)
    this.name = 'A2pRegistrationError'
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function maskSid(sid: string): string {
  if (sid.length <= 4) return '****'
  return `${sid.slice(0, 2)}****${sid.slice(-4)}`
}
