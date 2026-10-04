/**
 * Permission matrix step definitions.
 *
 * Generic parameterized steps for testing role-based access control
 * across all API endpoints. Creates one user per default role and
 * verifies expected HTTP status codes for each endpoint.
 */
import { Given, When, Before, getState, setState } from './fixtures'
// Status assertions (Then) are in assertions.steps.ts
import { getSharedState, setLastResponse } from './shared-state'
import { getScenarioState } from './common.steps'
import {
  apiGet,
  apiPost,
  apiPatch,
  apiPut,
  apiDelete,
  createVolunteerViaApi,
  createShiftViaApi,
  createBanViaApi,
  generateTestKeypair,
  uniquePhone,
  uniqueName,
} from '../../api-helpers'

const BASE_URL = process.env.TEST_HUB_URL || 'http://localhost:3000'

// ── Role-keyed user state ───────────────────────────────────────────

interface RoleUser {
  deviceKey: string
  pubkey: string
  name: string
}

interface PermMatrixState {
  roleUsers: Record<string, RoleUser>
  /** Reusable test resources created by Given steps */
  testVolunteerPubkey?: string
  deletableVolunteerPubkey?: string
  testShiftId?: string
  deletableShiftId?: string
  testBanPhone?: string
  testInviteCode?: string
  testNoteId?: string
}

const PERMISSION_MATRIX_KEY = 'permission_matrix'

function getPermMatrixState(world: Record<string, unknown>): PermMatrixState {
  return getState<PermMatrixState>(world, PERMISSION_MATRIX_KEY)
}


Before({ tags: '@backend' }, async ({ world }) => {
  const pm = { roleUsers: {} }
  setState(world, PERMISSION_MATRIX_KEY, pm)
})

// ── Role slug mapping ───────────────────────────────────────────────

function roleIdFromName(roleName: string): string {
  const map: Record<string, string> = {
    'super-admin': 'role-super-admin',
    'hub-admin': 'role-hub-admin',
    'reviewer': 'role-reviewer',
    'volunteer': 'role-volunteer',
    'reporter': 'role-reporter',
  }
  return map[roleName] ?? `role-${roleName}`
}

// ── Background: create test users ───────────────────────────────────

Given('test users exist for all default roles', async ({ request, world }) => {
  const roles = ['super-admin', 'hub-admin', 'reviewer', 'volunteer', 'reporter']
  for (const role of roles) {
    const vol = await createVolunteerViaApi(request, {
      name: `PM ${role} ${Date.now()}`,
      roleIds: [roleIdFromName(role)],
    })
    getPermMatrixState(world).roleUsers[role] = { deviceKey: vol.deviceKey, pubkey: vol.pubkey, name: vol.name }
  }
})

// ── Resource creation Given steps ───────────────────────────────────

Given('a test volunteer exists', async ({ request, world }) => {
  if (!getPermMatrixState(world).testVolunteerPubkey) {
    const vol = await createVolunteerViaApi(request, { name: `PM Target ${Date.now()}` })
    getPermMatrixState(world).testVolunteerPubkey = vol.pubkey
  }
})

Given('a deletable test volunteer exists', async ({ request, world }) => {
  // Create a fresh volunteer each time (will be deleted by the test)
  const vol = await createVolunteerViaApi(request, { name: `PM Deletable ${Date.now()}` })
  getPermMatrixState(world).deletableVolunteerPubkey = vol.pubkey
})

Given('a test shift exists', async ({ request, world }) => {
  if (!getPermMatrixState(world).testShiftId) {
    const hubId = getScenarioState(world).hubId
    const shift = await createShiftViaApi(request, { name: `PM Shift ${Date.now()}`, hubId })
    getPermMatrixState(world).testShiftId = shift.id
  }
})

Given('a deletable test shift exists', async ({ request, world }) => {
  const hubId = getScenarioState(world).hubId
  const shift = await createShiftViaApi(request, { name: `PM Del Shift ${Date.now()}`, hubId })
  getPermMatrixState(world).deletableShiftId = shift.id
})

Given('a test ban exists', async ({ request, world }) => {
  // Create a fresh ban each time (will be deleted by the test)
  const hubId = getScenarioState(world).hubId
  const ban = await createBanViaApi(request, { phone: uniquePhone(), reason: 'PM test', hubId })
  getPermMatrixState(world).testBanPhone = ban.phone
})

