import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react'
import { ensureDeviceRegistered, resetDeviceRegistrationCache } from '@/lib/device-registration'
import { useTranslation } from 'react-i18next'
import {
  deviceImportAndLoad,
  isValidSeedHex,
  persistAndUnlockDeviceKeys,
  createAuthToken,
} from './platform'
import * as keyManager from './key-manager'
import { getMe, login, logout as apiLogout, updateMyAvailability, setOnAuthExpired, setOnApiActivity } from './api'
import { permissionGranted } from '@shared/permissions'
import { loginWithPasskey as webauthnLogin } from './webauthn'

interface AuthState {
  isKeyUnlocked: boolean
  publicKey: string | null
  roles: string[]
  permissions: string[]
  primaryRoleName: string | null
  name: string | null
  isLoading: boolean
  error: string | null
  transcriptionEnabled: boolean
  spokenLanguages: string[]
  uiLanguage: string
  profileCompleted: boolean
  onBreak: boolean
  callPreference: 'phone' | 'browser' | 'both'
  sessionExpiring: boolean
  sessionExpired: boolean
  adminPubkey: string
  adminDecryptionPubkey: string
  serverEventKeyHex: string | null
  serverEventKeyPrevHex: string | null
  eventKeyEpoch: number | undefined
  eventKeyEpochDuration: number | undefined
  webauthnRequired: boolean
  webauthnRegistered: boolean
}

interface AuthContextValue extends AuthState {
  signIn: (seedHex: string, pin: string) => Promise<void>
  loginAfterKeyLoaded: (pubkeyHex: string) => Promise<void>
  signInWithPasskey: () => Promise<void>
  signOut: () => void
  refreshProfile: () => Promise<void>
  toggleBreak: () => Promise<void>
  renewSession: () => Promise<void>
  unlockWithPin: (pin: string) => Promise<boolean>
  lockKey: () => void
  hasPermission: (permission: string) => boolean
  isAdmin: boolean
  isAuthenticated: boolean
  hasDeviceKey: boolean
  adminPubkey: string
  adminDecryptionPubkey: string
  webauthnEnrollmentRequired: boolean
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  const [state, setState] = useState<AuthState>({
    isKeyUnlocked: false,
    publicKey: null,
    roles: [],
    permissions: [],
    primaryRoleName: null,
    name: null,
    isLoading: true,
    error: null,
    transcriptionEnabled: true,
    spokenLanguages: ['en'],
    uiLanguage: 'en',
    profileCompleted: true,
    onBreak: false,
    callPreference: 'phone',
    sessionExpiring: false,
    sessionExpired: false,
    adminPubkey: '',
    adminDecryptionPubkey: '',
    serverEventKeyHex: null,
    serverEventKeyPrevHex: null,
    eventKeyEpoch: undefined,
    eventKeyEpochDuration: undefined,
    webauthnRequired: false,
    webauthnRegistered: false,
  })

  const lastApiActivity = useRef(Date.now())

  // Track API activity — called after each successful request
  const markActivity = useCallback(() => {
    lastApiActivity.current = Date.now()
    setState(s => s.sessionExpiring ? { ...s, sessionExpiring: false } : s)
  }, [])

  // Listen for key manager lock/unlock events
  useEffect(() => {
    const unsubLock = keyManager.onLock(() => {
      setState(s => ({ ...s, isKeyUnlocked: false }))
    })
    const unsubUnlock = keyManager.onUnlock(() => {
      setState(s => ({
        ...s,
        isKeyUnlocked: true,
        publicKey: keyManager.getPublicKeyHex(),
      }))
    })
    return () => { unsubLock(); unsubUnlock() }
  }, [])

  // Register auth expiry callback — called by api.ts when a 401 is received
  useEffect(() => {
    setOnAuthExpired(() => {
      setState(s => ({
        ...s,
        sessionExpired: true,
        sessionExpiring: false,
        ...(s.isKeyUnlocked ? {} : { roles: [], permissions: [], primaryRoleName: null, name: null }),
      }))
    })
    return () => setOnAuthExpired(null)
  }, [])

  // Register API activity callback
  useEffect(() => {
    setOnApiActivity(markActivity)
    return () => setOnApiActivity(null)
  }, [markActivity])

