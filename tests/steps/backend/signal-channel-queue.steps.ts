/**
 * Step definitions for core/signal-channel.feature's retry queue & rate
 * limiting scenarios.
 *
 * Bind directly to the real SignalMessageQueue service
 * (apps/worker/messaging/signal/queue.ts) via thin dev-only pass-through
 * endpoints (dev.ts's /test-simulate/signal-queue/*) for enqueue/fail/sent —
 * there is no production HTTP route for those since they happen internally
 * during a real send attempt. The dead-letter retry scenario instead calls
 * the real ADMIN route (POST /messaging/signal/queue/retry/:id), which
 * already existed in routes/signal.ts.
 */
import { expect, type APIRequestContext } from '@playwright/test'
import { Given, When, Then, getState, setState } from './fixtures'
import { simulateIncomingMessage, uniqueCallerNumber } from '../../simulation-helpers'
import { apiGet, apiPost, devGet, devPost } from '../../api-helpers'

const STATE_KEY = 'signal-channel-queue'

interface QueueState {
  conversationId?: string
  recipientIdentifier: string
  messageId?: string
  status?: string
  retryCount?: number
  nextRetryAt?: string | null
}

function getQueueState(world: Record<string, unknown>): QueueState {
  const existing = getState<QueueState | undefined>(world, STATE_KEY)
  if (existing) return existing
  const fresh: QueueState = { recipientIdentifier: uniqueCallerNumber() }
  setState(world, STATE_KEY, fresh)
  return fresh
}

async function enqueue(
  request: APIRequestContext,
  workerHub: string,
  conversationId: string,
  recipientIdentifier: string,
): Promise<{ id: string; status: string; retryCount: number }> {
  const { status: httpStatus, data } = await devPost<{ id: string; status: string; retryCount: number }>(
    request,
    '/test-simulate/signal-queue/enqueue',
    { hubId: workerHub, conversationId, recipientIdentifier, body: 'Simulated outbound Signal message' },
  )
  expect(httpStatus).toBe(200)
  return data
}

async function markFailed(
  request: APIRequestContext,
  messageId: string,
): Promise<{ status: string; retryCount: number; nextRetryAt: string | null; lastError: string | null }> {
  const { status: httpStatus, data } = await devPost<{
    status: string
    retryCount: number
    nextRetryAt: string | null
    lastError: string | null
  }>(request, '/test-simulate/signal-queue/mark-failed', { messageId, error: 'Simulated bridge timeout' })
  expect(httpStatus).toBe(200)
  return data
}

// ── Given ────────────────────────────────────────────────────────────

Given('a Signal message fails to send due to bridge timeout', async ({ request, world }) => {
  const state = getQueueState(world)
  const inbound = await simulateIncomingMessage(request, {
    senderNumber: state.recipientIdentifier,
    body: 'Need help',
    channel: 'signal',
  })
  state.conversationId = inbound.conversationId
})

Given('a queued message has failed {int} times', async ({ request, world, workerHub }, times: number) => {
  const state = getQueueState(world)
  const inbound = await simulateIncomingMessage(request, {
    senderNumber: state.recipientIdentifier,
    body: 'Need help',
    channel: 'signal',
  })
  state.conversationId = inbound.conversationId
  const enqueued = await enqueue(request, workerHub, inbound.conversationId, state.recipientIdentifier)
  state.messageId = enqueued.id

  let last = enqueued
  for (let i = 0; i < times; i++) {
    last = await markFailed(request, enqueued.id)
  }
  state.status = last.status
  state.retryCount = last.retryCount
})

Given('a queued message has been retried {int} times', async ({ request, world, workerHub }, times: number) => {
  const state = getQueueState(world)
  const inbound = await simulateIncomingMessage(request, {
    senderNumber: state.recipientIdentifier,
    body: 'Need help',
    channel: 'signal',
  })
  state.conversationId = inbound.conversationId
  const enqueued = await enqueue(request, workerHub, inbound.conversationId, state.recipientIdentifier)
  state.messageId = enqueued.id

  let last = enqueued
  for (let i = 0; i < times; i++) {
    last = await markFailed(request, enqueued.id)
  }
  state.status = last.status
  state.retryCount = last.retryCount
})

Given('{int} messages were sent to {string} in the last minute', async ({ request, world, workerHub }, count: number, recipient: string) => {
  const state = getQueueState(world)
  state.recipientIdentifier = recipient
  for (let i = 0; i < count; i++) {
    const inbound = await simulateIncomingMessage(request, {
      senderNumber: uniqueCallerNumber(),
      body: 'Need help',
      channel: 'signal',
    })
    const enqueued = await enqueue(request, workerHub, inbound.conversationId, recipient)
    const { status: httpStatus } = await devPost(request, '/test-simulate/signal-queue/mark-sent', {
      messageId: enqueued.id,
    })
    expect(httpStatus).toBe(200)
  }
})

