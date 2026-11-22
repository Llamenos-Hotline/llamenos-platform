import { eq, sql } from 'drizzle-orm'
import type { Database } from '../db'
import { systemSettings, hubSettings as hubSettingsTable } from '../db/schema'
import { SINGLETON_ID, getSettings } from './system-settings-row'

const ALLOWED_HUB_SETTINGS = new Set([
  'hubName',
  'timezone',
  'language',
  'welcomeMessage',
  'emergencyMessage',
  'maxConcurrentCalls',

  'callSettings',
  'spamSettings',
  'transcriptionEnabled',
  'autoAssignment',
  'fallbackGroup',
  'caseManagementEnabled',
  'providerSetupComplete',
  'channels',
  'quotas',
  'usage',
  'subAccountEnabled',
  'subAccountConfigId',
  'heartbeatTimeout',
  'ivrLanguages',
  // #1342: the volunteer call-history ACCESS window. Written only by
  // updateCallHistoryAccess (settings:manage-calls, audited with old and new).
  'callHistoryAccess',
])

/**
 * A hub's own settings document (`hub_settings`): reads, allow-listed writes, quotas, usage
 * counters and the per-hub case-management switch.
 */
export class HubSettingsService {
  constructor(protected db: Database) {}

  async getHubSettings(
    hubId: string,
  ): Promise<Record<string, unknown>> {
    const [row] = await this.db
      .select()
      .from(hubSettingsTable)
      .where(eq(hubSettingsTable.hubId, hubId))
    return (row?.settings as Record<string, unknown>) ?? {}
  }

  async updateHubSettings(
    hubId: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    // Strip unknown keys
    const sanitized: Record<string, unknown> = {}
    for (const key of Object.keys(data)) {
      if (ALLOWED_HUB_SETTINGS.has(key)) {
        sanitized[key] = data[key]
      }
    }

    // Atomic top-level JSONB merge (#1144). The previous implementation was
    // read-modify-write: SELECT the whole settings blob, spread it with the
    // new keys in JS, write the whole object back. Two admins changing
    // *different* keys concurrently (or one admin with two tabs) both read
    // the same blob and the last write silently discarded the other's
    // change — including spam-mitigation toggles and the fallback ring
    // group, which live in this same blob.
    //
    // The `||` jsonb concatenation operator merges at the top level only:
    // every key in the right operand overwrites the corresponding key on
    // the left, and every key absent from the right operand is preserved.
    // It is evaluated by Postgres against the row this statement just
    // locked for the UPDATE — not a value read earlier in JS — so
    // concurrent writers touching disjoint (or even the same) keys are
    // serialised by the row lock instead of clobbering each other.
    //
    // The right-hand operand goes through the COLUMN's own driver encoder
    // (`mapToDriverValue`), not into the statement as a bare JS value.
    //
    // Never JSON.stringify it here. Bun's native SQL driver (what production
    // and `bun run dev:server` use) already serialises a JS value bound to a
    // jsonb parameter position, so pre-stringifying double-encodes — Postgres
    // then sees a quoted JSON *string scalar* instead of an object, and `||`
    // between an object and a scalar boxes both into a 2-element array instead
    // of merging keys (confirmed live via #1144's own BDD coverage: "Shift and
    // fallback group are independent" silently lost the fallback group).
    //
    // `bun-jsonb`'s customType has no `toDriver`, so `mapToDriverValue` is the
    // identity on Bun and the value still reaches the driver raw — production
    // behaviour is unchanged. It matters for every OTHER driver: a plain value
    // embedded in a `sql` template is bound with no encoder at all, and
    // drizzle's postgres-js session installs a transparent serialiser for
    // jsonb (OID 3802), so an object reaches postgres.js's byte encoder and
    // throws `ERR_INVALID_ARG_TYPE`. That is why this statement — reachable
    // from `setFallbackGroup` and `updateIvrLanguages`, both core routing
    // config — could not be exercised at all by the postgres-js integration
    // tier (#1167). Routing it through the column means the one declaration of
    // how this column is serialised is honoured on both drivers.
    // Mirrors the existing `metadata` merge in conversations.ts#update.
    const [row] = await this.db
      .insert(hubSettingsTable)
      .values({ hubId, settings: sanitized })
      .onConflictDoUpdate({
        target: hubSettingsTable.hubId,
        set: {
          settings: sql`COALESCE(${hubSettingsTable.settings}, '{}'::jsonb) || ${hubSettingsTable.settings.mapToDriverValue(sanitized)}::jsonb`,
        },
      })
      .returning({ settings: hubSettingsTable.settings })

    return row.settings as Record<string, unknown>
  }

  async getHubProviderSettings(
    hubId: string,
  ): Promise<Record<string, unknown>> {
    const settings = await this.getHubSettings(hubId)
    return {
      providerSetupComplete: settings.providerSetupComplete ?? false,
      channels: settings.channels ?? {},
      quotas: settings.quotas ?? {},
      usage: settings.usage ?? [],
      subAccountEnabled: settings.subAccountEnabled ?? false,
      subAccountConfigId: settings.subAccountConfigId ?? undefined,
    }
  }

