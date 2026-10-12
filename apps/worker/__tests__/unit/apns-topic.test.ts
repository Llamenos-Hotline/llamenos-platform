/**
 * Unit tests for apps/worker/lib/apns-topic.ts (Issue #724).
 *
 * Covers:
 * - Env-var override / default derivation for the APNs topic and VoIP topic.
 * - A drift guard: DEFAULT_APNS_BUNDLE_ID must equal PRODUCT_BUNDLE_IDENTIFIER
 *   in apps/ios/project.yml, so the backend and iOS app cannot silently
 *   diverge again the way they did before this fix (backend hardcoded
 *   'org.llamenos.mobile' while the iOS app ships as 'org.llamenos.hotline').
 * - The actual `apns-topic` HTTP header sent by the real @fivesheepco/cloudflare-apns2
 *   client for both a regular push (push-dispatch.ts) and a VoIP push (voip-push.ts),
 *   proving the derived value is what actually reaches Apple's wire format —
 *   not just what our own helper function returns.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import { DEFAULT_APNS_BUNDLE_ID, getApnsBundleId, getApnsVoipTopic } from '@worker/lib/apns-topic'
import type { Env, DeviceRecord, WakePayload, FullPushPayload } from '@worker/types/infra'

// ---------------------------------------------------------------------------
// getApnsBundleId / getApnsVoipTopic
// ---------------------------------------------------------------------------

describe('getApnsBundleId', () => {
  it('defaults to org.llamenos.hotline when APNS_BUNDLE_ID is unset', () => {
    expect(getApnsBundleId({} as Env)).toBe('org.llamenos.hotline')
    expect(getApnsBundleId({} as Env)).toBe(DEFAULT_APNS_BUNDLE_ID)
  })

  it('uses the env override when set', () => {
    expect(getApnsBundleId({ APNS_BUNDLE_ID: 'org.example.custom' } as Env)).toBe('org.example.custom')
  })

  it('falls back to the default for a blank override', () => {
    expect(getApnsBundleId({ APNS_BUNDLE_ID: '   ' } as Env)).toBe(DEFAULT_APNS_BUNDLE_ID)
    expect(getApnsBundleId({ APNS_BUNDLE_ID: '' } as Env)).toBe(DEFAULT_APNS_BUNDLE_ID)
  })
})

describe('getApnsVoipTopic', () => {
  it('appends .voip to the default bundle id', () => {
    expect(getApnsVoipTopic({} as Env)).toBe('org.llamenos.hotline.voip')
  })

  it('appends .voip to an env override', () => {
    expect(getApnsVoipTopic({ APNS_BUNDLE_ID: 'org.example.custom' } as Env)).toBe('org.example.custom.voip')
  })
})

// ---------------------------------------------------------------------------
// Drift guard against apps/ios/project.yml
// ---------------------------------------------------------------------------

describe('APNs topic drift guard', () => {
  it('DEFAULT_APNS_BUNDLE_ID matches PRODUCT_BUNDLE_IDENTIFIER in apps/ios/project.yml', () => {
    const projectYmlPath = join(__dirname, '../../../ios/project.yml')
    const contents = readFileSync(projectYmlPath, 'utf-8')

    // The main "Llamenos" application target's bundle id is the FIRST
    // PRODUCT_BUNDLE_IDENTIFIER in the file — the test/UI-test targets that
    // follow use suffixed variants (`.tests`, `.uitests`).
    const match = contents.match(/PRODUCT_BUNDLE_IDENTIFIER:\s*(\S+)/)
    expect(match, 'apps/ios/project.yml must define PRODUCT_BUNDLE_IDENTIFIER').not.toBeNull()

    const iosBundleId = match![1]
    expect(DEFAULT_APNS_BUNDLE_ID).toBe(iosBundleId)
  })
})

// ---------------------------------------------------------------------------
// Real outgoing `apns-topic` header — push-dispatch.ts (regular push)
// ---------------------------------------------------------------------------

vi.mock('@worker/lib/push-encryption', () => ({
  encryptWakePayload: () => 'encrypted-wake',
  encryptFullPayload: () => 'encrypted-full',
}))

/** Generate a throwaway ES256 (P-256) private key PEM for signing test JWTs. */
function generateTestSigningKey(): string {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
}

