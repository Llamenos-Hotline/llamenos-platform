import { Hono } from 'hono'
import type { AppEnv, Env } from '../types'
import type { MessagingChannelType, WhatsAppConfig } from '@shared/types'
import type { MessagingAdapter, IncomingMessage } from './adapter'
import { getMessagingAdapterFromService } from '../lib/service-factories'
import { audit } from '../services/audit'
import { KIND_MESSAGE_NEW, KIND_CONVERSATION_ASSIGNED, KIND_MESSAGE_REACTION, KIND_TYPING_INDICATOR } from '@shared/event-kinds'
import { publishEvent } from '../lib/ws-events'
import { createPushDispatcherFromService } from '../lib/push-dispatch'
import { createLogger } from '../lib/logger'
import { backgroundTask } from '../lib/hono-compat'
import type { Services } from '../services'
import { SignalAdapter } from './signal/adapter'
import type { SignalWebhookPayload } from './signal/types'
import { observeFirehoseMessage } from './firehose-observer'
import { checkWebhookReplay } from '../services/webhook-replay'
import { getDb } from '../db'
import { isIpInCidrs } from '../middleware/webhook-ip-allowlist'
import { webhookAuth } from '../middleware/webhook-auth'
import { hasHubPermission, permissionGranted, resolvePermissions } from '@shared/permissions'

const logger = createLogger('messaging')

const messaging = new Hono<AppEnv>()

/**
 * WhatsApp webhook verification (GET).
 * Meta's Cloud API sends a GET request with hub.mode, hub.verify_token, hub.challenge
 * to verify webhook ownership during setup.
 */
messaging.get('/whatsapp/webhook', async (c) => {
  const mode = c.req.query('hub.mode')
  const token = c.req.query('hub.verify_token')
  const challenge = c.req.query('hub.challenge')

  if (mode !== 'subscribe' || !token || !challenge) {
    return c.text('Bad request', 400)
  }

  // Read WhatsApp config to check verify token
  const services = c.get('services')
  try {
    const config = await services.settings.getMessagingConfig()
    const waConfig = config?.whatsapp as WhatsAppConfig | null
    if (waConfig?.verifyToken && token === waConfig.verifyToken) {
      return c.text(challenge)
    }
  } catch { /* fall through */ }

  return c.text('Forbidden', 403)
})

/**
 * RCS webhook verification (GET).
 * Google RBM sends a GET request to verify webhook ownership during setup.
 */
messaging.get('/rcs/webhook', async (c) => {
  // Google RBM webhook verification — just return 200
  return c.text('OK', 200)
})

/**
 * Messaging webhook handler.
 * Each channel has its own webhook URL:
 *   /api/messaging/sms/webhook?hub={hubId}
 *   /api/messaging/whatsapp/webhook?hub={hubId}
 *   /api/messaging/signal/webhook?hub={hubId}
 *
 * webhookAuth provides content-type enforcement, IP allowlisting, and replay protection.
 * Each adapter additionally validates its own provider-specific webhook signature.
 */
