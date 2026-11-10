/**
 * SimulatedMessagingAdapter — a MessagingAdapter that talks to no provider.
 *
 * Exists so a test instance with no configured messaging channel can still
 * exercise the product's real outbound path (encrypt → dispatch → store →
 * delivery-status transition) end to end. It is selected by the delivery
 * router ONLY when the channel is not configured AND this host may serve the
 * `/api/test-*` surface at all — `devSurfacesRefusal` (lib/dev-surfaces.ts):
 * `ENVIRONMENT` on the `development`/`staging` allowlist with `production`
 * refused first and unconditionally, `DEV_ROUTES_ENABLED=true`, and a
 * 32-character `DEV_RESET_SECRET` on anything but `development`.
 *
 * Why this exists: the conversations reply route used to store a reply as
 * `sent` when no provider accepted it (bridge unreachable, channel not
 * configured), so a volunteer believed they had answered someone in crisis
 * while the caller received nothing (#2551, the sibling of #2500). The
 * invariant is now that `sent` means a provider accepted the message. On a
 * test host the "provider" is this adapter: it genuinely accepts the send and
 * records it as a stored message row carrying its `sim-` external id, which
 * the `/api/test-simulate/delivery-status` endpoint can then transition to
 * `delivered` / `read` / `failed` — the simulation exercises the real path
 * instead of a bypass. On any other host an unconfigured channel fails the
 * send honestly (`failed`, with the reason) instead of pretending.
 *
 * It never accepts inbound webhooks (`validateWebhook` is always false) and
 * cannot parse one: simulated inbound messages are injected server-side by
 * the `/api/test-simulate/incoming-message` route, so there is no
 * unauthenticated surface that can conjure a message.
 */
import { devSurfacesRefusal, type DevSurfacesEnv } from '../lib/dev-surfaces'
import type {
  MessagingAdapter,
  IncomingMessage,
  SendMessageParams,
  SendMediaParams,
  SendResult,
  ChannelStatus,
} from './adapter'
import type { MessagingChannelType } from '@shared/types'

/** Prefix of every external id the simulator mints — lets tests tell a simulated send from a provider one. */
export const SIMULATED_MESSAGE_ID_PREFIX = 'sim-'

export type SimulatedMessagingEnv = DevSurfacesEnv

export class SimulatedMessagingRefusedError extends Error {
  constructor(readonly reason: string) {
    super(`SimulatedMessagingAdapter refused: ${reason}`)
    this.name = 'SimulatedMessagingRefusedError'
  }
}

/**
 * Returns why the simulated adapter may not be used on this host, or null when
 * it may. One delegation, not a second copy of the rules: `devSurfacesRefusal`
 * already refuses `production` first and unconditionally, refuses anything not
 * on the allowlist, demands the explicit flag, and demands a 32-character
 * secret on every reachable host.
 */
export function simulatedMessagingRefusalReason(env: SimulatedMessagingEnv): string | null {
  return devSurfacesRefusal(env)
}

export function isSimulatedMessagingAllowed(env: SimulatedMessagingEnv): boolean {
  return simulatedMessagingRefusalReason(env) === null
}

/** Throws SimulatedMessagingRefusedError unless the simulator may be used in this environment. */
export function assertSimulatedMessagingAllowed(env: SimulatedMessagingEnv): void {
  const reason = simulatedMessagingRefusalReason(env)
  if (reason) throw new SimulatedMessagingRefusedError(reason)
}

export class SimulatedMessagingAdapter implements MessagingAdapter {
  constructor(
    readonly channelType: MessagingChannelType,
    env: SimulatedMessagingEnv,
  ) {
    assertSimulatedMessagingAllowed(env)
  }

  parseIncomingMessage(_request: Request): Promise<IncomingMessage> {
    return Promise.reject(new Error('SimulatedMessagingAdapter has no inbound webhook — use /api/test-simulate/incoming-message'))
  }

  validateWebhook(_request: Request): Promise<boolean> {
    return Promise.resolve(false)
  }

  /**
   * Accept the send and mint the provider id the stored row will carry, like
   * the Signal bridge's timestamp externalId. Accepting is the point: on a
   * test host this IS the provider, so `sent` stays an honest claim.
   */
  sendMessage(_params: SendMessageParams): Promise<SendResult> {
    return Promise.resolve({ success: true, externalId: `${SIMULATED_MESSAGE_ID_PREFIX}${Date.now()}` })
  }

  sendMediaMessage(_params: SendMediaParams): Promise<SendResult> {
    return Promise.resolve({ success: true, externalId: `${SIMULATED_MESSAGE_ID_PREFIX}${Date.now()}` })
  }

  getChannelStatus(): Promise<ChannelStatus> {
    return Promise.resolve({ connected: true, details: { simulated: true } })
  }
}
