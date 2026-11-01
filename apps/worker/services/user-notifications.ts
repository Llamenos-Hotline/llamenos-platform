/**
 * UserNotificationsService — render and dispatch security alerts via Signal.
 *
 * The app server never sends to the Signal identifier directly.
 * It dispatches via the signal-notifier sidecar using the HMAC hash.
 * The sidecar resolves hash → plaintext and calls signal-cli-rest-api.
 *
 * Retry logic: up to 3 attempts with exponential backoff (200ms × 2^attempt).
 */
import { createHmac } from 'node:crypto'
import { createLogger } from '../lib/logger'
import { safeFetch } from '../lib/safe-fetch'
import type { SignalContactsService } from './signal-contacts'
import type { SecurityPrefsService } from './security-prefs'
import type { AuditService } from './audit'
import { ServiceError } from './settings'
import { getLocaleString } from '@llamenos/i18n'
import type { IncidentCategory, IncidentState } from '@protocol/schemas/incidents'

const log = createLogger('services.user-notifications')

// ---------------------------------------------------------------------------
// Alert types
// ---------------------------------------------------------------------------

export type AlertInput =
  | { type: 'new_device'; city: string; country: string; userAgent: string }
  | { type: 'passkey_added'; credentialLabel: string }
  | { type: 'passkey_removed'; credentialLabel: string }
  | { type: 'pin_changed' }
  | { type: 'recovery_rotated' }
  | { type: 'lockdown_triggered'; tier: 'A' | 'B' | 'C' }
  | { type: 'session_revoked_remote'; city: string; country: string }
  | { type: 'cert_pin_mismatch'; eventCount: number }
  | {
      type: 'digest'
      periodDays: number
      loginCount: number
      alertCount: number
      failedCount: number
    }
  /**
   * A hub incident opened or closed (B-INCIDENTS, #2341). Category and state
   * only — never counts, a number, or anything that identifies a caller; the
   * app shows the detail to whoever holds the permission.
   */
  | { type: 'hub_incident'; category: IncidentCategory; state: IncidentState }

// ---------------------------------------------------------------------------
// Message rendering
// ---------------------------------------------------------------------------

export function formatDisappearingTimerSeconds(days: number): number {
  return days * 86400
}

/** The camelCase locale key segment for each incident category (`incident.category.<key>`). */
const INCIDENT_CATEGORY_LOCALE_KEY: Record<IncidentCategory, string> = {
  spam: 'spam',
  'provider-media': 'providerMedia',
  'erasure-deadline': 'erasureDeadline',
  'ban-expiry': 'banExpiry',
  routing: 'routing',
  'provider-auth': 'providerAuth',
  'channel-disabled': 'channelDisabled',
}

/** `incident.opened` reads "Happening now"; an update is still happening. */
const INCIDENT_STATE_LOCALE_KEY: Record<IncidentState, string> = {
  opened: 'incident.opened',
  updated: 'incident.opened',
  closed: 'incident.closed',
}

/** A key from `locale`, falling back to English — every incident key exists in en.json. */
function localized(locale: string, key: string): string {
  const value = getLocaleString(locale, key) ?? getLocaleString('en', key)
  if (value === undefined) throw new Error(`Missing locale key ${key}`)
  return value
}

function renderIncidentAlert(
  input: Extract<AlertInput, { type: 'hub_incident' }>,
  locale: string,
): string {
  return localized(locale, 'incident.signalAlert')
    .replace('{{category}}', localized(locale, `incident.category.${INCIDENT_CATEGORY_LOCALE_KEY[input.category]}`))
    .replace('{{state}}', localized(locale, INCIDENT_STATE_LOCALE_KEY[input.state]))
}

/**
 * Render an alert's Signal text. `locale` is the recipient's UI language; the
 * incident alert is localized from `incident.*`, the older alerts are English.
 */
export function renderAlertMessage(input: AlertInput, locale = 'en'): string {
  switch (input.type) {
    case 'new_device':
      return `🔔 New sign-in detected from ${input.city}, ${input.country} (${input.userAgent}). If this wasn't you, revoke the session and rotate your PIN.`
    case 'passkey_added':
      return `🔑 Passkey "${input.credentialLabel}" was added to your account.`
    case 'passkey_removed':
      return `🔑 Passkey "${input.credentialLabel}" was removed from your account.`
    case 'pin_changed':
      return `🔐 Your PIN was changed. If this wasn't you, trigger an emergency lockdown.`
    case 'recovery_rotated':
      return `🔄 Your recovery key was rotated. Save the new key in a safe place.`
    case 'lockdown_triggered':
      return `🚨 Emergency lockdown tier ${input.tier} was triggered on your account.`
    case 'session_revoked_remote':
      return `⛔ A session from ${input.city}, ${input.country} was revoked.`
    case 'cert_pin_mismatch':
      return `🚨 ${input.eventCount} client(s) reported a TLS certificate pin mismatch. This may be an active network attack or an unexpected certificate rotation. Review the admin security events log.`
    case 'digest':
      return `📊 Summary (last ${input.periodDays} days): ${input.loginCount} login(s), ${input.alertCount} alert(s), ${input.failedCount} failed attempt(s).`
    case 'hub_incident':
      return renderIncidentAlert(input, locale)
  }
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3

async function sendToNotifier(
  notifierUrl: string,
  apiKey: string,
  identifierHash: string,
  message: string,
  disappearingTimerSeconds: number
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await safeFetch(`${notifierUrl.replace(/\/+$/, '')}/api/notify`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ identifierHash, message, disappearingTimerSeconds }),
      timeoutMs: 10_000,
      ssrfGuard: false,
    })
    if (!res.ok) {
      return { ok: false, error: `Notifier ${res.status}` }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'notifier error' }
  }
}

