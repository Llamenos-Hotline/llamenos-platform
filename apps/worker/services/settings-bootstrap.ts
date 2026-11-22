import { eq } from 'drizzle-orm'
import type { Database } from '../db'
import {
  systemSettings,
  hubs as hubsTable,
  hubSettings as hubSettingsTable,
  hubKeys,
  roles as rolesTable,
  customFieldDefinitions,
  entityTypeDefinitions,
  relationshipTypeDefinitions,
  reportTypeDefinitions,
  ivrAudio,
  rateLimits,
  captchas,
  caseNumberSequences,
} from '../db/schema'
import type { SpamSettings, CallSettings } from '../types'
import type { MessagingConfig, SetupState } from '@shared/types'
import { DEFAULT_MESSAGING_CONFIG } from '@shared/types'
import { IVR_LANGUAGES } from '@shared/languages'
import { DEFAULT_ROLES } from '@shared/permissions'
import { destructiveResetRefusal, type DevSurfacesEnv } from '../lib/dev-surfaces'
import { DEFAULT_CALL_SETTINGS } from './call-settings'
import { invalidateRolesCache } from './roles'
import { ServiceError } from './service-error'
import { DEFAULT_SPAM_SETTINGS } from './spam-settings'
import { SINGLETON_ID, getSettings } from './system-settings-row'

/**
 * What an `ensureInit` call seeds: the defaults every deployment needs, plus —
 * on a development server — a completed setup state and enabled messaging.
 */
type InitMode = 'default' | 'development'

/**
 * Seeds the defaults every deployment needs (spam, call and IVR settings, the default roles,
 * and — on a development server — a completed setup state) and wipes/re-seeds them for the
 * secret-gated test reset. Reads and writes the `system_settings` singleton and the `roles` table.
 */
export class SettingsBootstrapService {

  /**
   * Modes already initialised by this process (cleared by `reset`). Tracked per
   * mode, not as one flag: the server initialises defaults at boot, and a later
   * development-mode call must still apply its mode-specific seeding rather
   * than being swallowed as a repeat.
   */
  private initializedModes = new Set<InitMode>()

  constructor(protected db: Database) {}

  /**
   * Seed defaults into empty settings fields and an empty roles table. Only
   * ever fills what is empty, so it is safe on every server boot: values an
   * operator has set, and roles that exist, are never overwritten.
   */
  async ensureInit(env?: { ENVIRONMENT?: string }): Promise<void> {
    const mode: InitMode = env?.ENVIRONMENT === 'development' ? 'development' : 'default'
    if (this.initializedModes.has(mode)) return
    this.initializedModes.add(mode)

    const row = await getSettings(this.db)
    const spamSettings = row.spamSettings as SpamSettings | null

    // Seed spam settings if empty
    if (!spamSettings || Object.keys(spamSettings).length === 0) {
      await this.db
        .update(systemSettings)
        .set({
          spamSettings: { ...DEFAULT_SPAM_SETTINGS },
        })
        .where(eq(systemSettings.id, SINGLETON_ID))
    }

    // Seed call settings
    const callSettings = row.callSettings as CallSettings | null
    if (!callSettings || Object.keys(callSettings).length === 0) {
      await this.db
        .update(systemSettings)
        .set({
          callSettings: { ...DEFAULT_CALL_SETTINGS },
        })
        .where(eq(systemSettings.id, SINGLETON_ID))
    }

    // Seed IVR languages
    if (!row.ivrLanguages || row.ivrLanguages.length === 0) {
      await this.db
        .update(systemSettings)
        .set({ ivrLanguages: [...IVR_LANGUAGES] })
        .where(eq(systemSettings.id, SINGLETON_ID))
    }

    // Seed default roles if none exist. ON CONFLICT DO NOTHING: replicas booting
    // together against a fresh database can both see an empty table.
    const existingRoles = await this.db.select().from(rolesTable)
    if (existingRoles.length === 0) {
      const now = new Date()
      for (const r of DEFAULT_ROLES) {
        await this.db.insert(rolesTable).values({
          id: r.id,
          name: r.name,
          slug: r.slug,
          permissions: r.permissions,
          isDefault: r.isDefault,
          isSystem: r.isSystem,
          description: r.description,
          createdAt: now,
          updatedAt: now,
        }).onConflictDoNothing()
      }
    }

    // Development mode: mark setup complete, enable messaging
    if (mode !== 'default') {
      const setupState = row.setupState as SetupState | null
      if (!setupState || !setupState.setupCompleted) {
        await this.db
          .update(systemSettings)
          .set({
            setupState: {
              setupCompleted: true,
              completedSteps: ['welcome', 'telephony', 'channels'],
              pendingChannels: [],
              selectedChannels: ['voice', 'sms', 'signal', 'reports'],
            },
          })
          .where(eq(systemSettings.id, SINGLETON_ID))
      }
      const msgConfig = row.messagingConfig as MessagingConfig | null
      if (!msgConfig || Object.keys(msgConfig).length === 0) {
        await this.db
          .update(systemSettings)
          .set({
            messagingConfig: {
              ...DEFAULT_MESSAGING_CONFIG,
              enabledChannels: ['sms', 'signal'],
            },
          })
          .where(eq(systemSettings.id, SINGLETON_ID))
      }
    }
  }

  /**
   * Wipe every settings table and re-seed the defaults.
   *
   * Gated by `destructiveResetRefusal` (lib/dev-surfaces.ts) — see
   * `IdentityService.reset` for why that predicate and not the demo flags this
   * used to read.
   */
  async reset(env: DevSurfacesEnv, presentedSecret?: string): Promise<{ ok: true }> {
    const refusal = destructiveResetRefusal(env, presentedSecret)
    if (refusal) throw new ServiceError(403, refusal)

    await this.db.transaction(async (tx) => {
      // Clear all settings tables
      await tx.delete(customFieldDefinitions)
      await tx.delete(entityTypeDefinitions)
      await tx.delete(relationshipTypeDefinitions)
      await tx.delete(reportTypeDefinitions)
      await tx.delete(ivrAudio)
      await tx.delete(rateLimits)
      await tx.delete(captchas)
      await tx.delete(caseNumberSequences)
      await tx.delete(hubKeys)
      await tx.delete(hubSettingsTable)
      await tx.delete(hubsTable)
      await tx.delete(rolesTable)
      await tx.delete(systemSettings)
    })

    // Invalidate roles cache so concurrent requests don't see stale empty roles
    // between the delete above and the ensureInit re-seed below.
    invalidateRolesCache()

    this.initializedModes.clear()
    await this.ensureInit(env)

    // Invalidate again after re-seeding: a concurrent request may have cached
    // the empty roles table between the delete and ensureInit.
    invalidateRolesCache()

    return { ok: true }
  }
}
