import { describe, it, expect } from 'vitest'
import { isSipConfigured, generateSipParams } from '@worker/telephony/sip-tokens'
import type { TelephonyProviderConfig } from '@shared/types'

function twilioConfig(overrides?: Partial<TelephonyProviderConfig>): TelephonyProviderConfig {
  return {
    type: 'twilio',
    phoneNumber: '+1234567890',
    accountSid: 'AC_test',
    authToken: 'tok_test',
    sipDomain: 'sip.test.twilio.com',
    sipUsername: 'user_test',
    sipPassword: 'pass_test',
    ...overrides,
  }
}

function signalwireConfig(overrides?: Partial<TelephonyProviderConfig>): TelephonyProviderConfig {
  return {
    type: 'signalwire',
    phoneNumber: '+1234567890',
    accountSid: 'AC_test',
    authToken: 'tok_test',
    signalwireSpace: 'myspace.signalwire.com',
    sipDomain: 'sip.test.signalwire.com',
    sipUsername: 'user_test',
    sipPassword: 'pass_test',
    spaceUrl: 'https://myspace.signalwire.com',
    ...overrides,
  }
}

function vonageConfig(overrides?: Partial<TelephonyProviderConfig>): TelephonyProviderConfig {
  return {
    type: 'vonage',
    phoneNumber: '+1234567890',
    apiKey: 'key_test',
    apiSecret: 'secret_test',
    applicationId: 'app_test',
    asteriskGateway: 'gw.test.com',
    asteriskSipUsername: 'user_test',
    asteriskSipPassword: 'pass_test',
    ...overrides,
  }
}

function plivoConfig(overrides?: Partial<TelephonyProviderConfig>): TelephonyProviderConfig {
  return {
    type: 'plivo',
    phoneNumber: '+1234567890',
    authId: 'auth_test',
    authToken: 'tok_test',
    sipEndpointUsername: 'endpoint_user',
    sipEndpointPassword: 'endpoint_pass',
    ...overrides,
  }
}

function asteriskConfig(overrides?: Partial<TelephonyProviderConfig>): TelephonyProviderConfig {
  return {
    type: 'asterisk',
    phoneNumber: '+1234567890',
    ariUrl: 'https://asterisk.test:8089/ari',
    ariUsername: 'ari_user',
    ariPassword: 'ari_pass',
    bridgeSecret: 'bridge_secret',
    sipDomain: 'sip.asterisk.test',
    sipUsername: 'sip_user',
    sipPassword: 'sip_pass',
    ...overrides,
  }
}

