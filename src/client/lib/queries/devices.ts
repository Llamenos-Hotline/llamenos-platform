import { useState, useEffect, useCallback } from 'react'
import { request } from '@/lib/api'
import { registerCredential } from '@/lib/webauthn'

// ── Types ────────────────────────────────────────────────────────────

export interface DeviceDetail {
  id: string
  platform: string
  deviceName: string | null
  deviceModel: string | null
  osVersion: string | null
  appVersion: string | null
  ed25519Pubkey: string | null
  x25519Pubkey: string | null
  registeredAt: string
  lastSeenAt: string | null
  lastIpHash: string | null
  isCurrent: boolean
}

export interface SessionInfo {
  id: string
  deviceId: string | null
  platform: string | null
  userAgent: string | null
  ipHash: string | null
  createdAt: string
  expiresAt: string
  isCurrent: boolean
}

export interface SecurityEvent {
  id: string
  eventType: string
  deviceId: string | null
  metadata: Record<string, unknown>
  ipHash: string | null
  createdAt: string
}

export interface PasskeyInfo {
  credentialId: string
  label: string | null
  transports: string[]
  backedUp: boolean
  lastUsedAt: string | null
}

export interface AdminDeviceOverviewEntry {
  userPubkey: string
  displayName: string | null
  deviceCount: number
  lastSeenAt: string | null
  verified: boolean
  devices: DeviceDetail[]
}

export interface AdminDeviceOverview {
  entries: AdminDeviceOverviewEntry[]
  total: number
}

// ── Device hooks ─────────────────────────────────────────────────────

export function useDevices() {
  const [data, setData] = useState<DeviceDetail[] | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const load = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const res = await request<{ devices: DeviceDetail[] }>('/devices')
      setData(res.devices)
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  return { data, isLoading, error, refetch: load }
}

export async function renameDevice(deviceId: string, deviceName: string) {
  return request<{ id: string; deviceName: string }>(`/devices/${deviceId}`, {
    method: 'PATCH',
    body: JSON.stringify({ deviceName }),
  })
}

export async function revokeDevice(deviceId: string) {
  return request<{ revoked: boolean; deviceId: string; hubIdsRequiringKeyRotation: string[] }>(
    `/devices/${deviceId}/revoke`,
    { method: 'POST', body: JSON.stringify({ confirm: true }) },
  )
}

export async function verifyDevice(deviceId: string, signedAuditEntry: string) {
  return request<{ verified: boolean; verificationId: string }>(
    `/devices/${deviceId}/verify`,
    { method: 'POST', body: JSON.stringify({ signedAuditEntry }) },
  )
}

// ── Session hooks ────────────────────────────────────────────────────

export function useSessions() {
  const [data, setData] = useState<SessionInfo[] | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const load = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const res = await request<{ sessions: SessionInfo[] }>('/sessions')
      setData(res.sessions)
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  return { data, isLoading, error, refetch: load }
}

export async function terminateSession(sessionId: string) {
  await request(`/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
}

export async function terminateOtherSessions() {
  return request<{ terminated: number }>('/sessions/terminate-others', { method: 'POST' })
}

// ── Lockdown ─────────────────────────────────────────────────────────

export async function performLockdown() {
  return request<{ sessionsTerminated: number; hubIds: string[] }>('/account/lockdown', {
    method: 'POST',
  })
}

export async function completeLockdown(data: {
  pukRotated: boolean
  hubKeysRotated: string[]
  hubKeysFailed: string[]
}) {
  return request<{ ok: boolean }>('/account/lockdown/complete', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

// ── Security events ──────────────────────────────────────────────────

export function useSecurityEvents(limit: number, offset: number) {
  const [data, setData] = useState<{ events: SecurityEvent[]; total: number } | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const load = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const res = await request<{ events: SecurityEvent[]; total: number }>(
        `/security-events?limit=${limit}&offset=${offset}`,
      )
      setData(res)
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      setIsLoading(false)
    }
  }, [limit, offset])

  useEffect(() => { load() }, [load])

  return { data, isLoading, error, refetch: load }
}

// ── Admin device overview ────────────────────────────────────────────

export function useAdminDeviceOverview(hubId?: string) {
  const [data, setData] = useState<AdminDeviceOverview | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const load = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const params = hubId ? `?hubId=${hubId}` : ''
      const res = await request<AdminDeviceOverview>(`/admin/devices/overview${params}`)
      setData(res)
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      setIsLoading(false)
    }
  }, [hubId])

  useEffect(() => { load() }, [load])

  return { data, isLoading, error, refetch: load }
}

// ── Passkey hooks ────────────────────────────────────────────────────

export function usePasskeys() {
  const [data, setData] = useState<PasskeyInfo[] | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const load = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const res = await request<{ credentials: PasskeyInfo[] }>('/webauthn/credentials')
      setData(res.credentials)
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  return { data, isLoading, error, refetch: load }
}

export async function renamePasskey(credentialId: string, label: string) {
  await request(`/webauthn/credentials/${credentialId}`, {
    method: 'PATCH',
    body: JSON.stringify({ label }),
  })
}

export async function deletePasskey(credentialId: string) {
  await request(`/webauthn/credentials/${credentialId}`, { method: 'DELETE' })
}

/**
 * Run the full WebAuthn registration ceremony (`/webauthn/register/options`, the
 * authenticator prompt, then `/webauthn/register/verify`). There is no single
 * `/webauthn/register` route — the ceremony lives in `lib/webauthn.ts`.
 */
export async function registerPasskey(label: string): Promise<void> {
  await registerCredential(label)
}

// ── Mutations (side-effect helpers for invalidating caches) ──────────

/**
 * Simple refetch helper — calls all load functions after a mutation.
 * Components that need to stay in sync after mutations should call refetch.
 */
export function refetchAll(loaders: Array<() => void>) {
  loaders.forEach(fn => fn())
}
