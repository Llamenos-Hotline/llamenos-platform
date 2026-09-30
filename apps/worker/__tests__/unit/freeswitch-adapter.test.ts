/**
 * Unit tests for apps/worker/telephony/freeswitch.ts
 *
 * Tests FreeSwitchAdapter XML generation for mod_httapi.
 */
import { describe, it, expect } from 'vitest'
import { FreeSwitchAdapter } from '@worker/telephony/freeswitch'
import { fakeSpeech, spoken } from '../helpers/fake-speech'

/** What each <playback> in a document speaks, in order (uploads are null) */
const playbacks = (xml: string) =>
  [...xml.matchAll(/<playback file="([^"]*)"/g)].map((m) => spoken(m[1].replace(/&amp;/g, '&')))

function createAdapter() {
  return new FreeSwitchAdapter(
    '+15551234567',
    'http://bridge.local/webhooks',
    'bridge-secret',
    'http://callback.local'
  )
}

describe('FreeSwitchAdapter', () => {
  const adapter = createAdapter()

  describe('getEndpointFormat', () => {
    it('returns sofia/internal endpoint format', () => {
      const result = adapter.getEndpointFormat('+15559876543')
      expect(result).toBe('sofia/internal/+15559876543@trunk')
    })
  })

  describe('getPbxType', () => {
    it('returns "freeswitch"', () => {
      expect(adapter.getPbxType()).toBe('freeswitch')
    })
  })

  describe('handleLanguageMenu', () => {
    it('generates XML document response', async () => {
      const response = await adapter.handleLanguageMenu({
        enabledLanguages: ['en'],
        callSid: 'call-1',
        callerNumber: '+15551234567',
        hotlineName: 'Test Hotline',
        speechUrl: fakeSpeech,
      })

      expect(response.contentType).toBe('text/xml')
      expect(response.body).toContain('xml/freeswitch-httapi')
    })

    it('goes straight on in Spanish when it is the only hub language (#1347: generated speech speaks it)', async () => {
      const response = await adapter.handleLanguageMenu({
        enabledLanguages: ['es'],
        callSid: 'call-1',
        callerNumber: '+15551234567',
        hotlineName: 'Test Hotline',
        speechUrl: fakeSpeech,
      })

      expect(response.body).toContain('caller_lang=es')
    })

    it('announces every hub language in its own voice, as generated speech (#1347)', async () => {
      const response = await adapter.handleLanguageMenu({
        enabledLanguages: ['es', 'en', 'zh'],
        callSid: 'call-1',
        callerNumber: '+15551234567',
        hotlineName: 'Test Hotline',
        speechUrl: fakeSpeech,
      })

      expect(response.body).not.toContain('<speak')
      expect(playbacks(response.body).map((p) => p?.locale)).toEqual(['es', 'en', 'zh'])
      expect(response.body).toContain('<bind')
    })

    it('never offers Tagalog, which no offline voice speaks (#657, #1347)', async () => {
      const response = await adapter.handleLanguageMenu({
        enabledLanguages: ['tl', 'en'],
        callSid: 'call-1',
        callerNumber: '+15551234567',
        hotlineName: 'Test Hotline',
        speechUrl: fakeSpeech,
      })

      expect(response.body).not.toContain('<bind')
      expect(response.body).toContain('caller_lang=en')
    })
  })

  describe('handleIncomingCall', () => {
    it('returns hangup XML when rate limited', async () => {
      const response = await adapter.handleIncomingCall({
        rateLimited: true,
        voiceCaptchaEnabled: false,
        callerLanguage: 'en',
        callSid: 'call-1',
        callerNumber: '+15551111111',
        hotlineName: 'Test Hotline',
        speechUrl: fakeSpeech,
      })

      expect(response.contentType).toBe('text/xml')
      expect(response.body).toContain('hangup')
    })

    it('returns captcha XML when captcha enabled', async () => {
      const response = await adapter.handleIncomingCall({
        rateLimited: false,
        voiceCaptchaEnabled: true,
        captchaDigits: '5678',
        callerLanguage: 'en',
        callSid: 'call-1',
        callerNumber: '+15551111111',
        hotlineName: 'Test Hotline',
        speechUrl: fakeSpeech,
      })

      expect(response.contentType).toBe('text/xml')
      expect(response.body).toContain('<bind')
      // The digits are generated per call, so they are always generated speech.
      expect(playbacks(response.body)).toContainEqual({ locale: 'en', text: '5 6 7 8' })
    })
  })

  describe('handleCaptchaResponse', () => {
    it('continues call flow on correct digits', async () => {
      const response = await adapter.handleCaptchaResponse({
        digits: '5678',
        expectedDigits: '5678',
        callerLanguage: 'en',
        callSid: 'call-1',
        speechUrl: fakeSpeech,
      })

      expect(response.contentType).toBe('text/xml')
      // Should not contain hangup
      expect(response.body).not.toContain('"hangup"')
    })

    it('hangs up on incorrect digits', async () => {
      const response = await adapter.handleCaptchaResponse({
        digits: '0000',
        expectedDigits: '5678',
        callerLanguage: 'en',
        callSid: 'call-1',
        speechUrl: fakeSpeech,
      })

      expect(response.contentType).toBe('text/xml')
      expect(response.body).toContain('hangup')
    })
  })

  describe('rejectCall', () => {
    it('returns XML with hangup', () => {
      const response = adapter.rejectCall()
      expect(response.contentType).toBe('text/xml')
      expect(response.body).toContain('hangup')
    })
  })

  describe('emptyResponse', () => {
    it('returns empty XML document', () => {
      const response = adapter.emptyResponse()
      expect(response.contentType).toBe('text/xml')
      expect(response.body).toContain('xml/freeswitch-httapi')
    })
  })
})