  async updateHubQuotas(
    hubId: string,
    quotas: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    // Atomic — see updateHubSettings (#1144). Only the `quotas` key is
    // touched, so a concurrent updateHubSettings/updateHubUsage call on a
    // different key cannot be clobbered by this one. Encoded by the column,
    // never JSON.stringify'd — see the comment in updateHubSettings for why.
    const [row] = await this.db
      .insert(hubSettingsTable)
      .values({ hubId, settings: { quotas } })
      .onConflictDoUpdate({
        target: hubSettingsTable.hubId,
        set: {
          settings: sql`COALESCE(${hubSettingsTable.settings}, '{}'::jsonb) || jsonb_build_object('quotas', ${hubSettingsTable.settings.mapToDriverValue(quotas)}::jsonb)`,
        },
      })
      .returning({ settings: hubSettingsTable.settings })

    return (row.settings as Record<string, unknown>).quotas as Record<string, unknown>
  }

  async updateHubUsage(
    hubId: string,
    usage: Record<string, unknown>[],
  ): Promise<Record<string, unknown>[]> {
    // Atomic — see updateHubSettings (#1144). Encoded by the column, never
    // JSON.stringify'd — see the comment in updateHubSettings for why.
    //
    // `usage` is wrapped in an object rather than bound on its own. Bun SQL
    // serializes a JS *object* into a jsonb parameter correctly, but expands a
    // JS *array* into a positional record list: `${usage}::jsonb` compiled to
    // `($1, $2)::jsonb`, which Postgres rejects with "cannot cast type record
    // to jsonb" for any usage with more than one entry — and silently stored a
    // single-entry usage as a bare object instead of a one-element array.
    // Merging `{ usage }` with `||` sets exactly the same key, with no array
    // ever reaching a parameter position.
    const [row] = await this.db
      .insert(hubSettingsTable)
      .values({ hubId, settings: { usage } })
      .onConflictDoUpdate({
        target: hubSettingsTable.hubId,
        set: {
          settings: sql`COALESCE(${hubSettingsTable.settings}, '{}'::jsonb) || ${hubSettingsTable.settings.mapToDriverValue({ usage })}::jsonb`,
        },
      })
      .returning({ settings: hubSettingsTable.settings })

    return (row.settings as Record<string, unknown>).usage as Record<string, unknown>[]
  }

  async incrementHubUsage(
    hubId: string,
    resource: string,
    amount = 1,
  ): Promise<Record<string, unknown>> {
    // No production caller today, but fixed proactively (#1144) since the
    // read-modify-write shape here is identical to updateHubSettings and
    // would silently clobber a concurrent admin edit the moment it gains
    // one. A simple top-level `||` merge isn't enough because the mutation
    // is nested (find-or-create the current month inside the `usage`
    // array, then increment one field on it) — so this takes a row lock
    // with SELECT ... FOR UPDATE inside a transaction and recomputes
    // against the value Postgres just handed it under that lock, the same
    // pattern used by registerDevice/sigchain elsewhere in this codebase.
    return await this.db.transaction(async (tx) => {
      // Ensure a row exists to lock — an UPDATE/SELECT FOR UPDATE against a
      // missing row takes no lock at all, which would let two concurrent
      // "first increment for this hub" calls both race past the check.
      await tx
        .insert(hubSettingsTable)
        .values({ hubId, settings: {} })
        .onConflictDoNothing()

      const [row] = await tx
        .select({ settings: hubSettingsTable.settings })
        .from(hubSettingsTable)
        .where(eq(hubSettingsTable.hubId, hubId))
        .for('update')

      const settings = (row?.settings as Record<string, unknown>) ?? {}
      const usage = [...((settings.usage as Record<string, unknown>[]) ?? [])]
      const now = new Date()
      const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`

      const idx = usage.findIndex((u) => u.month === month)
      let currentMonth: Record<string, unknown>
      if (idx === -1) {
        currentMonth = { month, year: now.getFullYear() }
        usage.push(currentMonth)
      } else {
        currentMonth = { ...usage[idx] }
        usage[idx] = currentMonth
      }

      currentMonth[resource] = ((currentMonth[resource] as number) ?? 0) + amount

      await tx
        .update(hubSettingsTable)
        .set({ settings: { ...settings, usage } })
        .where(eq(hubSettingsTable.hubId, hubId))

      return currentMonth
    })
  }

  async getCaseManagementEnabled(hubId?: string): Promise<{ enabled: boolean }> {
    // Hub-scoped: check hub_settings first; fall back to global system_settings
    if (hubId) {
      const hubSettingsRow = await this.getHubSettings(hubId)
      if (typeof hubSettingsRow.caseManagementEnabled === 'boolean') {
        return { enabled: hubSettingsRow.caseManagementEnabled }
      }
    }
    const row = await getSettings(this.db)
    return { enabled: row.caseManagementEnabled ?? false }
  }

  async setCaseManagementEnabled(data: {
    enabled: boolean
  }, hubId?: string): Promise<{ enabled: boolean }> {
    const enabled = !!data.enabled
    if (hubId) {
      // Hub-scoped: store in hub_settings so parallel tests don't interfere
      await this.updateHubSettings(hubId, { caseManagementEnabled: enabled })
    } else {
      // Global fallback (non-hub-scoped path)
      await this.db
        .update(systemSettings)
        .set({ caseManagementEnabled: enabled })
        .where(eq(systemSettings.id, SINGLETON_ID))
    }
    return { enabled }
  }
}
