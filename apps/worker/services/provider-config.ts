import {
  eq,
  and,
  isNull,
  desc,
} from 'drizzle-orm'
import type { Database } from '../db'
import { providerConfigs } from '../db/schema'
import type { TelephonyProviderConfig } from '@shared/types'
import { PROVIDER_REQUIRED_FIELDS } from '@shared/types'
import { MOCK_PROVIDER_TYPE } from '../telephony/mock'
import { ServiceError } from './service-error'
import { loadHubNumbers, setPrimaryDeclaredNumber } from './hub-numbers'
import type { HubNumberScope } from '../db/schema'

const VALID_PROVIDER_TYPES = [
  'twilio',
  'signalwire',
  'vonage',
  'plivo',
  'asterisk',
  'telnyx',
  'bandwidth',
  'freeswitch',
] as const

/** The one place a `hubs` row becomes the wire `Hub` — every read of a hub goes through it. */
/**
 * The stored credentials of a hub's mock provider. Its webhook signing secret
 * (kept in `authToken`, the role Twilio's auth token plays) is encrypted at rest
 * like any provider credential; a mock with no secret accepts no webhooks.
 */
async function mockCredentials(
  phoneNumber: string,
  options: { webhookSecret?: string; serverKek?: string },
): Promise<string> {
  const creds = { type: MOCK_PROVIDER_TYPE, phoneNumber }
  if (!options.webhookSecret) return JSON.stringify(creds)
  if (!options.serverKek) throw new ServiceError(500, 'A mock webhook secret cannot be stored without SERVER_KEK')
  // Loaded on demand: `provider-setup/crypto` binds the native crypto library at import time, and this
  // module is imported (for `ServiceError`) by code that must stay loadable without it.
  const { encryptCredentials } = await import('./provider-setup/crypto')
  return encryptCredentials({ ...creds, authToken: options.webhookSecret }, options.serverKek)
}

/**
 * Telephony provider configuration (`provider_configs`, the platform and per-hub provider) and a
 * hub's mock telephony provider.
 */
export class ProviderConfigService {
  constructor(protected db: Database) {}

  async getProviderConfig(
    providerType: string,
    hubId?: string,
  ): Promise<typeof providerConfigs.$inferSelect | null> {
    const [row] = await this.db
      .select()
      .from(providerConfigs)
      .where(
        and(
          eq(providerConfigs.providerType, providerType),
          hubId
            ? eq(providerConfigs.hubId, hubId)
            : isNull(providerConfigs.hubId),
        ),
      )
    return row ?? null
  }

  async upsertProviderConfig(
    config: Partial<typeof providerConfigs.$inferInsert>,
  ): Promise<typeof providerConfigs.$inferSelect> {
    const now = new Date()
    const hubId = config.hubId !== undefined ? config.hubId : null

    // Find existing config for this hub (or global if hubId is null)
    const whereClause = hubId !== null
      ? eq(providerConfigs.hubId, hubId)
      : isNull(providerConfigs.hubId)

    const [existing] = await this.db
      .select({ id: providerConfigs.id })
      .from(providerConfigs)
      .where(whereClause)
      .limit(1)

    const id = existing?.id ?? config.id ?? crypto.randomUUID()

    if (existing) {
      await this.db
        .update(providerConfigs)
        .set({
          providerType: config.providerType,
          credentials: config.credentials,
          status: config.status,
          capabilities: config.capabilities,
          error: config.error,
          lastCheckedAt: config.lastCheckedAt,
          updatedAt: now,
        })
        .where(eq(providerConfigs.id, id))
    } else {
      await this.db
        .insert(providerConfigs)
        .values({
          id,
          hubId,
          providerType: config.providerType ?? '',
          credentials: config.credentials ?? null,
          status: config.status ?? 'disconnected',
          capabilities: config.capabilities ?? [],
          error: config.error ?? null,
          lastCheckedAt: config.lastCheckedAt ?? null,
          createdAt: now,
          updatedAt: now,
        })
    }

    const [row] = await this.db
      .select()
      .from(providerConfigs)
      .where(eq(providerConfigs.id, id))
    return row
  }

