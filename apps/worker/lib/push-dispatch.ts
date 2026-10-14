/**
 * Push notification dispatch service (Epic 86).
 *
 * Sends encrypted push notifications to mobile devices via APNs (iOS) and
 * ntfy/UnifiedPush (Android). Two-tier encryption: wake key for lock-screen
 * display, device key for full content.
 *
 * Android uses self-hosted ntfy (UnifiedPush) — no Google/Firebase dependency.
 * iOS uses APNs (platform requirement) with wake-only encrypted payloads.
 */

import type { Env, DeviceRecord, WakePayload, FullPushPayload } from '../types'
import type { IdentityService } from '../services/identity'
import type { ShiftsService } from '../services/shifts'
import { encryptWakePayload, encryptFullPayload } from './push-encryption'
import { NtfyClient } from './ntfy-client'
import { ntfyOriginPolicyFromEnv } from './ntfy-origin'
import { getApnsBundleId } from './apns-topic'
import { devSurfacesEnabled } from './dev-surfaces'

// ── Test Push Log (dev-surface hosts only) ────────────────────────────────────
// In-memory store for the last dispatched WakePayload — used by BDD tests to
// verify that push payloads carry the correct hubId without real APNs/FCM
// credentials. Written only where `devSurfacesEnabled` holds (lib/dev-surfaces.ts)
// and readable ONLY through `GET /api/test-push-log`, which additionally requires
// the dev surface's shared secret on the request.

interface TestPushLogEntry {
  wakePayload: WakePayload
  recipientPubkey: string
  recordedAt: string
}

const testPushLog: TestPushLogEntry[] = []

/**
 * Record a dispatched WakePayload for test inspection.
 * Only reachable through {@link RecordingPushDispatcher}, which is only
 * constructed where `devSurfacesEnabled(env)` holds — guarded at the one call
 * site that wraps a dispatcher.
 */
export function recordTestPushPayload(wakePayload: WakePayload, recipientPubkey: string): void {
  testPushLog.push({ wakePayload, recipientPubkey, recordedAt: new Date().toISOString() })
  // Keep only the last 50 entries to avoid unbounded memory growth
  if (testPushLog.length > 50) testPushLog.splice(0, testPushLog.length - 50)
}

/** Return all recorded push log entries (most recent last). */
export function getTestPushLog(): TestPushLogEntry[] {
  return [...testPushLog]
}

/** Clear the push log — call before each scenario to ensure isolation. */
export function clearTestPushLog(): void {
  testPushLog.splice(0, testPushLog.length)
}

export interface PushDispatcher {
  /**
   * Send push notification to a specific user's registered devices.
   */
  sendToVolunteer(
    userPubkey: string,
    wakePayload: WakePayload,
    fullPayload: FullPushPayload,
  ): Promise<void>

  /**
   * Send push notification to all on-shift volunteers.
   */
  sendToAllOnShift(
    wakePayload: WakePayload,
    fullPayload: FullPushPayload,
  ): Promise<void>
}

