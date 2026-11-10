import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { AuthProvider, useAuth } from './auth'
import * as keyManager from './key-manager'

const { getEffectivePermissionsMock, MockApiError, configState } = vi.hoisted(() => {
  class MockApiError extends Error {
    constructor(public status: number, public body: string) {
      super(`API error ${status}: ${body}`)
      this.name = 'ApiError'
    }
  }
  return {
    getEffectivePermissionsMock: vi.fn(),
    MockApiError,
    configState: { currentHubId: undefined as string | undefined },
  }
})

vi.mock('./platform', () => ({
  deviceImportAndLoad: vi.fn(async () => ({
    state: {
      signingPubkeyHex: 'mock-pubkey',
      encryptionPubkeyHex: 'mock-enc-pubkey',
      deviceId: 'mock-device',
    }
  })),
  isValidSeedHex: vi.fn((hex: string) => /^[0-9a-f]{64}$/i.test(hex)),
  persistAndUnlockDeviceKeys: vi.fn(),
  lockCrypto: vi.fn(async () => {}),
  createAuthToken: vi.fn(async () => JSON.stringify({ timestamp: Date.now(), token: 'mock-token' })),
  hasStoredKey: vi.fn(() => false),
}))

vi.mock('./api', () => ({
  getMe: vi.fn(async () => ({
    pubkey: 'mock-pubkey',
    roles: ['volunteer'],
    permissions: ['notes:read', 'notes:write'],
    primaryRole: { name: 'Volunteer' },
    name: 'Test User',
    transcriptionEnabled: true,
    spokenLanguages: ['en'],
    uiLanguage: 'en',
    profileCompleted: true,
    onBreak: false,
    callPreference: 'phone',
    adminDecryptionPubkey: 'admin-pubkey',
    serverEventKeyHex: null,
    serverEventKeyPrevHex: null,
    eventKeyEpoch: undefined,
    eventKeyEpochDuration: undefined,
    webauthnRequired: false,
    webauthnRegistered: false,
  })),
  // Default: the hub answers with exactly the account-wide set, so tests that
  // predate #1101 observe no change. Per-hub tests override this.
  getEffectivePermissions: getEffectivePermissionsMock,
  ApiError: MockApiError,
  login: vi.fn(),
  logout: vi.fn(),
  updateMyAvailability: vi.fn(),
  setOnAuthExpired: vi.fn(),
  setOnApiActivity: vi.fn(),
}))

// AuthProvider reads the active hub from ConfigContext; drive it directly.
vi.mock('./config', () => ({
  useConfig: () => ({
    currentHubId: configState.currentHubId,
    refreshMemberHubs: vi.fn(async () => {}),
    clearMemberHubs: vi.fn(),
  }),
  forgetHubPreference: vi.fn(),
}))

vi.mock('./webauthn', () => ({
  loginWithPasskey: vi.fn(async () => ({ token: 'passkey-token', pubkey: 'passkey-pubkey' })),
}))

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <AuthProvider>{children}</AuthProvider>
)

beforeEach(() => {
  keyManager.lock()
  sessionStorage.clear()
  localStorage.clear()
  configState.currentHubId = undefined
  getEffectivePermissionsMock.mockReset()
  getEffectivePermissionsMock.mockResolvedValue({
    userId: 'mock-pubkey',
    permissions: ['notes:read', 'notes:write'],
  })
})

describe('useAuth initial state', () => {
  it('starts with loading state', () => {
    const { result } = renderHook(() => useAuth(), { wrapper })
    expect(result.current.isAuthenticated).toBe(false)
    expect(result.current.isKeyUnlocked).toBe(false)
  })

  it('has empty roles and permissions initially', () => {
    const { result } = renderHook(() => useAuth(), { wrapper })
    expect(result.current.roles).toEqual([])
    expect(result.current.permissions).toEqual([])
  })

  it('has default preferences', () => {
    const { result } = renderHook(() => useAuth(), { wrapper })
    expect(result.current.callPreference).toBe('phone')
    expect(result.current.onBreak).toBe(false)
    expect(result.current.transcriptionEnabled).toBe(true)
  })
})

