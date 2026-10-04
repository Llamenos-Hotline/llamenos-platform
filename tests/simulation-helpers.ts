/**
 * Simulation endpoint helpers for Desktop Playwright tests.
 *
 * These call the dev-only simulation endpoints in apps/worker/routes/dev.ts
 * to inject fake incoming calls and messages without real Twilio credentials.
 * All endpoints require ENVIRONMENT=development + X-Test-Secret header.
 *
 * The backend base URL defaults to http://localhost:3000 (Docker Compose)
 * and can be overridden via TEST_HUB_URL env var.
 */

import type { APIRequestContext } from '@playwright/test'

const TEST_SECRET = process.env.DEV_RESET_SECRET || 'test-reset-secret'
/**
 * Backend base URL for simulation endpoints.
 * These must hit the backend directly (not the Vite frontend).
 * Defaults to http://localhost:3000 (Docker Compose backend).
 */
const HUB_BASE_URL = process.env.TEST_HUB_URL || 'http://localhost:3000'

function simulationHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Test-Secret': TEST_SECRET,
  }
}

// ── Response Types ──────────────────────────────────────────────────

export interface SimulateIncomingCallResult {
  ok: boolean
  callId: string
  status: 'ringing' | 'no-volunteers'
}

export interface SimulateAnswerCallResult {
  ok: boolean
  callId: string
  status: 'in-progress'
}

export interface SimulateEndCallResult {
  ok: boolean
  callId: string
  status: 'completed'
}

export interface SimulateVoicemailResult {
  ok: boolean
  callId: string
  status: 'unanswered'
}

export interface SimulateIncomingMessageResult {
  ok: boolean
  conversationId: string
  messageId: string
}

export interface SimulateDeliveryStatusResult {
  ok: boolean
}

// ── Option Types ────────────────────────────────────────────────────

export interface SimulateIncomingCallOptions {
  /** Caller phone number (required). Use a unique number per test. */
  callerNumber: string
  /** Language code (e.g., 'en', 'es'). Optional. */
  language?: string
  /** Hub ID override. Optional. */
  hubId?: string
  /** When true, errors if the call would ring nobody (on shift / fallback group, available, hub access). Optional. */
  checkVolunteers?: boolean
}

export interface SimulateIncomingMessageOptions {
  /** Sender phone number (required). Use a unique number per test. */
  senderNumber: string
  /** Message body text (required). */
  body: string
  /** Channel type: 'sms' | 'whatsapp' | 'signal'. Defaults to 'sms'. */
  channel?: 'sms' | 'whatsapp' | 'signal'
  /** Hub ID for conversation scoping. Pass the workerHub fixture value to prevent cross-worker interference. */
  hubId?: string
}

export interface SimulateDeliveryStatusOptions {
  /** Conversation ID from simulateIncomingMessage result. */
  conversationId: string
  /** Message ID from simulateIncomingMessage result. */
  messageId: string
  /** Delivery status to simulate. */
  status: 'delivered' | 'read' | 'failed'
}

// ── Helper Functions ────────────────────────────────────────────────

/**
 * Post to a simulation endpoint and return the parsed JSON response.
 * Throws with a descriptive error on non-2xx responses.
 */
async function postSimulation<T>(
  request: APIRequestContext,
  endpoint: string,
  body: Record<string, unknown>,
): Promise<T> {
  // Use absolute URL to hit the backend directly, not the Vite frontend.
  // Playwright's request.post() with a relative URL would resolve against
  // the baseURL (Vite at :8788), but simulation endpoints live on the backend.
  const url = `${HUB_BASE_URL}/api/test-simulate/${endpoint}`
  const res = await request.post(url, {
    headers: simulationHeaders(),
    data: body,
  })

  if (!res.ok()) {
    const text = await res.text()
    throw new Error(
      `Simulation endpoint ${endpoint} failed (${res.status()}): ${text}`,
    )
  }

  return res.json() as Promise<T>
}

