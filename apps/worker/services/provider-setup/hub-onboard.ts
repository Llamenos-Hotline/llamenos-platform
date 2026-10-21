import { eq, and } from 'drizzle-orm'
import type { Database } from '../../db'
import {
  hubOnboardingState,
  providerConfigs,
  providerTemplates,
} from '../../db/schema'
import { SettingsService } from '../settings'
import { ProviderSetup } from './index'
import { ProviderApiError } from './types'
import { hubQuotaSchema } from '@protocol/schemas/provider-setup'
import type {
  ChannelConfig,
  HubOnboardingState,
  HubSetupStatus,
  HubUsage,
} from '@protocol/schemas/provider-setup'

const ONBOARDING_STEPS = [
  'template_selection',
  'channel_selection',
  'provider_connection',
  'phone_number',
  'channel_setup',
  'completion',
] as const

type OnboardingStep = (typeof ONBOARDING_STEPS)[number]

function isValidStep(step: string): step is OnboardingStep {
  return ONBOARDING_STEPS.includes(step as OnboardingStep)
}

function getNextStep(current: OnboardingStep): OnboardingStep | null {
  const idx = ONBOARDING_STEPS.indexOf(current)
  if (idx === -1 || idx >= ONBOARDING_STEPS.length - 1) return null
  return ONBOARDING_STEPS[idx + 1]
}

export class HubOnboardService {
  constructor(
    private readonly db: Database,
    private readonly providerSetup: ProviderSetup,
    private readonly settings: SettingsService,
  ) {}

  async startOnboarding(
    hubId: string,
    templateId?: string,
  ): Promise<HubOnboardingState> {
    const now = new Date()

    const channelConfig: ChannelConfig = {
      voice: false,
      sms: false,
      email: false,
      signal: false,
      whatsapp: false,
      telegram: false,
      rcs: false,
    }

    if (templateId) {
      const [template] = await this.db
        .select()
        .from(providerTemplates)
        .where(eq(providerTemplates.id, templateId))
        .limit(1)

      if (template) {
        for (const ch of template.defaultChannels as string[]) {
          if (ch in channelConfig) {
            channelConfig[ch as keyof ChannelConfig] = true
          }
        }
      }
    }

    await this.db
      .insert(hubOnboardingState)
      .values({
        hubId,
        templateId: templateId ?? null,
        currentStep: 'template_selection',
        completedSteps: [],
        channelConfig,
        isComplete: false,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: hubOnboardingState.hubId,
        set: {
          templateId: templateId ?? null,
          currentStep: 'template_selection',
          completedSteps: [],
          channelConfig,
          isComplete: false,
          updatedAt: now,
        },
      })

    return {
      hubId,
      templateId,
      currentStep: 'template_selection',
      completedSteps: [],
      channelConfig,
      isComplete: false,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    }
  }

  async getOnboardingStatus(hubId: string): Promise<HubOnboardingState | null> {
    const [row] = await this.db
      .select()
      .from(hubOnboardingState)
      .where(eq(hubOnboardingState.hubId, hubId))
      .limit(1)

    if (!row) return null

    return {
      hubId: row.hubId,
      templateId: row.templateId ?? undefined,
      currentStep: row.currentStep,
      completedSteps: (row.completedSteps as string[]) ?? [],
      channelConfig: (row.channelConfig as ChannelConfig) ?? {},
      isComplete: row.isComplete,
      createdAt: row.createdAt?.toISOString(),
      updatedAt: row.updatedAt?.toISOString(),
    }
  }

