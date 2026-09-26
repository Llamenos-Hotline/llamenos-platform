import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv, EncryptedMessage } from '../types'
import type { MessagingChannelType } from '@shared/types'
import { routeOutboundMessage } from '../messaging/delivery-router'
import { checkPermission, requirePermission } from '../middleware/permission-guard'
import { listConversationsQuerySchema, sendMessageBodySchema, updateConversationBodySchema, conversationResponseSchema, messageResponseSchema, conversationListResponseSchema, messageListResponseSchema, conversationStatsResponseSchema, volunteerLoadResponseSchema } from '@protocol/schemas/conversations'
import { paginationSchema } from '@protocol/schemas/common'
import { authErrors, notFoundError } from '../openapi/helpers'
import { audit } from '../services/audit'
import { canClaimChannel, getClaimableChannels } from '@shared/permissions'
import { KIND_MESSAGE_NEW, KIND_CONVERSATION_ASSIGNED } from '@shared/event-kinds'
import { createPushDispatcherFromService } from '../lib/push-dispatch'
import type { WakePayload, FullPushPayload } from '../types'
import { publishEvent } from '../lib/ws-events'
import { withRetry, isRetryableError } from '../lib/retry'
import { getCircuitBreaker, CircuitOpenError } from '../lib/circuit-breaker'
import { incCounter } from './metrics'
import type { Services } from '../services'
import { createLogger } from '../lib/logger'
import { encryptMessageForStorage } from '../lib/crypto'

const logger = createLogger('routes.conversations')

const conversations = new Hono<AppEnv>()

/** Dispatch push notification to a specific user (Epic 86) */
function dispatchPushToUser(
  env: AppEnv['Bindings'],
  services: Services,
  userPubkey: string,
  wake: WakePayload,
  full: FullPushPayload,
): void {
  try {
    const dispatcher = createPushDispatcherFromService(env, services.identity, services.shifts)
    dispatcher.sendToVolunteer(userPubkey, wake, full).catch((e) => {
      logger.error('Push dispatch to user failed', e)
    })
  } catch (e) {
    logger.error('Push dispatch setup failed', e)
  }
}

/**
 * GET /conversations — list conversations
 * Users with conversations:read-all see everything.
 * Others see only their assigned + waiting conversations (filtered by claimable channels).
 */