describe('useAuth hasPermission', () => {
  it('returns false for unknown permission', () => {
    const { result } = renderHook(() => useAuth(), { wrapper })
    expect(result.current.hasPermission('admin:all')).toBe(false)
  })

  it('returns true for matching permission', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper })

    await act(async () => {
      await result.current.signIn('a'.repeat(64), '12345678')
    })

    await act(async () => {})
    await act(async () => {})
    expect(result.current.hasPermission('notes:read')).toBe(true)
  })
})

describe('useAuth isAdmin', () => {
  it('returns false for non-admin', () => {
    const { result } = renderHook(() => useAuth(), { wrapper })
    expect(result.current.isAdmin).toBe(false)
  })
})

describe('useAuth signOut', () => {
  it('clears all state on signOut', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper })

    await act(async () => {
      await result.current.signIn('a'.repeat(64), '12345678')
    })

    await act(async () => {})

    act(() => {
      result.current.signOut()
    })

    expect(result.current.isAuthenticated).toBe(false)
    expect(result.current.isKeyUnlocked).toBe(false)
    expect(result.current.publicKey).toBeNull()
    expect(result.current.roles).toEqual([])
    expect(result.current.permissions).toEqual([])
    expect(result.current.sessionExpired).toBe(false)
    expect(result.current.sessionExpiring).toBe(false)
  })

  it('removes session token on signOut', async () => {
    sessionStorage.setItem('llamenos-session-token', 'test-token')

    const { result } = renderHook(() => useAuth(), { wrapper })

    act(() => {
      result.current.signOut()
    })

    expect(sessionStorage.getItem('llamenos-session-token')).toBeNull()
  })

  it('removes draft keys on signOut', async () => {
    localStorage.setItem('llamenos-draft:1', 'draft1')
    localStorage.setItem('llamenos-draft:2', 'draft2')
    localStorage.setItem('llamenos-other', 'other')

    const { result } = renderHook(() => useAuth(), { wrapper })

    act(() => {
      result.current.signOut()
    })

    expect(localStorage.getItem('llamenos-draft:1')).toBeNull()
    expect(localStorage.getItem('llamenos-draft:2')).toBeNull()
    expect(localStorage.getItem('llamenos-other')).toBe('other')
  })
})

describe('useAuth lockKey', () => {
  it('locks key but keeps session', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper })

    await act(async () => {
      await result.current.signIn('a'.repeat(64), '12345678')
    })

    await act(async () => {})

    act(() => {
      result.current.lockKey()
    })

    expect(result.current.isKeyUnlocked).toBe(false)
    expect(result.current.hasDeviceKey).toBe(false)
  })
})

describe('useAuth session expiry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('tracks session expiry state', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper })

    await act(async () => {
      await result.current.signIn('a'.repeat(64), '12345678')
    })

    expect(result.current.sessionExpired).toBe(false)
    expect(result.current.sessionExpiring).toBe(false)
  })
})

describe('useAuth toggleBreak', () => {
  it('toggles break state', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper })

    await act(async () => {
      await result.current.signIn('a'.repeat(64), '12345678')
    })

    expect(result.current.onBreak).toBe(false)

    await act(async () => {
      await result.current.toggleBreak()
    })

    expect(result.current.onBreak).toBe(true)
  })
})

describe('useAuth error handling', () => {
  it('sets error on invalid seed', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper })

    await act(async () => {
      await result.current.signIn('invalid', '12345678')
    })

    await waitFor(() => {
      expect(result.current.error).toBe('Invalid secret key')
    })
    expect(result.current.isLoading).toBe(false)
  })

  it('clears error on successful signIn after failure', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper })

    await act(async () => {
      await result.current.signIn('invalid', '12345678')
    })

    await waitFor(() => {
      expect(result.current.error).toBe('Invalid secret key')
    })

    await act(async () => {
      await result.current.signIn('a'.repeat(64), '12345678')
    })

    await waitFor(() => {
      expect(result.current.error).toBeNull()
    })
  })
})