Given('a test invite exists', async ({ request, world, workerHub }) => {
  // Create a fresh invite each time (will be revoked by the test)
  const { data } = await apiPost<{ code: string }>(request, '/invites', {
    hubId: workerHub,
    name: `PM Invite ${Date.now()}`,
    phone: uniquePhone(),
    roleIds: ['role-volunteer'],
  })
  const d = data as Record<string, unknown> | null
  getPermMatrixState(world).testInviteCode = d?.code as string
    ?? (d?.invite as Record<string, unknown>)?.code as string
})

Given('a test note exists', async ({ request, world }) => {
  if (!getPermMatrixState(world).testNoteId) {
    // Create a note as admin (super-admin has notes:* via wildcard)
    const keypair = generateTestKeypair()
    const { data, status } = await apiPost<{ note?: { id?: string } }>(request, '/notes', {
      encryptedContent: 'test-encrypted-content',
      callId: `pm-test-note-${Date.now()}`,
      authorEnvelope: {
        ct: 'test-key-data',
        enc: keypair.pubkey,
      },
    })
    if (status === 200 || status === 201) {
      getPermMatrixState(world).testNoteId = data.note?.id
    }
  }
})

// ── Generic request steps ───────────────────────────────────────────

When('the {string} user sends {string} to {string}', async ({ request, world }, role: string, method: string, path: string) => {
  const user = getPermMatrixState(world).roleUsers[role]
  if (!user) throw new Error(`No test user for role "${role}"`)

  getSharedState(world).lastResponse = await sendRequest(request, method, path, user.deviceKey)
})

When('the {string} user sends {string} to {string} with valid volunteer body', async ({ request, world }, role: string, _method: string, _path: string) => {
  const user = getPermMatrixState(world).roleUsers[role]
  if (!user) throw new Error(`No test user for role "${role}"`)

  const kp = generateTestKeypair()
  getSharedState(world).lastResponse = await apiPost(request, '/users', {
    pubkey: kp.pubkey,
    name: uniqueName('PM Vol'),
    phone: uniquePhone(),
    roleIds: ['role-volunteer'],
  }, user.deviceKey)
})

When('the {string} user sends {string} to the test volunteer endpoint with update body', async ({ request, world }, role: string, _method: string) => {
  const user = getPermMatrixState(world).roleUsers[role]
  if (!user) throw new Error(`No test user for role "${role}"`)

  getSharedState(world).lastResponse = await apiPatch(request, `/users/${getPermMatrixState(world).testVolunteerPubkey}`, {
    name: uniqueName('PM Updated'),
  }, user.deviceKey)
})

When('the {string} user sends {string} to the deletable volunteer endpoint', async ({ request, world }, role: string, _method: string) => {
  const user = getPermMatrixState(world).roleUsers[role]
  if (!user) throw new Error(`No test user for role "${role}"`)

  getSharedState(world).lastResponse = await apiDelete(request, `/users/${getPermMatrixState(world).deletableVolunteerPubkey}`, user.deviceKey)
})

When('the {string} user sends {string} to {string} with valid shift body', async ({ request, world }, role: string, _method: string, _path: string) => {
  const user = getPermMatrixState(world).roleUsers[role]
  if (!user) throw new Error(`No test user for role "${role}"`)

  const hubId = getScenarioState(world).hubId
  getSharedState(world).lastResponse = await apiPost(request, hubId ? `/hubs/${hubId}/shifts` : '/shifts', {
    id: crypto.randomUUID(),
    encryptedName: uniqueName('PM Shift'),
    startTime: '09:00',
    endTime: '17:00',
    days: [1, 2, 3, 4, 5],
    userPubkeys: [],
  }, user.deviceKey)
})

When('the {string} user sends {string} to the test shift endpoint with shift update body', async ({ request, world }, role: string, _method: string) => {
  const user = getPermMatrixState(world).roleUsers[role]
  if (!user) throw new Error(`No test user for role "${role}"`)

  const hubId = getScenarioState(world).hubId
  getSharedState(world).lastResponse = await apiPatch(request, `/hubs/${hubId}/shifts/${getPermMatrixState(world).testShiftId}`, {
    encryptedName: uniqueName('PM Shift Updated'),
  }, user.deviceKey)
})