export interface UserNotificationsConfig {
  notifierUrl: string
  notifierApiKey: string
  /** Secret used to HMAC-sign client registration tokens (shared with the sidecar). */
  tokenSecret: string
}

// ---------------------------------------------------------------------------
// Service class
// ---------------------------------------------------------------------------

export class UserNotificationsService {
  constructor(
    private signalContacts: SignalContactsService,
    private prefs: SecurityPrefsService,
    private audit: AuditService,
    private config: UserNotificationsConfig
  ) {}

  async sendAlert(
    userPubkey: string,
    alert: AlertInput,
    /** The recipient's UI language, for alerts that are localized. */
    locale = 'en',
  ): Promise<{ delivered: boolean }> {
    const prefs = await this.prefs.get(userPubkey)

    // Respect user's notification channel preference
    if (prefs.notificationChannel !== 'signal') return { delivered: false }

    // Check digest cadence opt-out
    if (alert.type === 'digest' && prefs.digestCadence === 'off') {
      return { delivered: false }
    }

    // Check per-alert opt-outs
    if (alert.type === 'new_device' && !prefs.alertOnNewDevice) return { delivered: false }
    if (
      (alert.type === 'passkey_added' || alert.type === 'passkey_removed') &&
      !prefs.alertOnPasskeyChange
    ) {
      return { delivered: false }
    }
    if (alert.type === 'pin_changed' && !prefs.alertOnPinChange) return { delivered: false }

    const contact = await this.signalContacts.findByUser(userPubkey)
    if (!contact) return { delivered: false }

    const message = renderAlertMessage(alert, locale)
    const timer = formatDisappearingTimerSeconds(prefs.disappearingTimerDays)

    let lastErr = ''
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const result = await sendToNotifier(
        this.config.notifierUrl,
        this.config.notifierApiKey,
        contact.identifierHash,
        message,
        timer
      )
      if (result.ok) {
        await this.audit.log('signal_alert_sent', userPubkey, { alertType: alert.type })
        return { delivered: true }
      }
      lastErr = result.error ?? 'unknown'
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 200 * 2 ** attempt))
      }
    }

    log.error('Signal alert delivery failed', { userPubkey, lastErr })
    return { delivered: false }
  }

  /**
   * Issue a short-lived HMAC-signed registration token authorizing the client
   * to register their plaintext identifier directly with the sidecar.
   *
   * Token format: base64url(payload) + '.' + hex-HMAC-SHA256
   * Payload: JSON {identifierHash, expiresAt}
   * Expiry: 5 minutes from now.
   *
   * The sidecar validates the token using the shared tokenSecret, then stores
   * the hash → plaintext mapping. The app server never sees the plaintext.
   */
  issueRegistrationToken(identifierHash: string): string {
    // An empty key would sign tokens anyone can forge. There is no other secret to
    // fall back to (D6): refuse rather than issue.
    if (!this.config.tokenSecret) {
      throw new ServiceError(503, 'Signal notifier token secret is not configured (NOTIFIER_TOKEN_SECRET)')
    }
    const expiresAt = Date.now() + 5 * 60 * 1000
    const payload = Buffer.from(JSON.stringify({ identifierHash, expiresAt })).toString('base64url')
    const sig = createHmac('sha256', this.config.tokenSecret).update(payload).digest('hex')
    return `${payload}.${sig}`
  }

  /** Base URL of the signal-notifier sidecar (for returning to clients). */
  getSidecarUrl(): string {
    return this.config.notifierUrl.replace(/\/+$/, '')
  }

  /**
   * Remove the user's plaintext identifier from the sidecar.
   * Called by the API route when a contact is deleted.
   */
  async unregisterFromSidecar(identifierHash: string): Promise<void> {
    try {
      await safeFetch(
        `${this.config.notifierUrl.replace(/\/+$/, '')}/api/unregister/${encodeURIComponent(identifierHash)}`,
        {
          method: 'DELETE',
          headers: { authorization: `Bearer ${this.config.notifierApiKey}` },
          timeoutMs: 10_000,
          ssrfGuard: false,
        }
      )
    } catch (err) {
      log.error('Failed to unregister from sidecar', { identifierHash, err })
    }
  }
}
