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
  WebhookUrlsResponse,
} from '@protocol/schemas/provider-setup'
import { buildProviderWebhookUrls } from '../../lib/provider-webhook-urls'
import { ProviderConfigService } from '../provider-config'
import { loadHubNumbers, recordProvisionedNumber, replaceDeclaredNumbers, setPrimaryDeclaredNumber, type HubNumber } from '../hub-numbers'
import type { HubNumberScope } from '../../db/schema'
import { getProviderCapability, hasCapability } from './registry'
import { encryptCredentials, decryptCredentials } from './crypto'
import type { WebhookUrls, ConnectionTestResult, SipTrunkConfig, SipTrunkRequest } from './types'
import { ProviderApiError } from './types'

export class ProviderSetup {
  private readonly providerConfig: ProviderConfigService

  constructor(
    private readonly db: Database,
    private readonly serverKek: string,
    /** Public webhook origin — see `webhookOrigin` in lib/provider-webhook-urls.ts. */
    private readonly webhookOrigin: string,
  ) {
    this.providerConfig = new ProviderConfigService(db)
  }

  /**
   * Save a provider's credentials. `phoneNumbers` are the numbers the operator
   * declares for the hub — on a self-hosted PBX, the DIDs the carrier delivers,
   * which no provider API can enumerate. They replace the hub's declared set;
   * the single `phoneNumber` is the hotline number and replaces only the
   * primary. Omitting both leaves the hub's numbers alone.
   *
   * `numberScope` is the authority the caller declares them with: `platform`
   * only for a caller holding instance authority (`system:manage-hubs`), else
   * `hub` — which routes only calls the hub's own provider account delivers
   * (see `hub_numbers.scope`).
   *
   * A hubless (instance-wide) provider has no hub to route to, so its number is
   * kept in its credentials, where the adapter reads the number it dials from.
   */
  async configure(
    provider: TelephonyProviderType,
    credentials: Record<string, string>,
    hubId: string | undefined,
    phoneNumber: string | undefined,
    phoneNumbers: readonly string[] | undefined,
    numberScope: HubNumberScope,
  ): Promise<{ ok: true }> {
    const impl = getProviderCapability(provider)
    if (!impl) {
      throw new ProviderApiError(`Provider ${provider} not supported`, 400, 'Unsupported provider')
    }

    const stored = !hubId && phoneNumber ? { ...credentials, phoneNumber } : credentials
    const encryptedCreds = encryptCredentials(stored, this.serverKek)

    // Numbers first: one already held by another hub refuses the request before
    // any credential is stored.
    if (hubId) {
      if (phoneNumbers) await replaceDeclaredNumbers(this.db, hubId, phoneNumbers, numberScope)
      else if (phoneNumber) await setPrimaryDeclaredNumber(this.db, hubId, phoneNumber, numberScope)
    }

    await this.providerConfig.upsertProviderConfig({
      hubId: hubId ?? null,
      providerType: provider,
      credentials: encryptedCreds,
      status: 'connected',
      capabilities: impl.capabilities as string[],
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

    const creds = decryptCredentials(config.credentials, this.serverKek)
    const result = await impl.testConnection(creds)

    await this.providerConfig.upsertProviderConfig({
      id: config.id,
      hubId: config.hubId,
      providerType: config.providerType,
      status: result.connected ? 'connected' : 'error',
      capabilities: config.capabilities as string[],
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
    return impl.listOwnedNumbers(creds)
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

    // A number bought for a hub is a number that hub answers on — the same
    // store a declared one lands in, so routing needs nothing provider-specific.
    if (hubId) {
      const config = await this.getProviderConfigRow(provider, hubId)
      await recordProvisionedNumber(this.db, hubId, number.phoneNumber, config?.id ?? null)
    }

    return number
  }

  /** The numbers a hub answers on, primary first. */
  async hubNumbers(hubId: string): Promise<HubNumber[]> {
    return (await loadHubNumbers(this.db, [hubId])).get(hubId) ?? []
  }

  /**
   * Declare the numbers an operator says belong to a hub (a self-hosted PBX's
   * DIDs). Replaces the declared set; provisioned numbers are untouched.
   */
  async declareNumbers(hubId: string, numbers: readonly string[], numberScope: HubNumberScope): Promise<HubNumber[]> {
    return replaceDeclaredNumbers(this.db, hubId, numbers, numberScope)
  }

  /** Every provider-facing webhook URL for a hub (or the global config). */
  webhookUrls(hubId?: string): WebhookUrlsResponse {
    return buildProviderWebhookUrls(this.webhookOrigin, hubId || undefined)
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

    // The same table GET /provider-setup/webhook-urls shows an admin (#2068).
    const all = this.webhookUrls(options.hubId)
    const urls: WebhookUrls = {
      voiceIncoming: all.voiceIncoming,
      voiceStatus: all.voiceStatus,
    }
    if (options.enableSms) {
      urls.sms = all.messaging.sms
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

    const encryptedCreds = encryptCredentials(credentials, this.serverKek)

    await this.providerConfig.upsertProviderConfig({
      hubId: hubId ?? null,
      providerType: stateRow.provider,
      credentials: encryptedCreds,
      status: 'connected',
      capabilities,
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

    const numbers = config.hubId ? (await loadHubNumbers(this.db, [config.hubId])).get(config.hubId) ?? [] : []
    return {
      provider,
      status: config.status as ProviderStatusResponse['status'],
      capabilities: (config.capabilities as string[]) || [],
      phoneNumbers: numbers.length > 0 ? numbers.map((n: HubNumber) => n.number) : undefined,
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

    const creds = decryptCredentials(config.credentials, this.serverKek)
    return { impl, creds }
  }
}

export { ProviderApiError } from './types'
export { getProviderCapability, hasCapability } from './registry'
export { encryptCredentials, decryptCredentials } from './crypto'
export { registerAllProviders } from './providers'
