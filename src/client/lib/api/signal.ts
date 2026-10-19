import { request, hp, ApiError } from './client'
import { netFetch } from '../net'
import type {
  SignalRegistrationState,
  SignalAccountInfo,
} from '@protocol/schemas/setup'
import type {
  SecurityPrefs,
  SignalIdentityRecord,
  SignalQueueStats,
  SignalContactRecord,
  SignalContactRegistration,
  SidecarTokenResponse,
  NotifierRegisterPayload,
} from '@protocol/schemas/signal-notification'

export type { SignalRegistrationState }
export type { SignalAccountInfo }
export type { SignalIdentityRecord }
export type { SignalQueueStats }
export type { SecurityPrefs, SignalContactRecord }

// --- Signal Registration & Management ---

export async function signalRegister(data: {
  bridgeUrl: string
  bridgeApiKey: string
  phoneNumber: string
  useVoice?: boolean
  captcha?: string
}) {
  return request<SignalRegistrationState>('/setup/signal/register', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function signalVerify(data: {
  bridgeUrl: string
  bridgeApiKey: string
  phoneNumber: string
  verificationCode: string
}) {
  return request<SignalRegistrationState>('/setup/signal/verify', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function signalUnregister(data: {
  bridgeUrl: string
  bridgeApiKey: string
  registeredNumber: string
}) {
  return request<{ ok: boolean; error?: string }>('/setup/signal/unregister', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function getSignalAccountInfo() {
  return request<SignalAccountInfo>('/setup/signal/account')
}

export async function getSignalIdentities() {
  return request<{ identities: SignalIdentityRecord[] }>(hp('/messaging/signal/identities'))
}

export async function updateSignalIdentityTrust(uuid: string, trustLevel: string) {
  return request<{ success: boolean }>(hp('/messaging/signal/identities/trust'), {
    method: 'POST',
    body: JSON.stringify({ uuid, trustLevel }),
  })
}

export async function getSignalQueueStats() {
  return request<SignalQueueStats>(hp('/messaging/signal/queue/stats'))
}

// --- Signal Notification API ---

export async function getSignalContact(): Promise<SignalContactRecord | null> {
  try {
    return await request<SignalContactRecord>('/signal-notification/contact')
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null
    throw err
  }
}

export async function registerSignalContact(body: SignalContactRegistration) {
  return request<{ ok: boolean }>('/signal-notification/contact', {
    method: 'PUT',
    body: JSON.stringify(body),
  })
}

/** Mint the short-lived token that authorises one registration against the sidecar. */
export async function getSignalSidecarToken() {
  return request<SidecarTokenResponse>('/signal-notification/contact/sidecar-token', {
    method: 'POST',
    body: JSON.stringify({}),
  })
}

/** Body of the sidecar's `POST /api/register-client` — the one place plaintext is allowed to go. */
type SidecarRegisterBody = Pick<NotifierRegisterPayload, 'plaintextIdentifier' | 'identifierType'> & {
  token: string
}

/**
 * Hand the plaintext identifier to the sidecar — never to the app server. The
 * app server only ever holds the HMAC hash and an HPKE ciphertext of it.
 *
 * The app's session credentials are deliberately NOT attached: the sidecar
 * authenticates this call by `token` alone, and the app's `Authorization` header
 * has no business reaching a different service. Goes through `netFetch`, so a
 * packaged build still only reaches an origin the Rust allowlist permits.
 */
async function postToSidecar(sidecarUrl: string, body: SidecarRegisterBody): Promise<void> {
  const res = await netFetch(`${sidecarUrl.replace(/\/+$/, '')}/api/register-client`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new ApiError(res.status, await res.text())
}

/**
 * Register a Signal contact so that it either ends up registered everywhere or
 * nowhere.
 *
 * 1. Store the hash + ciphertext on the app server (the sidecar token is bound to
 *    that stored hash, so this has to come first).
 * 2. Get a sidecar token and register the plaintext with the sidecar directly.
 *
 * If step 2 fails for any reason, step 1 is rolled back. Leaving the hash stored
 * would show a contact as "registered" that the sidecar cannot deliver to. If the
 * rollback itself fails the error says so, because the caller is then looking at
 * exactly that half-registered state and must not treat it as a clean failure.
 */
export async function registerSignalContactEverywhere(
  contact: SignalContactRegistration,
  plaintextIdentifier: string,
): Promise<void> {
  await registerSignalContact(contact)
  try {
    const { token, sidecarUrl } = await getSignalSidecarToken()
    await postToSidecar(sidecarUrl, {
      token,
      plaintextIdentifier,
      identifierType: contact.identifierType,
    })
  } catch (err) {
    try {
      await deleteSignalContact()
    } catch (rollbackErr) {
      throw new Error('Signal registration failed and could not be rolled back', {
        cause: new AggregateError([err, rollbackErr]),
      })
    }
    throw err
  }
}

export async function deleteSignalContact() {
  return request<null>('/signal-notification/contact', { method: 'DELETE' })
}

export async function getSignalHmacKey(): Promise<{ hmacKey: string }> {
  return request<{ hmacKey: string }>('/signal-notification/hmac-key')
}

export async function getSecurityPrefs(): Promise<SecurityPrefs> {
  return request<SecurityPrefs>('/signal-notification/security-prefs')
}

export async function updateSecurityPrefs(patch: Partial<Omit<SecurityPrefs, 'updatedAt'>>) {
  return request<SecurityPrefs>('/signal-notification/security-prefs', {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}
