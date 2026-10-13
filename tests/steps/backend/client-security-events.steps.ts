/**
 * Client-reported security events (POST /api/security-events, unauthenticated).
 */
import { expect } from '@playwright/test'
import { When, Then, Before, getState, setState } from './fixtures'
import { getSharedState, setLastResponse } from './shared-state'
import { apiGet } from '../../api-helpers'
import { harnessClientHeaders } from '../../dev-surface-secret'

const BASE_URL = process.env.TEST_HUB_URL || 'http://localhost:3000'

interface ClientSecurityEventsState {
  /** Unique SPKI-hash-shaped pin used to find our event in the admin listing. */
  markerPin?: string
}

const STATE_KEY = 'client_security_events'

Before(async ({ world }) => {
  setState<ClientSecurityEventsState>(world, STATE_KEY, {})
})

function randomFakeIp(): string {
  return `10.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`
}

/** 44-char base64 string, like a SHA-256 SPKI hash. */
function randomPin(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')
}

function eventItem(overrides: Record<string, unknown> = {}, pin = randomPin()): Record<string, unknown> {
  return {
    event_type: 'cert_pin_mismatch',
    occurred_at: new Date().toISOString(),
    app_version: '1.0.0 (1)',
    os_version: 'iOS Version 18.0',
    pin_identifiers: [pin, randomPin()],
    ...overrides,
  }
}

async function submit(
  request: import('@playwright/test').APIRequestContext,
  body: Record<string, unknown>,
  ip = randomFakeIp(),
): Promise<{ status: number; data: unknown }> {
  // Deliberately no Authorization header — the endpoint is unauthenticated.
  //
  // `harnessClientHeaders` names the client this submission is from. The
  // endpoint caps submissions at 5/min per client inside the route handler, and
  // that cap is NOT relaxed here — one scenario below asserts it fires. What
  // the named client buys is that the other six scenarios, each submitting
  // once, do not land in the same bucket as that flood. On a deployed target
  // every caller shares Caddy's address, so they did (#1625).
  const res = await request.post(`${BASE_URL}/api/security-events`, {
    headers: { 'Content-Type': 'application/json', ...harnessClientHeaders(ip) },
    data: body,
  })
  const data = await res.json().catch(() => null)
  return { status: res.status(), data }
}

When('an unauthenticated client reports a certificate pin mismatch', async ({ request, world }) => {
  const state = getState<ClientSecurityEventsState>(world, STATE_KEY)
  state.markerPin = randomPin()
  setLastResponse(world, await submit(request, { events: [eventItem({}, state.markerPin)] }))
})

When('an unauthenticated client reports a certificate pin mismatch with an extra {string} field', async ({ request, world }, field: string) => {
  setLastResponse(world, await submit(request, { events: [eventItem({ [field]: 'abc123' })] }))
})

When('an unauthenticated client reports a {string} event', async ({ request, world }, eventType: string) => {
  setLastResponse(world, await submit(request, { events: [eventItem({ event_type: eventType })] }))
})

When('an unauthenticated client reports {int} certificate pin mismatch events in one request', async ({ request, world }, count: number) => {
  const events = Array.from({ length: count }, () => eventItem())
  setLastResponse(world, await submit(request, { events }))
})

When('an unauthenticated client reports a certificate pin mismatch with a {int} character app version', async ({ request, world }, length: number) => {
  setLastResponse(world, await submit(request, { events: [eventItem({ app_version: 'v'.repeat(length) })] }))
})

When('an unauthenticated client reports a certificate pin mismatch with a {int} byte padding field', async ({ request, world }, bytes: number) => {
  setLastResponse(world, await submit(request, { events: [eventItem()], padding: 'x'.repeat(bytes) }))
})

When('an unauthenticated client submits {int} certificate pin mismatch reports from the same IP', async ({ request, world }, count: number) => {
  const ip = randomFakeIp()
  const statuses: number[] = []
  let last = { status: 0, data: null as unknown }
  for (let i = 0; i < count; i++) {
    last = await submit(request, { events: [eventItem()] }, ip)
    statuses.push(last.status)
  }
  getSharedState(world).floodResponses = statuses
  setLastResponse(world, last)
})

interface AdminSecurityEvent {
  id: string
  eventType: string
  deviceId: string | null
  metadata: { pinIdentifiers?: string[]; source?: string }
  ipHash: string | null
}

async function findReportedEvent(
  request: import('@playwright/test').APIRequestContext,
  markerPin: string,
): Promise<AdminSecurityEvent | undefined> {
  const res = await apiGet<{ events: AdminSecurityEvent[] }>(request, '/admin/security-events?limit=200')
  expect(res.status).toBe(200)
  return res.data.events.find((e) => e.metadata.pinIdentifiers?.includes(markerPin))
}

Then('an admin can see the reported certificate pin mismatch in the security events', async ({ request, world }) => {
  const { markerPin } = getState<ClientSecurityEventsState>(world, STATE_KEY)
  expect(markerPin).toBeDefined()
  const event = await findReportedEvent(request, markerPin!)
  expect(event, 'reported event should appear in GET /api/admin/security-events').toBeDefined()
  expect(event!.eventType).toBe('cert_pin_mismatch')
  expect(event!.metadata.source).toBe('client')
})

Then('the reported event carries no device or IP identifier', async ({ request, world }) => {
  const { markerPin } = getState<ClientSecurityEventsState>(world, STATE_KEY)
  const event = await findReportedEvent(request, markerPin!)
  expect(event).toBeDefined()
  expect(event!.deviceId).toBeNull()
  expect(event!.ipHash).toBeNull()
})

Then('the submissions before the limit succeed and a later submission is rejected with 429', async ({ world }) => {
  const statuses = getSharedState(world).floodResponses
  expect(statuses[0], 'first submission from a fresh IP must be accepted').toBe(202)
  expect(statuses, `statuses: ${statuses.join(',')}`).toContain(429)
})
