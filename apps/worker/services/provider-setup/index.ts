import { eq, and, desc, sql } from 'drizzle-orm'
import { randomBytes } from 'node:crypto'
import type { Database } from '../../db'
import { providerConfigs, oauthStates, signalRegistrations, a2pRegistrations } from '../../db/schema'
import type { TelephonyProviderType } from '@protocol/schemas/settings'
import type {
  OwnedNumber,
  AvailableNumber,
  NumberSearchQuery,
  NumberProvisionRequest,
  ProviderStatusResponse,
} from '@protocol/schemas/provider-setup'
import { SettingsService } from '../settings'
import { getProviderCapability, hasCapability } from './registry'
import { encryptCredentials, decryptCredentials } from './crypto'
import type { WebhookUrls, ConnectionTestResult, SipTrunkConfig, SipTrunkRequest } from './types'
import { ProviderApiError } from './types'

export class ProviderSetup {
  private readonly settings: SettingsService

  constructor(
    private readonly db: Database,
    private readonly hmacSecret: string,
    private readonly baseUrl: string,
  ) {
    this.settings = new SettingsService(db)
  }

  async configure(
    provider: TelephonyProviderType,
    credentials: Record<string, string>,
    hubId?: string,
    phoneNumber?: string,
  ): Promise<{ ok: true }> {
    const impl = getProviderCapability(provider)
    if (!impl) {
      throw new ProviderApiError(`Provider ${provider} not supported`, 400, 'Unsupported provider')
    }

    const encryptedCreds = encryptCredentials(credentials, this.hmacSecret)

    await this.settings.upsertProviderConfig({
      hubId: hubId ?? null,
      providerType: provider,
      credentials: encryptedCreds,
      status: 'connected',
      capabilities: impl.capabilities as string[],
      phoneNumbers: phoneNumber ? [phoneNumber] : [],
      error: null,
      lastCheckedAt: new Date(),
    })

    return { ok: true }
  }

  async testConnection(
    provider: TelephonyProviderType,
    hubId?: string,
  ): Promise<ConnectionTestResult> {
    const config = await this.getProviderConfigRow(provider, hubId)
    if (!config?.credentials) {
      return {
        connected: false,
        latencyMs: 0,
        error: 'No credentials configured',
        errorType: 'invalid_credentials',
      }
    }

    const impl = getProviderCapability(provider)
    if (!impl) {
      return {
        connected: false,
        latencyMs: 0,
        error: `Provider ${provider} not supported`,
        errorType: 'unknown',
      }
    }

    const creds = decryptCredentials(config.credentials, this.hmacSecret)
    const result = await impl.testConnection(creds)

    await this.settings.upsertProviderConfig({
      id: config.id,
      hubId: config.hubId,
      providerType: config.providerType,
      status: result.connected ? 'connected' : 'error',
      capabilities: config.capabilities as string[],
      phoneNumbers: config.phoneNumbers as string[],
      error: result.error || null,
      lastCheckedAt: new Date(),
    })

    return result
  }

  async listNumbers(
    provider: TelephonyProviderType,
    hubId?: string,
  ): Promise<OwnedNumber[]> {
    const { impl, creds } = await this.resolveProvider(provider, hubId, 'listNumbers')
    const numbers = await impl.listOwnedNumbers(creds)

    const config = await this.getProviderConfigRow(provider, hubId)
    if (config) {
      await this.settings.upsertProviderConfig({
        id: config.id,
        hubId: config.hubId,
        providerType: config.providerType,
        status: 'connected',
        capabilities: config.capabilities as string[],
        phoneNumbers: numbers.map((n) => n.phoneNumber),
        error: null,
        lastCheckedAt: new Date(),
      })
    }

    return numbers
  }

  async searchNumbers(
    provider: TelephonyProviderType,
    query: NumberSearchQuery,
    hubId?: string,
  ): Promise<AvailableNumber[]> {
    const { impl, creds } = await this.resolveProvider(provider, hubId, 'provisionNumbers')
    return impl.searchAvailableNumbers(creds, query)
  }

  async provisionNumber(
    provider: TelephonyProviderType,
    request: NumberProvisionRequest,
    hubId?: string,
  ): Promise<OwnedNumber> {
    const { impl, creds } = await this.resolveProvider(provider, hubId, 'provisionNumbers')
    const number = await impl.provisionNumber(creds, request)

    const config = await this.getProviderConfigRow(provider, hubId)
    if (config) {
      const existing = (config.phoneNumbers as string[]) || []
      await this.settings.upsertProviderConfig({
        id: config.id,
        hubId: config.hubId,
        providerType: config.providerType,
        status: 'connected',
        capabilities: config.capabilities as string[],
        phoneNumbers: [...existing, number.phoneNumber],
        error: null,
        lastCheckedAt: new Date(),
      })
    }

    return number
  }

