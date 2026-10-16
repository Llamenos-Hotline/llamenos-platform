/**
 * WebAuthn client-side helpers for passkey registration, login, and credential management.
 * Uses @simplewebauthn/browser for browser API interaction.
 */

import { startRegistration, startAuthentication, type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser'
import * as keyManager from './key-manager'
import { createAuthToken } from './platform'
import { getApiUrl, getApiPath } from './api-config'
import { netFetch } from './net'

// Monotonic timestamp shared with api.ts — prevents nonce replay when
// webauthn auth headers are generated concurrently with other API calls.
let lastAuthTimestamp = 0
function monotoneNow(): number {
  const now = Date.now()
  lastAuthTimestamp = now > lastAuthTimestamp ? now : lastAuthTimestamp + 1
  return lastAuthTimestamp
}

async function getAuthHeaders(method: string, path: string): Promise<Record<string, string>> {
  // Prefer session token if available
  const sessionToken = sessionStorage.getItem('llamenos-session-token')
  if (sessionToken) {
    return { 'Authorization': `Session ${sessionToken}` }
  }
  // Use CryptoState for Schnorr auth if unlocked
  if (keyManager.isUnlocked()) {
    try {
      // No nonce argument: createAuthToken generates and signs its own, and
      // returns it inside the token JSON that travels in the Bearer header.
      const token = await createAuthToken(monotoneNow(), method, getApiPath(path))
      return { 'Authorization': `Bearer ${token}` }
    } catch {
      return {}
    }
  }
  return {}
}

/**
 * Check if WebAuthn is supported in this browser.
 */
export function isWebAuthnAvailable(): boolean {
  return typeof window !== 'undefined' &&
    !!window.PublicKeyCredential &&
    typeof window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === 'function'
}

/**
 * Register a new WebAuthn credential (passkey).
 * Requires existing auth (device key or session token).
 */
export async function registerCredential(label: string): Promise<void> {
  // 1. Get registration options from server
  const optionsHeaders = await getAuthHeaders('POST', '/webauthn/register/options')
  const optionsRes = await netFetch(getApiUrl('/webauthn/register/options'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...optionsHeaders },
    body: JSON.stringify({ label }),
  })
  if (!optionsRes.ok) throw new Error('Failed to get registration options')
  const { challengeId, ...optionsJSON } = await optionsRes.json() as PublicKeyCredentialCreationOptionsJSON & { challengeId: string }

  // 2. Create credential via browser WebAuthn API
  const attestation = await startRegistration({ optionsJSON })

  // 3. Verify with server
  const verifyHeaders = await getAuthHeaders('POST', '/webauthn/register/verify')
  const verifyRes = await netFetch(getApiUrl('/webauthn/register/verify'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...verifyHeaders },
    body: JSON.stringify({ attestation, label, challengeId }),
  })
  if (!verifyRes.ok) throw new Error('Failed to verify registration')
}

/**
 * Login with a passkey. Returns session token + pubkey.
 * No auth required — uses discoverable credentials.
 */
export async function loginWithPasskey(): Promise<{ token: string; pubkey: string }> {
  // 1. Get authentication options from server (no auth needed)
  const optionsRes = await netFetch(getApiUrl('/webauthn/login/options'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  })
  if (!optionsRes.ok) throw new Error('Failed to get authentication options')
  const { challengeId, ...optionsJSON } = await optionsRes.json() as PublicKeyCredentialRequestOptionsJSON & { challengeId: string }

  // 2. Authenticate via browser WebAuthn API
  const assertion = await startAuthentication({ optionsJSON })

  // 3. Verify with server — returns session token
  const verifyRes = await netFetch(getApiUrl('/webauthn/login/verify'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assertion, challengeId }),
  })
  if (!verifyRes.ok) throw new Error('Failed to verify authentication')
  return verifyRes.json() as Promise<{ token: string; pubkey: string }>
}

import type { WebAuthnCredentialInfo } from '@protocol/schemas/webauthn'

/**
 * List registered credentials for the current user.
 */
export async function listCredentials(): Promise<WebAuthnCredentialInfo[]> {
  const headers = await getAuthHeaders('GET', '/webauthn/credentials')
  const res = await netFetch(getApiUrl('/webauthn/credentials'), { headers })
  if (!res.ok) throw new Error('Failed to list credentials')
  const data = await res.json() as { credentials: WebAuthnCredentialInfo[] }
  return data.credentials
}

/**
 * Delete a registered credential.
 */
export async function deleteCredential(id: string): Promise<void> {
  const headers = await getAuthHeaders('DELETE', `/webauthn/credentials/${encodeURIComponent(id)}`)
  const res = await netFetch(getApiUrl(`/webauthn/credentials/${encodeURIComponent(id)}`), {
    method: 'DELETE',
    headers,
  })
  if (!res.ok) throw new Error('Failed to delete credential')
}
