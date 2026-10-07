/**
 * SignalRegistrationService — state machine for registering a phone number
 * with a signal-cli-rest-api bridge.
 *
 * State machine:
 *   idle -> pending    (SMS code sent / voice call initiated)
 *   pending -> verifying (admin is entering voice verification code)
 *   pending -> complete  (bridge auto-confirmed SMS verification)
 *   pending -> failed    (10-minute timeout)
 *   verifying -> complete (code validated)
 *   verifying -> failed  (wrong code 3×, or timeout)
 *
 * Phone numbers are PII — encrypted before storage, masked in non-admin API responses.
 * Bridge URLs are SSRF-validated before any outbound HTTP call is made.
 */

import { eq, and } from 'drizzle-orm'
import { randomBytes } from 'node:crypto'
import type { Database } from '../../db'
import { signalRegistrations } from '../../db/schema'
import { encryptCredentials, decryptCredentials } from './crypto'
import { validateExternalUrl } from '../../lib/ssrf-guard'
import { safeFetch } from '../../lib/safe-fetch'
import { devSurfaceRequestAuthorized, type DevSurfacesEnv } from '../../lib/dev-surfaces'

// ── Types ─────────────────────────────────────────────────────────────────

export type SignalRegistrationStatus =
  | 'idle'
  | 'pending'
  | 'verifying'
  | 'complete'
  | 'failed'

export interface SignalRegistration {
  id: string
  hubId: string
  bridgeUrl: string | null
  /** Masked phone number (last 4 digits only) — never the raw value. */
  phoneNumberMasked: string
  method: 'sms' | 'voice'
  status: SignalRegistrationStatus
  attempts: number
  error: string | null
  expiresAt: string | null
  createdAt: string
  updatedAt: string
}

export interface StartRegistrationParams {
  bridgeUrl: string
  phoneNumber: string
  method: 'sms' | 'voice'
  hubId: string
  /**
   * The `X-Test-Secret` header of the request that asked for this, verbatim and
   * unvalidated. The SECRET is what travels, never a boolean: the service
   * checks it against the host's own configured secret (see
   * {@link SignalRegistrationService.syntheticBridge}), so no caller can turn
   * the synthetic path on by passing a flag.
   */
  harnessSecret?: string
}

export interface VerifyCodeParams {
  registrationId: string
  code: string
  /** See {@link StartRegistrationParams.harnessSecret}. */
  harnessSecret?: string
}

/** Valid state transitions. */
const VALID_TRANSITIONS: Record<SignalRegistrationStatus, SignalRegistrationStatus[]> = {
  idle: ['pending'],
  pending: ['verifying', 'complete', 'failed'],
  verifying: ['complete', 'failed'],
  complete: [],
  failed: [],
}

const REGISTRATION_TTL_MS = 10 * 60 * 1000 // 10 minutes
const MAX_VERIFY_ATTEMPTS = 3

// ── Service ───────────────────────────────────────────────────────────────

/**
 * Test verification code accepted on the synthetic path, where the bridge is
 * not contacted at all. See {@link SignalRegistrationService.syntheticBridge}
 * for who gets that path.
 */
const TEST_VALID_CODE = '123456'

export class SignalRegistrationService {
  private readonly devSurfaceEnv: DevSurfacesEnv

  constructor(
    private readonly db: Database,
    private readonly hmacSecret: string,
    env?: DevSurfacesEnv,
  ) {
    this.devSurfaceEnv = env ?? {}
  }

  /**
   * True when this request may take the SYNTHETIC bridge path: the bridge is
   * not contacted, `startRegistration` skips the register call, `checkStatus`
   * skips the poll, `verifyCode` accepts {@link TEST_VALID_CODE} and rejects
   * everything else, and `unregister` skips the bridge delete.
   *
   * This used to be `env?.ENVIRONMENT === 'development'`, fixed once at
   * construction. `createServices` runs exactly once per process, so on a
   * staging host the flag was permanently false and `verifyCode` dialled an
   * unreachable mock bridge — `admin/provider-setup-signal` failed with a 502
   * and a `status` of `undefined`, neither of which names the branch that was
   * taken (#1623). Setting `ENVIRONMENT=development` on the deployed host to
   * paper over it would have re-enabled every other development branch in the
   * codebase at once.
   *
   * The replacement is the PER-REQUEST form, `devSurfaceRequestAuthorized`,
   * which fits here where it did not fit the push recorder: all four callers
   * are ordinary request handlers in `routes/provider-setup.ts` with the
   * request's own headers in scope, and the harness sends `X-Test-Secret` on
   * every request it makes (`tests/dev-surface-secret.ts#devSurfaceHeaders`).
   * So the substitution is scoped to the caller that proved it is the harness,
   * rather than to the whole host: an admin of a staging instance who does NOT
   * hold the secret still talks to the real bridge, and still sees a real
   * bridge failure rather than a synthetic success.
   *
   * Both halves of the conjunction are load-bearing and the order is not
   * negotiable. `devSurfacesEnabled` refuses `production` FIRST and
   * unconditionally — before `DEV_ROUTES_ENABLED` or any secret is read — so a
   * production host that somehow carried a `DEV_RESET_SECRET` still cannot be
   * talked onto the synthetic path by any header. And without
   * `devSurfaceSecretPresented` every unauthenticated-to-the-dev-surface admin
   * on a reachable staging host would get it.
   */
  private syntheticBridge(harnessSecret: string | undefined): boolean {
    return devSurfaceRequestAuthorized(this.devSurfaceEnv, harnessSecret)
  }