describe('outgoing apns-topic header — regular push (push-dispatch.ts)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 200 }),
    )
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('sets apns-topic to the default bundle id for a regular push', async () => {
    const { createPushDispatcherFromService } = await import('@worker/lib/push-dispatch')

    const device: DeviceRecord = {
      platform: 'ios',
      pushToken: 'device-token-abc',
      wakeKeyPublic: 'deadbeef',
      x25519Pubkey: null,
      registeredAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    }

    const identityService = {
      getDevices: vi.fn().mockResolvedValue({ devices: [device] }),
      cleanupDevices: vi.fn(),
    } as never

    const shiftsService = { getCurrentVolunteers: vi.fn() } as never

    const env = {
      ENVIRONMENT: 'production',
      APNS_KEY_P8: generateTestSigningKey(),
      APNS_KEY_ID: 'TESTKEYID',
      APNS_TEAM_ID: 'TESTTEAMID',
    } as Env

    const dispatcher = createPushDispatcherFromService(env, identityService, shiftsService)

    const wake: WakePayload = { hubId: 'hub-1', type: 'message' }
    await dispatcher.sendToVolunteer('volunteer-pubkey', wake, wake as FullPushPayload)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [, init] = fetchSpy.mock.calls[0] as [unknown, RequestInit]
    const headers = init.headers as Headers
    expect(headers.get('apns-topic')).toBe(DEFAULT_APNS_BUNDLE_ID)
    expect(headers.get('apns-topic')).not.toBe('org.llamenos.mobile')
  })

  it('honors an APNS_BUNDLE_ID override for the regular push topic', async () => {
    const { createPushDispatcherFromService } = await import('@worker/lib/push-dispatch')

    const device: DeviceRecord = {
      platform: 'ios',
      pushToken: 'device-token-abc',
      wakeKeyPublic: 'deadbeef',
      x25519Pubkey: null,
      registeredAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    }

    const identityService = {
      getDevices: vi.fn().mockResolvedValue({ devices: [device] }),
      cleanupDevices: vi.fn(),
    } as never

    const shiftsService = { getCurrentVolunteers: vi.fn() } as never

    const env = {
      ENVIRONMENT: 'production',
      APNS_KEY_P8: generateTestSigningKey(),
      APNS_KEY_ID: 'TESTKEYID',
      APNS_TEAM_ID: 'TESTTEAMID',
      APNS_BUNDLE_ID: 'org.example.override',
    } as Env

    const dispatcher = createPushDispatcherFromService(env, identityService, shiftsService)
    const wake: WakePayload = { hubId: 'hub-1', type: 'message' }
    await dispatcher.sendToVolunteer('volunteer-pubkey', wake, wake as FullPushPayload)

    const [, init] = fetchSpy.mock.calls[0] as [unknown, RequestInit]
    const headers = init.headers as Headers
    expect(headers.get('apns-topic')).toBe('org.example.override')
  })
})

// ---------------------------------------------------------------------------
// Real outgoing `apns-topic` header — voip-push.ts (VoIP push)
// ---------------------------------------------------------------------------

vi.mock('@worker/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}))

describe('outgoing apns-topic header — VoIP push (voip-push.ts)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 200 }),
    )
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('sets apns-topic to "<default bundle id>.voip" for a VoIP push', async () => {
    const { dispatchVoipPushFromService } = await import('@worker/lib/voip-push')

    const identityService = {
      getVoipTokens: vi.fn().mockResolvedValue({
        devices: [{ platform: 'ios', voipToken: 'voip-token-abc' }],
      }),
    } as never

    const env = {
      APNS_KEY_P8: generateTestSigningKey(),
      APNS_KEY_ID: 'TESTKEYID',
      APNS_TEAM_ID: 'TESTTEAMID',
    } as Env

    await dispatchVoipPushFromService(
      ['volunteer-pubkey'],
      'call-1',
      'Caller',
      'hub-1',
      env,
      identityService,
    )

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [, init] = fetchSpy.mock.calls[0] as [unknown, RequestInit]
    const headers = init.headers as Headers
    expect(headers.get('apns-topic')).toBe(`${DEFAULT_APNS_BUNDLE_ID}.voip`)
    expect(headers.get('apns-topic')).not.toBe('org.llamenos.mobile.voip')
  })

  it('honors an APNS_BUNDLE_ID override for the VoIP topic', async () => {
    const { dispatchVoipPushFromService } = await import('@worker/lib/voip-push')

    const identityService = {
      getVoipTokens: vi.fn().mockResolvedValue({
        devices: [{ platform: 'ios', voipToken: 'voip-token-abc' }],
      }),
    } as never

    const env = {
      APNS_KEY_P8: generateTestSigningKey(),
      APNS_KEY_ID: 'TESTKEYID',
      APNS_TEAM_ID: 'TESTTEAMID',
      APNS_BUNDLE_ID: 'org.example.override',
    } as Env

    await dispatchVoipPushFromService(
      ['volunteer-pubkey'],
      'call-1',
      'Caller',
      'hub-1',
      env,
      identityService,
    )

    const [, init] = fetchSpy.mock.calls[0] as [unknown, RequestInit]
    const headers = init.headers as Headers
    expect(headers.get('apns-topic')).toBe('org.example.override.voip')
  })
})