conversations.get('/',
  describeRoute({
    tags: ['Conversations'],
    summary: 'List conversations',
    responses: {
      200: {
        description: 'List of conversations',
        content: {
          'application/json': {
            schema: resolver(conversationListResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  validator('query', listConversationsQuerySchema),
  async (c) => {
    const services = c.get('services')
    const pubkey = c.get('pubkey')
    const permissions = c.get('permissions')
    const user = c.get('user')
    const canReadAll = checkPermission(permissions, 'conversations:read-all')
    const query = c.req.valid('query')
    const hubId = c.get('hubId')

    const offset = (query.page - 1) * query.limit

    // Users without read-all only see their assigned conversations + waiting queue
    if (!canReadAll) {
      // Fetch assigned conversations
      const assigned = await services.conversations.list({
        hubId,
        status: query.status as import('../types').ConversationStatus | undefined,
        channelType: query.channel as MessagingChannelType | 'web' | undefined,
        assignedTo: pubkey,
        limit: query.limit,
        offset,
      })

      // Also fetch waiting conversations (available to claim)
      const waiting = await services.conversations.list({
        hubId,
        status: 'waiting',
        channelType: query.channel as MessagingChannelType | 'web' | undefined,
        limit: query.limit,
        offset,
      })

      // Filter waiting conversations by channels the volunteer can claim
      const claimableChannels = getClaimableChannels(permissions)
      const userChannels = user.supportedMessagingChannels

      let filteredWaiting = waiting.conversations
      // Filter by permission-based claimable channels
      if (claimableChannels.length > 0) {
        filteredWaiting = filteredWaiting.filter(conv =>
          claimableChannels.includes(conv.channelType)
        )
      }
      // Also filter by user's configured supported channels (if set)
      if (userChannels && userChannels.length > 0) {
        filteredWaiting = filteredWaiting.filter(conv =>
          userChannels.includes(conv.channelType as MessagingChannelType)
        )
      }
      // Hide all waiting if messaging is disabled for this user
      if (user.messagingEnabled === false) {
        filteredWaiting = []
      }

      return c.json({
        conversations: [...assigned.conversations, ...filteredWaiting],
        assignedCount: assigned.total,
        waitingCount: filteredWaiting.length,
        claimableChannels,
      })
    }

    const result = await services.conversations.list({
      hubId,
      status: query.status as import('../types').ConversationStatus | undefined,
      channelType: query.channel as MessagingChannelType | 'web' | undefined,
      limit: query.limit,
      offset,
    })

    return c.json(result)
  },
)

/**
 * GET /conversations/stats — conversation metrics
 */
conversations.get('/stats',
  describeRoute({
    tags: ['Conversations'],
    summary: 'Get conversation statistics',
    responses: {
      200: {
        description: 'Conversation metrics',
        content: { 'application/json': { schema: resolver(conversationStatsResponseSchema) } },
      },
      ...authErrors,
    },
  }),
  requirePermission('conversations:read-assigned'),
  async (c) => {
    const services = c.get('services')
    const hubId = c.get('hubId')
    const stats = await services.conversations.getStats(hubId)
    return c.json(stats)
  },
)

/**
 * GET /conversations/load — get volunteer load counts (active conversations per volunteer)
 * Admin only — used for reassignment UI
 */
conversations.get('/load',
  describeRoute({
    tags: ['Conversations'],
    summary: 'Get volunteer conversation load counts',
    responses: {
      200: {
        description: 'Volunteer load counts',
        content: { 'application/json': { schema: resolver(volunteerLoadResponseSchema) } },
      },
      ...authErrors,
    },
  }),
  async (c) => {
    const permissions = c.get('permissions')
    const canReadAll = checkPermission(permissions, 'conversations:read-all')
    if (!canReadAll) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    const services = c.get('services')
    const hubId = c.get('hubId')
    const loads = await services.conversations.getAllVolunteerLoads(hubId)
    return c.json({ loads })
  },
)

/**
 * GET /conversations/:id — get single conversation
 */
conversations.get('/:id',
  describeRoute({
    tags: ['Conversations'],
    summary: 'Get a single conversation',
    responses: {
      200: {
        description: 'Conversation details',
        content: {
          'application/json': {
            schema: resolver(conversationResponseSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  async (c) => {
    const services = c.get('services')
    const id = c.req.param('id')
    const pubkey = c.get('pubkey')
    const permissions = c.get('permissions')
    const canReadAll = checkPermission(permissions, 'conversations:read-all')

    const conv = await services.conversations.getById(id)

    // Non-admins can only view their assigned or waiting conversations
    if (!canReadAll && conv.assignedTo !== pubkey && conv.status !== 'waiting') {
      return c.json({ error: 'Forbidden' }, 403)
    }

    return c.json(conv)
  },
)

/**
 * GET /conversations/:id/messages — paginated messages
 */
conversations.get('/:id/messages',
  describeRoute({
    tags: ['Conversations'],
    summary: 'List messages in a conversation',
    responses: {
      200: {
        description: 'Paginated messages',
        content: {
          'application/json': {
            schema: resolver(messageListResponseSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  validator('query', paginationSchema),
  async (c) => {
    const services = c.get('services')
    const id = c.req.param('id')
    const pubkey = c.get('pubkey')
    const permissions = c.get('permissions')
    const canReadAll = checkPermission(permissions, 'conversations:read-all')
    const query = c.req.valid('query')

    // Verify access
    const conv = await services.conversations.getById(id)
    if (!canReadAll && conv.assignedTo !== pubkey && conv.status !== 'waiting') {
      return c.json({ error: 'Forbidden' }, 403)
    }

    const result = await services.conversations.listMessages(id, {
      limit: query.limit,
      offset: (query.page - 1) * query.limit,
    })

    return c.json(result)
  },
)

/**
 * POST /conversations/:id/messages — send outbound message
 * Body: { encryptedContent, readerEnvelopes, plaintextForSending? }
 * If plaintext is provided, it's sent via the messaging adapter then discarded.
 */
conversations.post('/:id/messages',
  describeRoute({
    tags: ['Conversations'],
    summary: 'Send an outbound message',
    responses: {
      201: {
        description: 'Message created',
        content: {
          'application/json': {
            schema: resolver(messageResponseSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  validator('json', sendMessageBodySchema),
  async (c) => {
    const services = c.get('services')
    const id = c.req.param('id')
    const pubkey = c.get('pubkey')
    const permissions = c.get('permissions')
    const canSendAny = checkPermission(permissions, 'conversations:send-any')

    // Verify access
    const conv = await services.conversations.getById(id)
    if (!canSendAny && conv.assignedTo !== pubkey) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    const body = c.req.valid('json')

    // Normalize: `body` field is an alias for `plaintextForSending`
    const plaintextForSending = body.plaintextForSending ?? body.body

    // Determine encrypted content + envelopes for storage.
    // If the client provided pre-encrypted content (web channel E2EE), use it directly.
    // Otherwise, encrypt server-side before storing — plaintext must NEVER be stored.
    let encryptedContent: string
    let readerEnvelopes = body.readerEnvelopes ?? []
    if (body.encryptedContent) {
      encryptedContent = body.encryptedContent
    } else if (plaintextForSending) {
      const adminDecryptionPubkey = c.env.ADMIN_DECRYPTION_PUBKEY || c.env.ADMIN_PUBKEY
      const readerPubkeys: string[] = []
      if (adminDecryptionPubkey) readerPubkeys.push(adminDecryptionPubkey)
      if (pubkey !== adminDecryptionPubkey) readerPubkeys.push(pubkey)
      const encrypted = encryptMessageForStorage(plaintextForSending, readerPubkeys)
      encryptedContent = encrypted.encryptedContent
      readerEnvelopes = encrypted.readerEnvelopes
    } else {
      encryptedContent = ''
    }

    // Web channel requires real E2EE envelope
    if (conv.channelType === 'web' && (!body.encryptedContent || !body.readerEnvelopes?.length)) {
      return c.json({ error: 'encryptedContent and readerEnvelopes are required for web channel' }, 400)
    }

    // External channels require at least plaintext for dispatch
    if (conv.channelType !== 'web' && !plaintextForSending && !body.encryptedContent) {
      return c.json({ error: 'plaintextForSending or body is required for external channels' }, 400)
    }

    // Build the message with initial pending status
    const messageId = crypto.randomUUID()
    let status: EncryptedMessage['status'] = 'pending'
    let externalId: string | undefined
    let failureReason: string | undefined

    if (plaintextForSending && conv.channelType !== 'web') {
      try {
        const identifier = await services.conversations.getContactIdentifier(id)

        const messagingBreaker = getCircuitBreaker({
          name: `messaging:${conv.channelType}`,
          failureThreshold: 5,
          resetTimeoutMs: 30_000,
        })

        const { result } = await messagingBreaker.execute(() =>
          withRetry(
            () => routeOutboundMessage(
              {
                settingsService: services.settings,
                hmacSecret: c.env.HMAC_SECRET,
                notifierUrl: c.env.NOTIFIER_URL,
                notifierApiKey: c.env.NOTIFIER_API_KEY,
              },
              {
                channelType: conv.channelType as 'sms' | 'whatsapp' | 'signal',
                recipientIdentifier: identifier,
                identifierHash: conv.contactIdentifierHash,
                body: plaintextForSending!,
                conversationId: id,
              }
            ),
            {
              maxAttempts: 3,
              baseDelayMs: 300,
              maxDelayMs: 3000,
              isRetryable: (error) => {
                if (typeof error === 'object' && error !== null && 'success' in error) return false
                // Configuration errors are permanent — never retry
                if (error instanceof Error) {
                  const msg = error.message
                  if (msg.includes('not configured') || msg.includes('not enabled')) return false
                }
                return isRetryableError(error)
              },
              onRetry: (attempt, error) => {
                logger.warn(`sendMessage retry ${attempt} via ${conv.channelType}`, { error })
                incCounter('llamenos_retry_attempts_total', { service: 'messaging', operation: 'sendMessage' })
              },
            },
          )
        )

        if (result.success && result.externalId) {
          externalId = result.externalId
          status = 'sent'
        } else if (!result.success) {
          // Bridge unreachable (network error) → store as sent, not failed
          const isBridgeUnavailable = result.error && (
            result.error.includes('request failed') ||
            result.error.includes('ECONNREFUSED') ||
            result.error.includes('ECONNRESET') ||
            result.error.includes('ETIMEDOUT') ||
            result.error.includes('fetch failed')
          )
          if (isBridgeUnavailable) {
            logger.warn(`${conv.channelType} bridge unavailable — message stored as sent`, { conversationId: id, error: result.error })
            status = 'sent'
          } else {
            status = 'failed'
            failureReason = result.error
          }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : 'Unknown error'
        const isNotConfigured = errMsg.includes('not configured') || errMsg.includes('not enabled')
            || err instanceof CircuitOpenError
        if (isNotConfigured) {
          logger.warn(`${conv.channelType} adapter not configured — message stored as sent`, { conversationId: id })
          status = 'sent'
        } else {
          logger.error(`Failed to send outbound message via ${conv.channelType}`, err)
          status = 'failed'
          failureReason = errMsg
        }
      }
    } else if (conv.channelType === 'web') {
      status = 'delivered'
    }

    // Fall back to client-provided externalId (used by simulation/test flows
    // when the messaging adapter is not configured)
    if (!externalId && body.externalId) {
      externalId = body.externalId
    }

    // Store the message via service
    const msg = await services.conversations.addMessage({
      id: messageId,
      conversationId: id,
      direction: 'outbound',
      authorPubkey: pubkey,
      encryptedContent,
      readerEnvelopes,
      externalId,
      status,
      failureReason,
    })

    // Publish new message event to the conversation's hub — clients subscribe per hub
    publishEvent(c.env, KIND_MESSAGE_NEW, {
      type: 'message:new',
      conversationId: id,
      channelType: 'outbound',
    }, conv.hubId ?? '')

    audit(c.get('services').audit, 'messageSent', pubkey, {
      conversationId: id,
      channel: conv.channelType,
    }, undefined, conv.hubId ?? null)

    return c.json(msg, 201)
  },
)

/**
 * PATCH /conversations/:id — update conversation (assign, close, reopen)
 */
conversations.patch('/:id',
  describeRoute({
    tags: ['Conversations'],
    summary: 'Update a conversation (assign, close, reopen)',
    responses: {
      200: {
        description: 'Conversation updated',
        content: {
          'application/json': {
            schema: resolver(conversationResponseSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  validator('json', updateConversationBodySchema),
  async (c) => {
    const services = c.get('services')
    const id = c.req.param('id')
    const pubkey = c.get('pubkey')
    const permissions = c.get('permissions')
    const canUpdate = checkPermission(permissions, 'conversations:update')
    const body = c.req.valid('json')

    // Only users with update permission or assigned volunteer can update
    const conv = await services.conversations.getById(id)
    if (!canUpdate && conv.assignedTo !== pubkey) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    const updated = await services.conversations.update(id, body)

    // Publish status change to the conversation's hub — clients subscribe per hub
    const convEventType = body.status === 'closed' ? 'conversation:closed' : 'conversation:assigned'
    publishEvent(c.env, KIND_CONVERSATION_ASSIGNED, {
      type: convEventType,
      conversationId: id,
      assignedTo: body.assignedTo,
    }, conv.hubId ?? '')

    audit(c.get('services').audit, body.status === 'closed' ? 'conversationClosed' : 'conversationUpdated', pubkey, {
      conversationId: id,
    }, undefined, conv.hubId ?? null)

    return c.json(updated)
  },
)

/**
 * POST /conversations/:id/claim — volunteer claims a waiting conversation
 * Channel-specific permission check: volunteer must have claim permission for the conversation's channel
 */
conversations.post('/:id/claim',
  describeRoute({
    tags: ['Conversations'],
    summary: 'Claim a waiting conversation',
    responses: {
      200: {
        description: 'Conversation claimed',
        content: {
          'application/json': {
            schema: resolver(conversationResponseSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  async (c) => {
    const services = c.get('services')
    const id = c.req.param('id')
    const pubkey = c.get('pubkey')
    const permissions = c.get('permissions')
    const user = c.get('user')
    const hubId = c.get('hubId')
    if (!hubId) {
      return c.json({ error: 'missing hub context' }, 400)
    }

    // Fetch conversation to check channel type
    const conv = await services.conversations.getById(id)

    // Check channel-specific claim permission
    if (!canClaimChannel(permissions, conv.channelType)) {
      return c.json({
        error: 'No permission to claim this channel type',
        channelType: conv.channelType,
        allowedChannels: getClaimableChannels(permissions),
      }, 403)
    }

    // Check user's supported messaging channels (if defined)
    if (user.supportedMessagingChannels && user.supportedMessagingChannels.length > 0) {
      if (!user.supportedMessagingChannels.includes(conv.channelType as MessagingChannelType)) {
        return c.json({
          error: 'User not configured for this channel',
          channelType: conv.channelType,
          supportedChannels: user.supportedMessagingChannels,
        }, 403)
      }
    }

    // Check if user has messaging enabled (defaults to true for backwards compatibility)
    if (user.messagingEnabled === false) {
      return c.json({ error: 'Messaging not enabled for this user' }, 403)
    }

    const claimed = await services.conversations.claim(id, pubkey)

    // Publish assignment to the conversation's hub — clients subscribe per hub
    publishEvent(c.env, KIND_CONVERSATION_ASSIGNED, {
      type: 'conversation:assigned',
      conversationId: id,
      assignedTo: pubkey,
    }, conv.hubId ?? '')

    // Push notification to assigned user (Epic 86)
    dispatchPushToUser(c.env, services, pubkey, {
      hubId,
      type: 'assignment',
      conversationId: id,
      channelType: conv.channelType,
    }, {
      hubId,
      type: 'assignment',
      conversationId: id,
      channelType: conv.channelType,
    })

    audit(c.get('services').audit, 'conversationClaimed', pubkey, {
      conversationId: id,
      channelType: conv.channelType,
    }, undefined, conv.hubId ?? null)

    return c.json(claimed)
  },
)

export default conversations