  /**
   * Start a Signal bridge registration.
   *
   * Validates the bridge URL for SSRF, encrypts the phone number, persists
   * the record, then calls the bridge to initiate SMS or voice verification.
   */
  async startRegistration(params: StartRegistrationParams): Promise<SignalRegistration> {
    const ssrfError = validateExternalUrl(params.bridgeUrl, 'Bridge URL')
    if (ssrfError) {
      throw new SignalRegistrationError(ssrfError, 400)
    }

    const encryptedPhone = encryptCredentials({ phoneNumber: params.phoneNumber }, this.hmacSecret)
    const id = randomBytes(16).toString('hex')
    const expiresAt = new Date(Date.now() + REGISTRATION_TTL_MS)
    const bridgeUrl = params.bridgeUrl.replace(/\/+$/, '')

    await this.db.insert(signalRegistrations).values({
      id,
      hubId: params.hubId,
      bridgeUrl,
      phoneNumber: encryptedPhone,
      method: params.method,
      status: 'pending',
      attempts: 0,
      expiresAt,
    })

    // Call bridge to initiate verification — non-fatal.
    // The record is already persisted with status 'pending'. If the bridge is
    // unreachable the admin can poll via checkStatus once it comes back online.
    // Fire-and-forget: detach the promise so the HTTP response is not blocked
    // by the bridge's TCP connect timeout (which can be 30+ seconds).
    this.callBridgeRegister(
      bridgeUrl,
      params.phoneNumber,
      params.method === 'voice',
      this.syntheticBridge(params.harnessSecret),
    )
      .catch((_err: unknown) => {
        // Bridge unreachable or returned an error — registration stays pending.
        // Intentionally swallowed: bridge availability is not required for the
        // registration record to exist.
      })

    const row = await this.loadRow(id)
    return this.toPublic(row)
  }

  /**
   * Poll the bridge for registration status and update the DB accordingly.
   *
   * For SMS registrations, the bridge confirms automatically when Signal
   * delivers the verification SMS. For voice, the admin must call verifyCode.
   */
  async checkStatus(
    registrationId: string,
    harnessSecret?: string,
  ): Promise<SignalRegistration> {
    const row = await this.loadRow(registrationId)
    await this.enforceNotExpired(row)

    if (row.status === 'complete' || row.status === 'failed') {
      return this.toPublic(row)
    }

    const bridgeUrl = row.bridgeUrl
    if (!bridgeUrl) {
      return this.toPublic(row)
    }

    // On the synthetic path, skip the bridge poll — no bridge is running
    if (!this.syntheticBridge(harnessSecret)) {
      const phone = this.decryptPhone(row.phoneNumber)
      try {
        const res = await this.fetchBridge(
          `${bridgeUrl}/v1/accounts/${encodeURIComponent(phone)}`,
          { headers: { 'Content-Type': 'application/json' } },
        )
        if (res.ok) {
          // Bridge confirmed the account exists — registration complete
          if (row.status === 'pending' && row.method === 'sms') {
            await this.transition(row, 'complete')
          }
        }
      } catch {
        // Transient error — do not change status
      }
    }

    const updated = await this.loadRow(registrationId)
    return this.toPublic(updated)
  }

