import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'
import {
  renderAlertMessage,
  formatDisappearingTimerSeconds,
  UserNotificationsService,
  type UserNotificationsConfig,
} from '../../services/user-notifications'

// ---------------------------------------------------------------------------
// Pure function tests
// ---------------------------------------------------------------------------

describe('formatDisappearingTimerSeconds', () => {
  it('converts 1 day to 86400 seconds', () => {
    expect(formatDisappearingTimerSeconds(1)).toBe(86400)
  })

  it('converts 7 days to 604800 seconds', () => {
    expect(formatDisappearingTimerSeconds(7)).toBe(604800)
  })

  it('handles 0 days', () => {
    expect(formatDisappearingTimerSeconds(0)).toBe(0)
  })
})

describe('renderAlertMessage', () => {
  it('renders new_device alert with location info', () => {
    const msg = renderAlertMessage({
      type: 'new_device',
      city: 'Berlin',
      country: 'Germany',
      userAgent: 'Firefox/130.0',
    })
    expect(msg).toContain('Berlin')
    expect(msg).toContain('Germany')
    expect(msg).toContain('Firefox/130.0')
    expect(msg).toContain('New sign-in')
  })

  it('renders passkey_added alert with credential label', () => {
    const msg = renderAlertMessage({
      type: 'passkey_added',
      credentialLabel: 'My YubiKey',
    })
    expect(msg).toContain('My YubiKey')
    expect(msg).toContain('added')
  })

  it('renders passkey_removed alert with credential label', () => {
    const msg = renderAlertMessage({
      type: 'passkey_removed',
      credentialLabel: 'Old Key',
    })
    expect(msg).toContain('Old Key')
    expect(msg).toContain('removed')
  })

  it('renders pin_changed alert', () => {
    const msg = renderAlertMessage({ type: 'pin_changed' })
    expect(msg).toContain('PIN was changed')
  })

  it('renders recovery_rotated alert', () => {
    const msg = renderAlertMessage({ type: 'recovery_rotated' })
    expect(msg).toContain('recovery key was rotated')
  })

  it('renders lockdown_triggered alert with tier', () => {
    const msg = renderAlertMessage({ type: 'lockdown_triggered', tier: 'A' })
    expect(msg).toContain('tier A')
    expect(msg).toContain('lockdown')
  })

  it('renders session_revoked_remote alert', () => {
    const msg = renderAlertMessage({
      type: 'session_revoked_remote',
      city: 'Bogotá',
      country: 'Colombia',
    })
    expect(msg).toContain('Bogotá')
    expect(msg).toContain('Colombia')
    expect(msg).toContain('revoked')
  })

  it('renders digest alert with stats', () => {
    const msg = renderAlertMessage({
      type: 'digest',
      periodDays: 7,
      loginCount: 12,
      alertCount: 3,
      failedCount: 1,
    })
    expect(msg).toContain('7 days')
    expect(msg).toContain('12 login')
    expect(msg).toContain('3 alert')
    expect(msg).toContain('1 failed')
  })
})

// ---------------------------------------------------------------------------
// HMAC registration token tests
// ---------------------------------------------------------------------------

describe('issueRegistrationToken', () => {
  const config: UserNotificationsConfig = {
    notifierUrl: 'http://localhost:3100',
    notifierApiKey: 'test-api-key',
    tokenSecret: 'super-secret-key-for-hmac',
  }

  function makeService() {
    const mockSignalContacts = { findByUser: vi.fn() }
    const mockPrefs = { get: vi.fn() }
    const mockAudit = { log: vi.fn() }
    return new UserNotificationsService(
      mockSignalContacts as never,
      mockPrefs as never,
      mockAudit as never,
      config,
    )
  }

  it('refuses to issue a token when no token secret is configured (no empty-key signing, no fallback)', () => {
    const svc = new UserNotificationsService(
      { findByUser: vi.fn() } as never,
      { get: vi.fn() } as never,
      { log: vi.fn() } as never,
      { ...config, tokenSecret: '' },
    )
    expect(() => svc.issueRegistrationToken('hash123')).toThrow(/NOTIFIER_TOKEN_SECRET/)
  })

  it('produces a payload.signature format', () => {
    const svc = makeService()
    const token = svc.issueRegistrationToken('hash123')
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[a-f0-9]+$/)
  })

  it('payload contains identifierHash and expiresAt', () => {
    const svc = makeService()
    const token = svc.issueRegistrationToken('hash-abc')
    const [payloadB64] = token.split('.')
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString())
    expect(payload.identifierHash).toBe('hash-abc')
    expect(payload.expiresAt).toBeGreaterThan(Date.now())
    // Expiry should be ~5 minutes from now
    expect(payload.expiresAt).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1000 + 1000)
  })

  it('HMAC signature validates with the shared secret', () => {
    const svc = makeService()
    const token = svc.issueRegistrationToken('hash-xyz')
    const [payloadB64, sig] = token.split('.')
    const expected = createHmac('sha256', config.tokenSecret)
      .update(payloadB64)
      .digest('hex')
    expect(sig).toBe(expected)
  })

  it('different identifierHashes produce different tokens', () => {
    const svc = makeService()
    const t1 = svc.issueRegistrationToken('hash-a')
    const t2 = svc.issueRegistrationToken('hash-b')
    expect(t1).not.toBe(t2)
  })

  it('tampered payload fails HMAC verification', () => {
    const svc = makeService()
    const token = svc.issueRegistrationToken('legit-hash')
    const [_payloadB64, sig] = token.split('.')

    // Tamper with payload
    const fakePayload = Buffer.from(
      JSON.stringify({ identifierHash: 'evil-hash', expiresAt: Date.now() + 999999999 }),
    ).toString('base64url')

    const expectedSig = createHmac('sha256', config.tokenSecret)
      .update(fakePayload)
      .digest('hex')
    expect(sig).not.toBe(expectedSig) // original sig doesn't match tampered payload
  })
})

