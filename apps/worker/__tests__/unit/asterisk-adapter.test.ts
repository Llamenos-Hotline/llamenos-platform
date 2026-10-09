/**
 * Unit tests for apps/worker/telephony/asterisk.ts
 *
 * Tests AsteriskAdapter IVR command generation.
 */
import { describe, it, expect } from 'vitest'
import { AsteriskAdapter } from '@worker/telephony/asterisk'
import { getPrompt, getVoicemailThanks } from '@shared/voice-prompts'
import { fakeSpeech, spoken } from '../helpers/fake-speech'

type Command = { action: string; url?: string }
const spokenBy = (commands: Command[]) => commands.flatMap((c) => (c.url && spoken(c.url) ? [spoken(c.url)] : []))

function createAdapter() {
  return new AsteriskAdapter(
    'http://ari.local:8088',
    'admin',
    'password',
    '+15551234567',
    'http://callback.local/webhooks',
    'bridge-secret-123'
  )
}

describe('AsteriskAdapter', () => {
  const adapter = createAdapter()

  describe('getEndpointFormat', () => {
    it('returns PJSIP endpoint format', () => {
      const result = adapter.getEndpointFormat('+15559876543')
      expect(result).toBe('PJSIP/+15559876543@trunk')
    })
  })

  describe('getPbxType', () => {
    it('returns "asterisk"', () => {
      expect(adapter.getPbxType()).toBe('asterisk')
    })
  })

  describe('handleLanguageMenu', () => {
    it('auto-selects language when only one is enabled', async () => {
      const response = await adapter.handleLanguageMenu({
        enabledLanguages: ['es'],
        callSid: 'call-1',
        callerNumber: '+15551234567',
        hotlineName: 'Test Hotline',
        speechUrl: fakeSpeech,
      })

      const body = JSON.parse(response.body)
      // Nothing to announce: straight on in the one language.
      expect(body.commands).toHaveLength(1)
      expect(body.commands[0].action).toBe('gather')
      expect(body.commands[0].metadata).toEqual({ auto: '1', forceLang: 'es' })
    })

    it('uses default language when no languages enabled', async () => {
      const response = await adapter.handleLanguageMenu({
        enabledLanguages: [],
        callSid: 'call-1',
        callerNumber: '+15551234567',
        hotlineName: 'Test Hotline',
        speechUrl: fakeSpeech,
      })

      const body = JSON.parse(response.body)
      // Should still emit gather with auto-select
      expect(body.commands.some((c: { action: string }) => c.action === 'gather')).toBe(true)
    })

    it('emits language prompts for multiple languages', async () => {
      const response = await adapter.handleLanguageMenu({
        enabledLanguages: ['en', 'es', 'zh'],
        callSid: 'call-1',
        callerNumber: '+15551234567',
        hotlineName: 'Test Hotline',
        speechUrl: fakeSpeech,
      })

      const body = JSON.parse(response.body)
      // Each option is announced in its own language, as generated speech.
      expect(spokenBy(body.commands).map((s) => s?.locale)).toEqual(['en', 'es', 'zh'])
      // Should end with a gather for digit input
      const lastCommand = body.commands[body.commands.length - 1]
      expect(lastCommand.action).toBe('gather')
      expect(lastCommand.numDigits).toBe(1)
    })
  })

  describe('handleIncomingCall', () => {
    it('hangs up when rate limited', async () => {
      const response = await adapter.handleIncomingCall({
        rateLimited: true,
        voiceCaptchaEnabled: false,
        callerLanguage: 'en',
        callSid: 'call-1',
        callerNumber: '+15551111111',
        hotlineName: 'Test Hotline',
        speechUrl: fakeSpeech,
      })

      const body = JSON.parse(response.body)
      const hangup = body.commands.find((c: { action: string }) => c.action === 'hangup')
      expect(hangup).toBeDefined()
      expect(spokenBy(body.commands).map((s) => s?.text)).toContain(getPrompt('rateLimited', 'en'))
    })

    it('emits captcha gather when voice captcha enabled', async () => {
      const response = await adapter.handleIncomingCall({
        rateLimited: false,
        voiceCaptchaEnabled: true,
        captchaDigits: '1234',
        callerLanguage: 'es',
        callSid: 'call-1',
        callerNumber: '+15551111111',
        hotlineName: 'Test Hotline',
        speechUrl: fakeSpeech,
      })

      const body = JSON.parse(response.body)
      const gather = body.commands.find((c: { action: string }) => c.action === 'gather')
      expect(gather).toBeDefined()
      expect(gather.numDigits).toBe(4)
      expect(gather.callbackEvent).toBe('captcha_response')
      // One clip per digit (ten clips a language, not one per call), each hiding its digit.
      expect(spokenBy(body.commands).slice(-4)).toEqual(['1', '2', '3', '4'].map((digit) => ({ locale: 'es', digit })))
    })

    it('queues caller when no captcha and not rate limited', async () => {
      const response = await adapter.handleIncomingCall({
        rateLimited: false,
        voiceCaptchaEnabled: false,
        callerLanguage: 'en',
        callSid: 'call-xyz',
        callerNumber: '+15551111111',
        hotlineName: 'Test Hotline',
        speechUrl: fakeSpeech,
      })

      const body = JSON.parse(response.body)
      const queue = body.commands.find((c: { action: string }) => c.action === 'queue')
      expect(queue).toBeDefined()
      expect(queue.queueName).toBe('call-xyz')
    })
  })

  describe('handleCaptchaResponse', () => {
    it('queues caller when digits match', async () => {
      const response = await adapter.handleCaptchaResponse({
        digits: '1234',
        expectedDigits: '1234',
        callerLanguage: 'en',
        callSid: 'call-1',
        speechUrl: fakeSpeech,
      })

      const body = JSON.parse(response.body)
      const queue = body.commands.find((c: { action: string }) => c.action === 'queue')
      expect(queue).toBeDefined()
    })

    it('hangs up when digits do not match', async () => {
      const response = await adapter.handleCaptchaResponse({
        digits: '9999',
        expectedDigits: '1234',
        callerLanguage: 'en',
        callSid: 'call-1',
        speechUrl: fakeSpeech,
      })

      const body = JSON.parse(response.body)
      const hangup = body.commands.find((c: { action: string }) => c.action === 'hangup')
      expect(hangup).toBeDefined()
    })
  })

  describe('handleCallAnswered', () => {
    it('bridges the call with recording', async () => {
      const response = await adapter.handleCallAnswered({
        parentCallSid: 'parent-call-123',
        callbackUrl: 'http://callback.local/recording',
        userPubkey: 'pubkey123',
      })

      const body = JSON.parse(response.body)
      const bridge = body.commands.find((c: { action: string }) => c.action === 'bridge')
      expect(bridge).toBeDefined()
      expect(bridge.queueName).toBe('parent-call-123')
      expect(bridge.record).toBe(true)
    })
  })

  describe('handleVoicemail', () => {
    it('emits record command with configurable max duration', async () => {
      const response = await adapter.handleVoicemail({
        callSid: 'call-1',
        callerLanguage: 'en',
        callbackUrl: 'http://callback.local/voicemail',
        maxRecordingSeconds: 60,
        speechUrl: fakeSpeech,
      })

      const body = JSON.parse(response.body)
      const record = body.commands.find((c: { action: string }) => c.action === 'record')
      expect(record).toBeDefined()
      expect(record.maxDuration).toBe(60)
      expect(record.finishOnKey).toBe('#')
    })

    it('defaults to 120 seconds when maxRecordingSeconds not provided', async () => {
      const response = await adapter.handleVoicemail({
        callSid: 'call-2',
        callerLanguage: 'en',
        callbackUrl: 'http://callback.local/voicemail',
        speechUrl: fakeSpeech,
      })

      const body = JSON.parse(response.body)
      const record = body.commands.find((c: { action: string }) => c.action === 'record')
      expect(record.maxDuration).toBe(120)
    })
  })

  describe('handleWaitMusic', () => {
    it('leaves queue when time exceeds timeout', async () => {
      const response = await adapter.handleWaitMusic('en', undefined, 100, 90)

      const body = JSON.parse(response.body)
      const leave = body.commands.find((c: { action: string }) => c.action === 'leave_queue')
      expect(leave).toBeDefined()
    })

    it('plays hold music when under timeout', async () => {
      const response = await adapter.handleWaitMusic('en', undefined, 30, 90, fakeSpeech)

      const body = JSON.parse(response.body)
      // Should have speak or play command, not leave_queue
      expect(body.commands.some((c: { action: string }) => c.action === 'leave_queue')).toBe(false)
    })

    it('defaults timeout to 90 seconds', async () => {
      // queueTime=89 should NOT leave
      const response = await adapter.handleWaitMusic('en', undefined, 89, undefined, fakeSpeech)
      const body = JSON.parse(response.body)
      expect(body.commands.some((c: { action: string }) => c.action === 'leave_queue')).toBe(false)

      // queueTime=90 SHOULD leave (>= 90)
      const response2 = await adapter.handleWaitMusic('en', undefined, 90)
      const body2 = JSON.parse(response2.body)
      expect(body2.commands.some((c: { action: string }) => c.action === 'leave_queue')).toBe(true)
    })
  })

  describe('rejectCall', () => {
    it('returns hangup with rejected reason', () => {
      const response = adapter.rejectCall()
      const body = JSON.parse(response.body)
      expect(body.commands[0].action).toBe('hangup')
      expect(body.commands[0].reason).toBe('rejected')
    })
  })

  describe('emptyResponse', () => {
    it('returns JSON with empty commands array', () => {
      const response = adapter.emptyResponse()
      expect(response.contentType).toBe('application/json')
      const body = JSON.parse(response.body)
      expect(body.commands).toEqual([])
    })
  })

  describe('handleVoicemailComplete', () => {
    it('speaks thank you and hangs up', () => {
      const response = adapter.handleVoicemailComplete('en', fakeSpeech)
      const body = JSON.parse(response.body)
      expect(spokenBy(body.commands)).toEqual([{ locale: 'en', text: getVoicemailThanks('en') }])
      expect(body.commands[body.commands.length - 1].action).toBe('hangup')
    })

    it('refuses to answer without a speech builder: a PBX cannot speak text itself', () => {
      expect(() => adapter.handleVoicemailComplete('en')).toThrow(/speech URL builder/)
    })
  })
})