  /**
   * Submit a voice verification code (voice flow only).
   *
   * Enforces a 3-attempt limit. On the third wrong code the registration
   * moves to 'failed' and cannot be retried without a new startRegistration.
   */
  async verifyCode(params: VerifyCodeParams): Promise<SignalRegistration> {
    // Defense-in-depth: validate code format even if route schema already checks
    if (!/^\d{3,8}$/.test(params.code)) {
      throw new SignalRegistrationError('Invalid verification code format', 400)
    }

    const row = await this.loadRow(params.registrationId)
    await this.enforceNotExpired(row)

    if (row.status !== 'pending' && row.status !== 'verifying') {
      throw new SignalRegistrationError(
        `Cannot verify code in state "${row.status}"`,
        409,
      )
    }

    const bridgeUrl = row.bridgeUrl
    if (!bridgeUrl) {
      throw new SignalRegistrationError('Registration has no bridge URL', 400)
    }

    // Transition to verifying if still in pending
    if (row.status === 'pending') {
      await this.transition(row, 'verifying')
    }

    // On the synthetic path, simulate bridge verification without a real
    // bridge. Matches the A2P pattern where Twilio calls return synthetic
    // results.
    const codeAccepted = this.syntheticBridge(params.harnessSecret)
      ? params.code === TEST_VALID_CODE
      : await this.callBridgeVerify(bridgeUrl, row, params)

    if (codeAccepted) {
      await this.db
        .update(signalRegistrations)
        .set({ status: 'complete', updatedAt: new Date() })
        .where(eq(signalRegistrations.id, params.registrationId))
    } else {
      const currentRow = await this.loadRow(params.registrationId)
      const newAttempts = (currentRow.attempts ?? 0) + 1
      const nextStatus: SignalRegistrationStatus =
        newAttempts >= MAX_VERIFY_ATTEMPTS ? 'failed' : 'verifying'

      // CAS: only update if attempts hasn't changed (prevents concurrent bypass of 3-attempt limit)
      const casResult = await this.db
        .update(signalRegistrations)
        .set({
          status: nextStatus,
          attempts: newAttempts,
          error: nextStatus === 'failed'
            ? `Verification failed after ${MAX_VERIFY_ATTEMPTS} attempts`
            : `Verification code rejected (attempt ${newAttempts}/${MAX_VERIFY_ATTEMPTS})`,
          updatedAt: new Date(),
        })
        .where(and(
          eq(signalRegistrations.id, params.registrationId),
          eq(signalRegistrations.attempts, currentRow.attempts ?? 0),
        ))
        .returning({ id: signalRegistrations.id })

      if (casResult.length === 0) {
        throw new SignalRegistrationError('Concurrent verification attempt detected — please retry', 409)
      }
    }

    const updated = await this.loadRow(params.registrationId)
    return this.toPublic(updated)
  }

  /**
   * Unregister the phone number from the Signal bridge and delete the DB record.
   */
  async unregister(registrationId: string, harnessSecret?: string): Promise<void> {
    const row = await this.loadRow(registrationId)
    const bridgeUrl = row.bridgeUrl

    if (bridgeUrl && !this.syntheticBridge(harnessSecret)) {
      const phone = this.decryptPhone(row.phoneNumber)
      try {
        await this.fetchBridge(
          `${bridgeUrl}/v1/accounts/${encodeURIComponent(phone)}`,
          { method: 'DELETE', headers: { 'Content-Type': 'application/json' } },
        )
      } catch {
        // Non-fatal — delete DB record regardless
      }
    }

    await this.db
      .delete(signalRegistrations)
      .where(eq(signalRegistrations.id, registrationId))
  }

