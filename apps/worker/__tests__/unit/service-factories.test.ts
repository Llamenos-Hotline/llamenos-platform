import { describe, it, expect, vi } from 'vitest'
import {
  getTelephonyFromService,
  getHubTelephonyFromService,
  resolveHubTelephonyConfig,
  getMessagingAdapterFromService,
} from '@worker/lib/service-factories'
import type { TelephonyProviderConfig, MessagingConfig, MessagingChannelType } from '@shared/types'

vi.mock('@worker/telephony/twilio', () => ({
  TwilioAdapter: vi.fn(function (sid: string, token: string, phone: string) {
    return { type: 'twilio', sid, token, phone }
  }),
}))

vi.mock('@worker/telephony/signalwire', () => ({
  SignalWireAdapter: vi.fn(function (sid: string, token: string, phone: string, space: string) {
    return { type: 'signalwire', sid, token, phone, space }
  }),
}))

vi.mock('@worker/telephony/vonage', () => ({
  VonageAdapter: vi.fn(function (...args: unknown[]) {
    return { type: 'vonage', args }
  }),
}))

vi.mock('@worker/telephony/plivo', () => ({
  PlivoAdapter: vi.fn(function (...args: unknown[]) {
    return { type: 'plivo', args }
  }),
}))

vi.mock('@worker/telephony/asterisk', () => ({
  AsteriskAdapter: vi.fn(function (...args: unknown[]) {
    return { type: 'asterisk', args }
  }),
}))

vi.mock('@worker/telephony/telnyx', () => ({
  TelnyxAdapter: vi.fn(function (...args: unknown[]) {
    return { type: 'telnyx', args }
  }),
}))

vi.mock('@worker/telephony/bandwidth', () => ({
  BandwidthAdapter: vi.fn(function (...args: unknown[]) {
    return { type: 'bandwidth', args }
  }),
}))

vi.mock('@worker/telephony/freeswitch', () => ({
  FreeSwitchAdapter: vi.fn(function (...args: unknown[]) {
    return { type: 'freeswitch', args }
  }),
}))

vi.mock('@worker/messaging/sms/factory', () => ({
  createSMSAdapter: vi.fn().mockImplementation(() => ({ channel: 'sms' })),
}))

vi.mock('@worker/messaging/whatsapp/factory', () => ({
  createWhatsAppAdapter: vi.fn().mockImplementation(() => ({ channel: 'whatsapp' })),
}))

vi.mock('@worker/messaging/signal/factory', () => ({
  createSignalAdapter: vi.fn().mockImplementation(() => ({ channel: 'signal' })),
}))

vi.mock('@worker/messaging/rcs/factory', () => ({
  createRCSAdapter: vi.fn().mockImplementation(() => ({ channel: 'rcs' })),
}))

vi.mock('@worker/messaging/telegram/factory', () => ({
  createTelegramAdapter: vi.fn().mockImplementation(() => ({ channel: 'telegram' })),
}))

