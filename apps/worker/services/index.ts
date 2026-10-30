/**
 * Service registry — creates all service instances from a database connection.
 *
 * Services replace Durable Objects. Each service owns a domain's tables
 * and provides typed methods for CRUD and business logic.
 */
import { hexToBytes } from '@shared/encoding'
import type { Database } from '../db'
import type { BlobStorage } from '../types'
import { IdentityService } from './identity'
import { SettingsService } from './settings'
import { RecordsService } from './records'
import { AuditService } from './audit'
import { ShiftsService } from './shifts'
import { CallsService } from './calls'
import { ConversationsService } from './conversations'
import { BlastsService } from './blasts'
import { MessagingSuppressionService } from './messaging-suppression'
import { ContactsService } from './contacts'
import { CasesService } from './cases'
import { TaskScheduler, type TaskSchedulerServiceDeps } from './scheduler'
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
import { HubShredService } from './hub-shred'
import { ProviderRecordingsService } from './provider-recordings'
import { CallRecordingsService } from './call-recordings'
import { RingGroupsService } from './ring-groups'
import { ShiftOverridesService } from './shift-overrides'
import { ActiveShiftsService } from './active-shifts'
import { ShiftAvailabilityService } from './shift-availability'
import { ShiftRequestsService } from './shift-requests'
import { RecoveryGroupService } from './recovery-group'
import { TeamsService } from './teams'
import { TagsService } from './tags'
import { IvrSpeechService } from './ivr-speech'
import { IncidentService } from './incidents'
import { parseSignalQueueRetentionDays } from '../messaging/signal/queue'
import { webhookOrigin } from '../lib/provider-webhook-urls'

export interface Services {
  identity: IdentityService
  settings: SettingsService
  records: RecordsService
  audit: AuditService
  shifts: ShiftsService
  calls: CallsService
  conversations: ConversationsService
  blasts: BlastsService
  /** Messaging opt-outs: every outbound adapter and the subscriber importer consult it. */
  messagingSuppression: MessagingSuppressionService
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
  /** The hub crypto-shred executor (spec §4). Takes the blob-storage binding at construction. */
  hubShred: HubShredService
  /** Caller audio the telephony provider still holds, until the provider confirms deleting it (#2297). */
  providerRecordings: ProviderRecordingsService
  /** The server's own sealed copies of opted-in call recordings (#2309). */
  callRecordings: CallRecordingsService
  ringGroups: RingGroupsService
  shiftOverrides: ShiftOverridesService
  activeShifts: ActiveShiftsService
  shiftAvailability: ShiftAvailabilityService
  shiftRequests: ShiftRequestsService
  recoveryGroup: RecoveryGroupService
  teams: TeamsService
  tags: TagsService
  ivrSpeech: IvrSpeechService
  /** Live, aggregate-only hub incidents every automatic defence reports through (#2341). */
  incidents: IncidentService
}

export interface ServicesOpts {
  /** Hashing key only (HMAC_SECRET): never encrypts anything. */
  hmacSecret?: string
  /** Key-encryption key (SERVER_KEK) for server-readable data: provider credentials, reply addresses, queued sends. */
  serverKek?: string
  firehoseSealKey?: string
  /** Messaging contact hash key (file-only MESSAGING_HASH_KEY): what a subscriber import hashes under, so STOP matches it. */
  messagingHashKey?: string
  env?: Record<string, string | undefined>
  notifierUrl?: string
  notifierApiKey?: string
  /** Secret shared with the sidecar for signing client registration tokens. Has no fallback to another secret. */
  notifierTokenSecret?: string
  /**
   * Object-storage binding (Env.BLOB_STORAGE) — required for the hub shred to
   * destroy file envelope mirrors, and to hold the server's sealed copy of a
   * call recording (#2309). Wired by the server entrypoint.
   */
  blobStorage?: Pick<BlobStorage, 'put' | 'get' | 'delete'>
}

