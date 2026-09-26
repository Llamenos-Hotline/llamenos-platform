/**
 * Backend webhook security step definitions.
 *
 * Tests that telephony/messaging webhooks enforce Content-Type validation
 * and IP allowlisting. These tests hit the telephony webhook routes
 * directly with crafted headers — no real telephony provider is needed.
 */
import { expect } from '@playwright/test'
import { Given, When, Then, Before, getState, setState } from './fixtures'
import { setLastResponse } from './shared-state'
import { createHmac } from 'node:crypto'

const BASE_URL = process.env.TEST_HUB_URL || 'http://localhost:3000'

// ── Local state ─────────────────────────────────────────────────

interface WebhookSecurityState {
  /** Content-Type header to send */
  contentType?: string
  /** Simulated source IP (via X-Forwarded-For or CF-Connecting-IP) */
  sourceIp?: string
  /** Provider name for IP allowlist tests */
  provider?: string
  /** Whether the provider expects form-encoded content */
  expectsFormEncoded?: boolean
  /** Twilio credentials configured on the scenario's hub (signed-webhook scenarios) */
  twilioAuthToken?: string
  /** Form body reused across the signed / unsigned deliveries of one scenario */
  signedPayload?: Record<string, string>
  /** Raw responses of the signed-webhook deliveries, in delivery order */
  webhookResponses: WebhookResponse[]
  /** Raw response of the unsigned delivery */
  unsignedResponse?: WebhookResponse
}

interface WebhookResponse {
  status: number
  contentType: string
  body: string
}

const STATE_KEY = 'webhook_security'

function getWebhookState(world: Record<string, unknown>): WebhookSecurityState {
  return getState<WebhookSecurityState>(world, STATE_KEY)
}

Before({ tags: '@backend' }, async ({ world }) => {
  setState(world, STATE_KEY, { webhookResponses: [] } satisfies WebhookSecurityState)
})

// ── Given steps ─────────────────────────────────────────────────

Given('a configured telephony provider expecting form-encoded content', async ({ world }) => {
  // Twilio sends webhooks as application/x-www-form-urlencoded
  getWebhookState(world).expectsFormEncoded = true
  getWebhookState(world).provider = 'TWILIO'
})

Given('a webhook with Content-Type {string}', async ({ world }, contentType: string) => {
  getWebhookState(world).contentType = contentType
})

Given('IP allowlisting is enabled for provider {string}', async ({ world }, provider: string) => {
  getWebhookState(world).provider = provider
})

Given('the request comes from IP {string}', async ({ world }, ip: string) => {
  getWebhookState(world).sourceIp = ip
})

// ── When steps ──────────────────────────────────────────────────

When('the webhook is delivered', async ({ request, world }) => {
  const state = getWebhookState(world)

  // Target the telephony incoming webhook endpoint.
  // In the real app this is POST /api/telephony/incoming — the middleware
  // validates the webhook signature and rejects invalid requests with 403.
  // Without a configured adapter it returns 404.
  //
  // For Content-Type mismatch tests: the telephony adapter validates the
  // webhook signature, which requires the correct Content-Type. If the
  // Content-Type is wrong, the adapter's parseIncomingWebhook or
  // validateWebhook will fail.
  //
  // For IP allowlist tests: the middleware checks CF-Connecting-IP against
  // the provider's known IP ranges.
  const webhookPath = `${BASE_URL}/api/telephony/incoming`

  const headers: Record<string, string> = {}

  // Set Content-Type — wrong one for the mismatch test, correct one otherwise
  // so requests reach the IP/replay checks without being rejected by content-type enforcement.
  if (state.contentType) {
    headers['Content-Type'] = state.contentType
  } else {
    headers['Content-Type'] = 'application/x-www-form-urlencoded'
  }

  // Simulate source IP via CF-Connecting-IP (the header the server trusts)
  if (state.sourceIp) {
    headers['CF-Connecting-IP'] = state.sourceIp
  }

  // Send a minimal POST body with a unique nonce to avoid replay-detection
  // collisions between parallel test scenarios sharing the same nonce table.
  const nonce = crypto.randomUUID()
  const res = await request.post(webhookPath, {
    headers,
    data: state.contentType === 'application/json'
      ? JSON.stringify({ CallSid: `test-${nonce}`, From: '+15551234567', To: '+15559876543' })
      : `CallSid=test-${nonce}&From=%2B15551234567&To=%2B15559876543`,
  })

  const contentTypeHeader = res.headers()['content-type'] ?? ''
  let data: unknown = null
  if (contentTypeHeader.includes('application/json')) {
    try { data = await res.json() } catch { data = null }
  } else {
    data = await res.text()
  }

  setLastResponse(world, { status: res.status(), data })
})

