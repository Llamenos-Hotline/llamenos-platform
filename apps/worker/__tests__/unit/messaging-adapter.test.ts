import { describe, it, expect } from 'vitest'
import type {
  MessagingChannelType,
  MessagingConfig,
  SMSConfig,
  WhatsAppConfig,
  SignalConfig,
  RCSConfig,
} from '@shared/types'
import {
  CHANNEL_SECURITY,
  CHANNEL_LABELS,
} from '@shared/types'

describe('MessagingAdapter types', () => {
  describe('channel types', () => {
    it('defines 4 messaging channel types', () => {
      const channels: MessagingChannelType[] = ['sms', 'whatsapp', 'signal', 'rcs']
      expect(channels.length).toBe(4)
    })

    it('all channels have security levels', () => {
      expect(CHANNEL_SECURITY.sms).toBe('none')
      expect(CHANNEL_SECURITY.whatsapp).toBe('provider-encrypted')
      expect(CHANNEL_SECURITY.signal).toBe('e2ee-to-bridge')
      expect(CHANNEL_SECURITY.rcs).toBe('provider-encrypted')
    })

    it('all channels have display labels', () => {
      expect(CHANNEL_LABELS.sms).toBe('SMS')
      expect(CHANNEL_LABELS.whatsapp).toBe('WhatsApp')
      expect(CHANNEL_LABELS.signal).toBe('Signal')
      expect(CHANNEL_LABELS.rcs).toBe('RCS')
    })

    it('voice channel has security level', () => {
      expect(CHANNEL_SECURITY.voice).toBe('provider-encrypted')
    })

    it('reports channel has e2ee security', () => {
      expect(CHANNEL_SECURITY.reports).toBe('e2ee')
    })
  })

  describe('messaging config', () => {
    it('SMSConfig requires enabled flag', () => {
      const sms: SMSConfig = { enabled: true }
      expect(sms.enabled).toBe(true)
    })

    it('SMSConfig supports auto response', () => {
      const sms: SMSConfig = {
        enabled: true,
        autoResponse: 'Thank you for contacting us',
        afterHoursResponse: 'We are closed',
      }
      expect(sms.autoResponse).toBeTruthy()
      expect(sms.afterHoursResponse).toBeTruthy()
    })

    it('WhatsAppConfig supports twilio mode', () => {
      const wa: WhatsAppConfig = {
        integrationMode: 'twilio',
      }
      expect(wa.integrationMode).toBe('twilio')
    })

    it('WhatsAppConfig supports direct Meta API mode', () => {
      const wa: WhatsAppConfig = {
        integrationMode: 'direct',
        phoneNumberId: '123',
        businessAccountId: '456',
        accessToken: 'token',
        verifyToken: 'verify',
        appSecret: 'secret',
      }
      expect(wa.integrationMode).toBe('direct')
      expect(wa.phoneNumberId).toBe('123')
    })

    it('SignalConfig requires bridge connection', () => {
      const signal: SignalConfig = {
        bridgeUrl: 'https://signal-bridge.internal:8080',
        bridgeApiKey: 'key123',
        webhookSecret: 'secret123',
        registeredNumber: '+15551234567',
      }
      expect(signal.bridgeUrl).toContain('signal-bridge')
      expect(signal.registeredNumber).toMatch(/^\+/)
    })

    it('RCSConfig requires Google credentials', () => {
      const rcs: RCSConfig = {
        agentId: 'agent-123',
        serviceAccountKey: '{"type":"service_account"}',
        webhookSecret: 'rcs-secret',
        fallbackToSms: true,
      }
      expect(rcs.agentId).toBeTruthy()
      expect(rcs.fallbackToSms).toBe(true)
    })

    it('MessagingConfig has all channel slots', () => {
      const config: MessagingConfig = {
        enabledChannels: ['sms', 'whatsapp'],
        sms: { enabled: true },
        whatsapp: { integrationMode: 'twilio' },
        signal: null,
        rcs: null,
        telegram: null,
        autoAssign: true,
        inactivityTimeout: 60,
        maxConcurrentPerUser: 3,
      }
      expect(config.enabledChannels).toContain('sms')
      expect(config.enabledChannels).toContain('whatsapp')
      expect(config.signal).toBeNull()
      expect(config.rcs).toBeNull()
      expect(config.telegram).toBeNull()
    })
  })

  // Adapter interface shape tests removed — they only tested literal object construction,
  // not actual adapter behavior. Real behavioral tests are in the per-adapter test files
  // (twilio-sms-adapter.test.ts, vonage-sms-adapter.test.ts, plivo-sms-adapter.test.ts, etc.)
})
