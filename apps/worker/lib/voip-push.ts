/**
 * VoIP push notification dispatch (Epic 91).
 *
 * Sends high-priority VoIP push notifications to mobile devices when a call arrives.
 * - iOS: APNs VoIP push via PushKit (wakes app, triggers CallKit immediately)
 * - Android: ntfy/UnifiedPush high-priority message (wakes app, triggers ConnectionService)
 *
 * VoIP push is separate from regular push (push-dispatch.ts) because:
 * 1. iOS VoIP push uses a different APNs topic (bundleId.voip)
 * 2. The payload is minimal — just a call reference + hubId + type. The reference is
 *    the call's `pushRef` (services/calls.ts), never its id: the call id IS the telephony
 *    provider's identifier, a key into the provider's CDR, and a push leaves our systems
 *    (APNs, ntfy) (#2374)
 * 3. It must be delivered with maximum priority to wake the native SIP stack
 * 4. Regular push goes through two-tier HPKE encryption
 */

import type { Env } from '../types'
import type { IdentityService } from '../services/identity'
import { NtfyClient } from './ntfy-client'
import { ntfyOriginPolicyFromEnv } from './ntfy-origin'
import { createLogger } from './logger'
import { getApnsVoipTopic } from './apns-topic'

const logger = createLogger('voip-push')

/**
 * The one payload both transports send. Everything in it is ours: the call's `pushRef`
 * (random, unrelated to the provider's identifier), the hub, and a type. No provider
 * identifier, and nothing about the caller — a caller's last digits next to a provider's
 * CDR would be an identification Apple could assemble. The wire key stays `call-id`
 * because the clients and liblinphone read that key; its value is the opaque ref, which
 * a client matches against `pushRef` on the calls API.
 */
export function voipPushPayload(pushRef: string, hubId: string): {
  type: 'incoming_call'
  'call-id': string
  'hub-id': string
} {
  return { type: 'incoming_call', 'call-id': pushRef, 'hub-id': hubId }
}

/**
 * Dispatch VoIP push using IdentityService instead of DO stubs.
 */
export async function dispatchVoipPushFromService(
  volunteerPubkeys: string[],
  pushRef: string,
  hubId: string,
  env: Env,
  identityService: IdentityService,
): Promise<void> {
  if (volunteerPubkeys.length === 0) return

  const hasApns = !!(env.APNS_KEY_P8 && env.APNS_KEY_ID && env.APNS_TEAM_ID)
  const hasNtfy = !!env.NTFY_URL
  if (!hasApns && !hasNtfy) return

  const { devices: deviceList } = await identityService.getVoipTokens(volunteerPubkeys)
  if (deviceList.length === 0) return

  logger.debug('Dispatching VoIP push', { devices: deviceList.length })

  const promises: Promise<void>[] = []

  for (const device of deviceList) {
    if (device.platform === 'ios' && hasApns) {
      promises.push(sendApnsVoipPush(device.voipToken, pushRef, hubId, env))
    } else if (device.platform === 'android' && hasNtfy) {
      promises.push(sendNtfyVoipPush(device.voipToken, pushRef, hubId, env))
    }
  }

  await Promise.allSettled(promises)
}

/**
 * Send APNs VoIP push via PushKit.
 * Uses the .voip topic — separate from regular notification topic.
 * Linphone SDK handles the push natively and reports to CallKit.
 */
async function sendApnsVoipPush(
  deviceToken: string,
  pushRef: string,
  hubId: string,
  env: Env,
): Promise<void> {
  try {
    // Dynamic import to avoid loading APNs client when not needed
    const { ApnsClient, Notification } = await import('@fivesheepco/cloudflare-apns2')

    const client = new ApnsClient({
      team: env.APNS_TEAM_ID!,
      keyId: env.APNS_KEY_ID!,
      signingKey: env.APNS_KEY_P8!,
      defaultTopic: getApnsVoipTopic(env), // VoIP topic — `<bundle id>.voip`
    })

    const { PushType, Priority } = await import('@fivesheepco/cloudflare-apns2')

    const notification = new Notification(deviceToken, {
      type: PushType.voip,
      priority: Priority.immediate,
      expiration: Math.floor(Date.now() / 1000) + 30, // 30 second TTL
      data: voipPushPayload(pushRef, hubId),
    })

    await client.send(notification)
  } catch (err) {
    logger.error(`APNs VoIP push failed for ${deviceToken.slice(0, 8)}...`, { error: err })
  }
}

/**
 * Send ntfy high-priority message for VoIP (Android via UnifiedPush).
 * The voipToken for Android is the UnifiedPush endpoint URL.
 * Payload is {@link voipPushPayload}: no caller display name (that's PII — the
 * app fetches it from the server after waking).
 */
async function sendNtfyVoipPush(
  pushEndpoint: string,
  pushRef: string,
  hubId: string,
  env: Env,
): Promise<void> {
  try {
    const ntfyClient = new NtfyClient(env.NTFY_URL!, env.NTFY_AUTH_TOKEN, ntfyOriginPolicyFromEnv(env))

    const payload = JSON.stringify(voipPushPayload(pushRef, hubId))

    await ntfyClient.send({
      endpoint: pushEndpoint,
      data: payload,
      priority: 'high',
    })
  } catch (err) {
    logger.error('ntfy VoIP push failed', { error: err })
  }
}
