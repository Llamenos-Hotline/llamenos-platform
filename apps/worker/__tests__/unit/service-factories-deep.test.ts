import { describe, it, expect, vi } from 'vitest'
import {
  getTelephonyFromService,
  getHubTelephonyFromService,
  getMessagingAdapterFromService,
} from '@worker/lib/service-factories'

describe('getTelephonyFromService', () => {
  it('returns adapter from service config when available', async () => {
    const settings = {
      getTelephonyProvider: vi.fn().mockResolvedValue({
        type: 'twilio',
        accountSid: 'AC123',
        authToken: 'token',
        phoneNumber: '+15551234567',
      }),
    }

    const adapter = await getTelephonyFromService({} as any, settings)
    expect(adapter).not.toBeNull()
    expect(settings.getTelephonyProvider).toHaveBeenCalled()
  })

  it('falls back to env vars when service fails', async () => {
    const settings = {
      getTelephonyProvider: vi.fn().mockRejectedValue(new Error('DB down')),
    }

    const adapter = await getTelephonyFromService({
      TWILIO_ACCOUNT_SID: 'AC999',
      TWILIO_AUTH_TOKEN: 'fallback-token',
      TWILIO_PHONE_NUMBER: '+15559999999',
    } as any, settings)

    expect(adapter).not.toBeNull()
  })

  it('returns null when no config and no env vars', async () => {
    const settings = {
      getTelephonyProvider: vi.fn().mockResolvedValue(null),
    }

    const adapter = await getTelephonyFromService({} as any, settings)
    expect(adapter).toBeNull()
  })

  it('falls back to env vars when service returns null', async () => {
    const settings = {
      getTelephonyProvider: vi.fn().mockResolvedValue(null),
    }

    const adapter = await getTelephonyFromService({
      TWILIO_ACCOUNT_SID: 'AC111',
      TWILIO_AUTH_TOKEN: 'tk',
      TWILIO_PHONE_NUMBER: '+1555',
    } as any, settings)

    expect(adapter).not.toBeNull()
  })
})

describe('getHubTelephonyFromService', () => {
  it('returns hub-specific adapter when available', async () => {
    const settings = {
      getHubTelephonyProvider: vi.fn().mockResolvedValue({
        type: 'signalwire',
        accountSid: 'hub-sid',
        authToken: 'hub-token',
        phoneNumber: '+15550001111',
        signalwireSpace: 'test.signalwire.com',
      }),
      getTelephonyProvider: vi.fn(),
    }

    // The HMAC secret is what decrypts the stored credentials. This assertion
    // used to pin `('hub-123')` with no second argument, which is precisely
    // the defect: the hub's provider resolved and its credentials stayed
    // ciphertext. Strengthened to require the secret rather than forbid it.
    const adapter = await getHubTelephonyFromService(
      { HMAC_SECRET: 'a'.repeat(64) } as any,
      settings,
      'hub-123',
    )
    expect(adapter).not.toBeNull()
    expect(settings.getHubTelephonyProvider).toHaveBeenCalledWith('hub-123', 'a'.repeat(64))
    expect(settings.getTelephonyProvider).not.toHaveBeenCalled()
  })

  it('falls back to global telephony when hub config fails', async () => {
    const settings = {
      getHubTelephonyProvider: vi.fn().mockRejectedValue(new Error('Not configured')),
      getTelephonyProvider: vi.fn().mockResolvedValue({
        type: 'twilio',
        accountSid: 'AC-global',
        authToken: 'global-token',
        phoneNumber: '+15552222222',
      }),
    }

    const adapter = await getHubTelephonyFromService({} as any, settings, 'hub-456')
    expect(adapter).not.toBeNull()
    expect(settings.getTelephonyProvider).toHaveBeenCalled()
  })

  it('falls back to global when hub config returns null', async () => {
    const settings = {
      getHubTelephonyProvider: vi.fn().mockResolvedValue(null),
      getTelephonyProvider: vi.fn().mockResolvedValue({
        type: 'twilio',
        accountSid: 'AC-fallback',
        authToken: 'token',
        phoneNumber: '+15553333333',
      }),
    }

    const adapter = await getHubTelephonyFromService({} as any, settings, 'hub-789')
    expect(adapter).not.toBeNull()
  })
})