  async configureWebhooks(
    provider: TelephonyProviderType,
    numberId: string,
    options: { enableSms?: boolean; hubId: string },
  ): Promise<void> {
    const { impl, creds } = await this.resolveProvider(
      provider,
      options.hubId,
      'autoWebhooks',
    )

    const urls: WebhookUrls = {
      voiceIncoming: `https://${this.baseUrl}/telephony/incoming`,
      voiceStatus: `https://${this.baseUrl}/telephony/status`,
    }
    if (options.enableSms) {
      urls.sms = `https://${this.baseUrl}/api/messaging/sms/webhook`
    }

    await impl.configureWebhooks(creds, numberId, urls)
  }

  async createSipTrunk(
    provider: TelephonyProviderType,
    request: SipTrunkRequest,
    hubId?: string,
  ): Promise<SipTrunkConfig> {
    const { impl, creds } = await this.resolveProvider(provider, hubId, 'sipTrunks')
    return impl.createSipTrunk(creds, request)
  }

  async createOAuthState(opts: {
    provider: string
    redirectUrl: string
    callbackScheme?: string
    hubId?: string
    ttlMs?: number
  }): Promise<{ stateId: string; expiresAt: Date }> {
    const stateId = randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + (opts.ttlMs ?? 10 * 60 * 1000))
    await this.db.insert(oauthStates).values({
      id: stateId,
      provider: opts.provider,
      hubId: opts.hubId ?? null,
      status: 'pending',
      redirectUrl: opts.redirectUrl,
      callbackScheme: opts.callbackScheme ?? null,
      expiresAt,
    })
    return { stateId, expiresAt }
  }

  async getOAuthState(stateId: string): Promise<typeof oauthStates.$inferSelect | null> {
    const [row] = await this.db.select().from(oauthStates).where(eq(oauthStates.id, stateId))
    return row ?? null
  }

  async completeOAuthState(
    stateId: string,
    credentials: Record<string, unknown>,
    capabilities: string[],
    hubId: string | null,
  ): Promise<void> {
    const [stateRow] = await this.db.select().from(oauthStates).where(eq(oauthStates.id, stateId))
    if (!stateRow) return

    const encryptedCreds = encryptCredentials(credentials, this.hmacSecret)

    await this.settings.upsertProviderConfig({
      hubId: hubId ?? null,
      providerType: stateRow.provider,
      credentials: encryptedCreds,
      status: 'connected',
      capabilities,
      phoneNumbers: [],
      lastCheckedAt: new Date(),
    })

    await this.db.delete(oauthStates).where(eq(oauthStates.id, stateId))
  }

  async failOAuthState(stateId: string): Promise<void> {
    await this.db.delete(oauthStates).where(eq(oauthStates.id, stateId))
  }

  async reset(): Promise<void> {
    await this.db.delete(signalRegistrations)
    await this.db.delete(a2pRegistrations)
    await this.db.delete(oauthStates)
    await this.db.delete(providerConfigs)
  }

  async getProviderStatus(
    provider: TelephonyProviderType,
    hubId?: string,
  ): Promise<ProviderStatusResponse> {
    const config = await this.getProviderConfigRow(provider, hubId)
    if (!config) {
      return {
        provider,
        status: 'disconnected',
        capabilities: [],
      }
    }

    return {
      provider,
      status: config.status as ProviderStatusResponse['status'],
      capabilities: (config.capabilities as string[]) || [],
      phoneNumbers: (config.phoneNumbers as string[]) || undefined,
      error: config.error || undefined,
      lastCheckedAt: config.lastCheckedAt?.toISOString() || undefined,
    }
  }

  private async getProviderConfigRow(
    provider: TelephonyProviderType,
    hubId?: string | null,
  ): Promise<typeof providerConfigs.$inferSelect | null> {
    // When hubId is provided, look up hub-scoped config.
    // When hubId is undefined/null, look up global config (hub_id IS NULL).
    const hubCondition = hubId
      ? eq(providerConfigs.hubId, hubId)
      : sql`${providerConfigs.hubId} IS NULL`

    const [row] = await this.db
      .select()
      .from(providerConfigs)
      .where(
        and(
          eq(providerConfigs.providerType, provider),
          hubCondition,
        ),
      )
      .orderBy(desc(providerConfigs.createdAt))
      .limit(1)
    return row ?? null
  }

  private async resolveProvider(
    provider: TelephonyProviderType,
    hubId: string | undefined,
    requiredCapability: string,
  ): Promise<{ impl: NonNullable<ReturnType<typeof getProviderCapability>>; creds: Record<string, unknown> }> {
    const config = await this.getProviderConfigRow(provider, hubId)
    if (!config?.credentials) {
      throw new ProviderApiError('Provider not configured — call /configure first', 424, 'Not configured')
    }

    const impl = getProviderCapability(provider)
    if (!impl) {
      throw new ProviderApiError(`Provider ${provider} not supported`, 400, 'Unsupported provider')
    }

    if (!hasCapability(provider, requiredCapability)) {
      throw new ProviderApiError(
        `Provider ${provider} does not support ${requiredCapability}`,
        400,
        'Capability not supported',
      )
    }

    const creds = decryptCredentials(config.credentials, this.hmacSecret)
    return { impl, creds }
  }
}

export { ProviderApiError } from './types'
export { getProviderCapability, hasCapability } from './registry'
export { encryptCredentials, decryptCredentials } from './crypto'
export { registerAllProviders } from './providers'