  // Register this device's X25519 encryption key with the server.
  //
  // Nothing can HPKE-wrap a message, transcription or call record to a user
  // whose devices carry no X25519 key, and before this the desktop registered
  // no device at all — so every server-written envelope reached the client with
  // no envelope addressed to it and rendered as `[Encrypted]`.
  //
  // Runs once authenticated AND unlocked, because the key lives in Rust
  // CryptoState and `getDevicePubkeys()` returns null while locked.
  useEffect(() => {
    if (!state.publicKey || !state.isKeyUnlocked) return
    let cancelled = false
    ensureDeviceRegistered().catch((err) => {
      if (cancelled) return
      // Loud, not fatal: the session is usable, but E2EE content written while
      // this is failing will not be readable on this device.
      console.error('[auth] device encryption key registration failed', err)
    })
    return () => { cancelled = true }
  }, [state.publicKey, state.isKeyUnlocked])

  // Session expiry warning — check every 60s if idle > 30 min.
  // Server uses sliding expiry (extends 8h on each validated request), so only truly
  // idle sessions expire. The 30-min client threshold gives ample warning.
  useEffect(() => {
    if (!state.isKeyUnlocked && !sessionStorage.getItem('llamenos-session-token')) return
    const interval = setInterval(() => {
      const elapsed = Date.now() - lastApiActivity.current
      const WARN_THRESHOLD = 30 * 60 * 1000 // 30 minutes
      if (elapsed >= WARN_THRESHOLD && !state.sessionExpired) {
        setState(s => ({ ...s, sessionExpiring: true }))
      }
    }, 60_000)
    return () => clearInterval(interval)
  }, [state.isKeyUnlocked, state.sessionExpired])

  // Restore session on mount
  useEffect(() => {
    let mounted = true
    // Try session token (WebAuthn session) — always try this first
    const sessionToken = sessionStorage.getItem('llamenos-session-token')
    if (sessionToken) {
      getMe()
        .then((me) => {
          if (!mounted) return
          lastApiActivity.current = Date.now()
          setState({
            isKeyUnlocked: keyManager.isUnlocked(),
            publicKey: me.pubkey,
            roles: me.roles || [],
            permissions: me.permissions || [],
            primaryRoleName: me.primaryRole?.name || null,
            name: me.name,
            isLoading: false,
            error: null,
            transcriptionEnabled: me.transcriptionEnabled,
            spokenLanguages: me.spokenLanguages || ['en'],
            uiLanguage: me.uiLanguage || 'en',
            profileCompleted: me.profileCompleted ?? true,
            onBreak: me.onBreak ?? false,
            callPreference: me.callPreference ?? 'phone',
            adminPubkey: me.adminDecryptionPubkey || '',
            adminDecryptionPubkey: me.adminDecryptionPubkey || '',
            serverEventKeyHex: me.serverEventKeyHex ?? null,
        serverEventKeyPrevHex: me.serverEventKeyPrevHex ?? null,
        eventKeyEpoch: me.eventKeyEpoch,
        eventKeyEpochDuration: me.eventKeyEpochDuration,
            webauthnRequired: me.webauthnRequired ?? false,
            webauthnRegistered: me.webauthnRegistered ?? false,
            sessionExpiring: false,
            sessionExpired: false,
          })
        })
        .catch(() => {
          if (!mounted) return
          sessionStorage.removeItem('llamenos-session-token')
          setState(s => ({ ...s, isLoading: false }))
        })
      return () => { mounted = false }
    }
    // If key manager is already unlocked (e.g., still in memory from tab switch),
    // try to authenticate with Schnorr token
    if (keyManager.isUnlocked()) {
      getMe()
        .then((me) => {
          if (!mounted) return
          lastApiActivity.current = Date.now()
          setState({
            isKeyUnlocked: true,
            publicKey: me.pubkey,
            roles: me.roles || [],
            permissions: me.permissions || [],
            primaryRoleName: me.primaryRole?.name || null,
            name: me.name,
            isLoading: false,
            error: null,
            transcriptionEnabled: me.transcriptionEnabled,
            spokenLanguages: me.spokenLanguages || ['en'],
            uiLanguage: me.uiLanguage || 'en',
            profileCompleted: me.profileCompleted ?? true,
            onBreak: me.onBreak ?? false,
            callPreference: me.callPreference ?? 'phone',
            adminPubkey: me.adminDecryptionPubkey || '',
            adminDecryptionPubkey: me.adminDecryptionPubkey || '',
            serverEventKeyHex: me.serverEventKeyHex ?? null,
        serverEventKeyPrevHex: me.serverEventKeyPrevHex ?? null,
        eventKeyEpoch: me.eventKeyEpoch,
        eventKeyEpochDuration: me.eventKeyEpochDuration,
            webauthnRequired: me.webauthnRequired ?? false,
            webauthnRegistered: me.webauthnRegistered ?? false,
            sessionExpiring: false,
            sessionExpired: false,
          })
        })
        .catch(() => {
          if (!mounted) return
          keyManager.lock()
          setState(s => ({ ...s, isLoading: false }))
        })
      return () => { mounted = false }
    }
    setState(s => ({ ...s, isLoading: false }))
    return () => { mounted = false }
  }, [])