  async completeStep(
    hubId: string,
    step: string,
    data?: Record<string, unknown>,
  ): Promise<HubOnboardingState> {
    if (!isValidStep(step)) {
      throw new ProviderApiError(`Invalid step: ${step}`, 400, 'Invalid step')
    }

    const [row] = await this.db
      .select()
      .from(hubOnboardingState)
      .where(eq(hubOnboardingState.hubId, hubId))
      .limit(1)

    if (!row) {
      throw new ProviderApiError('Onboarding not started', 404, 'Not found')
    }

    const completed = new Set<string>(row.completedSteps as string[])
    const currentIdx = ONBOARDING_STEPS.indexOf(row.currentStep as OnboardingStep)
    const stepIdx = ONBOARDING_STEPS.indexOf(step as OnboardingStep)

    // Must complete the current step — no skipping forward and no going back
    if (stepIdx !== currentIdx) {
      throw new ProviderApiError(
        stepIdx < currentIdx
          ? 'Cannot complete a previous step'
          : 'Cannot skip steps — complete the current step first',
        400,
        'Invalid step progression',
      )
    }

    completed.add(step)
    const nextStep = getNextStep(step as OnboardingStep)

    const updates: Record<string, unknown> = {
      completedSteps: Array.from(completed),
      updatedAt: new Date(),
    }

    if (nextStep) {
      updates.currentStep = nextStep
      if (nextStep === 'completion') {
        updates.isComplete = true
      }
    } else {
      updates.currentStep = 'completion'
      updates.isComplete = true
    }

    if (data?.channelConfig) {
      updates.channelConfig = {
        ...(row.channelConfig as Record<string, unknown>),
        ...(data.channelConfig as Record<string, unknown>),
      }
    }

    await this.db
      .update(hubOnboardingState)
      .set(updates)
      .where(eq(hubOnboardingState.hubId, hubId))

    return this.getOnboardingStatus(hubId) as Promise<HubOnboardingState>
  }

  async getHubSetupStatus(hubId: string): Promise<HubSetupStatus> {
    const [config] = await this.db
      .select()
      .from(providerConfigs)
      .where(eq(providerConfigs.hubId, hubId))
      .limit(1)

    const onboarding = await this.getOnboardingStatus(hubId)
    const hubSettings = await this.settings.getHubProviderSettings(hubId)

    const channelsConfigured: string[] = []
    const channelsPending: string[] = []

    const channelConfig = (onboarding?.channelConfig ?? hubSettings.channels ?? {}) as ChannelConfig
    for (const [channel, enabled] of Object.entries(channelConfig)) {
      if (enabled) {
        channelsConfigured.push(channel)
      } else {
        channelsPending.push(channel)
      }
    }

    return {
      hubId,
      providerConnected: config?.status === 'connected',
      providerType: config?.providerType as HubSetupStatus['providerType'],
      numbersProvisioned: (config?.phoneNumbers as string[])?.length ?? 0,
      channelsConfigured: channelsConfigured as HubSetupStatus['channelsConfigured'],
      channelsPending: channelsPending as HubSetupStatus['channelsPending'],
      a2pStatus: hubSettings.subAccountEnabled ? 'configured' : undefined,
      // Parsed, not passed through: a hub that has never had quotas set stores
      // `{}`, and clients type every quota as a number. hubQuotaSchema fills the
      // defaults so the field is either complete or absent, never half-built.
      quotas: hubQuotaSchema.parse(hubSettings.quotas ?? {}),
      onboardingComplete: onboarding?.isComplete ?? false,
    }
  }

  async completeOnboarding(hubId: string): Promise<{ ok: true }> {
    await this.db
      .update(hubOnboardingState)
      .set({
        isComplete: true,
        currentStep: 'completion',
        updatedAt: new Date(),
      })
      .where(eq(hubOnboardingState.hubId, hubId))

    const hubSettings = await this.settings.getHubSettings(hubId)
    await this.settings.updateHubSettings(hubId, {
      ...hubSettings,
      providerSetupComplete: true,
    })

    return { ok: true }
  }

  async getHubUsage(hubId: string): Promise<HubUsage> {
    const hubSettings = await this.settings.getHubSettings(hubId)
    const usage = (hubSettings.usage as HubUsage[]) ?? []

    const now = new Date()
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    const current = usage.find((u) => u.month === month)

    return (
      current ?? {
        month,
        year: now.getFullYear(),
        phoneNumbers: 0,
        smsSent: 0,
        callsReceived: 0,
        signalMessagesSent: 0,
        whatsAppMessagesSent: 0,
      }
    )
  }