/**
 * Simulate an incoming call to the hotline.
 *
 * Creates a call record in CallRouterDO with status "ringing".
 * Returns the generated callId for use with answerCall/endCall/voicemail.
 *
 * @example
 * ```ts
 * const { callId } = await simulateIncomingCall(request, {
 *   callerNumber: `+1212${Date.now().toString().slice(-7)}`,
 * })
 * ```
 */
export async function simulateIncomingCall(
  request: APIRequestContext,
  options: SimulateIncomingCallOptions,
): Promise<SimulateIncomingCallResult> {
  return postSimulation<SimulateIncomingCallResult>(
    request,
    'incoming-call',
    {
      callerNumber: options.callerNumber,
      ...(options.language ? { language: options.language } : {}),
      ...(options.hubId ? { hubId: options.hubId } : {}),
      ...(options.checkVolunteers ? { checkVolunteers: true } : {}),
    },
  )
}

/**
 * Simulate answering a ringing call.
 *
 * Transitions the call from "ringing" to "in-progress" for the given volunteer.
 *
 * @param callId - The call ID returned by simulateIncomingCall.
 * @param pubkey - The volunteer's public key (hex, 64 chars).
 */
export async function simulateAnswerCall(
  request: APIRequestContext,
  callId: string,
  pubkey: string,
): Promise<SimulateAnswerCallResult> {
  return postSimulation<SimulateAnswerCallResult>(
    request,
    'answer-call',
    { callId, pubkey },
  )
}

/**
 * Simulate ending an active call.
 *
 * Transitions the call to "completed" status.
 *
 * @param callId - The call ID returned by simulateIncomingCall.
 */
export async function simulateEndCall(
  request: APIRequestContext,
  callId: string,
): Promise<SimulateEndCallResult> {
  return postSimulation<SimulateEndCallResult>(
    request,
    'end-call',
    { callId },
  )
}

/**
 * Simulate a call going to voicemail (unanswered).
 *
 * Transitions the call to "unanswered" status.
 *
 * @param callId - The call ID returned by simulateIncomingCall.
 */
export async function simulateVoicemail(
  request: APIRequestContext,
  callId: string,
): Promise<SimulateVoicemailResult> {
  return postSimulation<SimulateVoicemailResult>(
    request,
    'voicemail',
    { callId },
  )
}

/**
 * Simulate an incoming text message (SMS, WhatsApp, or Signal).
 *
 * Creates a conversation in ConversationDO with the inbound message.
 * Returns the conversationId and messageId for further interactions.
 *
 * @example
 * ```ts
 * const { conversationId, messageId } = await simulateIncomingMessage(request, {
 *   senderNumber: `+1212${Date.now().toString().slice(-7)}`,
 *   body: 'Help, I need assistance',
 *   channel: 'sms',
 * })
 * ```
 */
export async function simulateIncomingMessage(
  request: APIRequestContext,
  options: SimulateIncomingMessageOptions,
): Promise<SimulateIncomingMessageResult> {
  return postSimulation<SimulateIncomingMessageResult>(
    request,
    'incoming-message',
    {
      senderNumber: options.senderNumber,
      body: options.body,
      ...(options.channel ? { channel: options.channel } : {}),
      ...(options.hubId ? { hubId: options.hubId } : {}),
    },
  )
}

/**
 * Simulate a delivery status update for an outbound message.
 *
 * Updates the status of a message within a conversation
 * (e.g., "delivered", "read", "failed").
 */
export async function simulateDeliveryStatus(
  request: APIRequestContext,
  options: SimulateDeliveryStatusOptions,
): Promise<SimulateDeliveryStatusResult> {
  return postSimulation<SimulateDeliveryStatusResult>(
    request,
    'delivery-status',
    {
      conversationId: options.conversationId,
      messageId: options.messageId,
      status: options.status,
    },
  )
}

// ── Convenience: unique caller/sender numbers ───────────────────────

/**
 * Generate a unique phone number for simulation tests.
 * Uses Date.now() to avoid collisions between parallel test workers.
 */
export function uniqueCallerNumber(): string {
  const suffix = Date.now().toString().slice(-7)
  return `+1212${suffix}`
}
