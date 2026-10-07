import { describe, it, expect } from 'vitest'
import {
  MockTelephonyAdapter,
  MockTelephonyRefusedError,
  isMockTelephonyAllowed,
  mockTelephonyRefusalReason,
  assertMockTelephonyAllowed,
} from '@worker/telephony/mock'
import { getTelephonyFromService, getHubTelephonyFromService } from '@worker/lib/service-factories'
import type { Env } from '@worker/types'
import type { TelephonyProviderConfig } from '@shared/types'

/**
 * The configuration in which the mock provider is constructible, as of #1604:
 * `devSurfacesEnabled` (apps/worker/lib/dev-surfaces.ts) — an ENVIRONMENT on the
 * ['development', 'staging'] allowlist, the explicit flag, and a >= 32-char
 * secret on anything but `development`. It used to be
 * `{ ENVIRONMENT: 'demo', DEMO_MODE: 'true', DEMO_MODE_CONFIRM: 'DESTROY_ALL_DATA' }`.
 */
const ALLOWED = {
  ENVIRONMENT: 'development',
  DEV_ROUTES_ENABLED: 'true',
  DEV_RESET_SECRET: 'a'.repeat(32),
}

describe('mock telephony environment guard', () => {
  it.each(['development', 'staging'])('is allowed in %s with the flag and a strong secret', (environment) => {
    expect(isMockTelephonyAllowed({ ...ALLOWED, ENVIRONMENT: environment })).toBe(true)
    expect(() => assertMockTelephonyAllowed({ ...ALLOWED, ENVIRONMENT: environment })).not.toThrow()
  })

  it('refuses in production even with every other flag set', () => {
    for (const environment of ['production', 'Production', ' production ']) {
      const env = { ...ALLOWED, ENVIRONMENT: environment }
      expect(isMockTelephonyAllowed(env)).toBe(false)
      expect(mockTelephonyRefusalReason(env)).toBe('ENVIRONMENT=production never serves /api/test-*')
      expect(() => new MockTelephonyAdapter(env, '+15555550100')).toThrow(MockTelephonyRefusedError)
    }
  })

  it('refuses when ENVIRONMENT is unset or unrecognised (fail closed)', () => {
    expect(isMockTelephonyAllowed({ ...ALLOWED, ENVIRONMENT: undefined })).toBe(false)
    expect(isMockTelephonyAllowed({ ...ALLOWED, ENVIRONMENT: 'prod' })).toBe(false)
    expect(isMockTelephonyAllowed({ ...ALLOWED, ENVIRONMENT: '' })).toBe(false)
  })

  // #1604 moved this gate from DEMO_MODE + DEMO_MODE_CONFIRM onto
  // `devSurfacesEnabled` — the same declaration that opens `/api/test-*`. These
  // assert the three factors that predicate requires, in place of the two demo
  // flags that used to stand here.
  it('refuses without DEV_ROUTES_ENABLED=true', () => {
    expect(isMockTelephonyAllowed({ ...ALLOWED, DEV_ROUTES_ENABLED: undefined })).toBe(false)
    expect(isMockTelephonyAllowed({ ...ALLOWED, DEV_ROUTES_ENABLED: 'false' })).toBe(false)
    expect(isMockTelephonyAllowed({ ...ALLOWED, DEV_ROUTES_ENABLED: '1' })).toBe(false)
  })

  it('refuses on a reachable environment without a strong secret', () => {
    const staging = { ...ALLOWED, ENVIRONMENT: 'staging' }
    expect(isMockTelephonyAllowed({ ...staging, DEV_RESET_SECRET: undefined })).toBe(false)
    expect(isMockTelephonyAllowed({ ...staging, DEV_RESET_SECRET: 'short' })).toBe(false)
    expect(isMockTelephonyAllowed({ ...staging, DEV_RESET_SECRET: 'a'.repeat(32) })).toBe(true)
  })

  it('refuses the demo environment name the old gate allowed', () => {
    // The removed gate accepted ENVIRONMENT=demo; the dev-surface allowlist is
    // ['development', 'staging'] only, so this is now strictly narrower.
    expect(isMockTelephonyAllowed({ ...ALLOWED, ENVIRONMENT: 'demo' })).toBe(false)
  })
})