  async deleteProviderConfig(id: string): Promise<{ ok: true }> {
    await this.db
      .delete(providerConfigs)
      .where(eq(providerConfigs.id, id))
    return { ok: true }
  }

  async getTelephonyProvider(serverKek?: string, hubId?: string): Promise<TelephonyProviderConfig | null> {
    // When a hubId is provided, read the hub-scoped config instead of the global one.
    const hubCondition = hubId
      ? eq(providerConfigs.hubId, hubId)
      : isNull(providerConfigs.hubId)
    const [row] = await this.db
      .select()
      .from(providerConfigs)
      .where(hubCondition)
      .orderBy(desc(providerConfigs.updatedAt))
      .limit(1)
    if (!row) return null

    // Build base config from provider_configs metadata
    const config: Record<string, unknown> = {
      type: row.providerType,
      phoneNumber: '',
    }

    // Decrypt credentials if the server KEK is provided and credentials exist
    if (row.credentials && serverKek) {
      try {
        const { decryptCredentials } = await import('./provider-setup/crypto')
        const creds = decryptCredentials(row.credentials, serverKek)
        Object.assign(config, creds)
      } catch {
        // Credentials may be plain JSON (legacy) — try parsing directly
        try {
          Object.assign(config, JSON.parse(row.credentials))
        } catch { /* ignore */ }
      }
    } else if (row.credentials) {
      // No KEK — try plain JSON parse (legacy path)
      try {
        Object.assign(config, JSON.parse(row.credentials))
      } catch { /* encrypted, can't decrypt without secret */ }
    }

    // A hub's number is the one routing resolves calls from (`hub_numbers`), not
    // a copy typed into the credentials: prefer a number bought through this
    // config, else the hub's primary.
    if (hubId) {
      const numbers = (await loadHubNumbers(this.db, [hubId])).get(hubId) ?? []
      const own = numbers.find((n) => n.providerConfigId === row.id) ?? numbers[0]
      if (own) config.phoneNumber = own.number
    }

    return config as unknown as TelephonyProviderConfig
  }

  /**
   * @deprecated Use ProviderSetupService.configure() instead — it encrypts credentials at rest.
   * This legacy method stores credentials in plaintext and will be removed in a future release.
   */
  async updateTelephonyProvider(
    _config: TelephonyProviderConfig,
  ): Promise<never> {
    throw new ServiceError(
      400,
      'updateTelephonyProvider is deprecated — use POST /provider-setup/configure which encrypts credentials at rest',
    )
  }

  /**
   * Hub-scoped telephony provider config.
   *
   * Delegates to {@link getTelephonyProvider}, which is the established read
   * path for exactly this row — same table, same hub predicate, same credential
   * handling. No separate parsing, key handling or decrypt helper here.
   *
   * The previous implementation read the row itself and did
   * `JSON.parse(row.credentials)`. That could never succeed: every writer stores
   * ciphertext (`provider-setup/index.ts` encrypts via `encryptCredentials`),
   * and the provider type lives in the `provider_configs.provider_type` COLUMN,
   * never inside the credentials JSON — so even a successful parse would have
   * yielded an object with no `type`. It therefore returned null for every
   * configured hub, which silently
   *   - disabled the hub-scoped IVR speakability constraint (#1260) by making
   *     the catalog resolution fall through to the instance-wide provider, and
   *   - made `getHubTelephonyFromService` fall back to the global provider for
   *     every hub, so per-hub provider configuration never took effect at all.
   */
  async getHubTelephonyProvider(
    hubId: string,
    serverKek?: string,
  ): Promise<TelephonyProviderConfig | null> {
    return this.getTelephonyProvider(serverKek, hubId)
  }