/**
 * Create a PushDispatcher from services (no DO stubs).
 * Returns a no-op dispatcher if push credentials aren't configured.
 *
 * Where the dev surface is enabled (`devSurfacesEnabled`, lib/dev-surfaces.ts)
 * the selected dispatcher is wrapped in {@link RecordingPushDispatcher} so every
 * dispatched WakePayload is written to the in-memory test push log — whichever
 * transport is (or isn't) configured. The recording used to live inside a
 * dev-only dispatcher that was reachable only when BOTH transports were
 * unconfigured, which meant the hubId contract was observed exclusively on a
 * path that never ships: as soon as a single transport variable was set,
 * `getTestPushLog()` went permanently empty even though dispatch was still
 * happening. The invariant it guards (every wake payload names the hub that
 * triggered it — the multi-hub routing axiom) is a property of payload
 * construction, not of a transport, so its observation point must not depend on
 * transport configuration or reachability either.
 *
 * Why `devSurfacesEnabled` (host-level) and not `devSurfaceRequestAuthorized`
 * (per-request)
 * -----------------------------------------------------------------------------
 * This used to read `env.ENVIRONMENT === 'development'`, which is never true on
 * a deployed host — so on a staging E2E target nothing was recorded and three
 * `core/push-hub-dispatch` scenarios failed on `capturedEntries.length === 0`,
 * a symptom that names neither the branch nor the environment (#1623).
 *
 * The replacement is deliberately the HOST-level predicate, even though #1623
 * asks for the per-request form wherever it fits, because this one does not fit:
 *
 *   - The only input available here is `env`. Two of the three call sites —
 *     `routes/conversations.ts#dispatchPushToUser` and
 *     `messaging/router.ts`' inbound-webhook path — construct a dispatcher
 *     inside a DETACHED background task, after the request that triggered it has
 *     been answered. Threading a request credential into work that outlives the
 *     request is the shape that produced #1176; a credential captured in a
 *     closure is also no longer the request's.
 *   - The recorded invariant is a property of payload CONSTRUCTION. It has to be
 *     observable on every dispatch path, including dispatches caused by traffic
 *     that is not the harness's own — the same argument the paragraph above
 *     makes about transports.
 *
 * What a host-level enable widens, stated plainly: on a host that has opted in
 * with all three dev-surface factors (`ENVIRONMENT` on the allowlist,
 * `DEV_ROUTES_ENABLED=true`, and a >=32-character `DEV_RESET_SECRET`), the last
 * 50 dispatched wake payloads are retained in process memory — including ones
 * caused by ordinary, non-harness traffic. A wake payload is routing metadata
 * (hubId, type, conversationId, channelType, callId) plus the recipient pubkey;
 * no message content and no caller PII. Nothing about the recorder is readable
 * without the secret: `GET`/`DELETE /api/test-push-log` (routes/dev.ts
 * `simulationGuard`) require `devSurfacesEnabled` AND the `X-Test-Secret`
 * header per request, so a secret-less caller on the same reachable host gains
 * exactly nothing from the recorder being on — and a caller who does hold the
 * secret can already wipe the database.
 *
 * `production` is refused FIRST and unconditionally inside
 * `devSurfacesRefusal`, before any flag or secret is read, so no secret can
 * turn the recorder on there. It is also narrower than the old check in
 * `development`: the recorder is now on exactly when the log is readable,
 * instead of writing to a log no route would serve.
 */
export function createPushDispatcherFromService(
  env: Env,
  identityService: IdentityService,
  shiftsService: ShiftsService,
): PushDispatcher {
  const hasApns = !!(env.APNS_KEY_P8 && env.APNS_KEY_ID && env.APNS_TEAM_ID)
  const hasNtfy = !!env.NTFY_URL
  const recording = devSurfacesEnabled(env)

  const dispatcher: PushDispatcher = !hasApns && !hasNtfy
    ? new NoopPushDispatcher()
    : new ServicePushDispatcher(env, identityService, shiftsService, hasApns, hasNtfy)

  return recording ? new RecordingPushDispatcher(dispatcher, shiftsService) : dispatcher
}

class NoopPushDispatcher implements PushDispatcher {
  async sendToVolunteer(): Promise<void> {}
  async sendToAllOnShift(): Promise<void> {}
}

/**
 * Dev-surface-only decorator that records each dispatched WakePayload in the
 * in-memory test log, then delegates to the real dispatcher. Records what the
 * dispatcher was asked to send, before any transport is attempted, so the BDD
 * assertion on payload shape cannot be silenced by an unconfigured, misconfigured
 * or unreachable APNs/ntfy endpoint. Never constructed on a host where
 * `devSurfacesEnabled(env)` is false — which includes every `production` host,
 * refused before any secret is read.
 */
class RecordingPushDispatcher implements PushDispatcher {
  constructor(
    private inner: PushDispatcher,
    private shiftsService: ShiftsService,
  ) {}

  async sendToVolunteer(
    userPubkey: string,
    wakePayload: WakePayload,
    fullPayload: FullPushPayload,
  ): Promise<void> {
    recordTestPushPayload(wakePayload, userPubkey)
    await this.inner.sendToVolunteer(userPubkey, wakePayload, fullPayload)
  }

  async sendToAllOnShift(
    wakePayload: WakePayload,
    fullPayload: FullPushPayload,
  ): Promise<void> {
    // Resolves the on-shift set a second time (the inner dispatcher resolves it
    // again to deliver) so the log carries one entry per recipient. Only ever on
    // a dev-surface host; not worth threading a recipient list through the
    // interface.
    const pubkeys = await this.shiftsService.getCurrentVolunteers('')
    for (const pk of pubkeys) {
      recordTestPushPayload(wakePayload, pk)
    }
    await this.inner.sendToAllOnShift(wakePayload, fullPayload)
  }
}

/**
 * Service-based push dispatcher — uses IdentityService and ShiftsService directly.
 */
class ServicePushDispatcher implements PushDispatcher {
  private ntfyClient: NtfyClient | null = null

  constructor(
    private env: Env,
    private identityService: IdentityService,
    private shiftsService: ShiftsService,
    private hasApns: boolean,
    private hasNtfy: boolean,
  ) {
    if (hasNtfy && env.NTFY_URL) {
      this.ntfyClient = new NtfyClient(env.NTFY_URL, env.NTFY_AUTH_TOKEN, ntfyOriginPolicyFromEnv(env))
    }
  }