describe('MockTelephonyAdapter', () => {
  const adapter = new MockTelephonyAdapter(ALLOWED, '+15555550100')

  it('never validates an inbound webhook', async () => {
    expect(await adapter.validateWebhook(new Request('http://x/api/telephony/incoming', { method: 'POST' }))).toBe(false)
  })

  it('rings volunteers without any network call and records the action', async () => {
    const legs = await adapter.ringVolunteers({
      callSid: 'mock-call-1',
      callerNumber: '+15550001111',
      volunteers: [{ phone: '+15550002222', callToken: 't1' }, { phone: '+15550003333', callToken: 't2' }],
      callbackUrl: 'http://x',
    })
    expect(legs).toHaveLength(2)
    expect(adapter.actions).toContainEqual({ type: 'ring', callSid: 'mock-call-1', legs: 2 })
  })

  it('records hangup and cancel-ringing', async () => {
    await adapter.hangupCall('mock-call-1')
    await adapter.cancelRinging(['a', 'b'], 'a')
    expect(adapter.actions).toContainEqual({ type: 'hangup', callSid: 'mock-call-1' })
    expect(adapter.actions).toContainEqual({ type: 'cancel-ringing', callSids: ['a', 'b'], exceptSid: 'a' })
  })

  it('parses JSON webhook payloads and defaults the called number to its hotline', async () => {
    const req = new Request('http://x', { method: 'POST', body: JSON.stringify({ callSid: 'c1', callerNumber: '+15550001111' }) })
    expect(await adapter.parseIncomingWebhook(req)).toEqual({ callSid: 'c1', callerNumber: '+15550001111', calledNumber: '+15555550100' })
  })

  it('returns non-Twilio, JSON mock responses', () => {
    expect(adapter.rejectCall().contentType).toBe('application/json')
    expect(JSON.parse(adapter.emptyResponse().body)).toMatchObject({ mock: true })
  })
})

describe('adapter factory selects the mock per hub, and refuses it where the dev surface is closed', () => {
  const mockConfig = { type: 'mock', phoneNumber: '+15555550100' } as unknown as TelephonyProviderConfig
  const settings = (hubConfig: TelephonyProviderConfig | null) => ({
    getHubTelephonyProvider: async () => hubConfig,
    getTelephonyProvider: async () => null,
  })
  const env = (over: Record<string, string>) => ({ ...over }) as unknown as Env

  it('returns a MockTelephonyAdapter for a hub configured with type mock on a test instance', async () => {
    const adapter = await getHubTelephonyFromService(env(ALLOWED), settings(mockConfig), 'hub-1')
    expect(adapter).toBeInstanceOf(MockTelephonyAdapter)
  })

  it('returns null (never a real provider fallback) in production with every other flag set', async () => {
    const withTwilioEnv = env({
      ...ALLOWED,
      ENVIRONMENT: 'production',
      TWILIO_ACCOUNT_SID: 'AC' + 'a'.repeat(32),
      TWILIO_AUTH_TOKEN: 'tok',
      TWILIO_PHONE_NUMBER: '+15550009999',
    })
    expect(await getHubTelephonyFromService(withTwilioEnv, settings(mockConfig), 'hub-1')).toBeNull()
    expect(await getTelephonyFromService(withTwilioEnv, { getTelephonyProvider: async () => mockConfig })).toBeNull()
  })

  it('returns null without DEV_ROUTES_ENABLED', async () => {
    expect(await getHubTelephonyFromService(env({ ...ALLOWED, DEV_ROUTES_ENABLED: '' }), settings(mockConfig), 'hub-1')).toBeNull()
  })
})