messaging.post('/:channel/webhook',
  webhookAuth({
    provider: 'messaging',
    allowedContentTypes: ['application/json'],
  }),
  async (c) => {
  const channel = c.req.param('channel') as MessagingChannelType
  const validChannels: MessagingChannelType[] = ['sms', 'whatsapp', 'signal', 'rcs', 'telegram']
  if (!validChannels.includes(channel)) {
    return c.json({ error: 'Unknown channel' }, 404)
  }

  // Hub-scoped routing: read hubId from query param, fall back to global
  const url = new URL(c.req.url)
  const hubId = url.searchParams.get('hub') || undefined
  const services = c.get('services')

  let adapter: MessagingAdapter
  try {
    adapter = await getMessagingAdapterFromService(channel, services.settings, c.env.HMAC_SECRET, c.env.WEBHOOK_BASE_URL ?? '')
  } catch {
    return c.json({ error: `${channel} channel is not configured` }, 404)
  }

  // W05-H03: IP allowlist (opt-in via <CHANNEL>_WEBHOOK_IPS env var)
  const cidrKey = `${channel.toUpperCase()}_WEBHOOK_IPS`
  const cidrs = (c.env as unknown as Record<string, string | undefined>)[cidrKey]
  if (cidrs) {
    const cidrList = cidrs.split(',').map(s => s.trim()).filter(Boolean)
    const clientIp = c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For')?.split(',')[0]?.trim()
    if (!clientIp || !isIpInCidrs(clientIp, cidrList)) {
      logger.warn(`Messaging webhook IP not in allowlist for ${channel}`, { clientIp })
      return new Response('Forbidden', { status: 403 })
    }
  }

  // Validate webhook signature
  const isValid = await adapter.validateWebhook(c.req.raw)
  if (!isValid) {
    logger.error(`Webhook signature FAILED for ${channel}`)
    return new Response('Forbidden', { status: 403 })
  }

  // W05-H02: Replay protection — return idempotent 200 for duplicate deliveries
  const bodyText = await c.req.raw.clone().text()
  const isFirst = await checkWebhookReplay(getDb(), channel, bodyText, 300)
  if (!isFirst) {
    logger.info(`Messaging webhook replay detected for ${channel}, returning idempotent 200`)
    return new Response('OK', { status: 200 })
  }

  // Try to parse as status update first (if adapter supports it)
  if (adapter.parseStatusWebhook) {
    try {
      const rawStatusUpdate = await adapter.parseStatusWebhook(c.req.raw)
      // Normalize to array (Signal can batch multiple timestamps per receipt)
      const statusUpdates = rawStatusUpdate
        ? Array.isArray(rawStatusUpdate) ? rawStatusUpdate : [rawStatusUpdate]
        : []

      if (statusUpdates.length > 0) {
        for (const statusUpdate of statusUpdates) {
          const result = await services.conversations.updateMessageStatus(statusUpdate)

          if ('conversationId' in result && result.conversationId && 'messageId' in result && result.messageId) {
            // Publish status update to WebSocket relay
            publishEvent(c.env, KIND_MESSAGE_NEW, {
              type: 'message:status',
              conversationId: result.conversationId,
              messageId: result.messageId,
              status: statusUpdate.status,
              timestamp: statusUpdate.timestamp,
            }, hubId ?? '')
          }

          // Also correlate with blast deliveries (non-blocking)
          if (statusUpdate.externalId) {
            backgroundTask(c,
              correlateBlastDeliveryStatus(services, statusUpdate.externalId, statusUpdate.status, statusUpdate.failureReason)
            )
          }
        }

        return c.json({ ok: true })
      }
    } catch {
      // Not a status update, continue to parse as message
    }
  }

  // Signal-specific: handle reactions and typing indicators
  if (channel === 'signal' && adapter instanceof SignalAdapter) {
    try {
      const signalPayload = await c.req.raw.clone().json() as SignalWebhookPayload

      // Handle typing indicators — broadcast as ephemeral event
      const typing = adapter.parseTypingIndicator(signalPayload)
      if (typing) {
        publishEvent(c.env, KIND_TYPING_INDICATOR, {
          type: 'typing',
          sender: typing.sender,
          isTyping: typing.isTyping,
          channelType: 'signal',
          timestamp: typing.timestamp,
        }, hubId ?? '')
        return c.json({ ok: true })
      }

      // Handle reactions — store and broadcast
      const reaction = adapter.parseReaction(signalPayload)
      if (reaction) {
        publishEvent(c.env, KIND_MESSAGE_REACTION, {
          type: 'message:reaction',
          emoji: reaction.emoji,
          targetAuthor: reaction.targetAuthor,
          targetTimestamp: reaction.targetTimestamp,
          isRemove: reaction.isRemove ?? false,
          sender: signalPayload.envelope.sourceUuid ?? signalPayload.envelope.source,
          channelType: 'signal',
        }, hubId ?? '')
        return c.json({ ok: true })
      }

      // If this is a receipt-only message (no dataMessage), skip message parsing
      if (!signalPayload.envelope.dataMessage) {
        // Already handled by parseStatusWebhook above, or it's an unknown envelope type
        return c.json({ ok: true })
      }
    } catch {
      // Failed to parse as JSON for Signal-specific handling; fall through to normal parsing
    }
  }

  // Parse the incoming message
  let incoming: IncomingMessage
  try {
    incoming = await adapter.parseIncomingMessage(c.req.raw)
  } catch (err) {
    logger.error(`Failed to parse ${channel} webhook`, err)
    return c.json({ error: 'Failed to parse message' }, 400)
  }

  // Firehose observer: buffer Signal group messages for inference agents
  if (channel === 'signal' && incoming.metadata?.groupId && incoming.body) {
    backgroundTask(c,
      observeFirehoseMessage(services.firehose, {
        signalGroupId: incoming.metadata.groupId,
        senderIdentifier: incoming.senderIdentifier,
        senderIdentifierHash: incoming.senderIdentifierHash,
        senderUsername: incoming.metadata?.sourceName ?? incoming.senderIdentifier.slice(-4),
        content: incoming.body,
        timestamp: new Date(incoming.timestamp),
        hubId,
      })
    )
  }

  // Keyword interception for blast subscribe/unsubscribe
  if (incoming.body) {
    const normalizedBody = incoming.body.trim().toUpperCase()
    const effectiveHubId = hubId ?? ''
    // STOP is always recognized (TCPA compliance)
    if (normalizedBody === 'STOP') {
      await services.blasts.handleSubscriberKeyword(effectiveHubId, {
        identifier: incoming.senderIdentifier,
        identifierHash: incoming.senderIdentifierHash,
        keyword: 'STOP',
        channel: incoming.channelType,
      })
      // Still forward to conversation for logging
    } else {
      // Check if it matches the subscribe keyword
      try {
        const settings = await services.blasts.getBlastSettings(effectiveHubId)
        if (normalizedBody === settings.subscribeKeyword.toUpperCase()) {
          await services.blasts.handleSubscriberKeyword(effectiveHubId, {
            identifier: incoming.senderIdentifier,
            identifierHash: incoming.senderIdentifierHash,
            keyword: normalizedBody,
            channel: incoming.channelType,
          })
        }
      } catch { /* blast settings not configured — ignore */ }
    }
  }

  // Forward to ConversationsService for processing
  const convResult = await services.conversations.handleIncoming(incoming, c.env.ADMIN_PUBKEY)

  // Publish new inbound message event to the webhook's hub — clients subscribe per hub
  publishEvent(c.env, KIND_MESSAGE_NEW, {
    type: 'message:new',
    conversationId: convResult.conversationId,
    channelType: channel,
  }, hubId ?? '')

  // Auto-assignment for new conversations
  if (convResult.isNew && convResult.status === 'waiting') {
    backgroundTask(c,
      tryAutoAssign(services, c.env, convResult.conversationId, channel, c.env.ADMIN_PUBKEY, hubId)
    )
  }

  // Push notification to assigned volunteer for new messages (Epic 86)
  // Only dispatch push if hubId is present — mobile clients require a real hub ID to route the notification.
  if (convResult.conversationId && hubId) {
    backgroundTask(c,(async () => {
      try {
        // Fetch the conversation to get the assigned volunteer
        const conv = await services.conversations.getById(convResult.conversationId)
        if (conv.assignedTo) {
          const dispatcher = createPushDispatcherFromService(c.env, services.identity, services.shifts)
          await dispatcher.sendToVolunteer(conv.assignedTo, {
            hubId,
            type: 'message',
            conversationId: convResult.conversationId,
            channelType: conv.channelType,
          }, {
            hubId,
            type: 'message',
            conversationId: convResult.conversationId,
            channelType: conv.channelType,
          })
        }
      } catch (e) {
        logger.error('Push dispatch failed for conversation', { conversationId: convResult.conversationId, error: e })
      }
    })())
  }

  // Audit the incoming message (no PII — only hashed identifier)
  c.executionCtx.waitUntil(
    audit(services.audit, 'messageReceived', 'system', {
      channel,
      senderHash: incoming.senderIdentifierHash,
    }, undefined, hubId ?? null)
  )

  // Return 200 to acknowledge webhook (providers expect fast acknowledgment)
  return c.json({ ok: true })
})

