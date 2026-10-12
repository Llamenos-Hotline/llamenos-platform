import { describe, it, expect } from 'vitest'
import {
  sipCredentialsMayBeIssued,
  isSipConfigured,
  generateSipParams,
} from '@worker/telephony/sip-tokens'
import type { TelephonyProviderConfig } from '@shared/types'

/**
 * #1203 — `/api/telephony/sip-token` would hand every volunteer the hub's own
 * SIP trunk credential, pointed at the telephony vendor.
 *
 * The bar for flipping `sipCredentialsMayBeIssued` to true is NOT "some
 * provider supports per-user credentials" — a per-volunteer credential at the
 * vendor still registers against the vendor's domain and still leaks every
 * volunteer's IP and presence to them. It is: registration against
 * infrastructure we run, with a real per-volunteer identity.
 *
 * That is now exactly the asterisk case: /sip-token issues `vol_<pubkey16>`
 * with a derived per-endpoint secret, provisioned on OUR OWN PBX over ARI
 * (telephony/registrar.ts) and individually revocable. Every vendor stays
 * refused, and these rails keep the vendor refusal loud.
 */
const HUB_TRUNK_PASSWORD = 'hub-shared-trunk-secret'

function twilioConfig(): TelephonyProviderConfig {
  return {
    type: 'twilio',
    accountSid: 'AC123',
    authToken: 'tok',
    sipDomain: 'example.sip.twilio.com',
    sipUsername: 'hub-trunk',
    sipPassword: HUB_TRUNK_PASSWORD,
  } as unknown as TelephonyProviderConfig
}

function asteriskConfig(): TelephonyProviderConfig {
  return {
    type: 'asterisk',
    phoneNumber: '+1234567890',
    ariUrl: 'http://asterisk:8088',
    ariUsername: 'llamenos',
    ariPassword: 'ari-pass',
    sipDomain: 'pbx.example.org',
  } as unknown as TelephonyProviderConfig
}

describe('#1203 shared SIP trunk credential is not issued', () => {
  it('refuses to issue for a fully SIP-configured vendor provider', () => {
    const config = twilioConfig()
    // The provider IS configured — this is not "nothing to issue", it is
    // "there is something to issue and we decline to".
    expect(isSipConfigured(config)).toBe(true)
    expect(sipCredentialsMayBeIssued(config)).toBe(false)
  })

  it('refuses for every vendor provider type', () => {
    for (const type of ['twilio', 'signalwire', 'vonage', 'plivo'] as const) {
      expect(sipCredentialsMayBeIssued({ ...twilioConfig(), type } as TelephonyProviderConfig)).toBe(false)
    }
  })

  it('refuses for providers with no SIP client support at all', () => {
    for (const type of ['telnyx', 'bandwidth', 'freeswitch'] as const) {
      expect(sipCredentialsMayBeIssued({ ...twilioConfig(), type } as TelephonyProviderConfig)).toBe(false)
    }
  })

  it('refuses when there is no provider at all', () => {
    expect(sipCredentialsMayBeIssued(null)).toBe(false)
  })

  /**
   * The safe half of the #1435 refusal: per-volunteer identities against our
   * OWN registrar. The vendor generators are deliberately left intact and
   * stay unreachable — the gate, not the generators, is what changed.
   */
  it('issues for provider:asterisk only — our own registrar, per-volunteer identities', () => {
    const config = asteriskConfig()
    expect(isSipConfigured(config)).toBe(true)
    expect(sipCredentialsMayBeIssued(config)).toBe(true)
  })

  it('does not issue for asterisk without its registrar configuration', () => {
    // sipDomain absent: clients would have nowhere to register.
    expect(isSipConfigured(asteriskConfig())).toBe(true)
    expect(isSipConfigured({ ...asteriskConfig(), sipDomain: undefined })).toBe(false)
    expect(isSipConfigured({ ...asteriskConfig(), ariUrl: undefined })).toBe(false)
    expect(isSipConfigured({ ...asteriskConfig(), ariUsername: undefined })).toBe(false)
    expect(isSipConfigured({ ...asteriskConfig(), ariPassword: undefined })).toBe(false)
  })

  /**
   * The generators are deliberately left intact — the refusal is at the route,
   * and this documents WHY they cannot simply be called instead. If this test
   * ever fails because a generator started deriving a per-volunteer secret,
   * that is good news, but read #1203's point (3) before relaxing the guard:
   * the vendor still sees the registration.
   */
  it('the vendor generator still returns the hub credential verbatim — which is the reason for the guard', () => {
    const params = generateSipParams(twilioConfig(), 'vol_abc123')
    expect(params.sip.password).toBe(HUB_TRUNK_PASSWORD)
    // Identity is accepted and ignored: nothing about the credential is
    // per-volunteer.
    const other = generateSipParams(twilioConfig(), 'vol_completely_different')
    expect(other.sip.password).toBe(params.sip.password)
    expect(other.sip.username).toBe(params.sip.username)
  })

  /**
   * The asterisk branch is gone from the shared generator: the ONLY issuable
   * asterisk credential is the per-volunteer identity (registrar.ts). Calling
   * generateSipParams for asterisk must fail loudly, never fall back to the
   * hub-scoped sipUsername/sipPassword.
   */
  it('generateSipParams has no asterisk shared-credential branch anymore', () => {
    const config = {
      ...asteriskConfig(),
      sipUsername: 'hub-trunk',
      sipPassword: HUB_TRUNK_PASSWORD,
    } as TelephonyProviderConfig
    expect(() => generateSipParams(config, 'vol_abc123')).toThrow('SIP not supported for provider: asterisk')
  })
})