  // Sign in with Ed25519 seed hex + PIN
  const signIn = useCallback(async (seedHex: string, pin: string) => {
    setState(s => ({ ...s, isLoading: true, error: null }))
    if (!isValidSeedHex(seedHex)) {
      setState(s => ({ ...s, isLoading: false, error: t('auth.invalidKey') }))
      return
    }
    try {
      // Import Ed25519 seed, encrypt with PIN, persist to store
      const encrypted = await deviceImportAndLoad(seedHex, pin, crypto.randomUUID())
      await persistAndUnlockDeviceKeys(encrypted, pin)
      const pubkeyHex = encrypted.state.signingPubkeyHex
      keyManager.markUnlocked(pubkeyHex)
      // Create auth token using CryptoState (device key never leaves Rust)
      const tokenJson = await createAuthToken(Date.now(), 'POST', '/api/auth/login')
      const parsed = JSON.parse(tokenJson)
      await login(pubkeyHex, parsed.timestamp, parsed.token)
      const me = await getMe()
      lastApiActivity.current = Date.now()
      setState({
        isKeyUnlocked: true,
        publicKey: pubkeyHex,
        roles: me.roles || [],
        permissions: me.permissions || [],
        primaryRoleName: me.primaryRole?.name || null,
        name: me.name,
        isLoading: false,
        error: null,
        transcriptionEnabled: me.transcriptionEnabled,
        spokenLanguages: me.spokenLanguages || ['en'],
        uiLanguage: me.uiLanguage || 'en',
        profileCompleted: me.profileCompleted ?? true,
        onBreak: me.onBreak ?? false,
        callPreference: me.callPreference ?? 'phone',
        adminPubkey: me.adminDecryptionPubkey || '',
        adminDecryptionPubkey: me.adminDecryptionPubkey || '',
        serverEventKeyHex: me.serverEventKeyHex ?? null,
        serverEventKeyPrevHex: me.serverEventKeyPrevHex ?? null,
        eventKeyEpoch: me.eventKeyEpoch,
        eventKeyEpochDuration: me.eventKeyEpochDuration,
        webauthnRequired: me.webauthnRequired ?? false,
        webauthnRegistered: me.webauthnRegistered ?? false,
        sessionExpiring: false,
        sessionExpired: false,
      })
    } catch (err) {
      setState(s => ({
        ...s,
        isLoading: false,
        error: err instanceof Error ? err.message : t('auth.loginFailed'),
      }))
    }
  }, [])

  // Log in after key is already loaded into CryptoState (post-onboarding / post-bootstrap).
  // Do NOT call signIn() in this case — it would try to import the key again (double-encrypt).
  const loginAfterKeyLoaded = useCallback(async (pubkeyHex: string) => {
    setState(s => ({ ...s, isLoading: true, error: null }))
    try {
      // Sync key-manager state so getAuthHeaders() can produce auth tokens
      keyManager.markUnlocked(pubkeyHex)
      const tokenJson = await createAuthToken(Date.now(), 'POST', '/api/auth/login')
      const parsed = JSON.parse(tokenJson)
      await login(pubkeyHex, parsed.timestamp, parsed.token)
      const me = await getMe()
      lastApiActivity.current = Date.now()
      setState({
        isKeyUnlocked: true,
        publicKey: pubkeyHex,
        roles: me.roles || [],
        permissions: me.permissions || [],
        primaryRoleName: me.primaryRole?.name || null,
        name: me.name,
        isLoading: false,
        error: null,
        transcriptionEnabled: me.transcriptionEnabled,
        spokenLanguages: me.spokenLanguages || ['en'],
        uiLanguage: me.uiLanguage || 'en',
        profileCompleted: me.profileCompleted ?? true,
        onBreak: me.onBreak ?? false,
        callPreference: me.callPreference ?? 'phone',
        adminPubkey: me.adminDecryptionPubkey || '',
        adminDecryptionPubkey: me.adminDecryptionPubkey || '',
        serverEventKeyHex: me.serverEventKeyHex ?? null,
        serverEventKeyPrevHex: me.serverEventKeyPrevHex ?? null,
        eventKeyEpoch: me.eventKeyEpoch,
        eventKeyEpochDuration: me.eventKeyEpochDuration,
        webauthnRequired: me.webauthnRequired ?? false,
        webauthnRegistered: me.webauthnRegistered ?? false,
        sessionExpiring: false,
        sessionExpired: false,
      })
    } catch (err) {
      setState(s => ({
        ...s,
        isLoading: false,
        error: err instanceof Error ? err.message : t('auth.loginFailed'),
      }))
    }
  }, [])