describe('getMessagingAdapterFromService', () => {
  it('throws when channel is not enabled', async () => {
    const settings = {
      getMessagingConfig: vi.fn().mockResolvedValue({
        enabledChannels: ['sms'], // whatsapp not in list
        sms: { enabled: true },
      }),
      getTelephonyProvider: vi.fn(),
    }

    await expect(
      getMessagingAdapterFromService('whatsapp', settings, 'hmac'),
    ).rejects.toThrow('whatsapp channel is not enabled')
  })

  it('throws for SMS when telephony provider is not configured', async () => {
    const settings = {
      getMessagingConfig: vi.fn().mockResolvedValue({
        enabledChannels: ['sms'],
        sms: { enabled: true },
      }),
      getTelephonyProvider: vi.fn().mockResolvedValue(null),
    }

    await expect(
      getMessagingAdapterFromService('sms', settings, 'hmac'),
    ).rejects.toThrow('SMS requires a configured telephony provider')
  })

  it('throws for unknown channel', async () => {
    const settings = {
      getMessagingConfig: vi.fn().mockResolvedValue({
        enabledChannels: ['carrier_pigeon' as string],
      }),
      getTelephonyProvider: vi.fn(),
    }

    await expect(
      getMessagingAdapterFromService('carrier_pigeon' as any, settings, 'hmac'),
    ).rejects.toThrow('Unknown channel: carrier_pigeon')
  })

  it('throws when SMS is in enabledChannels but sms.enabled is false', async () => {
    const settings = {
      getMessagingConfig: vi.fn().mockResolvedValue({
        enabledChannels: ['sms'],
        sms: { enabled: false },
      }),
      getTelephonyProvider: vi.fn(),
    }

    await expect(
      getMessagingAdapterFromService('sms', settings, 'hmac'),
    ).rejects.toThrow('SMS is not enabled')
  })

  it('throws when WhatsApp config is missing', async () => {
    const settings = {
      getMessagingConfig: vi.fn().mockResolvedValue({
        enabledChannels: ['whatsapp'],
        // no whatsapp key
      }),
      getTelephonyProvider: vi.fn(),
    }

    await expect(
      getMessagingAdapterFromService('whatsapp', settings, 'hmac'),
    ).rejects.toThrow('WhatsApp is not configured')
  })

  it('throws when Signal config is missing', async () => {
    const settings = {
      getMessagingConfig: vi.fn().mockResolvedValue({
        enabledChannels: ['signal'],
      }),
      getTelephonyProvider: vi.fn(),
    }

    await expect(
      getMessagingAdapterFromService('signal', settings, 'hmac'),
    ).rejects.toThrow('Signal is not configured')
  })

  it('throws when Telegram config is missing', async () => {
    const settings = {
      getMessagingConfig: vi.fn().mockResolvedValue({
        enabledChannels: ['telegram'],
      }),
      getTelephonyProvider: vi.fn(),
    }

    await expect(
      getMessagingAdapterFromService('telegram', settings, 'hmac'),
    ).rejects.toThrow('Telegram is not configured')
  })

  it('throws when RCS config is missing', async () => {
    const settings = {
      getMessagingConfig: vi.fn().mockResolvedValue({
        enabledChannels: ['rcs'],
      }),
      getTelephonyProvider: vi.fn(),
    }

    await expect(
      getMessagingAdapterFromService('rcs', settings, 'hmac'),
    ).rejects.toThrow('RCS is not configured')
  })
})

// NostrPublisher tests removed — replaced by ConnectionManager in ws-manager.ts