Given('a dead-letter message exists', async ({ request, world, workerHub }) => {
  const state = getQueueState(world)
  const inbound = await simulateIncomingMessage(request, {
    senderNumber: state.recipientIdentifier,
    body: 'Need help',
    channel: 'signal',
  })
  state.conversationId = inbound.conversationId
  const enqueued = await enqueue(request, workerHub, inbound.conversationId, state.recipientIdentifier)
  state.messageId = enqueued.id

  // Default maxRetries is 5 — the 6th failure crosses the dead-letter threshold.
  let last = enqueued
  for (let i = 0; i < 6; i++) {
    last = await markFailed(request, enqueued.id)
  }
  state.status = last.status
  state.retryCount = last.retryCount
  expect(state.status).toBe('dead')
})

// ── When ─────────────────────────────────────────────────────────────

When('the message is enqueued', async ({ request, world, workerHub }) => {
  const state = getQueueState(world)
  const { conversationId } = state
  expect(conversationId).toBeDefined()
  if (!conversationId) throw new Error('conversationId not set')
  const enqueued = await enqueue(request, workerHub, conversationId, state.recipientIdentifier)
  state.messageId = enqueued.id
  state.status = enqueued.status
  state.retryCount = enqueued.retryCount
})

When('the message fails again', async ({ request, world }) => {
  const state = getQueueState(world)
  const { messageId } = state
  expect(messageId).toBeDefined()
  if (!messageId) throw new Error('messageId not set')
  const result = await markFailed(request, messageId)
  state.status = result.status
  state.retryCount = result.retryCount
  state.nextRetryAt = result.nextRetryAt
})

When('it fails again', async ({ request, world }) => {
  const state = getQueueState(world)
  const { messageId } = state
  expect(messageId).toBeDefined()
  if (!messageId) throw new Error('messageId not set')
  const result = await markFailed(request, messageId)
  state.status = result.status
  state.retryCount = result.retryCount
  state.nextRetryAt = result.nextRetryAt
})

When('another message is attempted to the same number', async ({ request, world }) => {
  const state = getQueueState(world)
  const { status: httpStatus, data } = await devGet<{ rateLimited: boolean }>(
    request,
    `/test-simulate/signal-queue/rate-limited?recipientIdentifier=${encodeURIComponent(state.recipientIdentifier)}`,
  )
  expect(httpStatus).toBe(200)
  setState(world, `${STATE_KEY}-rate-limited`, data.rateLimited)
})

When('the admin retries the message', async ({ request, world }) => {
  const state = getQueueState(world)
  expect(state.messageId).toBeDefined()
  const { status: httpStatus, data } = await apiPost<{ success: boolean }>(
    request,
    `/messaging/signal/queue/retry/${state.messageId}`,
    {},
  )
  expect(httpStatus).toBe(200)
  expect(data.success).toBe(true)

  const { data: refreshed } = await devGet<{ status: string; retryCount: number }>(
    request,
    `/test-simulate/signal-queue/message?id=${state.messageId}`,
  )
  state.status = refreshed.status
  state.retryCount = refreshed.retryCount
})

// ── Then ─────────────────────────────────────────────────────────────

Then('it should have status {string} with retry count {int}', ({ world }, expectedStatus: string, expectedRetryCount: number) => {
  const state = getQueueState(world)
  expect(state.status).toBe(expectedStatus)
  expect(state.retryCount).toBe(expectedRetryCount)
})

Then('the next retry delay should be approximately {int} seconds', ({ world }, expectedSeconds: number) => {
  const state = getQueueState(world)
  const { nextRetryAt } = state
  expect(nextRetryAt).toBeTruthy()
  if (!nextRetryAt) throw new Error('nextRetryAt not set')
  const delaySeconds = (new Date(nextRetryAt).getTime() - Date.now()) / 1000
  // markFailed applies up to 20% jitter on top of the base exponential delay,
  // plus test-execution slack.
  expect(delaySeconds).toBeGreaterThanOrEqual(expectedSeconds - 15)
  expect(delaySeconds).toBeLessThanOrEqual(expectedSeconds * 1.3)
})

Then('the queued message status should be {string}', ({ world }, expectedStatus: string) => {
  const state = getQueueState(world)
  expect(state.status).toBe(expectedStatus)
})

Then('it should appear in the dead-letter queue', async ({ request, world, workerHub }) => {
  const state = getQueueState(world)
  const { status: httpStatus, data } = await apiGet<{ deadLetters: Array<{ id: string }> }>(
    request,
    `/messaging/signal/queue/dead-letters?hub=${workerHub}`,
  )
  expect(httpStatus).toBe(200)
  expect(data.deadLetters.some(m => m.id === state.messageId)).toBe(true)
})

Then('the send should be rate-limited', ({ world }) => {
  const rateLimited = getState<boolean | undefined>(world, `${STATE_KEY}-rate-limited`)
  expect(rateLimited).toBe(true)
})
