/**
 * API Contract validation step definitions.
 *
 * Tests that Zod schemas reject invalid input with 400 responses
 * and accept valid input. Uses admin credentials for all requests.
 * Status assertions are in assertions.steps.ts (shared).
 */
import { expect } from '@playwright/test'
import { When, Then, Given, Before } from './fixtures'
import { resolvePathParams, setLastResponse } from './shared-state'
import {
  apiGet,
  apiPost,
  apiPatch,
  apiPut,
  generateTestKeypair,
  uniquePhone,
  uniqueName,
  ADMIN_NSEC,
} from '../../api-helpers'

Before({ tags: '@backend' }, async () => {
  // shared state reset handled by fixture
})

// ── Generic admin request with DataTable body ───────────────────────

When('an admin sends {string} to {string} with body:', async (
  { request, world },
  method: string,
  path: string,
  dataTable: { raw: () => string[][] },
) => {
  const rows = dataTable.raw()
  const body: Record<string, unknown> = {}
  for (const [key, value] of rows) {
    try {
      body[key] = JSON.parse(value)
    } catch {
      body[key] = value === '' ? '' : value
    }
  }

  const apiPath = path.startsWith('/api') ? path.slice(4) : path

  switch (method) {
    case 'GET':
      setLastResponse(world, await apiGet(request, apiPath, ADMIN_NSEC))
      break
    case 'POST':
      setLastResponse(world, await apiPost(request, apiPath, body, ADMIN_NSEC))
      break
    case 'PATCH':
      setLastResponse(world, await apiPatch(request, apiPath, body, ADMIN_NSEC))
      break
    case 'PUT':
      setLastResponse(world, await apiPut(request, apiPath, body, ADMIN_NSEC))
      break
    default:
      throw new Error(`Unknown method: ${method}`)
  }
})

// ── Generic admin GET/POST/PATCH (no body) ──────────────────────────

When('an admin sends {string} to {string}', async ({ request, world, workerHub }, method: string, path: string) => {
  const resolved = resolvePathParams(world, path, workerHub)
  const apiPath = resolved.startsWith('/api') ? resolved.slice(4) : resolved
  switch (method) {
    case 'GET':
      setLastResponse(world, await apiGet(request, apiPath, ADMIN_NSEC))
      break
    case 'POST':
      setLastResponse(world, await apiPost(request, apiPath, {}, ADMIN_NSEC))
      break
    case 'PATCH':
      setLastResponse(world, await apiPatch(request, apiPath, {}, ADMIN_NSEC))
      break
    default:
      throw new Error(`Unknown method: ${method}`)
  }
})

// ── Specific invalid body steps ─────────────────────────────────────

When('an admin sends {string} to {string} with empty encrypted content', async ({ request, world }, _method: string, _path: string) => {
  setLastResponse(world, await apiPost(request, '/notes', {
    encryptedContent: '',
    callId: 'test-call-id',
  }, ADMIN_NSEC))
})

When('an admin sends {string} to {string} with missing title', async ({ request, world }, _method: string, _path: string) => {
  setLastResponse(world, await apiPost(request, '/reports', {
    encryptedContent: 'test-content',
    readerEnvelopes: [{ pubkey: 'a'.repeat(64), ct: 'key', enc: 'b'.repeat(64) }],
  }, ADMIN_NSEC))
})

When('an admin sends {string} to {string} with invalid day body', async ({ request, world }, _method: string, _path: string) => {
  setLastResponse(world, await apiPost(request, '/shifts', {
    name: 'Bad Shift',
    startTime: '09:00',
    endTime: '17:00',
    days: [0, 1, 7], // 7 is invalid (0-6 only)
    userPubkeys: [],
  }, ADMIN_NSEC))
})

When('an admin sends {string} to {string} with negative day body', async ({ request, world }, _method: string, _path: string) => {
  setLastResponse(world, await apiPost(request, '/shifts', {
    name: 'Bad Shift',
    startTime: '09:00',
    endTime: '17:00',
    days: [-1, 0, 1],
    userPubkeys: [],
  }, ADMIN_NSEC))
})

When('an admin sends {string} to {string} with valid twilio body', async ({ request, world }, _method: string, _path: string) => {
  setLastResponse(world, await apiPatch(request, '/settings/telephony-provider', {
    type: 'twilio',
    accountSid: 'AC' + '0'.repeat(32), // HIGH-W5: AC + 32 hex chars = 34 chars total (obviously fake test value)
    authToken: 'test_auth_token_value',
    phoneNumber: '+15551234567',
  }, ADMIN_NSEC))
})

// ── Valid request steps ─────────────────────────────────────────────

When('an admin creates a volunteer with valid data', async ({ request, world }) => {
  const kp = generateTestKeypair()
  setLastResponse(world, await apiPost(request, '/users', {
    pubkey: kp.pubkey,
    name: uniqueName('Contract Vol'),
    phone: uniquePhone(),
    roleIds: ['role-volunteer'],
  }, ADMIN_NSEC))
})

When('an admin creates a shift with valid data', async ({ request, world }) => {
  setLastResponse(world, await apiPost(request, '/shifts', {
    id: crypto.randomUUID(),
    encryptedName: uniqueName('Contract Shift'),
    startTime: '09:00',
    endTime: '17:00',
    days: [1, 2, 3, 4, 5],
    userPubkeys: [],
  }, ADMIN_NSEC))
})

// ── Security: Ban Audit Log Privacy (HIGH-W3) ───────────────────────

Given('I am authenticated as admin', async () => {
  // Admin auth is the default for all admin steps via ADMIN_NSEC — no setup needed
})

Then(
  'the audit log entry for {string} should not contain the raw phone {string}',
  async ({ request }, eventType: string, rawPhone: string) => {
    const res = await apiGet<{ entries: Array<{ eventType: string; payload: unknown }> }>(
      request,
      '/audit',
      ADMIN_NSEC,
    )
    expect(res.status).toBe(200)
    const entries = res.data.entries ?? []
    const matching = entries.filter(e => e.eventType === eventType)
    for (const entry of matching) {
      const payloadStr = JSON.stringify(entry.payload)
      expect(payloadStr).not.toContain(rawPhone)
    }
  },
)

// ── Security: Dev Endpoint Disclosure (HIGH-W4) ─────────────────────

When(
  'a client sends {string} to {string} with header {string}',
  async ({ request, world }, method: string, path: string, header: string) => {
    // No auth — testing unauthenticated access with specific custom header
    const [headerName, headerValue] = header.split(': ', 2)
    const headers: Record<string, string> = { [headerName]: headerValue }

    let res: Awaited<ReturnType<typeof request.post>>
    if (method === 'POST') {
      res = await request.post(path, { headers })
    } else if (method === 'GET') {
      res = await request.get(path, { headers })
    } else {
      throw new Error(`Unsupported method: ${method}`)
    }
    const data = res.ok() ? await res.json().catch(() => null) : null
    setLastResponse(world, { status: res.status(), data })
  },
)