export function createServices(db: Database, opts?: ServicesOpts): Services {
  // Register provider implementations once during service initialization (not at module import)
  registerAllProviders()

  const settings = new SettingsService(db)
  const identity = new IdentityService(db, opts?.env?.ADMIN_PUBKEY)
  const hubShred = new HubShredService(db, opts?.blobStorage)
  const callRecordings = new CallRecordingsService(db, opts?.blobStorage, opts?.serverKek)
  const erasure = new ErasureService(db, {
    deleteEnvelopeMirrors: (fileIds) => hubShred.deleteBlobEnvelopeMirrors(fileIds),
  })

  // The X25519 recipients for hub-less server-sealed envelope sets (call records,
  // audit keys): ADMIN_DECRYPTION_PUBKEY. Super-admins are never readers (D1,
  // #2190), and a record with no hub has no hub admins.
  const resolveAdminRecipients = (): Promise<string[]> =>
    identity.listAdminEnvelopeRecipients(opts?.env?.ADMIN_DECRYPTION_PUBKEY)

  // The per-user audit key path (issue #1684 item 3) requires SERVER_SECRET to
  // store the key server-decryptably. validateConfig refuses to boot without
  // it; a hand-rolled caller that omits it gets the plaintext-details behavior
  // the audit log had before EP08.
  const serverSecretHex = opts?.env?.SERVER_SECRET?.trim()
  const audit = new AuditService(db, serverSecretHex
    ? {
        serverSecret: hexToBytes(serverSecretHex),
        resolveAdminRecipients,
        keyStore: erasure,
      }
    : undefined)

  const conversations = new ConversationsService(db, opts?.serverKek)
  const firehose = new FirehoseService(db)
  const signalContacts = new SignalContactsService(db, opts?.hmacSecret ?? '')
  const securityPrefs = new SecurityPrefsService(db)
  const userNotifications = new UserNotificationsService(signalContacts, securityPrefs, audit, {
    notifierUrl: opts?.notifierUrl ?? '',
    notifierApiKey: opts?.notifierApiKey ?? '',
    tokenSecret: opts?.notifierTokenSecret ?? '',
  })
  const digestCron = new DigestCronService(db, userNotifications, securityPrefs)
  const messagingSuppression = new MessagingSuppressionService(db, opts?.messagingHashKey)
  const providerSetup = new ProviderSetup(db, opts?.serverKek ?? '', webhookOrigin(opts?.env ?? {}))

  const services: Services = {
    identity,
    settings,
    records: new RecordsService(db, audit),
    audit,
    shifts: new ShiftsService(db),
    calls: new CallsService(db, { getAdminRecipients: resolveAdminRecipients, serverKek: opts?.serverKek }),
    conversations,
    blasts: new BlastsService(db, opts?.hmacSecret, opts?.serverKek, opts?.messagingHashKey, messagingSuppression),
    messagingSuppression,
    contacts: new ContactsService(db),
    cases: new CasesService(db),
    scheduler: new TaskScheduler(
      db,
      opts?.hmacSecret ?? '',
      opts?.serverKek ?? '',
      parseSignalQueueRetentionDays(opts?.env?.SIGNAL_QUEUE_RETENTION_DAYS),
    ),
    cryptoKeys: new CryptoKeysService(db),
    firehose,
    signalContacts,
    securityPrefs,
    userNotifications,
    digestCron,
    providerSetup,
    // The dev-surface subset, not just ENVIRONMENT: `verifyCode` and friends
    // decide whether a request may take the synthetic bridge path with
    // `devSurfaceRequestAuthorized`, which needs the opt-in flag and the
    // configured secret as well (#1623). Listed explicitly rather than spread,
    // so what the service can read stays visible here.
    signalRegistration: new SignalRegistrationService(db, opts?.serverKek ?? '', {
      ENVIRONMENT: opts?.env?.ENVIRONMENT,
      DEV_ROUTES_ENABLED: opts?.env?.DEV_ROUTES_ENABLED,
      DEV_RESET_SECRET: opts?.env?.DEV_RESET_SECRET,
      E2E_TEST_SECRET: opts?.env?.E2E_TEST_SECRET,
    }),
    a2pRegistration: new A2pRegistrationService(db, opts?.serverKek ?? ''),
    providerTemplates: new ProviderTemplateService(db),
    hubOnboard: new HubOnboardService(db, providerSetup, settings),
    erasure,
    retention: new RetentionService(db),
    hubShred,
    providerRecordings: new ProviderRecordingsService(db, audit, callRecordings),
    callRecordings,
    ringGroups: new RingGroupsService(db),
    shiftOverrides: new ShiftOverridesService(db),
    activeShifts: new ActiveShiftsService(db),
    shiftAvailability: new ShiftAvailabilityService(db),
    shiftRequests: new ShiftRequestsService(db),
    recoveryGroup: new RecoveryGroupService(db, settings, audit),
    ivrSpeech: new IvrSpeechService(opts?.hmacSecret ?? ''),
    teams: new TeamsService(db),
    tags: new TagsService(db),
    incidents: new IncidentService(db, audit),
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

/**
 * The scheduler's service dependencies, derived from the registry production
 * builds. This is the ONE place the background workers are given their
 * services, so a test can hand `TaskScheduler.start()` exactly what
 * `src/server/index.ts` hands it (see
 * apps/worker/__tests__/integration/hub-shred-wiring.test.ts) instead of a
 * hand-assembled object that can agree with nothing.
 *
 * The return type is required in every field, so dropping a service here is a
 * compile error rather than a worker that silently stops running (#1566).
 */
export function schedulerServiceDeps(services: Services): TaskSchedulerServiceDeps {
  return {
    blastsService: services.blasts,
    settingsService: services.settings,
    retentionService: services.retention,
    auditService: services.audit,
    erasureService: services.erasure,
    identityService: services.identity,
    hubShred: services.hubShred,
    callsService: services.calls,
    incidents: services.incidents,
  }
}

// Re-export service classes for direct import
export {
  ErasureService,
  RetentionService,
  TeamsService,
  TagsService,
  IncidentService,
  IdentityService,
  SettingsService,
  RecordsService,
  AuditService,
  ShiftsService,
  CallsService,
  ConversationsService,
  BlastsService,
  MessagingSuppressionService,
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
  HubShredService,
}