/**
 * Try to auto-assign a new conversation to an available volunteer.
 * This runs in background via executionCtx.waitUntil() to not delay webhook response.
 */
async function tryAutoAssign(
  services: Services,
  env: Env,
  conversationId: string,
  channelType: MessagingChannelType,
  adminPubkey: string,
  hubId: string | undefined,
): Promise<void> {
  try {
    // 1. Check if auto-assign is enabled
    const messagingConfig = await services.settings.getMessagingConfig()
    if (!messagingConfig?.autoAssign) return

    const maxConcurrent = messagingConfig.maxConcurrentPerUser || 3

    // 2. Get current on-shift volunteers (scoped to hub, or global if no hub)
    const onShiftPubkeys = await services.shifts.getCurrentVolunteers(hubId ?? '')
    if (onShiftPubkeys.length === 0) return

    // 3. Get user details to filter by channel capability
    const { users: allUsers } = await services.identity.getUsers()
    const { roles: roleDefs } = await services.settings.getRoles()
    // The assignee must be able to claim conversations in the conversation's
    // hub — a volunteer removed from the hub may linger in its shift roster (#1037).
    const canClaimHere = (v: (typeof allUsers)[number]) => hubId
      ? hasHubPermission(v.roles, v.hubRoles ?? [], roleDefs, hubId, 'conversations:claim')
      : permissionGranted(resolvePermissions(v.roles, roleDefs), 'conversations:claim')
    const onShiftVolunteers = allUsers.filter(v =>
      onShiftPubkeys.includes(v.pubkey) &&
      v.active &&
      !v.onBreak &&
      v.messagingEnabled !== false &&
      canClaimHere(v)
    )

    // Filter by channel capability
    const eligibleVolunteers = onShiftVolunteers.filter(v => {
      // If no channels specified, volunteer can handle all
      if (!v.supportedMessagingChannels || v.supportedMessagingChannels.length === 0) {
        return true
      }
      return v.supportedMessagingChannels.includes(channelType)
    })

    if (eligibleVolunteers.length === 0) return

    // 4. Get volunteer load counts via service
    const loads = await services.conversations.getAllVolunteerLoads()

    // 5. Find least-loaded volunteer under max capacity
    let bestCandidate: string | null = null
    let lowestLoad = Infinity

    for (const vol of eligibleVolunteers) {
      const currentLoad = loads[vol.pubkey] || 0
      if (currentLoad < maxConcurrent && currentLoad < lowestLoad) {
        lowestLoad = currentLoad
        bestCandidate = vol.pubkey
      }
    }

    if (!bestCandidate) return // All volunteers at capacity

    // 6. Auto-assign the conversation via service
    await services.conversations.claim(conversationId, bestCandidate)

    // Publish assignment to the conversation's hub — clients subscribe per hub
    publishEvent(env, KIND_CONVERSATION_ASSIGNED, {
      type: 'conversation:assigned',
      conversationId,
      assignedTo: bestCandidate,
      autoAssigned: true,
    }, hubId ?? '')

    logger.info('Auto-assigned conversation', { conversationId, assignedTo: bestCandidate.slice(0, 8) })
  } catch (err) {
    logger.error('Auto-assignment failed', err)
  }
}

/**
 * Correlate a messaging provider delivery status with blast deliveries.
 * If the externalId matches a blast delivery, update its status accordingly.
 */
async function correlateBlastDeliveryStatus(
  services: Services,
  externalId: string,
  status: import('../types').MessageDeliveryStatus,
  failureReason?: string,
): Promise<void> {
  try {
    const delivery = await services.blasts.findDeliveryByExternalId(externalId)
    if (!delivery) return // Not a blast delivery

    switch (status) {
      case 'delivered':
      case 'read':
        await services.blasts.markDeliveryDelivered(delivery.id)
        break
      case 'failed':
        await services.blasts.markDeliveryFailed(
          delivery.id,
          failureReason ?? 'Delivery failed (provider)',
          delivery.attempts,
        )
        break
      // 'sent' and 'pending' are already tracked at send time
    }

    // Sync blast stats (non-blocking)
    await services.blasts.syncBlastStats(delivery.blastId)
  } catch (err) {
    logger.error('Blast delivery correlation failed', err)
  }
}

export default messaging
