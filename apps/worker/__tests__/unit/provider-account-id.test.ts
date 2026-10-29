/**
 * TelephonyAdapter.providerAccountId (#2297): the account a provider-held
 * recording is bound to. It is stored as a SHA-256 fingerprint, so it must
 * never carry a credential — a fast hash of an API key or token is a stored
 * password hash (CodeQL js/insufficient-password-hash). Every adapter is built
 * with recognisable secrets and checked against them.
 *
 * #2309 adds two more things the server stores or returns per adapter: the
 * recording-posture enforcement result (written to the audit chain) and the
 * provider-retention statement. Both are checked against the same secrets,
 * with every provider request answered by a failure that echoes the request
 * back — the worst case for a leak.
 */
import { describe, expect, it, vi } from 'vitest'

// Every provider answers 500 with the request — and the raw secret — in the
// body, so any path that copies a provider's answer into a stored value leaks.
const { safeFetch } = vi.hoisted(() => ({
  safeFetch: vi.fn(async (url: string, init?: RequestInit) =>
    new Response(JSON.stringify({ url, headers: init?.headers, echoed: 'SECRET-must-not-appear' }), { status: 500 })),
}))
vi.mock('@worker/lib/safe-fetch', () => ({ safeFetch }))

import { providerRetentionStatementSchema, providerSettingEnforcementSchema } from '@protocol/schemas/settings'
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

describe('enforceRecordingPosture and providerRetention (#2309)', () => {
  const leaked = (text: string) => text.includes(SECRET)

  it.each(adapters)('%s: a provider that refuses every write yields no credential, and nothing reported as off', async (_name, adapter) => {
    const actions = await adapter.enforceRecordingPosture()
    expect(actions.length).toBeGreaterThan(0)
    for (const action of actions) {
      expect(providerSettingEnforcementSchema.safeParse(action).success).toBe(true)
      // A refused or unreadable provider can never read as turned off.
      expect(['failed', 'not-settable']).toContain(action.outcome)
    }
    expect(leaked(JSON.stringify(actions))).toBe(false)
  })

  it.each(adapters)('%s: the retention statement names what stays at the provider, without a credential', (_name, adapter) => {
    const statement = adapter.providerRetention()
    expect(providerRetentionStatementSchema.safeParse(statement).success).toBe(true)
    expect(leaked(JSON.stringify(statement))).toBe(false)
    // Call detail records name the caller's and every rung volunteer's number:
    // either this server deletes them, or the statement says they stay.
    if ('deleteCallLog' in adapter) {
      expect(statement.removed.some(r => /call log/i.test(r.what))).toBe(true)
    } else {
      expect(statement.retained.some(r => /call detail record/i.test(r.what))).toBe(true)
    }
  })
})
