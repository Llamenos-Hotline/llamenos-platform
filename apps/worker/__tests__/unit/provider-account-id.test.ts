/**
 * TelephonyAdapter.providerAccountId (#2297): the account a provider-held
 * recording is bound to. It is stored as a SHA-256 fingerprint, so it must
 * never carry a credential — a fast hash of an API key or token is a stored
 * password hash (CodeQL js/insufficient-password-hash). Every adapter is built
 * with recognisable secrets and checked against them.
 */
import { describe, expect, it } from 'vitest'
import { TwilioAdapter } from '@worker/telephony/twilio'
import { SignalWireAdapter } from '@worker/telephony/signalwire'
import { VonageAdapter } from '@worker/telephony/vonage'
import { PlivoAdapter } from '@worker/telephony/plivo'
import { TelnyxAdapter } from '@worker/telephony/telnyx'
import { BandwidthAdapter } from '@worker/telephony/bandwidth'
import { AsteriskAdapter } from '@worker/telephony/asterisk'
import { FreeSwitchAdapter } from '@worker/telephony/freeswitch'
import { providerAccountFingerprint } from '@worker/services/provider-recordings'

const SECRET = 'SECRET-must-not-appear'

const adapters = [
  ['twilio', new TwilioAdapter('AC-account', `${SECRET}-token`, '+15550000001')],
  ['signalwire', new SignalWireAdapter('project-id', `${SECRET}-token`, '+15550000001', 'space')],
  ['vonage', new VonageAdapter(`${SECRET}-key`, `${SECRET}-secret`, 'app-uuid', '+15550000001', `${SECRET}-pk`)],
  ['plivo', new PlivoAdapter('auth-id', `${SECRET}-token`, '+15550000001')],
  ['telnyx', new TelnyxAdapter(`${SECRET}-key`, 'connection-id', '+15550000001')],
  ['bandwidth', new BandwidthAdapter('account-id', 'api-user', `${SECRET}-secret`, 'app-id', '+15550000001')],
  ['asterisk', new AsteriskAdapter('https://ari.example', 'ari-user', `${SECRET}-pw`, '+15550000001', 'https://bridge.example', `${SECRET}-bridge`)],
  ['freeswitch', new FreeSwitchAdapter('+15550000001', 'https://bridge.example', `${SECRET}-bridge`, 'https://cb.example')],
] as const

describe('providerAccountId', () => {
  it.each(adapters)('%s identifies its account without any credential', (_name, adapter) => {
    const id = adapter.providerAccountId()
    expect(id).not.toContain(SECRET)
    expect(id.length).toBeGreaterThan(0)
  })

  it('distinguishes two accounts of the same provider', () => {
    const a = new TwilioAdapter('AC-one', 'token', '+15550000001')
    const b = new TwilioAdapter('AC-two', 'token', '+15550000001')
    expect(providerAccountFingerprint(a)).not.toBe(providerAccountFingerprint(b))
    expect(providerAccountFingerprint(a)).toBe(providerAccountFingerprint(new TwilioAdapter('AC-one', 'other-token', '+15550009999')))
  })
})