  // Unlock with PIN (primary day-to-day auth)
  const unlockWithPin = useCallback(async (pin: string): Promise<boolean> => {
    const pubkey = await keyManager.unlock(pin)
    if (!pubkey) return false

    try {
      const me = await getMe()
      lastApiActivity.current = Date.now()
      setState({
        isKeyUnlocked: true,
        publicKey: pubkey,
        roles: me.roles || [],
        permissions: me.permissions || [],
        primaryRoleName: me.primaryRole?.name || null,
        name: me.name,
        isLoading: false,
        error: null,
        transcriptionEnabled: me.transcriptionEnabled,
        spokenLanguages: me.spokenLanguages || ['en'],
        uiLanguage: me.uiLanguage || 'en',
        profileCompleted: me.profileCompleted ?? true,
        onBreak: me.onBreak ?? false,
        callPreference: me.callPreference ?? 'phone',
        adminPubkey: me.adminDecryptionPubkey || '',
        adminDecryptionPubkey: me.adminDecryptionPubkey || '',
        serverEventKeyHex: me.serverEventKeyHex ?? null,
        serverEventKeyPrevHex: me.serverEventKeyPrevHex ?? null,
        eventKeyEpoch: me.eventKeyEpoch,
        eventKeyEpochDuration: me.eventKeyEpochDuration,
        webauthnRequired: me.webauthnRequired ?? false,
        webauthnRegistered: me.webauthnRegistered ?? false,
        sessionExpiring: false,
        sessionExpired: false,
      })
      return true
    } catch {
      keyManager.lock()
      return false
    }
  }, [])

  const lockKey = useCallback(() => {
    keyManager.lock()
  }, [])

  const signInWithPasskey = useCallback(async () => {
    setState(s => ({ ...s, isLoading: true, error: null }))
    try {
      const { token, pubkey } = await webauthnLogin()
      // Store session token (not device key — user doesn't have it)
      sessionStorage.setItem('llamenos-session-token', token)
      const me = await getMe()
      lastApiActivity.current = Date.now()
      setState({
        isKeyUnlocked: false, // No device key available — crypto locked
        publicKey: pubkey,
        roles: me.roles || [],
        permissions: me.permissions || [],
        primaryRoleName: me.primaryRole?.name || null,
        name: me.name,
        isLoading: false,
        error: null,
        transcriptionEnabled: me.transcriptionEnabled,
        spokenLanguages: me.spokenLanguages || ['en'],
        uiLanguage: me.uiLanguage || 'en',
        profileCompleted: me.profileCompleted ?? true,
        onBreak: me.onBreak ?? false,
        callPreference: me.callPreference ?? 'phone',
        adminPubkey: me.adminDecryptionPubkey || '',
        adminDecryptionPubkey: me.adminDecryptionPubkey || '',
        serverEventKeyHex: me.serverEventKeyHex ?? null,
        serverEventKeyPrevHex: me.serverEventKeyPrevHex ?? null,
        eventKeyEpoch: me.eventKeyEpoch,
        eventKeyEpochDuration: me.eventKeyEpochDuration,
        webauthnRequired: me.webauthnRequired ?? false,
        webauthnRegistered: me.webauthnRegistered ?? false,
        sessionExpiring: false,
        sessionExpired: false,
      })
    } catch (err) {
      setState(s => ({
        ...s,
        isLoading: false,
        error: err instanceof Error ? err.message : t('auth.passkeyLoginFailed'),
      }))
    }
  }, [])