describe('service-factories', () => {

  describe('getTelephonyFromService', () => {
    it('returns adapter from settings config', async () => {
      const config: TelephonyProviderConfig = {
        type: 'twilio',
        accountSid: 'AC_test',
        authToken: 'token',
        phoneNumber: '+1234',
      }
      const settingsService = {
        getTelephonyProvider: vi.fn().mockResolvedValue(config),
      }
      const env = {} as unknown as Parameters<typeof getTelephonyFromService>[0]
      const adapter = await getTelephonyFromService(env, settingsService)
      expect(adapter).toBeDefined()
      expect(settingsService.getTelephonyProvider).toHaveBeenCalled()
    })

    it('falls back to env vars when settings fail', async () => {
      const settingsService = {
        getTelephonyProvider: vi.fn().mockRejectedValue(new Error('db down')),
      }
      const env = {
        TWILIO_ACCOUNT_SID: 'AC_fallback',
        TWILIO_AUTH_TOKEN: 'fallback_token',
        TWILIO_PHONE_NUMBER: '+1999',
      } as unknown as Parameters<typeof getTelephonyFromService>[0]
      const adapter = await getTelephonyFromService(env, settingsService)
      expect(adapter).toEqual({
        type: 'twilio',
        sid: 'AC_fallback',
        token: 'fallback_token',
        phone: '+1999',
      })
    })

    it('falls back to env vars when settings returns null', async () => {
      const settingsService = {
        getTelephonyProvider: vi.fn().mockResolvedValue(null),
      }
      const env = {
        TWILIO_ACCOUNT_SID: 'AC_fb',
        TWILIO_AUTH_TOKEN: 'tk',
        TWILIO_PHONE_NUMBER: '+1888',
      } as unknown as Parameters<typeof getTelephonyFromService>[0]
      const adapter = await getTelephonyFromService(env, settingsService)
      expect(adapter).toEqual({
        type: 'twilio',
        sid: 'AC_fb',
        token: 'tk',
        phone: '+1888',
      })
    })

    it('returns null when no config available', async () => {
      const settingsService = {
        getTelephonyProvider: vi.fn().mockResolvedValue(null),
      }
      const env = {} as unknown as Parameters<typeof getTelephonyFromService>[0]
      const adapter = await getTelephonyFromService(env, settingsService)
      expect(adapter).toBeNull()
    })
  })

  describe('getHubTelephonyFromService', () => {
    it('returns hub-specific config when available', async () => {
      const hubConfig: TelephonyProviderConfig = {
        type: 'signalwire',
        accountSid: 'AC_hub',
        authToken: 'hub_token',
        phoneNumber: '+1111',
        signalwireSpace: 'space',
      }
      const settingsService = {
        getHubTelephonyProvider: vi.fn().mockResolvedValue(hubConfig),
        getTelephonyProvider: vi.fn().mockResolvedValue(null),
      }
      const env = {} as unknown as Parameters<typeof getHubTelephonyFromService>[0]
      const adapter = await getHubTelephonyFromService(env, settingsService, 'hub-1')
      expect(adapter).toEqual({
        type: 'signalwire',
        sid: 'AC_hub',
        token: 'hub_token',
        phone: '+1111',
        space: 'space',
      })
    })

    it('falls back to global telephony config', async () => {
      const globalConfig: TelephonyProviderConfig = {
        type: 'twilio',
        accountSid: 'AC_global',
        authToken: 'global_token',
        phoneNumber: '+2222',
      }
      const settingsService = {
        getHubTelephonyProvider: vi.fn().mockResolvedValue(null),
        getTelephonyProvider: vi.fn().mockResolvedValue(globalConfig),
      }
      const env = {} as unknown as Parameters<typeof getHubTelephonyFromService>[0]
      const adapter = await getHubTelephonyFromService(env, settingsService, 'hub-1')
      expect(adapter).toEqual({
        type: 'twilio',
        sid: 'AC_global',
        token: 'global_token',
        phone: '+2222',
      })
    })

    /**
     * `resolveHubTelephonyConfig` is what `services/ringing.ts` asks whether
     * this hub's calls go through the PBX we run — only then does a volunteer
     * have an in-app endpoint to be sent an INVITE. It must name the SAME
     * provider the adapter placing the call was built from. It did not once:
     * ringing read `getHubTelephonyProvider` directly, which is null for a hub
     * with no per-hub row, so it concluded "not our PBX" while the call went
     * out through the instance-wide Asterisk and the volunteer's registered app
     * was never dialled.
     */
    it.each([
      ['a hub-specific provider', 'signalwire', null],
      ['the instance-wide provider', null, 'twilio'],
    ] as const)('agrees with the adapter on %s', async (_label, hubType, globalType) => {
      const asConfig = (type: string | null): TelephonyProviderConfig | null =>
        type ? ({ type, phoneNumber: '+1111', accountSid: 'AC', authToken: 't', signalwireSpace: 's' } as TelephonyProviderConfig) : null
      const settingsService = {
        getHubTelephonyProvider: vi.fn().mockResolvedValue(asConfig(hubType)),
        getTelephonyProvider: vi.fn().mockResolvedValue(asConfig(globalType)),
      }
      const env = {} as unknown as Parameters<typeof getHubTelephonyFromService>[0]

      const config = await resolveHubTelephonyConfig(env, settingsService, 'hub-1')
      const adapter = await getHubTelephonyFromService(env, settingsService, 'hub-1')

      expect(config?.type).toBe(hubType ?? globalType)
      expect((adapter as unknown as { type: string }).type).toBe(config?.type)
    })

    it('resolves nothing when neither the hub nor the instance has a provider', async () => {
      const settingsService = {
        getHubTelephonyProvider: vi.fn().mockResolvedValue(null),
        getTelephonyProvider: vi.fn().mockRejectedValue(new Error('db down')),
      }
      const env = {} as unknown as Parameters<typeof getHubTelephonyFromService>[0]
      expect(await resolveHubTelephonyConfig(env, settingsService, 'hub-1')).toBeNull()
    })

    it('reads only the instance-wide provider for a call that resolved to no hub', async () => {
      const settingsService = {
        getHubTelephonyProvider: vi.fn().mockResolvedValue(null),
        getTelephonyProvider: vi.fn().mockResolvedValue({ type: 'asterisk', phoneNumber: '+1' } as TelephonyProviderConfig),
      }
      const env = {} as unknown as Parameters<typeof getHubTelephonyFromService>[0]
      expect((await resolveHubTelephonyConfig(env, settingsService, ''))?.type).toBe('asterisk')
      expect(settingsService.getHubTelephonyProvider).not.toHaveBeenCalled()
    })

    it('falls back to env vars when both hub and global fail', async () => {
      const settingsService = {
        getHubTelephonyProvider: vi.fn().mockRejectedValue(new Error('fail')),
        getTelephonyProvider: vi.fn().mockRejectedValue(new Error('fail')),
      }
      const env = {
        TWILIO_ACCOUNT_SID: 'AC_env',
        TWILIO_AUTH_TOKEN: 'env_token',
        TWILIO_PHONE_NUMBER: '+3333',
      } as unknown as Parameters<typeof getHubTelephonyFromService>[0]
      const adapter = await getHubTelephonyFromService(env, settingsService, 'hub-1')
      expect(adapter).toEqual({
        type: 'twilio',
        sid: 'AC_env',
        token: 'env_token',
        phone: '+3333',
      })
    })
  })

  describe('getMessagingAdapterFromService', () => {
    const baseMessagingConfig = {
      enabledChannels: ['sms', 'whatsapp', 'signal', 'rcs', 'telegram'] as MessagingChannelType[],
      sms: { enabled: true, provider: 'twilio' },
      whatsapp: { phoneNumberId: '123', accessToken: 'token' },
      signal: { bridgeUrl: 'http://signal:8080', phoneNumber: '+1234' },
      rcs: { agentId: 'agent', brandId: 'brand' },
      telegram: { botToken: 'bot-token' },
    } as unknown as MessagingConfig

    it('returns SMS adapter', async () => {
      const settingsService = {
        getMessagingConfig: vi.fn().mockResolvedValue(baseMessagingConfig),
        getTelephonyProvider: vi.fn().mockResolvedValue({ type: 'twilio', accountSid: 'AC', authToken: 't', phoneNumber: '+1' } as TelephonyProviderConfig),
      }
      const adapter = await getMessagingAdapterFromService('sms', settingsService, 'secret')
      expect(adapter).toEqual({ channel: 'sms' })
    })

    it('returns WhatsApp adapter', async () => {
      const settingsService = {
        getMessagingConfig: vi.fn().mockResolvedValue(baseMessagingConfig),
        getTelephonyProvider: vi.fn(),
      }
      const adapter = await getMessagingAdapterFromService('whatsapp', settingsService, 'secret')
      expect(adapter).toEqual({ channel: 'whatsapp' })
    })

    it('returns Signal adapter', async () => {
      const settingsService = {
        getMessagingConfig: vi.fn().mockResolvedValue(baseMessagingConfig),
        getTelephonyProvider: vi.fn(),
      }
      const adapter = await getMessagingAdapterFromService('signal', settingsService, 'secret')
      expect(adapter).toEqual({ channel: 'signal' })
    })

    it('returns RCS adapter', async () => {
      const settingsService = {
        getMessagingConfig: vi.fn().mockResolvedValue(baseMessagingConfig),
        getTelephonyProvider: vi.fn(),
      }
      const adapter = await getMessagingAdapterFromService('rcs', settingsService, 'secret')
      expect(adapter).toEqual({ channel: 'rcs' })
    })

    it('returns Telegram adapter', async () => {
      const settingsService = {
        getMessagingConfig: vi.fn().mockResolvedValue(baseMessagingConfig),
        getTelephonyProvider: vi.fn(),
      }
      const adapter = await getMessagingAdapterFromService('telegram', settingsService, 'secret')
      expect(adapter).toEqual({ channel: 'telegram' })
    })

    it('throws when channel is not enabled', async () => {
      const config: MessagingConfig = {
        ...baseMessagingConfig,
        enabledChannels: ['sms'],
      }
      const settingsService = {
        getMessagingConfig: vi.fn().mockResolvedValue(config),
        getTelephonyProvider: vi.fn(),
      }
      await expect(getMessagingAdapterFromService('whatsapp', settingsService, 'secret')).rejects.toThrow(
        'whatsapp channel is not enabled'
      )
    })

    it('throws when SMS is not enabled', async () => {
      const config = {
        ...baseMessagingConfig,
        enabledChannels: ['sms' as MessagingChannelType],
        sms: undefined,
      } as unknown as MessagingConfig
      const settingsService = {
        getMessagingConfig: vi.fn().mockResolvedValue(config),
        getTelephonyProvider: vi.fn(),
      }
      await expect(getMessagingAdapterFromService('sms', settingsService, 'secret')).rejects.toThrow(
        'SMS is not enabled'
      )
    })

    it('throws when SMS requires telephony provider but none configured', async () => {
      const config: MessagingConfig = {
        ...baseMessagingConfig,
        enabledChannels: ['sms'],
      }
      const settingsService = {
        getMessagingConfig: vi.fn().mockResolvedValue(config),
        getTelephonyProvider: vi.fn().mockResolvedValue(null),
      }
      await expect(getMessagingAdapterFromService('sms', settingsService, 'secret')).rejects.toThrow(
        'SMS requires a configured telephony provider'
      )
    })
  })

  // NostrPublisher tests removed — replaced by ConnectionManager in ws-manager.ts
})
