/**
 * Distribute a flat bag of mock methods across the settings-domain services
 * that own them, for tests that build a hand-rolled service registry.
 *
 * The owner of each method is read off the real service classes, so a mock
 * method that no service defines is an error here rather than a silent no-op
 * the route never calls.
 */
import { SettingsBootstrapService } from '../../services/settings-bootstrap'
import { HubSettingsService } from '../../services/hub-settings'
import { HubService } from '../../services/hubs'
import { HubKeyService } from '../../services/hub-keys'
import { HubStorageService } from '../../services/hub-storage'
import { RolesService } from '../../services/roles'
import { SpamSettingsService } from '../../services/spam-settings'
import { RateLimitService } from '../../services/rate-limits'
import { CaptchaService } from '../../services/captcha'
import { TtlCleanupService } from '../../services/ttl-cleanup'
import { CallSettingsService } from '../../services/call-settings'
import { IvrSettingsService } from '../../services/ivr-settings'
import { ProviderConfigService } from '../../services/provider-config'
import { MessagingConfigService } from '../../services/messaging-config'
import { SetupStateService } from '../../services/setup-state'
import { CustomFieldsService } from '../../services/custom-fields'
import { ReportTypesService } from '../../services/report-types'
import { EntitySchemaService } from '../../services/entity-schema'
import { TemplateStateService } from '../../services/template-state'
import { PlatformSettingsService } from '../../services/platform-settings'
import type { SettingsDomainServices } from '../../services/settings-domain'

const OWNERS: { [K in keyof SettingsDomainServices]: { prototype: object } } = {
  settingsBootstrap: SettingsBootstrapService,
  hubSettings: HubSettingsService,
  hubs: HubService,
  hubKeys: HubKeyService,
  hubStorage: HubStorageService,
  roles: RolesService,
  spamSettings: SpamSettingsService,
  rateLimits: RateLimitService,
  captcha: CaptchaService,
  ttlCleanup: TtlCleanupService,
  callSettings: CallSettingsService,
  ivrSettings: IvrSettingsService,
  providerConfig: ProviderConfigService,
  messagingConfig: MessagingConfigService,
  setupState: SetupStateService,
  customFields: CustomFieldsService,
  reportTypes: ReportTypesService,
  entitySchema: EntitySchemaService,
  templateState: TemplateStateService,
  platformSettings: PlatformSettingsService,
}

/** `{ getHubs, getRoles }` → `{ hubs: { getHubs }, roles: { getRoles } }`, keeping each mock function's identity. */
export function settingsDomainMock(flat: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const [method, fn] of Object.entries(flat)) {
    const owner = Object.entries(OWNERS).find(([, cls]) => Object.getOwnPropertyNames(cls.prototype).includes(method))
    if (!owner) throw new Error(`no settings-domain service defines ${method}`)
    ;(out[owner[0]] ??= {})[method] = fn
  }
  return out
}
