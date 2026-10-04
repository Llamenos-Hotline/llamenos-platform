/**
 * Service registry — creates all service instances from a database connection.
 *
 * Services replace Durable Objects. Each service owns a domain's tables
 * and provides typed methods for CRUD and business logic.
 */
import type { Database } from '../db'

import { IdentityService } from './identity'
import { SettingsService } from './settings'
import { RecordsService } from './records'
import { AuditService } from './audit'
import { ShiftsService } from './shifts'
import { CallsService } from './calls'
import { ConversationsService } from './conversations'
import { BlastsService } from './blasts'
import { ContactsService } from './contacts'
import { CasesService } from './cases'
import { TaskScheduler } from './scheduler'
import { CryptoKeysService } from './crypto-keys'
import { FirehoseService } from './firehose'
import { FirehoseAgentService } from './firehose-agent'
import { SignalContactsService } from './signal-contacts'
import { SecurityPrefsService } from './security-prefs'
import { UserNotificationsService } from './user-notifications'
import { DigestCronService } from './digest-cron'
import { ProviderSetup, registerAllProviders } from './provider-setup'
import { SignalRegistrationService } from './provider-setup/signal-registration'
import { A2pRegistrationService } from './provider-setup/a2p-registration'
import { ProviderTemplateService } from './provider-setup/templates'
import { HubOnboardService } from './provider-setup/hub-onboard'
import { ErasureService } from './erasure'
import { RetentionService } from './retention'
import { RingGroupsService } from './ring-groups'
import { ShiftOverridesService } from './shift-overrides'
import { ActiveShiftsService } from './active-shifts'
import { ShiftAvailabilityService } from './shift-availability'
import { ShiftRequestsService } from './shift-requests'
import { RecoveryGroupService } from './recovery-group'
import { TeamsService } from './teams'
import { TagsService } from './tags'
import { IvrSpeechService } from './ivr-speech'

export interface Services {
  identity: IdentityService
  settings: SettingsService
  records: RecordsService
  audit: AuditService
  shifts: ShiftsService
  calls: CallsService
  conversations: ConversationsService
  blasts: BlastsService
  contacts: ContactsService
  cases: CasesService
  scheduler: TaskScheduler
  /** Phase 6: sigchain, PUK envelope, and MLS message operations */
  cryptoKeys: CryptoKeysService
  firehose: FirehoseService
  firehoseAgent?: FirehoseAgentService
  signalContacts: SignalContactsService
  securityPrefs: SecurityPrefsService
  userNotifications: UserNotificationsService
  digestCron: DigestCronService
  providerSetup: ProviderSetup
  signalRegistration: SignalRegistrationService
  a2pRegistration: A2pRegistrationService
  providerTemplates: ProviderTemplateService
  hubOnboard: HubOnboardService
  erasure: ErasureService
  retention: RetentionService
  ringGroups: RingGroupsService
  shiftOverrides: ShiftOverridesService
  activeShifts: ActiveShiftsService
  shiftAvailability: ShiftAvailabilityService
  shiftRequests: ShiftRequestsService
  recoveryGroup: RecoveryGroupService
  teams: TeamsService
  tags: TagsService
  ivrSpeech: IvrSpeechService
}

export interface ServicesOpts {
  hmacSecret?: string
  firehoseSealKey?: string
  env?: Record<string, string | undefined>
  notifierUrl?: string
  notifierApiKey?: string
  /** Secret shared with the sidecar for signing client registration tokens. Falls back to hmacSecret. */
  notifierTokenSecret?: string
}

export function createServices(db: Database, opts?: ServicesOpts): Services {
  // Register provider implementations once during service initialization (not at module import)
  registerAllProviders()

  const audit = new AuditService(db)
  const settings = new SettingsService(db)
  const conversations = new ConversationsService(db, opts?.hmacSecret)
  const firehose = new FirehoseService(db)
  const signalContacts = new SignalContactsService(db, opts?.hmacSecret ?? '')
  const securityPrefs = new SecurityPrefsService(db)
  const userNotifications = new UserNotificationsService(signalContacts, securityPrefs, audit, {
    notifierUrl: opts?.notifierUrl ?? '',
    notifierApiKey: opts?.notifierApiKey ?? '',
    tokenSecret: opts?.notifierTokenSecret ?? opts?.hmacSecret ?? '',
  })
  const digestCron = new DigestCronService(db, userNotifications, securityPrefs)
  const providerSetup = new ProviderSetup(db, opts?.hmacSecret ?? '', opts?.env?.DOMAIN ?? 'localhost')

  const identity = new IdentityService(db, opts?.env?.ADMIN_PUBKEY)

  const services: Services = {
    identity,
    settings,
    records: new RecordsService(db, audit),
    audit,
    shifts: new ShiftsService(db),
    calls: new CallsService(db),
    conversations,
    blasts: new BlastsService(db, opts?.hmacSecret),
    contacts: new ContactsService(db),
    cases: new CasesService(db),
    scheduler: new TaskScheduler(db),
    cryptoKeys: new CryptoKeysService(db),
    firehose,
    signalContacts,
    securityPrefs,
    userNotifications,
    digestCron,
    providerSetup,
    signalRegistration: new SignalRegistrationService(db, opts?.hmacSecret ?? '', { ENVIRONMENT: opts?.env?.ENVIRONMENT }),
    a2pRegistration: new A2pRegistrationService(db, opts?.hmacSecret ?? ''),
    providerTemplates: new ProviderTemplateService(db),
    hubOnboard: new HubOnboardService(db, providerSetup, settings),
    erasure: new ErasureService(db, identity),
    retention: new RetentionService(db),
    ringGroups: new RingGroupsService(db),
    shiftOverrides: new ShiftOverridesService(db),
    activeShifts: new ActiveShiftsService(db),
    shiftAvailability: new ShiftAvailabilityService(db),
    shiftRequests: new ShiftRequestsService(db),
    recoveryGroup: new RecoveryGroupService(db, audit),
    ivrSpeech: new IvrSpeechService(opts?.hmacSecret ?? ''),
    teams: new TeamsService(db),
    tags: new TagsService(db),
  }

  // Only create firehose agent if seal key is configured
  if (opts?.firehoseSealKey) {
    services.firehoseAgent = new FirehoseAgentService(
      db,
      firehose,
      conversations,
      audit,
      settings,
      opts.firehoseSealKey,
      opts.env ?? {},
    )
  }

  return services
}

// Re-export service classes for direct import
export {
  ErasureService,
  RetentionService,
  TeamsService,
  TagsService,
  IdentityService,
  SettingsService,
  RecordsService,
  AuditService,
  ShiftsService,
  CallsService,
  ConversationsService,
  BlastsService,
  ContactsService,
  CasesService,
  TaskScheduler,
  CryptoKeysService,
  FirehoseService,
  FirehoseAgentService,
  SignalContactsService,
  SecurityPrefsService,
  UserNotificationsService,
  DigestCronService,
  ProviderSetup,
  SignalRegistrationService,
  A2pRegistrationService,
  ProviderTemplateService,
  HubOnboardService,
  RingGroupsService,
  ShiftOverridesService,
  ActiveShiftsService,
  ShiftAvailabilityService,
  ShiftRequestsService,
  RecoveryGroupService,
}
