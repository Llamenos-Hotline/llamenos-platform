/**
 * The settings-domain services, built together from one `db` handle.
 *
 * `createServices` (services/index.ts) and the tests that need only this slice
 * of the registry both go through `createSettingsDomain`, so the wiring between
 * these services — which ones take the hub-settings or provider-config service
 * as a collaborator — lives in exactly one place.
 */
import type { Database } from '../db'
import { SettingsBootstrapService } from './settings-bootstrap'
import { HubSettingsService } from './hub-settings'
import { HubService } from './hubs'
import { HubKeyService } from './hub-keys'
import { HubStorageService } from './hub-storage'
import { RolesService } from './roles'
import { SpamSettingsService } from './spam-settings'
import { RateLimitService } from './rate-limits'
import { CaptchaService } from './captcha'
import { TtlCleanupService } from './ttl-cleanup'
import { CallSettingsService } from './call-settings'
import { IvrSettingsService } from './ivr-settings'
import { ProviderConfigService } from './provider-config'
import { MessagingConfigService } from './messaging-config'
import { SetupStateService } from './setup-state'
import { CustomFieldsService } from './custom-fields'
import { ReportTypesService } from './report-types'
import { EntitySchemaService } from './entity-schema'
import { TemplateStateService } from './template-state'
import { PlatformSettingsService } from './platform-settings'

export interface SettingsDomainServices {
  settingsBootstrap: SettingsBootstrapService
  hubSettings: HubSettingsService
  hubs: HubService
  hubKeys: HubKeyService
  hubStorage: HubStorageService
  roles: RolesService
  spamSettings: SpamSettingsService
  rateLimits: RateLimitService
  captcha: CaptchaService
  ttlCleanup: TtlCleanupService
  callSettings: CallSettingsService
  ivrSettings: IvrSettingsService
  providerConfig: ProviderConfigService
  messagingConfig: MessagingConfigService
  setupState: SetupStateService
  customFields: CustomFieldsService
  reportTypes: ReportTypesService
  entitySchema: EntitySchemaService
  templateState: TemplateStateService
  platformSettings: PlatformSettingsService
}

export function createSettingsDomain(db: Database, serverKek?: string): SettingsDomainServices {
  const hubSettings = new HubSettingsService(db)
  const providerConfig = new ProviderConfigService(db)
  return {
    settingsBootstrap: new SettingsBootstrapService(db),
    hubSettings,
    hubs: new HubService(db),
    hubKeys: new HubKeyService(db),
    hubStorage: new HubStorageService(db),
    roles: new RolesService(db),
    spamSettings: new SpamSettingsService(db, hubSettings),
    rateLimits: new RateLimitService(db),
    captcha: new CaptchaService(db),
    ttlCleanup: new TtlCleanupService(db),
    callSettings: new CallSettingsService(db, hubSettings),
    ivrSettings: new IvrSettingsService(db, hubSettings, providerConfig),
    providerConfig,
    messagingConfig: new MessagingConfigService(db, hubSettings, serverKek),
    setupState: new SetupStateService(db),
    customFields: new CustomFieldsService(db),
    reportTypes: new ReportTypesService(db),
    entitySchema: new EntitySchemaService(db),
    templateState: new TemplateStateService(db),
    platformSettings: new PlatformSettingsService(db),
  }
}