// ── Correctly signed webhooks through the full middleware stack (#1036) ──────
//
// These scenarios post REAL provider-signed webhooks to /api/telephony/incoming.
// A signature can only be computed with the provider's auth token, so they need
// the server's env-var Twilio provider (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN /
// TWILIO_PHONE_NUMBER) exported to this process as well. They are tagged
// @signed-webhooks and run in their own opt-in project; if that environment is
// missing they FAIL LOUDLY — a signed-webhook test that passes without a signed
// webhook is a no-op.

// Twilio's documented signature: base64(HMAC-SHA1(authToken, url + sorted key+value pairs)).
function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params).sort().reduce((acc, key) => acc + key + params[key], url)
  return createHmac('sha1', authToken).update(data).digest('base64')
}

async function postIncoming(
  request: import('@playwright/test').APIRequestContext,
  params: Record<string, string>,
  authToken?: string,
): Promise<WebhookResponse> {
  const path = '/api/telephony/incoming'
  // The server signs over WEBHOOK_BASE_URL when configured, else the request's own origin.
  const signedOrigin = process.env.WEBHOOK_BASE_URL ? new URL(process.env.WEBHOOK_BASE_URL).origin : BASE_URL
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' }
  if (authToken) headers['X-Twilio-Signature'] = twilioSignature(authToken, signedOrigin + path, params)
  const res = await request.post(`${BASE_URL}${path}`, { headers, data: new URLSearchParams(params).toString() })
  return {
    status: res.status(),
    contentType: res.headers()['content-type'] ?? '',
    body: await res.text(),
  }
}

function ensurePayload(state: WebhookSecurityState): Record<string, string> {
  state.signedPayload ??= {
    CallSid: `CA${crypto.randomUUID().replace(/-/g, '')}`,
    From: '+15551234567',
    To: process.env.TWILIO_PHONE_NUMBER ?? '+15559876543',
  }
  return state.signedPayload
}

function expectTwiml(res: WebhookResponse | undefined): void {
  expect(res).toBeDefined()
  expect(res!.status).toBe(200)
  expect(res!.contentType).toContain('xml')
  expect(res!.body).toContain('<Response')
  expect(res!.body).not.toBe('OK')
}

Given('the server accepts Twilio-signed telephony webhooks', async ({ world }) => {
  const authToken = process.env.TWILIO_AUTH_TOKEN
  if (!authToken || !process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_PHONE_NUMBER) {
    throw new Error(
      '@signed-webhooks scenarios need TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_PHONE_NUMBER ' +
      'set to the SAME values in the backend server and in this test process (and WEBHOOK_BASE_URL too, if the server has it).',
    )
  }
  getWebhookState(world).twilioAuthToken = authToken
})

When('a Twilio-signed incoming-call webhook is delivered', async ({ request, world }) => {
  const state = getWebhookState(world)
  const res = await postIncoming(request, ensurePayload(state), state.twilioAuthToken)
  state.webhookResponses.push(res)
  setLastResponse(world, { status: res.status, data: res.body })
})

When('a Twilio-signed incoming-call webhook is delivered twice', async ({ request, world }) => {
  const state = getWebhookState(world)
  const params = ensurePayload(state)
  for (let i = 0; i < 2; i++) {
    state.webhookResponses.push(await postIncoming(request, params, state.twilioAuthToken))
  }
})

When('an unsigned incoming-call webhook is delivered', async ({ request, world }) => {
  const state = getWebhookState(world)
  state.unsignedResponse = await postIncoming(request, ensurePayload(state))
})

When('a Twilio-signed incoming-call webhook with the same payload is delivered', async ({ request, world }) => {
  const state = getWebhookState(world)
  const res = await postIncoming(request, ensurePayload(state), state.twilioAuthToken)
  state.webhookResponses.push(res)
  setLastResponse(world, { status: res.status, data: res.body })
})

Then('the webhook response should be TwiML and not the replay acknowledgement', async ({ world }) => {
  expectTwiml(getWebhookState(world).webhookResponses[0])
})

Then('the first webhook response should be TwiML', async ({ world }) => {
  expectTwiml(getWebhookState(world).webhookResponses[0])
})

Then('the second webhook response should be the plain replay acknowledgement', async ({ world }) => {
  const second = getWebhookState(world).webhookResponses[1]
  expect(second).toBeDefined()
  expect(second.status).toBe(200)
  expect(second.contentType).toContain('text/plain')
  expect(second.body).toBe('OK')
})

Then('the unsigned webhook response status should be {int}', async ({ world }, expectedStatus: number) => {
  expect(getWebhookState(world).unsignedResponse?.status).toBe(expectedStatus)
})