When('the {string} user sends {string} to the deletable shift endpoint', async ({ request, world }, role: string, _method: string) => {
  const user = getPermMatrixState(world).roleUsers[role]
  if (!user) throw new Error(`No test user for role "${role}"`)

  const hubId = getScenarioState(world).hubId
  getSharedState(world).lastResponse = await apiDelete(request, `/hubs/${hubId}/shifts/${getPermMatrixState(world).deletableShiftId}`, user.deviceKey)
})

When('the {string} user sends {string} to {string} with fallback body', async ({ request, world }, role: string, _method: string, _path: string) => {
  const user = getPermMatrixState(world).roleUsers[role]
  if (!user) throw new Error(`No test user for role "${role}"`)

  getSharedState(world).lastResponse = await apiPut(request, '/shifts/fallback', {
    userPubkeys: [],
  }, user.deviceKey)
})

When('the {string} user sends {string} to {string} with valid ban body', async ({ request, world }, role: string, _method: string, _path: string) => {
  const user = getPermMatrixState(world).roleUsers[role]
  if (!user) throw new Error(`No test user for role "${role}"`)

  getSharedState(world).lastResponse = await apiPost(request, '/bans', {
    phone: uniquePhone(),
    reason: 'PM test ban',
  }, user.deviceKey)
})

When('the {string} user sends {string} to {string} with valid bulk ban body', async ({ request, world }, role: string, _method: string, _path: string) => {
  const user = getPermMatrixState(world).roleUsers[role]
  if (!user) throw new Error(`No test user for role "${role}"`)

  getSharedState(world).lastResponse = await apiPost(request, '/bans/bulk', {
    phones: [uniquePhone()],
    reason: 'PM bulk test',
  }, user.deviceKey)
})

When('the {string} user sends {string} to the test ban endpoint', async ({ request, world }, role: string, _method: string) => {
  const user = getPermMatrixState(world).roleUsers[role]
  if (!user) throw new Error(`No test user for role "${role}"`)

  getSharedState(world).lastResponse = await apiDelete(
    request,
    `/bans/${encodeURIComponent(getPermMatrixState(world).testBanPhone!)}`,
    user.deviceKey,
  )
})

When('the {string} user sends {string} to {string} with valid note body', async ({ request, world }, role: string, _method: string, _path: string) => {
  const user = getPermMatrixState(world).roleUsers[role]
  if (!user) throw new Error(`No test user for role "${role}"`)

  getSharedState(world).lastResponse = await apiPost(request, '/notes', {
    encryptedContent: 'pm-test-encrypted',
    callId: `pm-note-${Date.now()}`,
    authorEnvelope: {
      ct: 'test-key',
      enc: user.pubkey,
    },
  }, user.deviceKey)
})

When('the {string} user sends {string} to the test note reply endpoint with reply body', async ({ request, world }, role: string, _method: string) => {
  const user = getPermMatrixState(world).roleUsers[role]
  if (!user) throw new Error(`No test user for role "${role}"`)

  getSharedState(world).lastResponse = await apiPost(request, `/notes/${getPermMatrixState(world).testNoteId}/replies`, {
    encryptedContent: 'pm-test-reply',
    readerEnvelopes: [{
      pubkey: user.pubkey,
      ct: 'test-key',
      enc: user.pubkey,
    }],
  }, user.deviceKey)
})

When('the {string} user sends {string} to {string} with valid invite body', async ({ request, world, workerHub }, role: string, _method: string, _path: string) => {
  const user = getPermMatrixState(world).roleUsers[role]
  if (!user) throw new Error(`No test user for role "${role}"`)

  getSharedState(world).lastResponse = await apiPost(request, '/invites', {
    hubId: workerHub,
    name: uniqueName('PM Invite'),
    phone: uniquePhone(),
    roleIds: ['role-volunteer'],
  }, user.deviceKey)
})

When('the {string} user sends {string} to the test invite endpoint', async ({ request, world }, role: string, _method: string) => {
  const user = getPermMatrixState(world).roleUsers[role]
  if (!user) throw new Error(`No test user for role "${role}"`)

  getSharedState(world).lastResponse = await apiDelete(request, `/invites/${getPermMatrixState(world).testInviteCode}`, user.deviceKey)
})

