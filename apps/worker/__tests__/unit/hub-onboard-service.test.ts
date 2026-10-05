import { describe, it, expect, beforeEach } from 'vitest'
import { HubOnboardService } from '@worker/services/provider-setup/hub-onboard'
import { ProviderSetup } from '@worker/services/provider-setup'
import { SettingsService } from '@worker/services/settings'
import { createMockDb } from './mock-db'

function setup() {
  const { db, reset } = createMockDb()
  const providerSetup = new ProviderSetup(db as any, 'secret', 'localhost')
  const settings = new SettingsService(db as any)
  const service = new HubOnboardService(db as any, providerSetup, settings)
  return { db, service, reset }
}

describe('HubOnboardService', () => {
  beforeEach(() => {
    const { reset } = setup()
    reset()
  })

  describe('startOnboarding', () => {
    it('creates onboarding state for hub', async () => {
      const { db, service } = setup()
      db.$setSelectResult([])

      const result = await service.startOnboarding('hub-1')
      expect(result.hubId).toBe('hub-1')
      expect(result.currentStep).toBe('template_selection')
      expect(result.isComplete).toBe(false)
    })

    it('applies template defaults when templateId provided', async () => {
      const { db, service } = setup()
      db.$setSelectResult([
        {
          id: 'tpl-1',
          defaultChannels: ['voice', 'sms'],
        },
      ])

      const result = await service.startOnboarding('hub-1', 'tpl-1')
      expect(result.channelConfig).toEqual({
        voice: true,
        sms: true,
        email: false,
        signal: false,
        whatsapp: false,
        telegram: false,
        rcs: false,
      })
    })
  })

  describe('getOnboardingStatus', () => {
    it('returns status when onboarding exists', async () => {
      const { db, service } = setup()
      db.$setSelectResult([
        {
          hubId: 'hub-1',
          currentStep: 'provider_connection',
          completedSteps: ['template_selection', 'channel_selection'],
          channelConfig: { voice: true },
          isComplete: false,
          createdAt: new Date('2026-01-01'),
          updatedAt: new Date('2026-01-01'),
        },
      ])

      const result = await service.getOnboardingStatus('hub-1')
      expect(result).not.toBeNull()
      expect(result?.currentStep).toBe('provider_connection')
      expect(result?.completedSteps).toEqual(['template_selection', 'channel_selection'])
    })

    it('returns null when onboarding does not exist', async () => {
      const { db, service } = setup()
      db.$setSelectResult([])

      const result = await service.getOnboardingStatus('hub-1')
      expect(result).toBeNull()
    })
  })

  describe('completeStep', () => {
    it('advances to next step', async () => {
      const { db, service } = setup()
      db.$setSelectResults([
        [
          {
            hubId: 'hub-1',
            currentStep: 'template_selection',
            completedSteps: [],
            channelConfig: {},
            isComplete: false,
          },
        ],
        [
          {
            hubId: 'hub-1',
            currentStep: 'channel_selection',
            completedSteps: ['template_selection'],
            channelConfig: {},
            isComplete: false,
            createdAt: new Date('2026-01-01'),
            updatedAt: new Date('2026-01-01'),
          },
        ],
      ])

      const result = await service.completeStep('hub-1', 'template_selection')
      expect(result.completedSteps).toContain('template_selection')
    })

    it('rejects invalid step', async () => {
      const { db, service } = setup()
      db.$setSelectResult([])

      await expect(service.completeStep('hub-1', 'invalid_step')).rejects.toThrow(
        'Invalid step',
      )
    })

    it('rejects skipping steps', async () => {
      const { db, service } = setup()
      db.$setSelectResult([
        {
          hubId: 'hub-1',
          currentStep: 'template_selection',
          completedSteps: [],
          channelConfig: {},
          isComplete: false,
        },
      ])

      await expect(service.completeStep('hub-1', 'provider_connection')).rejects.toThrow(
        'Cannot skip steps',
      )
    })
  })

  describe('completeOnboarding', () => {
    it('marks onboarding as complete', async () => {
      const { db, service } = setup()
      db.$setSelectResult([
        {
          hubId: 'hub-1',
          settings: {},
        },
      ])

      const result = await service.completeOnboarding('hub-1')
      expect(result.ok).toBe(true)
    })
  })

  describe('getHubUsage', () => {
    it('returns current month usage', async () => {
      const { db, service } = setup()
      const now = new Date()
      const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
      db.$setSelectResult([
        {
          hubId: 'hub-1',
          settings: {
            usage: [
              {
                month,
                year: now.getFullYear(),
                smsSent: 42,
                callsReceived: 10,
              },
            ],
          },
        },
      ])

      const result = await service.getHubUsage('hub-1')
      expect(result.smsSent).toBe(42)
      expect(result.callsReceived).toBe(10)
    })

    it('returns zero usage when no data exists', async () => {
      const { db, service } = setup()
      db.$setSelectResult([{ hubId: 'hub-1', settings: {} }])

      const result = await service.getHubUsage('hub-1')
      expect(result.smsSent).toBe(0)
      expect(result.callsReceived).toBe(0)
    })
  })

  describe('getHubSetupStatus', () => {
    it('reports channels, provider and complete quotas', async () => {
      const { db, service } = setup()
      db.$setSelectResults([
        // providerConfigs
        [{ hubId: 'hub-1', providerType: 'twilio', status: 'connected', phoneNumbers: ['+15550000000'] }],
        // hubOnboardingState (getOnboardingStatus)
        [
          {
            hubId: 'hub-1',
            currentStep: 'provider_connection',
            completedSteps: ['template_selection', 'channel_selection'],
            channelConfig: {
              voice: true, sms: true, email: false, signal: false,
              whatsapp: false, telegram: false, rcs: false,
            },
            isComplete: false,
          },
        ],
        // hub_settings (getHubProviderSettings)
        [{ hubId: 'hub-1', settings: { quotas: { maxSmsPerMonth: 25 } } }],
      ])

      const result = await service.getHubSetupStatus('hub-1')
      expect(result.providerConnected).toBe(true)
      expect(result.providerType).toBe('twilio')
      expect(result.numbersProvisioned).toBe(1)
      expect(result.channelsConfigured).toEqual(['voice', 'sms'])
      expect(result.onboardingComplete).toBe(false)
      // Every quota is present: the stored partial wins, the rest default.
      // Clients type these as numbers, so a half-built object fails to decode.
      expect(result.quotas).toEqual({
        maxPhoneNumbers: 5,
        maxSmsPerMonth: 25,
        maxCallsPerMonth: 500,
        maxSignalMessagesPerMonth: 500,
        maxWhatsAppMessagesPerMonth: 500,
        maxSubAccounts: 0,
      })
    })

    it('fills every quota for a hub that has never had one set', async () => {
      const { db, service } = setup()
      db.$setSelectResults([[], [], [{ hubId: 'hub-1', settings: {} }]])

      const result = await service.getHubSetupStatus('hub-1')
      expect(result.providerConnected).toBe(false)
      expect(result.quotas).toEqual({
        maxPhoneNumbers: 5,
        maxSmsPerMonth: 1000,
        maxCallsPerMonth: 500,
        maxSignalMessagesPerMonth: 500,
        maxWhatsAppMessagesPerMonth: 500,
        maxSubAccounts: 0,
      })
    })
  })

  describe('checkQuota', () => {
    it('allows when under limit', async () => {
      const { db, service } = setup()
      const now = new Date()
      const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
      db.$setSelectResult([
        {
          hubId: 'hub-1',
          settings: {
            quotas: { smsSent: 100 },
            usage: [{ month, year: now.getFullYear(), smsSent: 50 }],
          },
        },
      ])

      const result = await service.checkQuota('hub-1', 'smsSent')
      expect(result.allowed).toBe(true)
      expect(result.limit).toBe(100)
      expect(result.current).toBe(50)
    })

    it('blocks when at limit', async () => {
      const { db, service } = setup()
      const now = new Date()
      const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
      db.$setSelectResult([
        {
          hubId: 'hub-1',
          settings: {
            quotas: { smsSent: 100 },
            usage: [{ month, year: now.getFullYear(), smsSent: 100 }],
          },
        },
      ])

      const result = await service.checkQuota('hub-1', 'smsSent')
      expect(result.allowed).toBe(false)
      expect(result.current).toBe(100)
    })
  })

  describe('enableChannel / disableChannel', () => {
    it('enables a channel', async () => {
      const { db, service } = setup()
      db.$setSelectResult([
        {
          hubId: 'hub-1',
          settings: { channels: { voice: false, sms: false } },
        },
      ])

      const result = await service.enableChannel('hub-1', 'voice')
      expect(result.voice).toBe(true)
    })

    it('disables a channel', async () => {
      const { db, service } = setup()
      db.$setSelectResult([
        {
          hubId: 'hub-1',
          settings: { channels: { voice: true, sms: true } },
        },
      ])

      const result = await service.disableChannel('hub-1', 'sms')
      expect(result.sms).toBe(false)
    })
  })

  describe('switchProvider', () => {
    it('deletes old config and creates new', async () => {
      const { db, service } = setup()
      db.$setSelectResult([])

      const result = await service.switchProvider('hub-1', 'signalwire')
      expect(result.ok).toBe(true)
    })
  })
})