// ---------------------------------------------------------------------------
// getSidecarUrl
// ---------------------------------------------------------------------------

describe('getSidecarUrl', () => {
  it('strips trailing slashes from notifier URL', () => {
    const svc = new UserNotificationsService(
      {} as never,
      {} as never,
      {} as never,
      {
        notifierUrl: 'http://localhost:3100///',
        notifierApiKey: 'key',
        tokenSecret: 'secret',
      },
    )
    expect(svc.getSidecarUrl()).toBe('http://localhost:3100')
  })
})

// ---------------------------------------------------------------------------
// sendAlert — preference filtering logic
// ---------------------------------------------------------------------------

describe('sendAlert', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function makeDeps(overrides?: {
    notificationChannel?: string
    digestCadence?: string
    alertOnNewDevice?: boolean
    alertOnPasskeyChange?: boolean
    alertOnPinChange?: boolean
    contactExists?: boolean
    notifierOk?: boolean
  }) {
    const opts = {
      notificationChannel: 'signal',
      digestCadence: 'weekly',
      alertOnNewDevice: true,
      alertOnPasskeyChange: true,
      alertOnPinChange: true,
      contactExists: true,
      notifierOk: true,
      ...overrides,
    }

    const prefs = {
      get: vi.fn().mockResolvedValue({
        notificationChannel: opts.notificationChannel,
        digestCadence: opts.digestCadence,
        alertOnNewDevice: opts.alertOnNewDevice,
        alertOnPasskeyChange: opts.alertOnPasskeyChange,
        alertOnPinChange: opts.alertOnPinChange,
        disappearingTimerDays: 1,
      }),
    }

    const signalContacts = {
      findByUser: vi.fn().mockResolvedValue(
        opts.contactExists
          ? { identifierHash: 'contact-hash-abc' }
          : null,
      ),
    }

    const audit = { log: vi.fn().mockResolvedValue(undefined) }

    // Mock global fetch
    const fetchMock = vi.fn().mockResolvedValue({
      ok: opts.notifierOk,
      status: opts.notifierOk ? 200 : 500,
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const config: UserNotificationsConfig = {
      notifierUrl: 'http://localhost:3100',
      notifierApiKey: 'test-key',
      tokenSecret: 'test-secret',
    }

    const svc = new UserNotificationsService(
      signalContacts as never,
      prefs as never,
      audit as never,
      config,
    )

    return { svc, prefs, signalContacts, audit, fetchMock }
  }

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('skips delivery when notification channel is not signal', async () => {
    const { svc, fetchMock } = makeDeps({ notificationChannel: 'web_push' })
    const result = await svc.sendAlert('pk1', { type: 'pin_changed' })
    expect(result.delivered).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('skips digest when digestCadence is off', async () => {
    const { svc, fetchMock } = makeDeps({ digestCadence: 'off' })
    const result = await svc.sendAlert('pk1', {
      type: 'digest',
      periodDays: 7,
      loginCount: 5,
      alertCount: 0,
      failedCount: 0,
    })
    expect(result.delivered).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('skips new_device when alertOnNewDevice is false', async () => {
    const { svc, fetchMock } = makeDeps({ alertOnNewDevice: false })
    const result = await svc.sendAlert('pk1', {
      type: 'new_device',
      city: 'NYC',
      country: 'US',
      userAgent: 'Chrome',
    })
    expect(result.delivered).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('skips passkey_added when alertOnPasskeyChange is false', async () => {
    const { svc, fetchMock } = makeDeps({ alertOnPasskeyChange: false })
    const result = await svc.sendAlert('pk1', {
      type: 'passkey_added',
      credentialLabel: 'Key',
    })
    expect(result.delivered).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('skips passkey_removed when alertOnPasskeyChange is false', async () => {
    const { svc, fetchMock } = makeDeps({ alertOnPasskeyChange: false })
    const result = await svc.sendAlert('pk1', {
      type: 'passkey_removed',
      credentialLabel: 'Key',
    })
    expect(result.delivered).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('skips pin_changed when alertOnPinChange is false', async () => {
    const { svc, fetchMock } = makeDeps({ alertOnPinChange: false })
    const result = await svc.sendAlert('pk1', { type: 'pin_changed' })
    expect(result.delivered).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns delivered:false when no Signal contact exists', async () => {
    const { svc, fetchMock } = makeDeps({ contactExists: false })
    const result = await svc.sendAlert('pk1', { type: 'pin_changed' })
    expect(result.delivered).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('delivers successfully and logs audit event', async () => {
    const { svc, audit, fetchMock } = makeDeps()
    const result = await svc.sendAlert('pk1', { type: 'pin_changed' })
    expect(result.delivered).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(audit.log).toHaveBeenCalledWith('signal_alert_sent', 'pk1', { alertType: 'pin_changed' })
  })

  it('sends correct request to notifier sidecar', async () => {
    const { svc, fetchMock } = makeDeps()
    await svc.sendAlert('pk1', { type: 'pin_changed' })

    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:3100/api/notify')
    expect(opts.method).toBe('POST')
    expect(opts.headers['authorization']).toBe('Bearer test-key')

    const body = JSON.parse(opts.body)
    expect(body.identifierHash).toBe('contact-hash-abc')
    expect(body.message).toContain('PIN was changed')
    expect(body.disappearingTimerSeconds).toBe(86400) // 1 day
  })

  it('retries up to 3 times on notifier failure', async () => {
    const { svc, fetchMock } = makeDeps({ notifierOk: false })
    const result = await svc.sendAlert('pk1', { type: 'pin_changed' })
    expect(result.delivered).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(3) // MAX_RETRIES = 3
  })

  it('succeeds on second attempt after first failure', async () => {
    const { svc, fetchMock, audit } = makeDeps()
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 200 })

    const result = await svc.sendAlert('pk1', { type: 'pin_changed' })
    expect(result.delivered).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(audit.log).toHaveBeenCalled()
  })

  it('always delivers lockdown_triggered regardless of per-alert opt-outs', async () => {
    // lockdown_triggered is not gated by any per-alert preference —
    // it's always delivered as long as the channel is signal and contact exists
    const { svc } = makeDeps({
      alertOnNewDevice: false,
      alertOnPasskeyChange: false,
      alertOnPinChange: false,
    })
    const result = await svc.sendAlert('pk1', {
      type: 'lockdown_triggered',
      tier: 'B',
    })
    expect(result.delivered).toBe(true)
  })

  it('always delivers recovery_rotated regardless of per-alert opt-outs', async () => {
    const { svc } = makeDeps({
      alertOnNewDevice: false,
      alertOnPasskeyChange: false,
      alertOnPinChange: false,
    })
    const result = await svc.sendAlert('pk1', { type: 'recovery_rotated' })
    expect(result.delivered).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// unregisterFromSidecar
// ---------------------------------------------------------------------------

describe('unregisterFromSidecar', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('sends DELETE request to sidecar with correct URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const svc = new UserNotificationsService(
      {} as never,
      {} as never,
      {} as never,
      {
        notifierUrl: 'http://localhost:3100',
        notifierApiKey: 'test-key',
        tokenSecret: 'secret',
      },
    )

    await svc.unregisterFromSidecar('hash-abc')

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:3100/api/unregister/hash-abc')
    expect(opts.method).toBe('DELETE')
    expect(opts.headers.authorization).toBe('Bearer test-key')
  })

  it('does not throw on network error (best-effort)', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('connection refused')) as unknown as typeof fetch

    const svc = new UserNotificationsService(
      {} as never,
      {} as never,
      {} as never,
      {
        notifierUrl: 'http://localhost:3100',
        notifierApiKey: 'key',
        tokenSecret: 'secret',
      },
    )

    // Should not throw
    await expect(svc.unregisterFromSidecar('hash-abc')).resolves.toBeUndefined()
  })
})