  async checkQuota(
    hubId: string,
    resource: string,
  ): Promise<{ allowed: boolean; limit: number; current: number }> {
    const hubSettings = await this.settings.getHubSettings(hubId)
    const quotas = (hubSettings.quotas as Record<string, number | null>) ?? {}
    const usage = (hubSettings.usage as HubUsage[]) ?? []

    const now = new Date()
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    const currentMonth = usage.find((u) => u.month === month)

    const limit = quotas[resource] ?? null
    const current = (currentMonth?.[resource as keyof HubUsage] as number) ?? 0

    // null/undefined = unlimited (no quota set), 0 = blocked (no allocation)
    if (limit === null || limit === undefined) {
      return { allowed: true, limit: 0, current }
    }
    return { allowed: limit > 0 && current < limit, limit, current }
  }

  async enableChannel(hubId: string, channel: string): Promise<ChannelConfig> {
    const hubSettings = await this.settings.getHubSettings(hubId)
    const defaultChannels: ChannelConfig = {
      voice: false, sms: false, email: false, signal: false,
      whatsapp: false, telegram: false, rcs: false,
    }
    const channels = { ...defaultChannels, ...(hubSettings.channels as ChannelConfig) }
    channels[channel as keyof ChannelConfig] = true
    await this.settings.updateHubSettings(hubId, { ...hubSettings, channels })
    return channels
  }

  async disableChannel(hubId: string, channel: string): Promise<ChannelConfig> {
    const hubSettings = await this.settings.getHubSettings(hubId)
    const defaultChannels: ChannelConfig = {
      voice: false, sms: false, email: false, signal: false,
      whatsapp: false, telegram: false, rcs: false,
    }
    const channels = { ...defaultChannels, ...(hubSettings.channels as ChannelConfig) }
    channels[channel as keyof ChannelConfig] = false
    await this.settings.updateHubSettings(hubId, { ...hubSettings, channels })
    return channels
  }

  async switchProvider(
    hubId: string,
    newProviderType: string,
  ): Promise<{ ok: true }> {
    // Find the current provider type so we only delete that specific provider config,
    // not ALL configs for this hub (e.g. messaging providers should be preserved)
    const [current] = await this.db
      .select()
      .from(providerConfigs)
      .where(eq(providerConfigs.hubId, hubId))
      .limit(1)

    if (current) {
      await this.db
        .delete(providerConfigs)
        .where(
          and(
            eq(providerConfigs.hubId, hubId),
            eq(providerConfigs.providerType, current.providerType),
          ),
        )
    }

    await this.db.insert(providerConfigs).values({
      id: crypto.randomUUID(),
      hubId,
      providerType: newProviderType,
      status: 'disconnected',
      capabilities: [],
      phoneNumbers: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    return { ok: true }
  }

  async provisionSubAccount(
    hubId: string,
    masterConfigId: string,
  ): Promise<{ subAccountId: string }> {
    // Verify masterConfigId belongs to the requesting hub to prevent cross-hub access
    const [master] = await this.db
      .select()
      .from(providerConfigs)
      .where(
        and(
          eq(providerConfigs.id, masterConfigId),
          eq(providerConfigs.hubId, hubId),
        ),
      )
      .limit(1)

    if (!master) {
      throw new ProviderApiError('Master config not found', 404, 'Not found')
    }

    // Check sub-account quota
    const hubSettings = await this.settings.getHubSettings(hubId)
    const quotas = (hubSettings.quotas as Record<string, number>) ?? {}
    const maxSubAccounts = quotas.maxSubAccounts ?? 0

    if (maxSubAccounts > 0) {
      const existingConfigs = await this.db
        .select()
        .from(providerConfigs)
        .where(eq(providerConfigs.hubId, hubId))

      // Subtract 1 for the master config itself
      const subAccountCount = Math.max(0, existingConfigs.length - 1)
      if (subAccountCount >= maxSubAccounts) {
        throw new ProviderApiError(
          `Sub-account quota exceeded (max: ${maxSubAccounts})`,
          429,
          'Quota exceeded',
        )
      }
    }

    const subAccountId = crypto.randomUUID()

    await this.db.insert(providerConfigs).values({
      id: subAccountId,
      hubId,
      providerType: master.providerType,
      status: 'disconnected',
      capabilities: master.capabilities,
      phoneNumbers: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    await this.settings.updateHubSettings(hubId, {
      ...hubSettings,
      subAccountEnabled: true,
      subAccountConfigId: subAccountId,
    })

    return { subAccountId }
  }
}