describe('per-hub UI permissions (#1101)', () => {
  const seed = 'a'.repeat(64)

  it('gates the UI on the hub-resolved answer, not the account-wide /auth/me set', async () => {
    getEffectivePermissionsMock.mockResolvedValue({ userId: 'mock-pubkey', permissions: ['calls:answer'] })
    const { result } = renderHook(() => useAuth(), { wrapper })

    await act(async () => {
      await result.current.signIn(seed, '12345678')
    })

    await waitFor(() => {
      expect(result.current.permissions).toEqual(['calls:answer'])
    })
    // The account-wide set stays visible through the account-level gate only.
    expect(result.current.hasPermission('calls:answer')).toBe(true)
    expect(result.current.hasPermission('notes:read')).toBe(false)
    expect(result.current.hasAccountPermission('notes:read')).toBe(true)
    expect(getEffectivePermissionsMock).toHaveBeenCalledWith('mock-pubkey', undefined)
  })

  it('falls back to the account-wide set when the endpoint refuses with 403', async () => {
    getEffectivePermissionsMock.mockRejectedValue(new MockApiError(403, '{"error":"Forbidden"}'))
    const { result } = renderHook(() => useAuth(), { wrapper })

    await act(async () => {
      await result.current.signIn(seed, '12345678')
    })

    await waitFor(() => {
      expect(getEffectivePermissionsMock).toHaveBeenCalled()
    })
    await waitFor(() => {
      expect(result.current.hasPermission('notes:read')).toBe(true)
    })
  })

  it('keeps the last known set on a transient failure', async () => {
    getEffectivePermissionsMock.mockRejectedValue(new Error('network down'))
    const { result } = renderHook(() => useAuth(), { wrapper })

    await act(async () => {
      await result.current.signIn(seed, '12345678')
    })

    await waitFor(() => {
      expect(getEffectivePermissionsMock).toHaveBeenCalled()
    })
    // Blank is a lie here: the fetch failing says nothing about authority.
    expect(result.current.permissions).toEqual(['notes:read', 'notes:write'])
  })

  it('re-derives when the active hub changes, and caches per hub', async () => {
    configState.currentHubId = 'hub-A'
    getEffectivePermissionsMock.mockImplementation(async (_id: string, hubId?: string) => ({
      userId: 'mock-pubkey',
      permissions: hubId === 'hub-A' ? ['calls:answer'] : ['notes:read-own'],
    }))
    const { result, rerender } = renderHook(() => useAuth(), { wrapper })

    await act(async () => {
      await result.current.signIn(seed, '12345678')
    })

    await waitFor(() => {
      expect(result.current.permissions).toEqual(['calls:answer'])
    })
    expect(getEffectivePermissionsMock).toHaveBeenCalledWith('mock-pubkey', 'hub-A')

    configState.currentHubId = 'hub-B'
    rerender()
    await waitFor(() => {
      expect(result.current.permissions).toEqual(['notes:read-own'])
    })
    expect(getEffectivePermissionsMock).toHaveBeenCalledWith('mock-pubkey', 'hub-B')

    // Back to hub A: the cached set applies on the switch itself, before any
    // answer — while a background revalidation still fires (a role revoked
    // server-side must propagate on the next visit to the hub).
    const callsBefore = getEffectivePermissionsMock.mock.calls.length
    let resolveFetch: ((v: { userId: string; permissions: string[] }) => void) | undefined
    getEffectivePermissionsMock.mockImplementation(
      () => new Promise<{ userId: string; permissions: string[] }>(res => { resolveFetch = res }),
    )
    configState.currentHubId = 'hub-A'
    rerender()
    expect(result.current.permissions).toEqual(['calls:answer'])
    expect(getEffectivePermissionsMock.mock.calls.length).toBe(callsBefore + 1)

    await act(async () => {
      resolveFetch?.({ userId: 'mock-pubkey', permissions: ['calls:answer', 'calls:hangup'] })
    })
    await waitFor(() => {
      expect(result.current.permissions).toEqual(['calls:answer', 'calls:hangup'])
    })
  })

  it('signOut clears the per-hub cache so the next user never sees it', async () => {
    configState.currentHubId = 'hub-A'
    getEffectivePermissionsMock.mockResolvedValue({ userId: 'mock-pubkey', permissions: ['calls:answer'] })
    const { result } = renderHook(() => useAuth(), { wrapper })

    await act(async () => {
      await result.current.signIn(seed, '12345678')
    })
    await waitFor(() => {
      expect(result.current.permissions).toEqual(['calls:answer'])
    })

    act(() => {
      result.current.signOut()
    })
    expect(result.current.permissions).toEqual([])
    expect(result.current.accountPermissions).toEqual([])
  })
})
