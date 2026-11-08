import { createVerify, generateKeyPairSync } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { generateWebRtcToken, isWebRtcConfigured } from '@worker/telephony/webrtc-tokens'
import type { TelephonyProviderConfig } from '@shared/types'

function twilioConfig(overrides?: Partial<TelephonyProviderConfig>): TelephonyProviderConfig {
  return {
    type: 'twilio',
    phoneNumber: '+1234567890',
    accountSid: 'AC_test',
    authToken: 'tok_test',
    webrtcEnabled: true,
    apiKeySid: 'api_key_sid',
    apiKeySecret: 'api_key_secret',
    twimlAppSid: 'twiml_app_sid',
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
    webrtcEnabled: true,
    apiKeySid: 'api_key_sid',
    apiKeySecret: 'api_key_secret',
    twimlAppSid: 'twiml_app_sid',
    ...overrides,
  }
}

/**
 * Throwaway RS256 signing key for the Vonage token, generated per test run so no
 * private key material is committed (#2560). The public half verifies the signature.
 */
const vonageSigningKey = (() => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) as string,
  }
})()

function decodeJwtSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf-8'))
}

function vonageConfig(overrides?: Partial<TelephonyProviderConfig>): TelephonyProviderConfig {
  return {
    type: 'vonage',
    phoneNumber: '+1234567890',
    apiKey: 'key_test',
    apiSecret: 'secret_test',
    applicationId: 'app_test',
    webrtcEnabled: true,
    privateKey: vonageSigningKey.privateKeyPem,
    ...overrides,
  }
}

function plivoConfig(overrides?: Partial<TelephonyProviderConfig>): TelephonyProviderConfig {
  return {
    type: 'plivo',
    phoneNumber: '+1234567890',
    authId: 'auth_test',
    authToken: 'tok_test',
    webrtcEnabled: true,
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
    webrtcEnabled: true,
    ...overrides,
  }
}

describe('isWebRtcConfigured', () => {
  it('returns false for null config', () => {
    expect(isWebRtcConfigured(null)).toBe(false)
  })

  it('returns false when webrtcEnabled is false', () => {
    expect(isWebRtcConfigured(twilioConfig({ webrtcEnabled: false }))).toBe(false)
  })

  it('returns false when webrtcEnabled is undefined', () => {
    expect(isWebRtcConfigured(twilioConfig({ webrtcEnabled: undefined }))).toBe(false)
  })

  describe('twilio', () => {
    it('returns true when all WebRTC fields are present', () => {
      expect(isWebRtcConfigured(twilioConfig())).toBe(true)
    })

    it('returns false when apiKeySid is missing', () => {
      expect(isWebRtcConfigured(twilioConfig({ apiKeySid: undefined }))).toBe(false)
    })

    it('returns false when apiKeySecret is missing', () => {
      expect(isWebRtcConfigured(twilioConfig({ apiKeySecret: undefined }))).toBe(false)
    })

    it('returns false when twimlAppSid is missing', () => {
      expect(isWebRtcConfigured(twilioConfig({ twimlAppSid: undefined }))).toBe(false)
    })
  })

  describe('signalwire', () => {
    it('returns true when all WebRTC fields are present', () => {
      expect(isWebRtcConfigured(signalwireConfig())).toBe(true)
    })

    it('returns false when apiKeySid is missing', () => {
      expect(isWebRtcConfigured(signalwireConfig({ apiKeySid: undefined }))).toBe(false)
    })

    it('returns false when apiKeySecret is missing', () => {
      expect(isWebRtcConfigured(signalwireConfig({ apiKeySecret: undefined }))).toBe(false)
    })

    it('returns false when twimlAppSid is missing', () => {
      expect(isWebRtcConfigured(signalwireConfig({ twimlAppSid: undefined }))).toBe(false)
    })
  })

  describe('vonage', () => {
    it('returns true when applicationId and privateKey are present', () => {
      expect(isWebRtcConfigured(vonageConfig())).toBe(true)
    })

    it('returns false when applicationId is missing', () => {
      expect(isWebRtcConfigured(vonageConfig({ applicationId: undefined }))).toBe(false)
    })

    it('returns false when privateKey is missing', () => {
      expect(isWebRtcConfigured(vonageConfig({ privateKey: undefined }))).toBe(false)
    })
  })

  describe('plivo', () => {
    it('returns true when authId and authToken are present', () => {
      expect(isWebRtcConfigured(plivoConfig())).toBe(true)
    })

    it('returns false when authId is missing', () => {
      expect(isWebRtcConfigured(plivoConfig({ authId: undefined }))).toBe(false)
    })

    it('returns false when authToken is missing', () => {
      expect(isWebRtcConfigured(plivoConfig({ authToken: undefined }))).toBe(false)
    })
  })

  describe('unsupported provider', () => {
    it('returns false for asterisk', () => {
      expect(isWebRtcConfigured(asteriskConfig())).toBe(false)
    })

    it('returns false for telnyx', () => {
      const config: TelephonyProviderConfig = {
        type: 'telnyx',
        phoneNumber: '+1234567890',
        apiKey: 'key',
        connectionId: 'conn',
        webrtcEnabled: true,
      }
      expect(isWebRtcConfigured(config)).toBe(false)
    })

    it('returns false for bandwidth', () => {
      const config: TelephonyProviderConfig = {
        type: 'bandwidth',
        phoneNumber: '+1234567890',
        authId: 'id',
        authToken: 'tok',
        bandwidthAppId: 'app',
        webrtcEnabled: true,
      }
      expect(isWebRtcConfigured(config)).toBe(false)
    })

    it('returns false for freeswitch', () => {
      const config: TelephonyProviderConfig = {
        type: 'freeswitch',
        phoneNumber: '+1234567890',
        freeswitchBridgeUrl: 'https://fs.test',
        freeswitchBridgeSecret: 'secret',
        webrtcEnabled: true,
      }
      expect(isWebRtcConfigured(config)).toBe(false)
    })
  })
})

