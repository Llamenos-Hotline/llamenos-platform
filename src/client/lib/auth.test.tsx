import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { AuthProvider, useAuth } from './auth'
import * as keyManager from './key-manager'

const { getMyHubPermissionsMock, MockApiError, configState } = vi.hoisted(() => {
  class MockApiError extends Error {
    constructor(public status: number, public body: string) {
      super(`API error ${status}: ${body}`)
      this.name = 'ApiError'
    }
  }
  return {
    getMyHubPermissionsMock: vi.fn(),
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
  getMyHubPermissions: getMyHubPermissionsMock,
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
  getMyHubPermissionsMock.mockReset()
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
  // The account holds BOTH hubs' authority in /auth/me's union: notes:read, notes:write.
  const perHub: Record<string, string[]> = {
    'hub-A': ['notes:read', 'settings:manage'],
    'hub-B': ['calls:answer'],
  }
  const answerPerHub = () =>
    getMyHubPermissionsMock.mockImplementation(async (hubId: string) => ({ hubId, permissions: perHub[hubId] ?? [] }))

  async function signedIn() {
    const view = renderHook(() => useAuth(), { wrapper })
    await act(async () => {
      await view.result.current.signIn(seed, '12345678')
    })
    return view
  }

  it('two hubs give two different answers for the same account', async () => {
    answerPerHub()
    configState.currentHubId = 'hub-A'
    const { result, rerender } = await signedIn()

    await waitFor(() => expect(result.current.hasPermission('settings:manage')).toBe(true))
    expect(result.current.isAdmin).toBe(true)
    expect(result.current.hasPermission('calls:answer')).toBe(false)
    expect(getMyHubPermissionsMock).toHaveBeenCalledWith('hub-A')

    configState.currentHubId = 'hub-B'
    rerender()
    await waitFor(() => expect(result.current.hasPermission('calls:answer')).toBe(true))
    expect(result.current.isAdmin).toBe(false)
    expect(result.current.hasPermission('settings:manage')).toBe(false)
    // notes:read is in the account-wide union but not granted in hub-B.
    expect(result.current.hasPermission('notes:read')).toBe(false)
  })

  it('never leaks the account-wide union into a hub', async () => {
    answerPerHub()
    configState.currentHubId = 'hub-B'
    const { result } = await signedIn()
    await waitFor(() => expect(result.current.hasPermission('calls:answer')).toBe(true))

    expect(result.current.permissions).toEqual(['calls:answer'])
    expect(result.current.accountPermissions).toEqual(['notes:read', 'notes:write'])
    // The account-wide gate (relay re-wrap and other all-hubs work) still sees the union.
    expect(result.current.hasAccountPermission('notes:write')).toBe(true)
    expect(result.current.hasPermission('notes:write')).toBe(false)
  })

  it('offers nothing in a hub until that hub has answered', async () => {
    let answer: ((v: { hubId: string; permissions: string[] }) => void) | undefined
    getMyHubPermissionsMock.mockImplementation(() => new Promise(res => { answer = res }))
    configState.currentHubId = 'hub-A'
    const { result } = await signedIn()

    await waitFor(() => expect(getMyHubPermissionsMock).toHaveBeenCalled())
    // Fail closed: the union would offer notes:read here before the hub said so.
    expect(result.current.permissions).toEqual([])
    expect(result.current.isAdmin).toBe(false)

    await act(async () => { answer?.({ hubId: 'hub-A', permissions: ['notes:read'] }) })
    await waitFor(() => expect(result.current.permissions).toEqual(['notes:read']))
  })

  it('treats a 403 as the hub granting nothing, not as "fall back to the union"', async () => {
    getMyHubPermissionsMock.mockRejectedValue(new MockApiError(403, '{"error":"Access denied"}'))
    configState.currentHubId = 'hub-A'
    const { result } = await signedIn()

    await waitFor(() => expect(getMyHubPermissionsMock).toHaveBeenCalled())
    await act(async () => {})
    expect(result.current.permissions).toEqual([])
    expect(result.current.hasAccountPermission('notes:read')).toBe(true)
  })

  it('applies a hub\'s cached set on switching back, then revalidates', async () => {
    answerPerHub()
    configState.currentHubId = 'hub-A'
    const { result, rerender } = await signedIn()
    await waitFor(() => expect(result.current.permissions).toEqual(perHub['hub-A']))

    configState.currentHubId = 'hub-B'
    rerender()
    await waitFor(() => expect(result.current.permissions).toEqual(perHub['hub-B']))

    // Back to hub-A with its answer held back: the cached set applies at once...
    let answer: ((v: { hubId: string; permissions: string[] }) => void) | undefined
    getMyHubPermissionsMock.mockImplementation(() => new Promise(res => { answer = res }))
    configState.currentHubId = 'hub-A'
    rerender()
    expect(result.current.permissions).toEqual(perHub['hub-A'])
    // ...and a role revoked server-side lands when the revalidation answers.
    await act(async () => { answer?.({ hubId: 'hub-A', permissions: ['notes:read'] }) })
    await waitFor(() => expect(result.current.permissions).toEqual(['notes:read']))
    expect(result.current.isAdmin).toBe(false)
  })

  it('uses the account-wide set when no hub is active', async () => {
    const { result } = await signedIn()
    await waitFor(() => expect(result.current.permissions).toEqual(['notes:read', 'notes:write']))
    expect(getMyHubPermissionsMock).not.toHaveBeenCalled()
  })

  it('signOut drops every hub\'s answers', async () => {
    answerPerHub()
    configState.currentHubId = 'hub-A'
    const { result } = await signedIn()
    await waitFor(() => expect(result.current.isAdmin).toBe(true))

    act(() => { result.current.signOut() })
    await waitFor(() => expect(result.current.permissions).toEqual([]))
    expect(result.current.isAdmin).toBe(false)
    expect(result.current.accountPermissions).toEqual([])
  })
})
