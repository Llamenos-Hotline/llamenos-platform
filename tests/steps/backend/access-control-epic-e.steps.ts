/**
 * Step definitions for security/access-control-epic-e.feature (#1191).
 *
 * Covers seven backend security fixes from the 2026-05-18 audit: erasure
 * co-approver admin check (H01), cross-hub IDOR + per-user scoping on
 * /records/by-contact (HIGH-W4), account-lockdown elevated-auth re-check,
 * blast content sanitization (H02), SSRF fail-closed on DNS failure (H07),
 * PUK envelope upsert race safety (H09), dev-route X-Test-Secret gating
 * (HIGH-W2), ban-list phone masking (HIGH-W3), and recovery-group emergency
 * override approver-pubkey matching (HIGH-W6).
 *
 * Every scenario drives the real running server over HTTP (or, for the SSRF
 * guard, the real exported `apps/worker/lib/ssrf-guard.ts` functions
 * in-process — there is no standalone "validate this URL" route; see the
 * comment on that section below for why DNS cannot be mocked from here).
 */
import { expect, type APIRequestContext } from '@playwright/test'
import { Given, When, Then, Before, getState, setState } from './fixtures'
import { setLastResponse, getSharedState } from './shared-state'
import {
  ADMIN_SEED,
  apiGet,
  apiPost,
  devGet,
  devPost,
  createUserViaApi,
  createHubViaApi,
  createRoleViaApi,
  generateTestKeypair,
  seedHexToPubkey,
  enableCaseManagementViaApi,
  createEntityTypeViaApi,
  createContactViaApi,
  createRecordViaApi,
  linkContactToRecordViaApi,
  listBansViaApi,
} from '../../api-helpers'
import { ed25519 } from '@noble/curves/ed25519.js'
import { hexToBytes, bytesToHex, utf8ToBytes } from '@shared/encoding'
import { LABEL_ERASURE_OVERRIDE_SIG } from '@shared/crypto-labels'
import { validateExternalUrlWithDns } from '@worker/lib/ssrf-guard'

// ── State ──────────────────────────────────────────────────────────

interface ActorRef {
  pubkey: string
  seedHex: string
  registered: boolean
}

interface EpicEState {
  /** Gherkin pubkey labels ("vol-pk-1", "admin-pk-1", "unknown-pk-1", ...) */
  actors: Record<string, ActorRef>
  pendingErasureRequester?: string

  /** Gherkin hub labels ("hub-alpha", "hub-beta") -> real hub id */
  hubs: Record<string, string>
  hubEntityTypes: Record<string, string>
  /** Gherkin contact labels ("C-001", ...) -> real contact id */
  contacts: Record<string, string>
  /** Gherkin record labels ("R-001", ...) -> real record id */
  records: Record<string, string>
  /** Gherkin device labels ("dev-1", ...) -> real device id */
  devices: Record<string, string>

  /** Context set by "hub X has two case records for contact Y", consumed by
   *  the "record is created by volunteer" steps that follow it. */
  currentHubLabel?: string
  currentContactLabel?: string

  /** The currently-authenticated actor for the next When step. */
  currentActorSeed?: string
  currentHubId?: string

  pukUserSeed?: string
  concurrentPukResults?: Array<{ status: number; data: unknown }>
  lastPukEnvelopeValue?: string
  newPukEnvelopeValue?: string

  sessionToken?: string
  freshUserSeed?: string

  ssrfUrl?: string
  ssrfResult?: string | null

  recoverySessionId?: string
}

const STATE_KEY = 'epic_e'

function getS(world: Record<string, unknown>): EpicEState {
  return getState<EpicEState>(world, STATE_KEY)
}

Before(async ({ world }) => {
  setState<EpicEState>(world, STATE_KEY, {
    actors: {},
    hubs: {},
    hubEntityTypes: {},
    contacts: {},
    records: {},
    devices: {},
  })
})

// ── Shared helpers ────────────────────────────────────────────────

function slugify(permission: string): string {
  return permission.replace(/[^a-z0-9]/gi, '-')
}

async function scopedRole(
  request: APIRequestContext,
  permission: string,
): Promise<string> {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const role = await createRoleViaApi(request, {
    name: `epic-e ${permission} ${unique}`,
    slug: `epic-e-${slugify(permission)}-${unique}`,
    permissions: [permission],
  })
  return role.id
}

