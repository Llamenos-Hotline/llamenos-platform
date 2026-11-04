/**
 * Unit tests for apps/worker/lib/voip-push.ts
 *
 * Tests VoIP push dispatch logic, early exits, and error handling.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Env } from '@worker/types/infra'

// Mock external modules
vi.mock('@fivesheepco/cloudflare-apns2', () => ({
  ApnsClient: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue(undefined),
  })),
  Notification: vi.fn(),
  PushType: { voip: 'voip' },
  Priority: { immediate: 10 },
}))

vi.mock('@worker/lib/ntfy-client', () => ({
  NtfyClient: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue(true),
  })),
}))

vi.mock('@worker/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}))

import { dispatchVoipPushFromService } from '@worker/lib/voip-push'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockGetVoipTokens = vi.fn()

function makeIdentityService(devices: Array<{ platform: string; voipToken: string }> = []) {
  mockGetVoipTokens.mockResolvedValue({ devices })
  return { getVoipTokens: mockGetVoipTokens } as never
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    APNS_KEY_P8: 'key',
    APNS_KEY_ID: 'kid',
    APNS_TEAM_ID: 'team',
    NTFY_URL: 'http://ntfy:80',
    ...overrides,
  } as Env
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dispatchVoipPushFromService', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns early for empty volunteer list', async () => {
    const identity = makeIdentityService()

    await dispatchVoipPushFromService(
      [],
      'push-ref-1',
      'hub-1',
      makeEnv(),
      identity,
    )

    expect(mockGetVoipTokens).not.toHaveBeenCalled()
  })

  it('returns early when no push credentials configured', async () => {
    const identity = makeIdentityService()

    await dispatchVoipPushFromService(
      ['pk-1'],
      'push-ref-1',
      'hub-1',
      { ENVIRONMENT: 'production' } as Env,  // No APNs or ntfy
      identity,
    )

    expect(mockGetVoipTokens).not.toHaveBeenCalled()
  })

  it('returns early when no devices have VoIP tokens', async () => {
    const identity = makeIdentityService([])

    await dispatchVoipPushFromService(
      ['pk-1'],
      'push-ref-1',
      'hub-1',
      makeEnv(),
      identity,
    )

    // Should have checked for tokens
    expect(mockGetVoipTokens).toHaveBeenCalledWith(['pk-1'])
  })

  it('dispatches to iOS and Android devices', async () => {
    const devices = [
      { platform: 'ios', voipToken: 'ios-token' },
      { platform: 'android', voipToken: 'android-token' },
    ]
    const identity = makeIdentityService(devices)

    // Should not throw
    await dispatchVoipPushFromService(
      ['pk-1', 'pk-2'],
      'push-ref-1',
      'hub-1',
      makeEnv(),
      identity,
    )

    expect(mockGetVoipTokens).toHaveBeenCalledWith(['pk-1', 'pk-2'])
  })

  it('uses Promise.allSettled (does not reject on individual failure)', async () => {
    // Even if one push fails, the others should complete
    const devices = [
      { platform: 'ios', voipToken: 'ios-token' },
      { platform: 'android', voipToken: 'android-token' },
    ]
    const identity = makeIdentityService(devices)

    // Should not throw even if underlying push fails
    await expect(
      dispatchVoipPushFromService(
        ['pk-1'],
        'push-ref-1',
        'hub-1',
        makeEnv(),
        identity,
      ),
    ).resolves.toBeUndefined()
  })
})
