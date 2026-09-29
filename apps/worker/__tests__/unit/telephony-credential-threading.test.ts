import { describe, it, expect } from 'vitest'
import { getTelephonyFromService, getHubTelephonyFromService } from '@worker/lib/service-factories'
import type { Env } from '@worker/types/infra'

/**
 * Rail: every path that resolves a telephony provider must hand the settings
 * service the HMAC secret, because that is what decrypts the stored
 * credentials.
 *
 * What went wrong. `getHubTelephonyProvider` was repaired to actually read a
 * hub's provider row, but `getHubTelephonyFromService` — the factory that
 * real call handling uses (`services/ringing.ts:172`) — never passed a
 * secret. The provider then resolved and its credentials stayed ciphertext,
 * which is externally indistinguishable from the original bug: a hub is
 * configured, and its configuration has no effect.
 *
 * Why the omission was easy to miss: the factories' structural parameter
 * types declared `getTelephonyProvider()` with NO parameters, so passing the
 * secret was not merely forgotten, it was unrepresentable — and `tsc` was
 * perfectly happy.
 *
 * This asserts on the ARGUMENT the factory passes, not on the adapter it
 * returns, because a wrong-but-parseable credential blob still builds an
 * adapter. The argument is the contract.
 */

const HMAC = 'f'.repeat(64)

function env(): Env {
  return { HMAC_SECRET: HMAC, WEBHOOK_BASE_URL: 'https://api.example.org' } as unknown as Env
}

/** Records what the factory passed, and returns a config so the happy path continues. */
function recordingSettings() {
  const seen: { global: unknown[][]; hub: unknown[][] } = { global: [], hub: [] }
  return {
    seen,
    service: {
      async getTelephonyProvider(...args: unknown[]) {
        seen.global.push(args)
        return { type: 'twilio', credentials: { accountSid: 'AC', authToken: 't', phoneNumber: '+1' } } as never
      },
      async getHubTelephonyProvider(...args: unknown[]) {
        seen.hub.push(args)
        return { type: 'twilio', credentials: { accountSid: 'AC', authToken: 't', phoneNumber: '+1' } } as never
      },
    },
  }
}

describe('telephony credential threading', () => {
  it('getTelephonyFromService passes the HMAC secret to the settings service', async () => {
    const r = recordingSettings()
    await getTelephonyFromService(env(), r.service)
    expect(r.seen.global.length, 'the global provider was never resolved').toBeGreaterThan(0)
    expect(r.seen.global[0]?.[0], 'no HMAC secret was passed — credentials stay encrypted').toBe(HMAC)
  })

  it('getHubTelephonyFromService passes hubId AND the HMAC secret (the real call-handling path)', async () => {
    const r = recordingSettings()
    await getHubTelephonyFromService(env(), r.service, 'hub-42')
    expect(r.seen.hub.length, 'the hub provider was never resolved').toBeGreaterThan(0)
    expect(r.seen.hub[0]?.[0]).toBe('hub-42')
    expect(r.seen.hub[0]?.[1], 'no HMAC secret was passed — per-hub config resolves but stays encrypted').toBe(HMAC)
  })

  it('a hub with its own provider never silently falls through to the global one', async () => {
    const r = recordingSettings()
    await getHubTelephonyFromService(env(), r.service, 'hub-42')
    expect(r.seen.hub.length).toBe(1)
    expect(r.seen.global.length, 'fell back to the global provider despite the hub resolving').toBe(0)
  })
})
