/**
 * Tests for sip-tokens.ts — SIP connection parameter generation.
 *
 * NOTE: The source file is named sip-tokens.ts but contains no JWT logic.
 * It generates provider-agnostic SIP connection params for the Linphone SDK.
 * The shift-overnight and conversation-status targets were skipped because their
 * core logic lives in unexported private functions (isShiftActive) or requires
 * a live database connection (updateMessageStatus).
 */
import { describe, it, expect } from 'vitest'
import { isSipConfigured, generateSipParams } from '@worker/telephony/sip-tokens'
import type { TelephonyProviderConfig } from '@shared/types'

// Minimal valid configs for each provider
const twilioConfig: TelephonyProviderConfig = {
  type: 'twilio',
  accountSid: 'ACtest',
  authToken: 'token',
  phoneNumber: '+15550000000',
  sipDomain: 'myapp.sip.twilio.com',
  sipUsername: 'user',
  sipPassword: 'pass',
}

const asteriskConfig: TelephonyProviderConfig = {
  type: 'asterisk',
  phoneNumber: '+15550000002',
  sipDomain: 'pbx.example.com',
  ariUrl: 'http://pbx.example.com:8088/ari',
  ariUsername: 'llamenos',
  ariPassword: 'ari-secret',
}

const plivoConfig: TelephonyProviderConfig = {
  type: 'plivo',
  authId: 'id',
  authToken: 'tok',
  phoneNumber: '+15550000001',
  sipEndpointUsername: 'plivouser',
  sipEndpointPassword: 'plivo123',
}

describe('isSipConfigured', () => {
  it('returns false for null', () => {
    expect(isSipConfigured(null)).toBe(false)
  })

  it('returns true for complete Twilio SIP config', () => {
    expect(isSipConfigured(twilioConfig)).toBe(true)
  })

  it('returns false for Twilio without sipDomain', () => {
    const cfg = { ...twilioConfig, sipDomain: undefined }
    expect(isSipConfigured(cfg as TelephonyProviderConfig)).toBe(false)
  })

  it('returns true for complete Asterisk config', () => {
    expect(isSipConfigured(asteriskConfig)).toBe(true)
  })

  it('returns false for Asterisk missing ARI credentials', () => {
    const cfg = { ...asteriskConfig, ariPassword: undefined }
    expect(isSipConfigured(cfg as TelephonyProviderConfig)).toBe(false)
  })

  it('returns false for Asterisk missing the registrar domain', () => {
    const cfg = { ...asteriskConfig, sipDomain: undefined }
    expect(isSipConfigured(cfg as TelephonyProviderConfig)).toBe(false)
  })

  it('returns true for Plivo with endpoint credentials', () => {
    expect(isSipConfigured(plivoConfig)).toBe(true)
  })

  it('returns false for Plivo without sipEndpointUsername', () => {
    const cfg = { ...plivoConfig, sipEndpointUsername: undefined }
    expect(isSipConfigured(cfg as TelephonyProviderConfig)).toBe(false)
  })
})

describe('generateSipParams', () => {
  it('Twilio: returns correct provider and TLS transport', () => {
    const params = generateSipParams(twilioConfig, 'volunteer1')
    expect(params.provider).toBe('twilio')
    expect(params.sip.transport).toBe('tls')
    expect(params.sip.domain).toBe('myapp.sip.twilio.com')
    expect(params.sip.username).toBe('user')
    expect(params.sip.password).toBe('pass')
    expect(params.sip.mediaEncryption).toBe('srtp')
  })

  it('Twilio: includes an ICE server', () => {
    const params = generateSipParams(twilioConfig, 'vol')
    expect(params.sip.iceServers.length).toBeGreaterThan(0)
    expect(params.sip.iceServers[0].url).toMatch(/^stun:/)
  })

  it('Asterisk: no shared-credential branch — the per-volunteer registrar path is the only credential', () => {
    expect(() => generateSipParams(asteriskConfig, 'vol')).toThrow(
      'SIP not supported for provider: asterisk',
    )
  })

  it('Plivo: uses phone.plivo.com domain', () => {
    const params = generateSipParams(plivoConfig, 'vol')
    expect(params.provider).toBe('plivo')
    expect(params.sip.domain).toBe('phone.plivo.com')
    expect(params.sip.username).toBe('plivouser')
    expect(params.sip.password).toBe('plivo123')
  })

  it('throws for unsupported provider', () => {
    const cfg = { type: 'unknown' } as unknown as TelephonyProviderConfig
    expect(() => generateSipParams(cfg, 'vol')).toThrow()
  })
})