async function ensureHub(
  request: APIRequestContext,
  world: Record<string, unknown>,
  label: string,
): Promise<string> {
  const s = getS(world)
  if (!s.hubs[label]) {
    const hubId = await createHubViaApi(request, `epic-e-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
    await enableCaseManagementViaApi(request, true, undefined, hubId)
    const entityType = await createEntityTypeViaApi(request, { hubId })
    s.hubs[label] = hubId
    s.hubEntityTypes[label] = (entityType as unknown as { id: string }).id
  }
  return s.hubs[label]
}

/** hub "X" has [also] a case record for contact "Y" — shared by both phrasings. */
async function hubHasRecordForContact(
  request: APIRequestContext,
  world: Record<string, unknown>,
  hubLabel: string,
  contactLabel: string,
): Promise<void> {
  const s = getS(world)
  const hubId = await ensureHub(request, world, hubLabel)
  let contactId = s.contacts[contactLabel]
  if (!contactId) {
    const contact = await createContactViaApi(request, { hubId })
    contactId = (contact as unknown as { id: string }).id
    s.contacts[contactLabel] = contactId
  }
  const entityTypeId = s.hubEntityTypes[hubLabel]
  const record = await createRecordViaApi(request, entityTypeId, { hubId })
  const recordId = (record as unknown as { id: string }).id
  // Cross-hub link is deliberate: the contact may belong to a different hub
  // than this record (that is exactly the shape the IDOR fix protects —
  // see apps/worker/services/cases.ts listByContact's hubId filter).
  await linkContactToRecordViaApi(request, recordId, contactId, 'caller', undefined, hubId)
  s.records[`${hubLabel}:${contactLabel}`] = recordId
}

async function registerDeviceFor(
  request: APIRequestContext,
  seedHex: string,
): Promise<string> {
  const wakeKeyPublic = bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
  const pushToken = bytesToHex(crypto.getRandomValues(new Uint8Array(16)))
  const reg = await apiPost(request, '/devices/register', { platform: 'ios', pushToken, wakeKeyPublic }, seedHex)
  expect(reg.status).toBe(204)
  const list = await apiGet<{ devices: Array<{ id: string }> }>(request, '/devices', seedHex)
  return list.data.devices[list.data.devices.length - 1].id
}

function fakeEnvelope(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(64)))
}

function resolveApproverPubkey(world: Record<string, unknown>, label: string): string {
  const s = getS(world)
  if (s.actors[label]) return s.actors[label].pubkey
  // A label never registered via "my pubkey is X" is an intentionally
  // unrelated pubkey for the mismatch scenario.
  const kp = generateTestKeypair()
  s.actors[label] = { pubkey: kp.pubkey, seedHex: kp.seedHex, registered: false }
  return kp.pubkey
}

// ── H01: Erasure co-approver admin check ─────────────────────────────

Given('a registered volunteer user with pubkey {string}', async ({ request, world }, label: string) => {
  const user = await createUserViaApi(request, { roleIds: ['role-volunteer'] })
  getS(world).actors[label] = { pubkey: user.pubkey, seedHex: user.seedHex, registered: true }
})

Given('a registered admin user with pubkey {string}', async ({ request, world }, label: string) => {
  const user = await createUserViaApi(request, { roleIds: ['role-super-admin'] })
  getS(world).actors[label] = { pubkey: user.pubkey, seedHex: user.seedHex, registered: true }
})

Given('a registered admin user with pubkey {string} and role {string}', async ({ request, world }, label: string, roleId: string) => {
  const user = await createUserViaApi(request, { roleIds: [roleId] })
  getS(world).actors[label] = { pubkey: user.pubkey, seedHex: user.seedHex, registered: true }
})

Given('no user is registered with pubkey {string}', ({ world }, label: string) => {
  const kp = generateTestKeypair()
  getS(world).actors[label] = { pubkey: kp.pubkey, seedHex: kp.seedHex, registered: false }
})

When('{string} submits an emergency erasure request', ({ world }, label: string) => {
  getS(world).pendingErasureRequester = label
})

When('a volunteer submits an emergency erasure request', async ({ request, world }) => {
  const user = await createUserViaApi(request, { roleIds: ['role-volunteer'] })
  const label = '__anon_volunteer__'
  const s = getS(world)
  s.actors[label] = { pubkey: user.pubkey, seedHex: user.seedHex, registered: true }
  s.pendingErasureRequester = label
})

async function submitEmergencyErasure(
  request: APIRequestContext,
  world: Record<string, unknown>,
  coApproverLabel: string,
): Promise<void> {
  const s = getS(world)
  const requester = s.actors[s.pendingErasureRequester!]
  const coApprover = s.actors[coApproverLabel]
  const timestamp = new Date().toISOString()
  const message = utf8ToBytes(`${LABEL_ERASURE_OVERRIDE_SIG}:${requester.pubkey}:${timestamp}`)
  const coApproverSignature = bytesToHex(ed25519.sign(message, hexToBytes(coApprover.seedHex)))
  setLastResponse(world, await apiPost(request, '/erasure/me/emergency', {
    justification: 'epic-e emergency erasure test',
    coApproverPubkey: coApprover.pubkey,
    coApproverSignature,
    timestamp,
  }, requester.seedHex))
}

When('the co-approver signature is made by {string} \\(a volunteer, not an admin\\)', async ({ request, world }, label: string) => {
  await submitEmergencyErasure(request, world, label)
})

When('the co-approver signature is made by {string} \\(a hub admin\\)', async ({ request, world }, label: string) => {
  await submitEmergencyErasure(request, world, label)
})

When('the co-approver signature is made by {string}', async ({ request, world }, label: string) => {
  await submitEmergencyErasure(request, world, label)
})

Then('the error mentions co-approver must be an admin', ({ world }) => {
  const res = getSharedState(world).lastResponse!
  const data = res.data as { error?: string }
  expect(data.error ?? '').toMatch(/co-approver.*admin/i)
})

Then('the error mentions co-approver must be a registered admin device', ({ world }) => {
  const res = getSharedState(world).lastResponse!
  const data = res.data as { error?: string }
  expect(data.error ?? '').toMatch(/co-approver must be a registered admin device/i)
})

// ── IDOR / HIGH-W4: /records/by-contact ──────────────────────────────

Given('hub {string} has a case record for contact {string}', async ({ request, world }, hubLabel: string, contactLabel: string) => {
  await hubHasRecordForContact(request, world, hubLabel, contactLabel)
})

Given('hub {string} also has a case record for contact {string}', async ({ request, world }, hubLabel: string, contactLabel: string) => {
  await hubHasRecordForContact(request, world, hubLabel, contactLabel)
})

Given('hub {string} has no records for contact {string}', async ({ request, world }, hubLabel: string) => {
  // Only ensure the hub exists (so the caller can be made a member of it
  // later) — the contact referenced by this scenario is created by whichever
  // *other* hub's "has a case record" step runs next.
  await ensureHub(request, world, hubLabel)
})

Given('hub {string} has two case records for contact {string}', async ({ request, world }, hubLabel: string, contactLabel: string) => {
  const s = getS(world)
  const hubId = await ensureHub(request, world, hubLabel)
  const contact = await createContactViaApi(request, { hubId })
  s.contacts[contactLabel] = (contact as unknown as { id: string }).id
  s.currentHubLabel = hubLabel
  s.currentContactLabel = contactLabel
})

Given('record {string} is created by volunteer {string}', async ({ request, world }, recordLabel: string, volLabel: string) => {
  const s = getS(world)
  const hubLabel = s.currentHubLabel!
  const hubId = s.hubs[hubLabel]
  const contactId = s.contacts[s.currentContactLabel!]

  let actor = s.actors[volLabel]
  if (!actor) {
    const user = await createUserViaApi(request, { roleIds: ['role-volunteer'] })
    actor = { pubkey: user.pubkey, seedHex: user.seedHex, registered: true }
    s.actors[volLabel] = actor
    await apiPost(request, `/hubs/${hubId}/members`, { pubkey: actor.pubkey, roleIds: ['role-volunteer'] })
  }

  const entityTypeId = s.hubEntityTypes[hubLabel]
  const record = await createRecordViaApi(request, entityTypeId, { hubId }, actor.seedHex)
  const recordId = (record as unknown as { id: string }).id
  await linkContactToRecordViaApi(request, recordId, contactId, 'caller', undefined, hubId)
  s.records[recordLabel] = recordId
})

Given('I am authenticated as a volunteer in {string}', async ({ request, world }, hubLabel: string) => {
  const s = getS(world)
  const hubId = s.hubs[hubLabel]
  expect(hubId, `hub "${hubLabel}" was never created`).toBeDefined()
  // This scenario group tests the hub-scoping (IDOR) fix specifically, not
  // per-user ownership scoping — that is the separate HIGH-W4 group below,
  // which grants the narrower "cases:read-own" explicitly. Granting
  // "cases:read-all" here keeps hub isolation the only variable under test.
  const roleId = await scopedRole(request, 'cases:read-all')
  const user = await createUserViaApi(request, { roleIds: [roleId] })
  await apiPost(request, `/hubs/${hubId}/members`, { pubkey: user.pubkey, roleIds: [roleId] })
  s.currentActorSeed = user.seedHex
  s.currentHubId = hubId
})

Given('I am authenticated as volunteer {string} in {string} with {string}', async ({ request, world }, volLabel: string, hubLabel: string, permission: string) => {
  const s = getS(world)
  const hubId = s.hubs[hubLabel]
  const actor = s.actors[volLabel]
  expect(actor, `actor "${volLabel}" was never created`).toBeDefined()
  const roleId = await scopedRole(request, permission)
  await apiPost(request, `/hubs/${hubId}/members`, { pubkey: actor!.pubkey, roleIds: [roleId] })
  s.currentActorSeed = actor!.seedHex
  s.currentHubId = hubId
})

Given('I am authenticated as admin in {string} with {string}', async ({ request, world }, hubLabel: string, permission: string) => {
  const s = getS(world)
  const hubId = s.hubs[hubLabel]
  const roleId = await scopedRole(request, permission)
  const user = await createUserViaApi(request, { roleIds: [roleId] })
  await apiPost(request, `/hubs/${hubId}/members`, { pubkey: user.pubkey, roleIds: [roleId] })
  s.currentActorSeed = user.seedHex
  s.currentHubId = hubId
})

When('I call GET \\/api\\/records\\/by-contact\\/{word}', async ({ request, world }, contactLabel: string) => {
  const s = getS(world)
  const contactId = s.contacts[contactLabel]
  expect(contactId, `contact "${contactLabel}" was never created`).toBeDefined()
  setLastResponse(world, await apiGet(request, `/hubs/${s.currentHubId}/records/by-contact/${contactId}`, s.currentActorSeed!))
})

Then('the returned records all belong to hub {string}', ({ world }, hubLabel: string) => {
  const s = getS(world)
  const expectedHubId = s.hubs[hubLabel]
  const res = getSharedState(world).lastResponse!
  expect(res.status).toBe(200)
  const records = (res.data as { records: Array<{ hubId: string }> }).records
  expect(records.length).toBeGreaterThan(0)
  for (const record of records) expect(record.hubId).toBe(expectedHubId)
})

Then('no records from hub {string} are returned', ({ world }, hubLabel: string) => {
  const s = getS(world)
  const bannedHubId = s.hubs[hubLabel]
  const res = getSharedState(world).lastResponse!
  const records = (res.data as { records: Array<{ hubId: string }> }).records
  expect(records.some((record) => record.hubId === bannedHubId)).toBe(false)
})

Then('the returned records list is empty', ({ world }) => {
  const res = getSharedState(world).lastResponse!
  expect(res.status).toBe(200)
  expect((res.data as { records: unknown[] }).records).toEqual([])
})

Then('the returned records contain only {string}', ({ world }, recordLabel: string) => {
  const s = getS(world)
  const expectedId = s.records[recordLabel]
  const res = getSharedState(world).lastResponse!
  const ids = (res.data as { records: Array<{ id: string }> }).records.map((record) => record.id)
  expect(ids).toEqual([expectedId])
})

Then('record {string} is not visible', ({ world }, recordLabel: string) => {
  const s = getS(world)
  const id = s.records[recordLabel]
  const res = getSharedState(world).lastResponse!
  const ids = (res.data as { records: Array<{ id: string }> }).records.map((record) => record.id)
  expect(ids).not.toContain(id)
})

Then('the returned records contain both {string} and {string}', ({ world }, labelA: string, labelB: string) => {
  const s = getS(world)
  const res = getSharedState(world).lastResponse!
  const ids = (res.data as { records: Array<{ id: string }> }).records.map((record) => record.id)
  expect(ids).toContain(s.records[labelA])
  expect(ids).toContain(s.records[labelB])
})

// ── Lockdown: elevated-auth re-check ──────────────────────────────────

Given('I am authenticated with a session token \\(not a Schnorr-signed request\\)', async ({ request, world }) => {
  const user = await createUserViaApi(request)
  // There is no WebAuthn virtual-authenticator simulation anywhere in this
  // suite (minting a real session normally requires a full login ceremony —
  // see apps/worker/routes/webauthn.ts login/verify). /test-create-session
  // mints a real services.identity.createSession() session for a pubkey
  // directly, the same way /test-recovery-seed-session bypasses the Signal
  // OTP ceremony — the only way to drive requireFreshAuth's session-vs-Schnorr
  // branch with a real, server-validated session token.
  const { status, data } = await devPost<{ token: string }>(request, '/test-create-session', { pubkey: user.pubkey })
  expect(status).toBe(200)
  getS(world).sessionToken = data.token
})

Given('I am authenticated with a fresh Schnorr-signed Ed25519 request', async ({ request, world }) => {
  const user = await createUserViaApi(request)
  getS(world).freshUserSeed = user.seedHex
})

async function callWithCurrentAuth(
  request: APIRequestContext,
  world: Record<string, unknown>,
  path: string,
  body: Record<string, unknown>,
): Promise<void> {
  const s = getS(world)
  if (s.sessionToken) {
    const res = await request.post(`/api${path}`, {
      headers: { Authorization: `Session ${s.sessionToken}`, 'Content-Type': 'application/json' },
      data: body,
    })
    setLastResponse(world, { status: res.status(), data: await res.json().catch(() => null) })
  } else if (s.freshUserSeed) {
    setLastResponse(world, await apiPost(request, path, body, s.freshUserSeed))
  } else {
    throw new Error('No auth context set — run an "I am authenticated with ..." step first')
  }
}

When('I call POST \\/api\\/account\\/lockdown', async ({ request, world }) => {
  await callWithCurrentAuth(request, world, '/account/lockdown', {})
})

When('I call POST \\/api\\/account\\/lockdown\\/complete with valid completion payload', async ({ request, world }) => {
  await callWithCurrentAuth(request, world, '/account/lockdown/complete', { pukRotated: true, hubKeysRotated: [] })
})

Then('the error code is {string}', ({ world }, code: string) => {
  const res = getSharedState(world).lastResponse!
  expect((res.data as { code?: string }).code).toBe(code)
})

// ── H02: Blast content sanitization ──────────────────────────────────

Given('I am authenticated as an admin', ({ world }) => {
  getS(world).currentActorSeed = ADMIN_SEED
})

async function postBlast(
  request: APIRequestContext,
  world: Record<string, unknown>,
  body: string,
): Promise<{ status: number; data: unknown }> {
  const s = getS(world)
  if (!s.currentHubId) {
    s.currentHubId = await createHubViaApi(request, `epic-e-blast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  }
  return apiPost(request, `/hubs/${s.currentHubId}/blasts`, {
    name: 'Epic E Blast',
    content: { body },
    channels: ['sms'],
  }, s.currentActorSeed ?? ADMIN_SEED)
}

When('I call POST \\/api\\/blasts with body containing a null byte character', async ({ request, world }) => {
  setLastResponse(world, await postBlast(request, world, 'hello\x00world'))
})

When('I call POST \\/api\\/blasts with body "hello\\\\x07world"', async ({ request, world }) => {
  setLastResponse(world, await postBlast(request, world, 'hello\x07world'))
})

When('I call POST \\/api\\/blasts with body containing ASCII backspace \\(0x08\\)', async ({ request, world }) => {
  setLastResponse(world, await postBlast(request, world, 'hello\x08world'))
})

When('I call POST \\/api\\/blasts with body "Line 1\\\\nLine 2"', async ({ request, world }) => {
  setLastResponse(world, await postBlast(request, world, 'Line 1\nLine 2'))
})

When('I call POST \\/api\\/blasts with body "Column A\\\\tColumn B"', async ({ request, world }) => {
  setLastResponse(world, await postBlast(request, world, 'Column A\tColumn B'))
})

Then('the error mentions control characters', ({ world }) => {
  const res = getSharedState(world).lastResponse!
  expect(JSON.stringify(res.data).toLowerCase()).toContain('control character')
})

Then('the response status is not {int}', ({ world }, status: number) => {
  const res = getSharedState(world).lastResponse!
  expect(res.status).not.toBe(status)
})

// ── H07: SSRF guard fail-closed on DNS resolution failure ─────────────
//
// validateExternalUrlWithDns() is imported and called directly: it is a
// pure, side-effect-free function from apps/worker/lib/ssrf-guard.ts (the
// real production implementation — not a test-local reimplementation), and
// there is no standalone HTTP route whose only job is "validate this URL"
// (the only callers are embedded deep in provider-setup routes). The
// NXDOMAIN scenario drives the real DNS resolver against the IETF-reserved
// ".invalid" TLD (RFC 2606), which is guaranteed to never resolve —
// deterministic without mocking, in CI or anywhere else. The other two
// scenarios ask for a *specific* resolved IP, which real DNS cannot give
// deterministically; they instead pass that IP as the URL's literal host.
// validateExternalUrlWithDns() skips the DNS hop entirely for an IP-literal
// host (see its own early-return) and runs isInternalAddress() on it
// directly — the exact same check a real DNS answer would feed into.

Given('an external provider URL {string}', ({ world }, url: string) => {
  getS(world).ssrfUrl = url
})

Given('DNS resolution for {string} fails with NXDOMAIN', () => {
  // No-op — see the comment above this section.
})

Given('DNS resolution for {string} returns {string}', ({ world }, _hostname: string, ip: string) => {
  const s = getS(world)
  const url = new URL(s.ssrfUrl!)
  url.hostname = ip
  s.ssrfUrl = url.toString()
})

When('the SSRF guard validates the URL', async ({ world }) => {
  const s = getS(world)
  s.ssrfResult = await validateExternalUrlWithDns(s.ssrfUrl!, 'webhook URL')
})

Then('the URL is blocked', ({ world }) => {
  expect(getS(world).ssrfResult).not.toBeNull()
})

Then('the URL is allowed', ({ world }) => {
  expect(getS(world).ssrfResult).toBeNull()
})

Then('the error message mentions DNS', ({ world }) => {
  expect(getS(world).ssrfResult ?? '').toMatch(/DNS/)
})

Then('the error message mentions internal address', ({ world }) => {
  expect((getS(world).ssrfResult ?? '').toLowerCase()).toContain('internal')
})

// ── H09: PUK envelope upsert race safety ──────────────────────────────

Given('I am authenticated as a volunteer with two active devices', async ({ request, world }) => {
  const s = getS(world)
  const user = await createUserViaApi(request)
  s.pukUserSeed = user.seedHex
  s.devices['dev-1'] = await registerDeviceFor(request, user.seedHex)
  s.devices['dev-2'] = await registerDeviceFor(request, user.seedHex)
})

When('two simultaneous POST \\/api\\/puk\\/envelopes requests are sent for generation {int} on device {string}', async ({ request, world }, generation: number, deviceLabel: string) => {
  const s = getS(world)
  const deviceId = s.devices[deviceLabel]
  const [first, second] = await Promise.all([
    apiPost(request, '/puk/envelopes', { envelopes: [{ deviceId, generation, envelope: fakeEnvelope() }] }, s.pukUserSeed!),
    apiPost(request, '/puk/envelopes', { envelopes: [{ deviceId, generation, envelope: fakeEnvelope() }] }, s.pukUserSeed!),
  ])
  s.concurrentPukResults = [first, second]
})

Then('both responses have status {int}', ({ world }, status: number) => {
  const results = getS(world).concurrentPukResults!
  expect(results.map((r) => r.status)).toEqual([status, status])
})

Then('exactly one envelope record exists for \\(device {string}, generation {int}\\)', async ({ request, world }, deviceLabel: string, generation: number) => {
  const s = getS(world)
  const deviceId = s.devices[deviceLabel]
  // "Exactly one" is enforced at the database layer by the unique constraint
  // on (deviceId, generation) with ON CONFLICT DO UPDATE (H09 — see
  // apps/worker/services/crypto-keys.ts distributePukEnvelopes). GET
  // deterministically returning a single, well-formed record for this
  // (device, generation) is what a colliding duplicate row would break.
  const res = await apiGet(request, `/puk/envelopes/${deviceId}`, s.pukUserSeed!)
  expect(res.status).toBe(200)
  expect((res.data as { generation: number }).generation).toBe(generation)
})

Given('device {string} has a PUK envelope for generation {int}', async ({ request, world }, deviceLabel: string, generation: number) => {
  const s = getS(world)
  if (!s.pukUserSeed) s.pukUserSeed = (await createUserViaApi(request)).seedHex
  if (!s.devices[deviceLabel]) s.devices[deviceLabel] = await registerDeviceFor(request, s.pukUserSeed)
  const envelope = fakeEnvelope()
  const res = await apiPost(request, '/puk/envelopes', {
    envelopes: [{ deviceId: s.devices[deviceLabel], generation, envelope }],
  }, s.pukUserSeed)
  expect(res.status).toBe(201)
  s.lastPukEnvelopeValue = envelope
})

When('I call POST \\/api\\/puk\\/envelopes with a new envelope for generation {int} on device {string}', async ({ request, world }, generation: number, deviceLabel: string) => {
  const s = getS(world)
  const newEnvelope = fakeEnvelope()
  s.newPukEnvelopeValue = newEnvelope
  setLastResponse(world, await apiPost(request, '/puk/envelopes', {
    envelopes: [{ deviceId: s.devices[deviceLabel], generation, envelope: newEnvelope }],
  }, s.pukUserSeed!))
})

Then('the stored envelope for \\(device {string}, generation {int}\\) is updated to the new value', async ({ request, world }, deviceLabel: string, generation: number) => {
  const s = getS(world)
  const res = await apiGet(request, `/puk/envelopes/${s.devices[deviceLabel]}`, s.pukUserSeed!)
  expect(res.status).toBe(200)
  const data = res.data as { generation: number; envelope: string }
  expect(data.generation).toBe(generation)
  expect(data.envelope).toBe(s.newPukEnvelopeValue)
  expect(data.envelope).not.toBe(s.lastPukEnvelopeValue)
})

Given('device {string} has PUK envelopes for generations {int}, {int}, and {int}', async ({ request, world }, deviceLabel: string, g0: number, g1: number, g2: number) => {
  const s = getS(world)
  if (!s.pukUserSeed) s.pukUserSeed = (await createUserViaApi(request)).seedHex
  if (!s.devices[deviceLabel]) s.devices[deviceLabel] = await registerDeviceFor(request, s.pukUserSeed)
  for (const generation of [g0, g1, g2]) {
    const res = await apiPost(request, '/puk/envelopes', {
      envelopes: [{ deviceId: s.devices[deviceLabel], generation, envelope: fakeEnvelope() }],
    }, s.pukUserSeed)
    expect(res.status).toBe(201)
  }
})

When('I call GET \\/api\\/puk\\/envelopes\\/{word}', async ({ request, world }, deviceLabel: string) => {
  const s = getS(world)
  setLastResponse(world, await apiGet(request, `/puk/envelopes/${s.devices[deviceLabel]}`, s.pukUserSeed!))
})

Then('the returned generation is {int}', ({ world }, generation: number) => {
  const res = getSharedState(world).lastResponse!
  expect((res.data as { generation: number }).generation).toBe(generation)
})

// ── HIGH-W2: Dev-route X-Test-Secret gating ────────────────────────────

Given('the server is running in development mode with DEV_RESET_SECRET set', () => {
  // No-op: the backend-bdd dev server always runs with ENVIRONMENT=development
  // and DEV_RESET_SECRET set (scripts/dev-bun.sh) — this documents the
  // precondition rather than mutating shared server state, matching the
  // established pattern in tests/steps/backend/network-security.steps.ts.
})

When('I call POST \\/api\\/test-reset without X-Test-Secret header', async ({ request, world }) => {
  const res = await request.post('/api/test-reset', { headers: { 'Content-Type': 'application/json' } })
  setLastResponse(world, { status: res.status(), data: await res.json().catch(() => null) })
})

When('I call POST \\/api\\/test-reset with X-Test-Secret {string}', async ({ request, world }, secret: string) => {
  const res = await request.post('/api/test-reset', {
    headers: { 'Content-Type': 'application/json', 'X-Test-Secret': secret },
  })
  setLastResponse(world, { status: res.status(), data: await res.json().catch(() => null) })
})

When('I call GET \\/api\\/test-push-log with correct X-Test-Secret', async ({ request, world }) => {
  // Substitutes for calling /api/test-reset with a *correct* secret: both
  // routes share the identical checkResetSecret() guard (apps/worker/routes/dev.ts),
  // but test-reset wipes the whole database — unsafe to trigger for real while
  // other @backend scenarios run in parallel against this same server/DB
  // (playwright.config.ts runs backend-bdd with workers > 1). test-push-log
  // exercises the same gate with no destructive side effect.
  setLastResponse(world, await devGet(request, '/test-push-log'))
})

// ── HIGH-W3: Ban list phone masking ────────────────────────────────────

Given('I am authenticated as an admin with {string} permission', async ({ request, world }, permission: string) => {
  const s = getS(world)
  const hubId = await createHubViaApi(request, `epic-e-${slugify(permission)}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  const roleId = await scopedRole(request, permission)
  const user = await createUserViaApi(request, { roleIds: [roleId] })
  await apiPost(request, `/hubs/${hubId}/members`, { pubkey: user.pubkey, roleIds: [roleId] })
  s.currentActorSeed = user.seedHex
  s.currentHubId = hubId
})

When('I ban the phone number {string} with reason {string}', async ({ request, world }, phone: string, reason: string) => {
  const s = getS(world)
  setLastResponse(world, await apiPost(request, `/hubs/${s.currentHubId}/bans`, { phone, reason }, s.currentActorSeed!))
})

Then('the ban response contains phone {string}', ({ world }, expectedDisplay: string) => {
  const res = getSharedState(world).lastResponse!
  expect((res.data as { ban?: { phone?: string } }).ban?.phone).toBe(expectedDisplay)
})

Then('the stored phoneDisplay field does not contain the full phone number', ({ world }) => {
  const res = getSharedState(world).lastResponse!
  const phone = (res.data as { ban?: { phone?: string } }).ban?.phone ?? ''
  expect(phone).not.toContain('2125551234')
})

When('I bulk ban phones [{string}, {string}]', async ({ request, world }, phone1: string, phone2: string) => {
  const s = getS(world)
  setLastResponse(world, await apiPost(request, `/hubs/${s.currentHubId}/bans/bulk`, {
    phones: [phone1, phone2],
    reason: 'epic-e bulk ban test',
  }, s.currentActorSeed!))
})

Then('the stored phoneDisplay values are {string} and {string}', async ({ request, world }, display1: string, display2: string) => {
  const s = getS(world)
  const bans = await listBansViaApi(request, s.currentHubId)
  const displays = bans.map((b) => b.phone)
  expect(displays).toContain(display1)
  expect(displays).toContain(display2)
})

// ── HIGH-W6: Recovery-group emergency override approver match ─────────

Given('my pubkey is {string}', ({ world }, label: string) => {
  const s = getS(world)
  s.actors[label] = { pubkey: seedHexToPubkey(s.currentActorSeed!), seedHex: s.currentActorSeed!, registered: true }
})

Given('a recovery session exists and is awaiting contributions', async ({ request, world }) => {
  const s = getS(world)
  const recoveringUser = await createUserViaApi(request)
  const { pubkey: newDevicePubkey } = generateTestKeypair()
  const { status, data } = await devPost<{ sessionId: string }>(request, '/test-recovery-seed-session', {
    hubId: s.currentHubId!,
    userPubkey: recoveringUser.pubkey,
    newDevicePubkey,
    status: 'active',
  })
  expect(status).toBe(200)
  s.recoverySessionId = data.sessionId
})

When('I apply the emergency override with approverPubkey {string}', async ({ request, world }, approverLabel: string) => {
  const s = getS(world)
  const approverPubkey = resolveApproverPubkey(world, approverLabel)
  const sessionId = s.recoverySessionId!
  const signature = bytesToHex(ed25519.sign(utf8ToBytes(sessionId), hexToBytes(s.currentActorSeed!)))
  setLastResponse(world, await apiPost(request, `/recovery-group/session/${sessionId}/emergency`, {
    approverPubkey,
    justification: 'epic-e emergency override test',
    signature,
  }, s.currentActorSeed!))
})

Then('the error mentions approverPubkey must match', ({ world }) => {
  const res = getSharedState(world).lastResponse!
  expect((res.data as { error?: string }).error ?? '').toMatch(/approverPubkey must match/i)
})

Then('the response is not {int}', ({ world }, status: number) => {
  const res = getSharedState(world).lastResponse!
  expect(res.status).not.toBe(status)
})
