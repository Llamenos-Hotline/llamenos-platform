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
 * The leak is latent only because no client completes registration (#1188).
 * Finishing that work activates it, so the refusal lives on the server and
 * these rails make removing it loud.
 *
 * The bar for flipping `sipCredentialsMayBeIssued` to true is NOT "some
 * provider supports per-user credentials" — a per-volunteer credential at the
 * vendor still registers against the vendor's domain and still leaks every
 * volunteer's IP and presence to them. It is #1173: registration against
 * infrastructure we run.
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

describe('#1203 shared SIP trunk credential is not issued', () => {
  it('refuses to issue for a fully SIP-configured provider', () => {
    const config = twilioConfig()
    // The provider IS configured — this is not "nothing to issue", it is
    // "there is something to issue and we decline to".
    expect(isSipConfigured(config)).toBe(true)
    expect(sipCredentialsMayBeIssued(config)).toBe(false)
  })

  it('refuses for every provider type, not just twilio', () => {
    for (const type of ['twilio', 'signalwire', 'vonage', 'plivo', 'asterisk'] as const) {
      expect(sipCredentialsMayBeIssued({ ...twilioConfig(), type } as TelephonyProviderConfig)).toBe(false)
    }
  })

  it('refuses when there is no provider at all', () => {
    expect(sipCredentialsMayBeIssued(null)).toBe(false)
  })

  /**
   * The generators are deliberately left intact — the refusal is at the route,
   * and this documents WHY they cannot simply be called instead. If this test
   * ever fails because a generator started deriving a per-volunteer secret,
   * that is good news, but read #1203's point (3) before relaxing the guard:
   * the vendor still sees the registration.
   */
  it('the generator still returns the hub credential verbatim — which is the reason for the guard', () => {
    const params = generateSipParams(twilioConfig(), 'vol_abc123')
    expect(params.sip.password).toBe(HUB_TRUNK_PASSWORD)
    // Identity is accepted and ignored: nothing about the credential is
    // per-volunteer.
    const other = generateSipParams(twilioConfig(), 'vol_completely_different')
    expect(other.sip.password).toBe(params.sip.password)
    expect(other.sip.username).toBe(params.sip.username)
  })
})