describe('generateWebRtcToken', () => {
  const identity = 'volunteer-42'

  describe('twilio', () => {
    it('returns a JWT with 3 parts separated by dots', async () => {
      const result = await generateWebRtcToken(twilioConfig(), identity)
      expect(result.provider).toBe('twilio')
      const parts = result.token.split('.')
      expect(parts).toHaveLength(3)
    })

    it('throws when apiKeySid is missing', async () => {
      await expect(generateWebRtcToken(twilioConfig({ apiKeySid: undefined }), identity)).rejects.toThrow(
        'Missing Twilio WebRTC config: apiKeySid, apiKeySecret, twimlAppSid, accountSid',
      )
    })

    it('throws when apiKeySecret is missing', async () => {
      await expect(generateWebRtcToken(twilioConfig({ apiKeySecret: undefined }), identity)).rejects.toThrow(
        'Missing Twilio WebRTC config: apiKeySid, apiKeySecret, twimlAppSid, accountSid',
      )
    })

    it('throws when twimlAppSid is missing', async () => {
      await expect(generateWebRtcToken(twilioConfig({ twimlAppSid: undefined }), identity)).rejects.toThrow(
        'Missing Twilio WebRTC config: apiKeySid, apiKeySecret, twimlAppSid, accountSid',
      )
    })

    it('throws when accountSid is missing', async () => {
      await expect(generateWebRtcToken(twilioConfig({ accountSid: undefined }), identity)).rejects.toThrow(
        'Missing Twilio WebRTC config: apiKeySid, apiKeySecret, twimlAppSid, accountSid',
      )
    })
  })

  describe('signalwire', () => {
    it('returns a JWT with 3 parts separated by dots', async () => {
      const result = await generateWebRtcToken(signalwireConfig(), identity)
      expect(result.provider).toBe('signalwire')
      const parts = result.token.split('.')
      expect(parts).toHaveLength(3)
    })

    it('throws when apiKeySid is missing', async () => {
      await expect(generateWebRtcToken(signalwireConfig({ apiKeySid: undefined }), identity)).rejects.toThrow(
        'Missing Twilio WebRTC config: apiKeySid, apiKeySecret, twimlAppSid, accountSid',
      )
    })

    it('throws when apiKeySecret is missing', async () => {
      await expect(generateWebRtcToken(signalwireConfig({ apiKeySecret: undefined }), identity)).rejects.toThrow(
        'Missing Twilio WebRTC config: apiKeySid, apiKeySecret, twimlAppSid, accountSid',
      )
    })

    it('throws when twimlAppSid is missing', async () => {
      await expect(generateWebRtcToken(signalwireConfig({ twimlAppSid: undefined }), identity)).rejects.toThrow(
        'Missing Twilio WebRTC config: apiKeySid, apiKeySecret, twimlAppSid, accountSid',
      )
    })

    it('throws when accountSid is missing', async () => {
      await expect(generateWebRtcToken(signalwireConfig({ accountSid: undefined }), identity)).rejects.toThrow(
        'Missing Twilio WebRTC config: apiKeySid, apiKeySecret, twimlAppSid, accountSid',
      )
    })
  })

  describe('vonage', () => {
    it('returns a JWT with 3 parts separated by dots', async () => {
      const result = await generateWebRtcToken(vonageConfig(), identity)
      expect(result.provider).toBe('vonage')
      const parts = result.token.split('.')
      expect(parts).toHaveLength(3)
    })

    it('signs the JWT with the configured RSA key (RS256), verifiable by its public key', async () => {
      const result = await generateWebRtcToken(vonageConfig(), identity)
      const [headerB64, payloadB64, sigB64] = result.token.split('.')

      expect(decodeJwtSegment(headerB64)).toEqual({ typ: 'JWT', alg: 'RS256' })
      const payload = decodeJwtSegment(payloadB64)
      expect(payload.application_id).toBe('app_test')
      expect(payload.sub).toBe(identity)
      expect(payload.exp).toBe((payload.iat as number) + 3600)

      const verifier = createVerify('RSA-SHA256')
      verifier.update(`${headerB64}.${payloadB64}`)
      expect(verifier.verify(vonageSigningKey.publicKeyPem, Buffer.from(sigB64, 'base64url'))).toBe(true)
    })

    it('produces a signature that does not verify under a different key', async () => {
      const result = await generateWebRtcToken(vonageConfig(), identity)
      const [headerB64, payloadB64, sigB64] = result.token.split('.')
      const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey

      const verifier = createVerify('RSA-SHA256')
      verifier.update(`${headerB64}.${payloadB64}`)
      expect(verifier.verify(other, Buffer.from(sigB64, 'base64url'))).toBe(false)
    })

    it('throws when applicationId is missing', async () => {
      await expect(generateWebRtcToken(vonageConfig({ applicationId: undefined }), identity)).rejects.toThrow(
        'Missing Vonage WebRTC config: applicationId, privateKey',
      )
    })

    it('throws when privateKey is missing', async () => {
      await expect(generateWebRtcToken(vonageConfig({ privateKey: undefined }), identity)).rejects.toThrow(
        'Missing Vonage WebRTC config: applicationId, privateKey',
      )
    })
  })

  describe('plivo', () => {
    it('returns a base64url-decodable JSON token', async () => {
      const result = await generateWebRtcToken(plivoConfig(), identity)
      expect(result.provider).toBe('plivo')

      const padded = result.token.padEnd(result.token.length + ((4 - (result.token.length % 4)) % 4), '=')
      const normalized = padded.replace(/-/g, '+').replace(/_/g, '/')
      const decoded = Buffer.from(normalized, 'base64').toString('utf-8')
      const parsed = JSON.parse(decoded)

      expect(parsed.username).toBe(`${identity}@app.plivo.com`)
      expect(parsed.authId).toBe('auth_test')
      expect(typeof parsed.exp).toBe('number')
      expect(typeof parsed.sig).toBe('string')
      expect(parsed.sig).toHaveLength(64)
    })

    it('throws when authId is missing', async () => {
      await expect(generateWebRtcToken(plivoConfig({ authId: undefined }), identity)).rejects.toThrow(
        'Missing Plivo WebRTC config: authId, authToken',
      )
    })

    it('throws when authToken is missing', async () => {
      await expect(generateWebRtcToken(plivoConfig({ authToken: undefined }), identity)).rejects.toThrow(
        'Missing Plivo WebRTC config: authId, authToken',
      )
    })
  })

  describe('asterisk', () => {
    it('throws because Asterisk WebRTC is not yet supported', async () => {
      await expect(generateWebRtcToken(asteriskConfig(), identity)).rejects.toThrow(
        'Asterisk WebRTC requires JsSIP configuration (Epic 35)',
      )
    })
  })

  describe('unsupported provider', () => {
    it('throws for telnyx', async () => {
      const config: TelephonyProviderConfig = {
        type: 'telnyx',
        phoneNumber: '+1234567890',
        apiKey: 'key',
        connectionId: 'conn',
      }
      await expect(generateWebRtcToken(config, identity)).rejects.toThrow(
        'WebRTC not supported for provider: telnyx',
      )
    })

    it('throws for bandwidth', async () => {
      const config: TelephonyProviderConfig = {
        type: 'bandwidth',
        phoneNumber: '+1234567890',
        authId: 'id',
        authToken: 'tok',
        bandwidthAppId: 'app',
      }
      await expect(generateWebRtcToken(config, identity)).rejects.toThrow(
        'WebRTC not supported for provider: bandwidth',
      )
    })

    it('throws for freeswitch', async () => {
      const config: TelephonyProviderConfig = {
        type: 'freeswitch',
        phoneNumber: '+1234567890',
        freeswitchBridgeUrl: 'https://fs.test',
        freeswitchBridgeSecret: 'secret',
      }
      await expect(generateWebRtcToken(config, identity)).rejects.toThrow(
        'WebRTC not supported for provider: freeswitch',
      )
    })
  })
})