  /**
   * Get account information from the bridge for a registration.
   */
  async getAccountInfo(registrationId: string): Promise<{
    registered: boolean
    phoneNumberMasked: string
    uuid?: string
    error?: string
  }> {
    const row = await this.loadRow(registrationId)
    const bridgeUrl = row.bridgeUrl
    const phone = this.decryptPhone(row.phoneNumber)

    if (!bridgeUrl) {
      return { registered: false, phoneNumberMasked: maskPhone(phone), error: 'No bridge URL configured' }
    }

    try {
      const res = await this.fetchBridge(
        `${bridgeUrl}/v1/accounts/${encodeURIComponent(phone)}`,
        { headers: { 'Content-Type': 'application/json' } },
      )

      if (!res.ok) {
        return {
          registered: false,
          phoneNumberMasked: maskPhone(phone),
          error: res.status === 404 ? 'Number is not registered on this bridge' : `HTTP ${res.status}`,
        }
      }

      const data = await res.json() as { uuid?: string }
      return {
        registered: true,
        phoneNumberMasked: maskPhone(phone),
        uuid: data.uuid,
      }
    } catch (err) {
      return {
        registered: false,
        phoneNumberMasked: maskPhone(phone),
        error: `Bridge unreachable: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  /**
   * Get the current registration for a hub, if any.
   */
  async getRegistrationForHub(hubId: string): Promise<SignalRegistration | null> {
    const [row] = await this.db
      .select()
      .from(signalRegistrations)
      .where(eq(signalRegistrations.hubId, hubId))
      .limit(1)

    if (!row) return null
    return this.toPublic(row)
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /** Validate bridge URL for SSRF safety, then fetch. */
  private async fetchBridge(url: string, opts?: RequestInit): Promise<Response> {
    const ssrfError = validateExternalUrl(url, 'Bridge URL')
    if (ssrfError) {
      throw new SignalRegistrationError(ssrfError, 400)
    }
    return safeFetch(url, { ...opts, timeoutMs: 10_000, ssrfGuard: false })
  }

  private async loadRow(id: string) {
    const [row] = await this.db
      .select()
      .from(signalRegistrations)
      .where(eq(signalRegistrations.id, id))
    if (!row) throw new SignalRegistrationError('Registration not found', 404)
    return row
  }

  private async enforceNotExpired(row: typeof signalRegistrations.$inferSelect): Promise<void> {
    if (row.status === 'complete' || row.status === 'failed') return
    if (row.expiresAt && new Date() > row.expiresAt) {
      await this.db
        .update(signalRegistrations)
        .set({ status: 'failed', error: 'Registration expired', updatedAt: new Date() })
        .where(eq(signalRegistrations.id, row.id))
      throw new SignalRegistrationError('Registration has expired', 410)
    }
  }

  private async transition(
    row: typeof signalRegistrations.$inferSelect,
    next: SignalRegistrationStatus,
  ): Promise<void> {
    const current = row.status as SignalRegistrationStatus
    const allowed = VALID_TRANSITIONS[current]
    if (!allowed.includes(next)) {
      throw new SignalRegistrationError(
        `Invalid state transition: ${current} -> ${next}`,
        409,
      )
    }
    await this.db
      .update(signalRegistrations)
      .set({ status: next, updatedAt: new Date() })
      .where(and(
        eq(signalRegistrations.id, row.id),
        eq(signalRegistrations.status, current),
      ))
  }

  private async callBridgeRegister(
    bridgeUrl: string,
    phoneNumber: string,
    useVoice: boolean,
    synthetic: boolean,
  ): Promise<void> {
    // On the synthetic path, skip the real bridge call — no bridge is running.
    // Matches the A2P pattern where callTwilioSubmitBrand returns synthetic data.
    if (synthetic) return

    try {
      const res = await this.fetchBridge(
        `${bridgeUrl}/v1/register/${encodeURIComponent(phoneNumber)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ use_voice: useVoice }),
        },
      )
      if (!res.ok) {
        const errorText = await res.text()
        throw new SignalRegistrationError(
          `Bridge registration failed: HTTP ${res.status} — ${errorText}`,
          502,
        )
      }
    } catch (err) {
      if (err instanceof SignalRegistrationError) throw err
      throw new SignalRegistrationError(
        `Bridge unreachable: ${err instanceof Error ? err.message : String(err)}`,
        502,
      )
    }
  }

  /**
   * Call the bridge to verify a code. Returns true if the bridge accepted the code.
   * Throws SignalRegistrationError on bridge unreachable.
   */
  private async callBridgeVerify(
    bridgeUrl: string,
    row: typeof signalRegistrations.$inferSelect,
    params: VerifyCodeParams,
  ): Promise<boolean> {
    const phone = this.decryptPhone(row.phoneNumber)
    try {
      const res = await safeFetch(
        `${bridgeUrl}/v1/register/${encodeURIComponent(phone)}/verify/${encodeURIComponent(params.code)}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, timeoutMs: 10_000, ssrfGuard: false },
      )
      return res.ok
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new SignalRegistrationError(`Bridge unreachable: ${message}`, 502)
    }
  }

  private decryptPhone(encryptedPhone: string): string {
    const creds = decryptCredentials(encryptedPhone, this.hmacSecret)
    return String(creds.phoneNumber)
  }

  private toPublic(row: typeof signalRegistrations.$inferSelect): SignalRegistration {
    const phone = this.decryptPhone(row.phoneNumber)
    return {
      id: row.id,
      hubId: row.hubId,
      bridgeUrl: null, // Never expose internal bridge URL in API responses
      phoneNumberMasked: maskPhone(phone),
      method: row.method as 'sms' | 'voice',
      status: row.status as SignalRegistrationStatus,
      attempts: row.attempts ?? 0,
      error: row.error,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }
  }
}

// ── Error class ───────────────────────────────────────────────────────────

export class SignalRegistrationError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message)
    this.name = 'SignalRegistrationError'
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function maskPhone(phone: string): string {
  if (phone.length <= 4) return '****'
  return `****${phone.slice(-4)}`
}