  async sendToVolunteer(
    userPubkey: string,
    wakePayload: WakePayload,
    fullPayload: FullPushPayload,
  ): Promise<void> {
    const { devices: deviceList } = await this.identityService.getDevices(userPubkey)
    if (deviceList.length === 0) return

    const staleTokens: string[] = []

    for (const device of deviceList) {
      // Desktop devices (#1548 groundwork) register without a push token — they
      // are envelope targets, not push targets. Skipping them here also avoids
      // HPKE-sealing against an empty wake key.
      if (!device.pushToken) continue

      const encryptedWake = encryptWakePayload(wakePayload, device.wakeKeyPublic)
      // #1021 (sibling): the full tier used to be sealed to `userPubkey`, the
      // user's Ed25519 auth key, which is not an HPKE recipient — no device
      // could ever decrypt it. It is a per-device tier, so seal it to that
      // device's registered X25519 encryption key. A device that has not
      // published one gets the wake tier only, rather than an envelope that
      // merely looks encrypted.
      const encryptedFull = device.x25519Pubkey
        ? encryptFullPayload(fullPayload, device.x25519Pubkey)
        : ''

      const success = await this.sendToDevice(device, encryptedWake, encryptedFull, wakePayload)
      if (!success) {
        staleTokens.push(device.pushToken)
      }
    }

    if (staleTokens.length > 0) {
      await this.identityService.cleanupDevices(userPubkey, staleTokens)
    }
  }

  async sendToAllOnShift(
    wakePayload: WakePayload,
    fullPayload: FullPushPayload,
  ): Promise<void> {
    const pubkeys = await this.shiftsService.getCurrentVolunteers('')
    await Promise.allSettled(
      pubkeys.map(pk => this.sendToVolunteer(pk, wakePayload, fullPayload)),
    )
  }

  private async sendToDevice(
    device: DeviceRecord,
    encryptedWake: string,
    encryptedFull: string,
    wake: WakePayload,
  ): Promise<boolean> {
    if (device.platform === 'ios' && this.hasApns) {
      return this.sendApns(device.pushToken, encryptedWake, encryptedFull, wake)
    }
    if (device.platform === 'android' && this.ntfyClient) {
      return this.sendNtfy(device.pushToken, encryptedWake, encryptedFull, wake)
    }
    return true
  }

  private async sendApns(
    deviceToken: string,
    encryptedWake: string,
    encryptedFull: string,
    _wake: WakePayload,
  ): Promise<boolean> {
    const { ApnsClient, Notification } = await import(
      '@fivesheepco/cloudflare-apns2'
    )

    const apns = new ApnsClient({
      team: this.env.APNS_TEAM_ID!,
      keyId: this.env.APNS_KEY_ID!,
      signingKey: this.env.APNS_KEY_P8!,
      defaultTopic: getApnsBundleId(this.env),
    })

    // Wake-only APNs payload: NO plaintext title/body/category.
    // The encrypted payload contains all notification content.
    // The app decrypts locally and posts a local notification.
    const notification = new Notification(deviceToken, {
      badge: 1,
      sound: 'default',
      mutableContent: true,
      contentAvailable: true,
      data: {
        encrypted: encryptedWake,
        encryptedFull,
      },
    })

    try {
      await apns.send(notification)
      return true
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error)
      if (errMsg.includes('410') || errMsg.includes('BadDeviceToken') || errMsg.includes('Unregistered')) {
        return false
      }
      return true
    }
  }

  /**
   * Send encrypted push payload via ntfy (UnifiedPush) to an Android device.
   *
   * The device's pushToken is the full UnifiedPush endpoint URL registered
   * during device setup (e.g. https://ntfy.example.com/up-topic-xxx).
   * ntfy sees only opaque ciphertext — zero plaintext metadata.
   */
  private async sendNtfy(
    pushEndpoint: string,
    encryptedWake: string,
    encryptedFull: string,
    wake: WakePayload,
  ): Promise<boolean> {
    if (!this.ntfyClient) return true

    // Combine encrypted tiers into a single JSON envelope
    const payload = JSON.stringify({
      encrypted: encryptedWake,
      encryptedFull,
    })

    return this.ntfyClient.send({
      endpoint: pushEndpoint,
      data: payload,
      priority: wake.type === 'shift_reminder' ? 'default' : 'high',
    })
  }
}

// Notification content helpers removed — all push payloads are encrypted.
// The app decrypts locally and generates notification content from the
// wake-tier payload (title, body, category) on the device.