When('the {string} user sends {string} to {string} with spam settings body', async ({ request, world }, role: string, _method: string, _path: string) => {
  const user = getPermMatrixState(world).roleUsers[role]
  if (!user) throw new Error(`No test user for role "${role}"`)

  getSharedState(world).lastResponse = await apiPatch(request, '/settings/spam', {
    voiceCaptchaEnabled: false,
  }, user.deviceKey)
})

When('the {string} user sends {string} to {string} with telephony body', async ({ request, world }, role: string, _method: string, _path: string) => {
  const user = getPermMatrixState(world).roleUsers[role]
  if (!user) throw new Error(`No test user for role "${role}"`)

  getSharedState(world).lastResponse = await apiPatch(request, '/settings/telephony-provider', {
    type: 'twilio',
    accountSid: 'AC' + '0'.repeat(32), // HIGH-W5: AC + 32 hex chars (obviously fake test value)
    authToken: 'test_token',
    phoneNumber: '+15551234567',
  }, user.deviceKey)
})

When('the {string} user sends {string} to {string} with messaging body', async ({ request, world }, role: string, _method: string, _path: string) => {
  const user = getPermMatrixState(world).roleUsers[role]
  if (!user) throw new Error(`No test user for role "${role}"`)

  getSharedState(world).lastResponse = await apiPatch(request, '/settings/messaging', {
    smsEnabled: false,
  }, user.deviceKey)
})

When('the {string} user sends {string} to {string} with IVR body', async ({ request, world }, role: string, _method: string, _path: string) => {
  const user = getPermMatrixState(world).roleUsers[role]
  if (!user) throw new Error(`No test user for role "${role}"`)

  getSharedState(world).lastResponse = await apiPatch(request, '/settings/ivr-languages', {
    enabledLanguages: ['en'],
  }, user.deviceKey)
})

When('the {string} user sends {string} to {string} with transcription body', async ({ request, world }, role: string, _method: string, _path: string) => {
  const user = getPermMatrixState(world).roleUsers[role]
  if (!user) throw new Error(`No test user for role "${role}"`)

  getSharedState(world).lastResponse = await apiPatch(request, '/settings/transcription', {
    globalEnabled: false,
  }, user.deviceKey)
})

When('the {string} user sends {string} to {string} with custom fields body', async ({ request, world }, role: string, _method: string, _path: string) => {
  const user = getPermMatrixState(world).roleUsers[role]
  if (!user) throw new Error(`No test user for role "${role}"`)

  getSharedState(world).lastResponse = await apiPut(request, '/settings/custom-fields', {
    fields: [],
  }, user.deviceKey)
})

When('the {string} user sends {string} to {string} with call settings body', async ({ request, world }, role: string, _method: string, _path: string) => {
  const user = getPermMatrixState(world).roleUsers[role]
  if (!user) throw new Error(`No test user for role "${role}"`)

  getSharedState(world).lastResponse = await apiPatch(request, '/settings/call', {
    queueTimeoutSeconds: 120,
  }, user.deviceKey)
})

When('the {string} user sends {string} to {string} with webauthn body', async ({ request, world }, role: string, _method: string, _path: string) => {
  const user = getPermMatrixState(world).roleUsers[role]
  if (!user) throw new Error(`No test user for role "${role}"`)

  getSharedState(world).lastResponse = await apiPatch(request, '/settings/webauthn', {
    requireForAdmins: false,
  }, user.deviceKey)
})

When('the {string} user sends {string} to {string} with TTL body', async ({ request, world }, role: string, _method: string, _path: string) => {
  const user = getPermMatrixState(world).roleUsers[role]
  if (!user) throw new Error(`No test user for role "${role}"`)

  getSharedState(world).lastResponse = await apiPatch(request, '/settings/ttl', {
    captchaChallenge: 600000,
  }, user.deviceKey)
})

When('the {string} user sends {string} to {string} with report type body', async ({ request, world }, role: string, _method: string, _path: string) => {
  const user = getPermMatrixState(world).roleUsers[role]
  if (!user) throw new Error(`No test user for role "${role}"`)

  getSharedState(world).lastResponse = await apiPost(request, '/settings/report-types', {
    name: uniqueName('PM ReportType'),
  }, user.deviceKey)
})