  const refreshProfile = useCallback(async () => {
    try {
      const me = await getMe()
      lastApiActivity.current = Date.now()
      setState(s => ({
        ...s,
        name: me.name,
        roles: me.roles || [],
        permissions: me.permissions || [],
        primaryRoleName: me.primaryRole?.name || null,
        publicKey: me.pubkey,
        transcriptionEnabled: me.transcriptionEnabled,
        spokenLanguages: me.spokenLanguages || ['en'],
        uiLanguage: me.uiLanguage || 'en',
        profileCompleted: me.profileCompleted ?? true,
        onBreak: me.onBreak ?? false,
        callPreference: me.callPreference ?? 'phone',
        adminPubkey: me.adminDecryptionPubkey || '',
        adminDecryptionPubkey: me.adminDecryptionPubkey || '',
        serverEventKeyHex: me.serverEventKeyHex ?? null,
        serverEventKeyPrevHex: me.serverEventKeyPrevHex ?? null,
        eventKeyEpoch: me.eventKeyEpoch,
        eventKeyEpochDuration: me.eventKeyEpochDuration,
        webauthnRequired: me.webauthnRequired ?? false,
        webauthnRegistered: me.webauthnRegistered ?? false,
        sessionExpiring: false,
        sessionExpired: false,
      }))
    } catch {
      // ignore — if the refresh fails the user stays on the current page
    }
  }, [])

  const renewSession = useCallback(async () => {
    try {
      const me = await getMe()
      lastApiActivity.current = Date.now()
      setState(s => ({
        ...s,
        name: me.name,
        roles: me.roles || [],
        permissions: me.permissions || [],
        primaryRoleName: me.primaryRole?.name || null,
        publicKey: me.pubkey,
        transcriptionEnabled: me.transcriptionEnabled,
        spokenLanguages: me.spokenLanguages || ['en'],
        uiLanguage: me.uiLanguage || 'en',
        profileCompleted: me.profileCompleted ?? true,
        onBreak: me.onBreak ?? false,
        callPreference: me.callPreference ?? 'phone',
        adminPubkey: me.adminDecryptionPubkey || '',
        adminDecryptionPubkey: me.adminDecryptionPubkey || '',
        serverEventKeyHex: me.serverEventKeyHex ?? null,
        serverEventKeyPrevHex: me.serverEventKeyPrevHex ?? null,
        eventKeyEpoch: me.eventKeyEpoch,
        eventKeyEpochDuration: me.eventKeyEpochDuration,
        webauthnRequired: me.webauthnRequired ?? false,
        webauthnRegistered: me.webauthnRegistered ?? false,
        sessionExpiring: false,
        sessionExpired: false,
      }))
    } catch {
      // Renewal failed — session truly expired
      setState(s => ({ ...s, sessionExpired: true, sessionExpiring: false }))
    }
  }, [])

  const toggleBreak = useCallback(async () => {
    const newValue = !state.onBreak
    try {
      await updateMyAvailability(newValue)
      setState(s => ({ ...s, onBreak: newValue }))
    } catch {
      // ignore — toast handled by caller
      throw new Error(t('auth.failedUpdateAvailability'))
    }
  }, [state.onBreak])

  const signOut = useCallback(() => {
    // Revoke server-side session token before clearing local state
    apiLogout()
    keyManager.lock()
    resetDeviceRegistrationCache()
    sessionStorage.removeItem('llamenos-session-token')
    // Clean up encrypted drafts from localStorage
    const draftKeys = Object.keys(localStorage).filter(k => k.startsWith('llamenos-draft:'))
    draftKeys.forEach(k => localStorage.removeItem(k))
    setState({
      isKeyUnlocked: false,
      publicKey: null,
      roles: [],
      permissions: [],
      primaryRoleName: null,
      name: null,
      isLoading: false,
      error: null,
      transcriptionEnabled: true,
      spokenLanguages: ['en'],
      uiLanguage: 'en',
      profileCompleted: true,
      onBreak: false,
      callPreference: 'phone',
      adminPubkey: '',
      adminDecryptionPubkey: '',
      serverEventKeyHex: null,
      serverEventKeyPrevHex: null,
      eventKeyEpoch: undefined,
      eventKeyEpochDuration: undefined,
      webauthnRequired: false,
      webauthnRegistered: false,
      sessionExpiring: false,
      sessionExpired: false,
    })
  }, [])

  const hasSessionToken = typeof window !== 'undefined' && !!sessionStorage.getItem('llamenos-session-token')

  const value: AuthContextValue = {
    ...state,
    signIn,
    loginAfterKeyLoaded,
    signInWithPasskey,
    signOut,
    refreshProfile,
    toggleBreak,
    renewSession,
    unlockWithPin,
    lockKey,
    hasPermission: (permission: string) => permissionGranted(state.permissions, permission),
    isAdmin: permissionGranted(state.permissions, 'settings:manage'),
    isAuthenticated: (state.isKeyUnlocked || hasSessionToken) && state.roles.length > 0,
    hasDeviceKey: state.isKeyUnlocked,
    webauthnEnrollmentRequired: state.webauthnRequired && !state.webauthnRegistered,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