describe('isSipConfigured', () => {
  it('returns false for null config', () => {
    expect(isSipConfigured(null)).toBe(false)
  })

  describe('twilio', () => {
    it('returns true when all SIP fields are present', () => {
      expect(isSipConfigured(twilioConfig())).toBe(true)
    })

    it('returns false when accountSid is missing', () => {
      expect(isSipConfigured(twilioConfig({ accountSid: undefined }))).toBe(false)
    })

    it('returns false when sipDomain is missing', () => {
      expect(isSipConfigured(twilioConfig({ sipDomain: undefined }))).toBe(false)
    })

    it('returns false when sipUsername is missing', () => {
      expect(isSipConfigured(twilioConfig({ sipUsername: undefined }))).toBe(false)
    })

    it('returns false when sipPassword is missing', () => {
      expect(isSipConfigured(twilioConfig({ sipPassword: undefined }))).toBe(false)
    })
  })

  describe('signalwire', () => {
    it('returns true when all SIP fields are present', () => {
      expect(isSipConfigured(signalwireConfig())).toBe(true)
    })

    it('returns false when accountSid is missing', () => {
      expect(isSipConfigured(signalwireConfig({ accountSid: undefined }))).toBe(false)
    })

    it('returns false when sipDomain is missing', () => {
      expect(isSipConfigured(signalwireConfig({ sipDomain: undefined }))).toBe(false)
    })

    it('returns false when sipUsername is missing', () => {
      expect(isSipConfigured(signalwireConfig({ sipUsername: undefined }))).toBe(false)
    })

    it('returns false when sipPassword is missing', () => {
      expect(isSipConfigured(signalwireConfig({ sipPassword: undefined }))).toBe(false)
    })
  })

  describe('vonage', () => {
    it('returns true when Asterisk gateway fields are present', () => {
      expect(isSipConfigured(vonageConfig())).toBe(true)
    })

    it('returns false when asteriskGateway is missing', () => {
      expect(isSipConfigured(vonageConfig({ asteriskGateway: undefined }))).toBe(false)
    })

    it('returns false when asteriskSipUsername is missing', () => {
      expect(isSipConfigured(vonageConfig({ asteriskSipUsername: undefined }))).toBe(false)
    })

    it('returns false when asteriskSipPassword is missing', () => {
      expect(isSipConfigured(vonageConfig({ asteriskSipPassword: undefined }))).toBe(false)
    })
  })

  describe('plivo', () => {
    it('returns true when SIP endpoint fields are present', () => {
      expect(isSipConfigured(plivoConfig())).toBe(true)
    })

    it('returns false when sipEndpointUsername is missing', () => {
      expect(isSipConfigured(plivoConfig({ sipEndpointUsername: undefined }))).toBe(false)
    })

    it('returns false when sipEndpointPassword is missing', () => {
      expect(isSipConfigured(plivoConfig({ sipEndpointPassword: undefined }))).toBe(false)
    })
  })

  describe('asterisk', () => {
    // Per-volunteer issuance needs the registrar's public SIP domain plus ARI
    // access to provision the endpoint — not the hub-scoped sipUsername/
    // sipPassword, which the per-volunteer path exists to avoid.
    it('returns true when the registrar domain and ARI credentials are present', () => {
      expect(isSipConfigured(asteriskConfig())).toBe(true)
    })

    it('returns false when sipDomain is missing', () => {
      expect(isSipConfigured(asteriskConfig({ sipDomain: undefined }))).toBe(false)
    })

    it('returns false when ariUrl is missing', () => {
      expect(isSipConfigured(asteriskConfig({ ariUrl: undefined }))).toBe(false)
    })

    it('returns false when ariUsername is missing', () => {
      expect(isSipConfigured(asteriskConfig({ ariUsername: undefined }))).toBe(false)
    })

    it('returns false when ariPassword is missing', () => {
      expect(isSipConfigured(asteriskConfig({ ariPassword: undefined }))).toBe(false)
    })

    it('ignores the hub-scoped sipUsername/sipPassword — they are the shared credential', () => {
      expect(isSipConfigured(asteriskConfig({ sipUsername: undefined, sipPassword: undefined }))).toBe(true)
    })
  })

  describe('unsupported provider', () => {
    it('returns false for telnyx', () => {
      const config: TelephonyProviderConfig = {
        type: 'telnyx',
        phoneNumber: '+1234567890',
        apiKey: 'key',
        connectionId: 'conn',
      }
      expect(isSipConfigured(config)).toBe(false)
    })

    it('returns false for bandwidth', () => {
      const config: TelephonyProviderConfig = {
        type: 'bandwidth',
        phoneNumber: '+1234567890',
        authId: 'id',
        authToken: 'tok',
        bandwidthAppId: 'app',
      }
      expect(isSipConfigured(config)).toBe(false)
    })

    it('returns false for freeswitch', () => {
      const config: TelephonyProviderConfig = {
        type: 'freeswitch',
        phoneNumber: '+1234567890',
        freeswitchBridgeUrl: 'https://fs.test',
        freeswitchBridgeSecret: 'secret',
      }
      expect(isSipConfigured(config)).toBe(false)
    })
  })
})

