import type { ComponentType } from 'react'
import { registerSection } from './registry'

import { LocationLookupSection } from './location-lookup-section'
import { PasskeyPolicySection } from './passkey-policy-section'
import { RecoveryGroupSection } from './recovery-group-section'
import { RecoveryRequestsAdminSection } from './recovery-requests-section'
import { DevicesSection } from './devices-section'
import { HubRolesSection } from './hub-roles-section'
import { TeamsSection } from './teams-section'
import { TagsSection } from './tags-section'
import { CustomFieldsSection } from './custom-fields-section'
import { ReportTypesSection } from './report-types-section'
import { FirehoseSection } from './firehose-section'
import { CallSettingsSection } from './call-settings-section'
import { VoicePromptsSection } from './voice-prompts-section'
import { IvrLanguagesSection } from './ivr-languages-section'
import { TranscriptionSection } from './transcription-section'
import { SpamSection } from './spam-section'
import { PhoneProviderSection } from './phone-provider-section'
import { MessagingSmsSection } from './messaging-sms-section'
import { RcsChannelSection } from './rcs-channel-section'
import { SignalChannelSection } from './signal-channel-section'
import { BansSection } from './bans-section'
import { AuditSection, PlatformAuditSection } from './audit-section'
import { AnalyticsSection } from './analytics-section'
import { HealthSection } from './health-section'
import { HubsSection } from './hubs-section'
import { PlatformRolesSection } from './platform-roles-section'
import { PlatformSection } from './platform-section'
import { RingGroupsSection } from './ring-groups-section'
import { ShiftOverridesSection } from './shift-overrides-section'
import { ErasureQueueSection } from './erasure-queue-section'
import { ErasureConfigSection } from './erasure-config-section'
import { RetentionSection } from './retention-section'
import { PlatformBansSection } from './platform-bans-section'

const sections: Record<string, ComponentType> = {
  'location-lookup': LocationLookupSection,
  'passkey-policy': PasskeyPolicySection,
  'recovery-group': RecoveryGroupSection,
  'recovery-requests': RecoveryRequestsAdminSection,
  'devices': DevicesSection,
  'hub-roles': HubRolesSection,
  'teams': TeamsSection,
  'tags': TagsSection,
  'custom-fields': CustomFieldsSection,
  'report-types': ReportTypesSection,
  'firehose': FirehoseSection,
  'call-settings': CallSettingsSection,
  'voice-prompts': VoicePromptsSection,
  'phone-menu-languages': IvrLanguagesSection,
  'transcription': TranscriptionSection,
  'spam-protection': SpamSection,
  'phone-provider': PhoneProviderSection,
  'messaging-sms': MessagingSmsSection,
  'rcs': RcsChannelSection,
  'signal': SignalChannelSection,
  'bans': BansSection,
  'audit': AuditSection,
  'analytics': AnalyticsSection,
  'health': HealthSection,
  'hubs': HubsSection,
  'platform-roles': PlatformRolesSection,
  'platform-settings': PlatformSection,
  'ring-groups': RingGroupsSection,
  'shift-overrides': ShiftOverridesSection,
  'erasure-queue': ErasureQueueSection,
  'erasure-config': ErasureConfigSection,
  'retention': RetentionSection,
  'platform-bans': PlatformBansSection,
  'platform-audit': PlatformAuditSection,
}

for (const [slug, component] of Object.entries(sections)) {
  registerSection(slug, component)
}