  /**
   * `numberScope` is the authority the caller wrote the provider's number with
   * (see `hub_numbers.scope`): `platform` only for a caller holding instance
   * authority (`system:manage-hubs`).
   */
  async setHubTelephonyProvider(
    hubId: string,
    config: TelephonyProviderConfig,
    numberScope: HubNumberScope,
  ): Promise<{ ok: true }> {
    if (!config || typeof config !== 'object') {
      throw new ServiceError(400, 'Invalid request body')
    }
    if (!config.type) {
      throw new ServiceError(400, 'Provider type is required')
    }
    if (!(VALID_PROVIDER_TYPES as readonly string[]).includes(config.type)) {
      throw new ServiceError(
        400,
        `Invalid provider type: ${config.type}`,
      )
    }
    const required = PROVIDER_REQUIRED_FIELDS[config.type]
    for (const field of required) {
      if (!config[field]) {
        throw new ServiceError(400, `Missing required field: ${field}`)
      }
    }
    if (config.phoneNumber && !/^\+\d{7,15}$/.test(config.phoneNumber)) {
      throw new ServiceError(
        400,
        'Phone number must be in E.164 format',
      )
    }

    const existing = await this.db
      .select()
      .from(providerConfigs)
      .where(eq(providerConfigs.hubId, hubId))
      .limit(1)
    const id = existing[0]?.id ?? crypto.randomUUID()
    await this.db.transaction(async (tx) => {
      await tx
        .insert(providerConfigs)
        .values({
          id,
          hubId,
          providerType: config.type,
          credentials: JSON.stringify(config),
          status: 'connected',
          capabilities: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: providerConfigs.id,
          set: {
            providerType: config.type,
            credentials: JSON.stringify(config),
            status: 'connected',
            updatedAt: new Date(),
          },
        })
      // The provider form's number is the hub's hotline number: it goes where
      // routing reads it, not only into the provider's own record.
      if (config.phoneNumber) await setPrimaryDeclaredNumber(tx, hubId, config.phoneNumber, numberScope)
    })
    return { ok: true }
  }

  /**
   * Select the test-only mock telephony provider (type `mock`) for a hub.
   *
   * Callers MUST have already checked `assertMockTelephonyAllowed` — this only
   * persists the selection. Refuses to overwrite a real provider's credentials.
   */
  async enableHubMockTelephony(
    hubId: string,
    phoneNumber: string,
    options: { webhookSecret?: string; serverKek?: string } = {},
  ): Promise<{ ok: true }> {
    const [existing] = await this.db
      .select()
      .from(providerConfigs)
      .where(eq(providerConfigs.hubId, hubId))
      .limit(1)
    if (existing && existing.providerType !== MOCK_PROVIDER_TYPE) {
      throw new ServiceError(
        409,
        `Hub already has a ${existing.providerType} telephony provider — remove it before enabling the mock`,
      )
    }
    const id = existing?.id ?? crypto.randomUUID()
    const values = {
      providerType: MOCK_PROVIDER_TYPE,
      credentials: await mockCredentials(phoneNumber, options),
      status: 'connected',
      updatedAt: new Date(),
    }
    // The mock's number is the one it dials from, kept in its credentials. It is
    // deliberately NOT declared as a number the hub answers on: every hub's mock
    // shares one default, and a dialled number belongs to one hub. A test that
    // routes calls to the mock sets the hub's number the way an operator does.
    await this.db
      .insert(providerConfigs)
      .values({ id, hubId, capabilities: [], createdAt: new Date(), ...values })
      .onConflictDoUpdate({ target: providerConfigs.id, set: values })
    return { ok: true }
  }

  /** Remove the mock provider from a hub. Never touches a real provider's config. */
  async disableHubMockTelephony(hubId: string): Promise<{ ok: true }> {
    await this.db
      .delete(providerConfigs)
      .where(and(eq(providerConfigs.hubId, hubId), eq(providerConfigs.providerType, MOCK_PROVIDER_TYPE)))
    return { ok: true }
  }

  /** Whether the hub currently selects the mock provider. */
  async isHubMockTelephonyEnabled(hubId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ providerType: providerConfigs.providerType })
      .from(providerConfigs)
      .where(eq(providerConfigs.hubId, hubId))
      .limit(1)
    return row?.providerType === MOCK_PROVIDER_TYPE
  }
}