describe('generateSipParams', () => {
  const identity = 'volunteer-42'

  describe('twilio', () => {
    it('generates correct SIP params', () => {
      const result = generateSipParams(twilioConfig(), identity)
      expect(result.provider).toBe('twilio')
      expect(result.sip.domain).toBe('sip.test.twilio.com')
      expect(result.sip.transport).toBe('tls')
      expect(result.sip.username).toBe('user_test')
      expect(result.sip.password).toBe('pass_test')
      expect(result.sip.mediaEncryption).toBe('srtp')
      expect(result.sip.iceServers).toEqual([
        { url: 'stun:global.stun.twilio.com:3478' },
      ])
    })

    it('throws when sipDomain is missing', () => {
      expect(() => generateSipParams(twilioConfig({ sipDomain: undefined }), identity)).toThrow(
        'Missing Twilio SIP config: sipDomain, sipUsername, sipPassword',
      )
    })

    it('throws when sipUsername is missing', () => {
      expect(() => generateSipParams(twilioConfig({ sipUsername: undefined }), identity)).toThrow(
        'Missing Twilio SIP config: sipDomain, sipUsername, sipPassword',
      )
    })

    it('throws when sipPassword is missing', () => {
      expect(() => generateSipParams(twilioConfig({ sipPassword: undefined }), identity)).toThrow(
        'Missing Twilio SIP config: sipDomain, sipUsername, sipPassword',
      )
    })
  })

  describe('signalwire', () => {
    it('generates correct SIP params using spaceUrl', () => {
      const result = generateSipParams(signalwireConfig(), identity)
      expect(result.provider).toBe('signalwire')
      expect(result.sip.domain).toBe('myspace.signalwire.com')
      expect(result.sip.transport).toBe('tls')
      expect(result.sip.username).toBe('user_test')
      expect(result.sip.password).toBe('pass_test')
      expect(result.sip.mediaEncryption).toBe('srtp')
      expect(result.sip.iceServers).toEqual([
        { url: 'stun:myspace.signalwire.com:3478' },
      ])
    })

    it('falls back to sipDomain when spaceUrl is missing', () => {
      const result = generateSipParams(signalwireConfig({ spaceUrl: undefined }), identity)
      expect(result.sip.domain).toBe('sip.test.signalwire.com')
      expect(result.sip.iceServers).toEqual([
        { url: 'stun:sip.test.signalwire.com:3478' },
      ])
    })

    it('strips protocol and trailing slash from spaceUrl', () => {
      const result = generateSipParams(
        signalwireConfig({ spaceUrl: 'https://custom.signalwire.com/' }),
        identity,
      )
      expect(result.sip.domain).toBe('custom.signalwire.com')
    })

    it('throws when sipDomain is missing', () => {
      expect(() => generateSipParams(signalwireConfig({ sipDomain: undefined }), identity)).toThrow(
        'Missing SignalWire SIP config',
      )
    })

    it('throws when sipUsername is missing', () => {
      expect(() => generateSipParams(signalwireConfig({ sipUsername: undefined }), identity)).toThrow(
        'Missing SignalWire SIP config',
      )
    })

    it('throws when sipPassword is missing', () => {
      expect(() => generateSipParams(signalwireConfig({ sipPassword: undefined }), identity)).toThrow(
        'Missing SignalWire SIP config',
      )
    })
  })

  describe('vonage', () => {
    it('generates correct SIP params via Asterisk gateway', () => {
      const result = generateSipParams(vonageConfig(), identity)
      expect(result.provider).toBe('vonage')
      expect(result.sip.domain).toBe('gw.test.com')
      expect(result.sip.transport).toBe('tls')
      expect(result.sip.username).toBe('user_test')
      expect(result.sip.password).toBe('pass_test')
      expect(result.sip.mediaEncryption).toBe('zrtp')
      expect(result.sip.iceServers).toEqual([
        { url: 'stun:gw.test.com:3478' },
      ])
    })

    it('throws when asteriskGateway is missing', () => {
      expect(() => generateSipParams(vonageConfig({ asteriskGateway: undefined }), identity)).toThrow(
        'Missing Vonage→Asterisk gateway config',
      )
    })

    it('throws when asteriskSipUsername is missing', () => {
      expect(() => generateSipParams(vonageConfig({ asteriskSipUsername: undefined }), identity)).toThrow(
        'Missing Vonage→Asterisk gateway config',
      )
    })

    it('throws when asteriskSipPassword is missing', () => {
      expect(() => generateSipParams(vonageConfig({ asteriskSipPassword: undefined }), identity)).toThrow(
        'Missing Vonage→Asterisk gateway config',
      )
    })
  })

  describe('plivo', () => {
    it('generates correct SIP params', () => {
      const result = generateSipParams(plivoConfig(), identity)
      expect(result.provider).toBe('plivo')
      expect(result.sip.domain).toBe('phone.plivo.com')
      expect(result.sip.transport).toBe('tls')
      expect(result.sip.username).toBe('endpoint_user')
      expect(result.sip.password).toBe('endpoint_pass')
      expect(result.sip.mediaEncryption).toBe('srtp')
      expect(result.sip.iceServers).toEqual([
        { url: 'stun:stun.plivo.com:3478' },
      ])
    })

    it('throws when sipEndpointUsername is missing', () => {
      expect(() => generateSipParams(plivoConfig({ sipEndpointUsername: undefined }), identity)).toThrow(
        'Missing Plivo SIP endpoint config',
      )
    })

    it('throws when sipEndpointPassword is missing', () => {
      expect(() => generateSipParams(plivoConfig({ sipEndpointPassword: undefined }), identity)).toThrow(
        'Missing Plivo SIP endpoint config',
      )
    })
  })

  describe('asterisk', () => {
    // No shared-credential branch: the only issuable asterisk credential is
    // the per-volunteer identity built by telephony/registrar.ts.
    it('throws — the per-volunteer path is the only asterisk credential', () => {
      expect(() => generateSipParams(asteriskConfig(), identity)).toThrow(
        'SIP not supported for provider: asterisk',
      )
    })
  })

  describe('unsupported provider', () => {
    it('throws for telnyx', () => {
      const config: TelephonyProviderConfig = {
        type: 'telnyx',
        phoneNumber: '+1234567890',
        apiKey: 'key',
        connectionId: 'conn',
      }
      expect(() => generateSipParams(config, identity)).toThrow('SIP not supported for provider: telnyx')
    })

    it('throws for bandwidth', () => {
      const config: TelephonyProviderConfig = {
        type: 'bandwidth',
        phoneNumber: '+1234567890',
        authId: 'id',
        authToken: 'tok',
        bandwidthAppId: 'app',
      }
      expect(() => generateSipParams(config, identity)).toThrow('SIP not supported for provider: bandwidth')
    })

    it('throws for freeswitch', () => {
      const config: TelephonyProviderConfig = {
        type: 'freeswitch',
        phoneNumber: '+1234567890',
        freeswitchBridgeUrl: 'https://fs.test',
        freeswitchBridgeSecret: 'secret',
      }
      expect(() => generateSipParams(config, identity)).toThrow('SIP not supported for provider: freeswitch')
    })
  })
})