When('the {string} user sends {string} to {string} with valid role body', async ({ request, world }, role: string, _method: string, _path: string) => {
  const user = getPermMatrixState(world).roleUsers[role]
  if (!user) throw new Error(`No test user for role "${role}"`)

  getSharedState(world).lastResponse = await apiPost(request, '/settings/roles', {
    name: uniqueName('PM Role'),
    slug: `pm-role-${Date.now()}`,
    permissions: ['notes:read-own'],
    description: 'PM test role',
  }, user.deviceKey)
})

When('the {string} user sends {string} to {string} with share body', async ({ request, world }, role: string, _method: string, _path: string) => {
  const user = getPermMatrixState(world).roleUsers[role]
  if (!user) throw new Error(`No test user for role "${role}"`)

  // Extract file ID from path, send share request
  getSharedState(world).lastResponse = await apiPost(request, '/files/test-file-id/share', {
    envelope: { pubkey: user.pubkey, encryptedFileKey: 'test', enc: user.pubkey },
    encryptedMetadata: { pubkey: user.pubkey, encryptedContent: 'test', enc: user.pubkey },
  }, user.deviceKey)
})

When('the {string} user sends {string} to {string} with valid hub body', async ({ request, world }, role: string, _method: string, _path: string) => {
  const user = getPermMatrixState(world).roleUsers[role]
  if (!user) throw new Error(`No test user for role "${role}"`)

  getSharedState(world).lastResponse = await apiPost(request, '/hubs', {
    name: uniqueName('PM Hub'),
    description: 'PM test hub',
  }, user.deviceKey)
})

When('the {string} user sends {string} to {string} with valid report body', async ({ request, world }, role: string, _method: string, _path: string) => {
  const user = getPermMatrixState(world).roleUsers[role]
  if (!user) throw new Error(`No test user for role "${role}"`)

  getSharedState(world).lastResponse = await apiPost(request, '/reports', {
    title: uniqueName('PM Report'),
    category: 'general',
    encryptedContent: 'pm-test-encrypted-report',
    readerEnvelopes: [{
      pubkey: user.pubkey,
      ct: 'test-key',
      enc: user.pubkey,
    }],
  }, user.deviceKey)
})

// ── Unauthenticated request step ────────────────────────────────────

When('an unauthenticated request is sent to {string} {string}', async ({request, world}, method: string, path: string) => {
  const url = `${BASE_URL}${path}`
  let res
  switch (method) {
    case 'GET':
      res = await request.get(url, { headers: { 'Content-Type': 'application/json' } })
      break
    case 'POST':
      res = await request.post(url, {
        headers: { 'Content-Type': 'application/json' },
        data: {},
      })
      break
    case 'PATCH':
      res = await request.patch(url, {
        headers: { 'Content-Type': 'application/json' },
        data: {},
      })
      break
    case 'PUT':
      res = await request.put(url, {
        headers: { 'Content-Type': 'application/json' },
        data: {},
      })
      break
    case 'DELETE':
      res = await request.delete(url, { headers: { 'Content-Type': 'application/json' } })
      break
    default:
      throw new Error(`Unknown method: ${method}`)
  }
  setLastResponse(world, { status: res.status(), data: null })
})

// Status assertions are in assertions.steps.ts (shared across all features)

// ── Helper: send generic request ────────────────────────────────────

async function sendRequest(
  request: import('@playwright/test').APIRequestContext,
  method: string,
  path: string,
  deviceKey: string,
): Promise<{ status: number; data: unknown }> {
  // Strip /api prefix if present — api helpers add it
  const apiPath = path.startsWith('/api') ? path.slice(4) : path
  switch (method) {
    case 'GET':
      return apiGet(request, apiPath, deviceKey)
    case 'POST':
      return apiPost(request, apiPath, {}, deviceKey)
    case 'PATCH':
      return apiPatch(request, apiPath, {}, deviceKey)
    case 'PUT':
      return apiPut(request, apiPath, {}, deviceKey)
    case 'DELETE':
      return apiDelete(request, apiPath, deviceKey)
    default:
      throw new Error(`Unknown method: ${method}`)
  }
}
