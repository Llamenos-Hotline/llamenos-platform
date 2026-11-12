/**
 * Backend steps for a call driven end to end by SIGNED provider webhooks (#1052).
 *
 * The test plays the telephony provider. The scenario's hub selects the mock
 * provider with a webhook signing secret, so every webhook below carries a real
 * signature and goes through the production path: `validateWebhook` (signature,
 * replay), the `/api/telephony/*` handlers, `startParallelRinging` and the
 * `TelephonyAdapter` calls it makes. Nothing here inserts a call, answers one
 * through a test-only route, or decides an outcome itself.
 *
 * Every assertion reads what the SERVER did:
 *  - who it rang: the ring set persisted on the call row (`active_calls.ring_set`)
 *    and the legs the provider was asked to dial (the mock's provider trace);
 *  - which pickup won: the call's `answeredBy`, and the adapter response each
 *    leg got (bridge vs hang-up);
 *  - what the losers got: the legs the provider was told to cancel;
 *  - the outcome: the call record and the hub's audit log.
 *
 * Waits are on server state (the ring set / dialled legs being written by the
 * background ringing task), never on time.
 */
import { expect, type APIRequestContext } from '@playwright/test'
import { Given, When, Then, After, getState, setState } from './fixtures'
import { getScenarioState } from './common.steps'
import {
  apiGet,
  apiPatch,
  apiPut,
  createHubViaApi,
  deleteHubViaApiIfPresent,
  listAuditLogViaApi,
  uniqueName,
} from '../../api-helpers'
import { TestDB } from '../../db-helpers'
import { uniqueCallerNumber } from '../../simulation-helpers'
import { createHmac } from 'node:crypto'

const BASE_URL = process.env.TEST_HUB_URL || 'http://localhost:3000'
// The server checks a signature over WEBHOOK_BASE_URL's origin when it has one,
// else over the origin the request reached — the same rule the providers sign by.
const SIGNED_ORIGIN = process.env.WEBHOOK_BASE_URL ? new URL(process.env.WEBHOOK_BASE_URL).origin : new URL(BASE_URL).origin

/**
 * The mock provider's documented signature (apps/worker/telephony/mock.ts):
 * hex HMAC-SHA256, under the hub's webhook secret, of the signed URL, a newline,
 * and the raw body. Computed here independently of the server's own signer, so a
 * signer that drifted from its own verifier could not pass.
 */
const MOCK_SIGNATURE_HEADER = 'X-Mock-Signature'
function mockSignature(secret: string, url: string, body: string): string {
  return createHmac('sha256', secret).update(`${url}\n${body}`).digest('hex')
}

/** How long the background ringing task may take to write what it decided. */
const RINGING_DECISION_TIMEOUT_MS = 15_000

interface ProviderResponse {
  status: number
  /** The mock adapter's response body: `{ mock: true, action, ... }` (or the replay "OK"). */
  action?: string
  body: string
}

interface ProviderLeg {
  legSid: string
  to: string
  answerUrl: string
  statusUrl: string
}

interface ProviderTrace {
  legs: ProviderLeg[]
  cancelledLegSids: string[]
  hungUp: boolean
}

interface LegPickup {
  volunteer: number
  response: ProviderResponse
}

interface SignedCallState {
  hubId: string
  secret: string
  hotline: string
  callSid?: string
  callerNumber?: string
  incoming?: ProviderResponse
  languageSelected?: ProviderResponse
  queueExit?: ProviderResponse
  pickups: LegPickup[]
  forged?: ProviderResponse
}

const STATE_KEY = 'signedCallRouting'

function signed(world: Record<string, unknown>): SignedCallState {
  const s = getState<SignedCallState | undefined>(world, STATE_KEY)
  if (!s) throw new Error('the scenario hub does not take signed provider webhooks — run the Background step first')
  return s
}

After({ tags: '@simulated-telephony' }, async ({ request, world }) => {
  const s = getState<SignedCallState | undefined>(world, STATE_KEY)
  if (s) await deleteHubViaApiIfPresent(request, s.hubId)
})

/** A fictional 555 number no other hub in this database owns. */
function fictionalNumber(): string {
  const digits = new Uint32Array(1)
  crypto.getRandomValues(digits)
  return `+1555${String(digits[0] % 10_000_000).padStart(7, '0')}`
}

/** POST a webhook the way the provider does: JSON body, signed over the URL and body. */
async function deliver(
  request: APIRequestContext,
  secret: string,
  pathAndQuery: string,
  body: Record<string, unknown>,
  options: { forge?: boolean } = {},
): Promise<ProviderResponse> {
  const raw = JSON.stringify(body)
  const signature = mockSignature(options.forge ? `${secret}-forged` : secret, SIGNED_ORIGIN + pathAndQuery, raw)
  const res = await request.post(`${BASE_URL}${pathAndQuery}`, {
    headers: { 'Content-Type': 'application/json', [MOCK_SIGNATURE_HEADER]: signature },
    data: raw,
  })
  const text = await res.text()
  let action: string | undefined
  try {
    action = (JSON.parse(text) as { action?: string }).action
  } catch {
    action = undefined
  }
  return { status: res.status(), action, body: text }
}

/** Path + query of a callback URL the server handed the provider for a leg. */
function callbackPath(url: string): string {
  const u = new URL(url)
  return u.pathname + u.search
}

function expectAction(res: ProviderResponse | undefined, action: string, what: string): void {
  expect(res, `${what}: no webhook response recorded`).toBeDefined()
  expect(res!.status, `${what}: HTTP ${res!.status} ${res!.body}`).toBe(200)
  expect(res!.action, `${what}: ${res!.body}`).toBe(action)
}

async function providerTrace(request: APIRequestContext, s: SignedCallState): Promise<ProviderTrace | null> {
  const { status, data } = await apiGet<ProviderTrace>(
    request,
    `/hubs/${s.hubId}/simulated-telephony/calls/${encodeURIComponent(s.callSid!)}/provider-trace`,
  )
  if (status === 404) return null
  expect(status, `provider trace: ${JSON.stringify(data)}`).toBe(200)
  return data
}

/** Wait until the ringing service has decided who this call rings (the ring set is written). */
async function ringDecision(s: SignedCallState): Promise<{ volunteers: string[]; usedFallback: boolean }> {
  const seen: { ringSet: { volunteers: string[]; usedFallback: boolean } | null } = { ringSet: null }
  await expect.poll(async () => {
    seen.ringSet = (await TestDB.getActiveCallRouting(s.callSid!))?.ringSet ?? null
    return seen.ringSet !== null
  }, { message: `the ringing service never recorded who call ${s.callSid} rings`, timeout: RINGING_DECISION_TIMEOUT_MS }).toBe(true)
  return seen.ringSet!
}

/** Wait until the provider dial has returned and its legs are recorded on the call. */
async function waitForDialledLegs(s: SignedCallState, count: number): Promise<void> {
  await expect.poll(
    async () => (await TestDB.getActiveCallRouting(s.callSid!))?.ringLegSids?.length ?? 0,
    { message: `the dialled legs of call ${s.callSid} were never recorded`, timeout: RINGING_DECISION_TIMEOUT_MS },
  ).toBe(count)
}

function volunteerAt(world: Record<string, unknown>, index: number) {
  const vol = getScenarioState(world).volunteers[index - 1]
  expect(vol, `volunteer ${index} does not exist in this scenario`).toBeDefined()
  return vol
}

/** "1, 2 and 3" / "1 and 3" / "2" → [1, 2, 3] / [1, 3] / [2] */
function indexList(list: string): number[] {
  return list.split(/,|\band\b/).map(p => p.trim()).filter(Boolean).map(Number)
}

async function legOf(request: APIRequestContext, world: Record<string, unknown>, index: number): Promise<ProviderLeg> {
  const s = signed(world)
  const trace = await providerTrace(request, s)
  expect(trace, `the provider was asked to dial nothing for call ${s.callSid}`).not.toBeNull()
  const vol = volunteerAt(world, index)
  const legs = trace!.legs.filter(l => l.to === vol.phone)
  expect(legs, `expected exactly one leg dialled to volunteer ${index}`).toHaveLength(1)
  return legs[0]
}

async function callFromApi(request: APIRequestContext, s: SignedCallState) {
  const { status, data } = await apiGet<{ status: string; answeredBy: string | null }>(
    request,
    `/hubs/${s.hubId}/calls/${encodeURIComponent(s.callSid!)}`,
  )
  expect(status, `GET call ${s.callSid}: ${JSON.stringify(data)}`).toBe(200)
  return data
}

// ── Setup ─────────────────────────────────────────────────────────

Given('a hub of its own whose calls arrive through signed mock-provider webhooks', async ({ request, world }) => {
  // A hub per scenario: the hub's provider, number and roster are all state the
  // shared worker hub must not carry into the next scenario.
  const hubId = await createHubViaApi(request, uniqueName('signed-calls'))
  const hotline = fictionalNumber()
  const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')
  setState(world, STATE_KEY, { hubId, secret, hotline, pickups: [] } satisfies SignedCallState)
  getScenarioState(world).hubId = hubId

  // /incoming routes a call to the hub that owns the dialled number.
  const patched = await apiPatch(request, `/hubs/${hubId}`, { phoneNumber: hotline })
  expect(patched.status, `set the hub's number: ${JSON.stringify(patched.data)}`).toBe(200)
  const mock = await apiPut(request, `/hubs/${hubId}/simulated-telephony/mock`, {
    enabled: true,
    phoneNumber: hotline,
    webhookSecret: secret,
  })
  expect(mock.status, `select the signed mock provider: ${JSON.stringify(mock.data)}`).toBe(200)
})

// ── The caller ────────────────────────────────────────────────────

async function dial(request: APIRequestContext, world: Record<string, unknown>, callerNumber: string): Promise<void> {
  const s = signed(world)
  s.callSid = `mock-call-${crypto.randomUUID()}`
  s.callerNumber = callerNumber
  s.incoming = s.languageSelected = s.queueExit = s.forged = undefined
  s.pickups = []
  s.incoming = await deliver(request, s.secret, `/api/telephony/incoming?hub=${s.hubId}`, {
    callSid: s.callSid,
    callerNumber,
    calledNumber: s.hotline,
  })
  getScenarioState(world).callId = s.callSid
}

async function chooseLanguage(request: APIRequestContext, world: Record<string, unknown>): Promise<void> {
  const s = signed(world)
  expectAction(s.incoming, 'language-menu', '/incoming')
  s.languageSelected = await deliver(request, s.secret, `/api/telephony/language-selected?hub=${s.hubId}`, {
    callSid: s.callSid,
    callerNumber: s.callerNumber,
    digits: '1',
  })
}

When('a caller dials the hotline and chooses a language', async ({ request, world }) => {
  await dial(request, world, uniqueCallerNumber())
  await chooseLanguage(request, world)
})

When('{string} dials the hotline', async ({ request, world }, callerNumber: string) => {
  await dial(request, world, callerNumber)
})

When("the caller's queue wait ends without an answer", async ({ request, world }) => {
  const s = signed(world)
  s.queueExit = await deliver(request, s.secret, `/api/telephony/queue-exit?hub=${s.hubId}&callSid=${s.callSid}&lang=en`, {
    result: 'leave',
  })
})

When('the caller hangs up while queued', async ({ request, world }) => {
  const s = signed(world)
  s.queueExit = await deliver(request, s.secret, `/api/telephony/queue-exit?hub=${s.hubId}&callSid=${s.callSid}&lang=en`, {
    result: 'hangup',
  })
})

Given('volunteer {int} is already on a call in this hub', async ({ request, world }, index: number) => {
  // A real first call, routed and answered through the same signed chain.
  await dial(request, world, uniqueCallerNumber())
  await chooseLanguage(request, world)
  const s = signed(world)
  await waitForDialledLegs(s, getScenarioState(world).volunteers.length)
  const pickup = await pickUp(request, world, index)
  expectAction(pickup.response, 'call-answered', `volunteer ${index} answering the first call`)
})

// ── Volunteer legs ────────────────────────────────────────────────

async function pickUp(request: APIRequestContext, world: Record<string, unknown>, index: number): Promise<LegPickup> {
  const s = signed(world)
  const leg = await legOf(request, world, index)
  // What the provider posts when a person answers the leg: the leg's own SID, to
  // the answer URL the server gave it for that leg.
  const response = await deliver(request, s.secret, callbackPath(leg.answerUrl), { callSid: leg.legSid })
  const pickup = { volunteer: index, response }
  s.pickups.push(pickup)
  return pickup
}

When('volunteer {int} picks up their leg', async ({ request, world }, index: number) => {
  await pickUp(request, world, index)
})

When('volunteers {int} and {int} pick up their legs at the same time', async ({ request, world }, a: number, b: number) => {
  await Promise.all([pickUp(request, world, a), pickUp(request, world, b)])
})

When("volunteer {int}'s leg reports it has completed", async ({ request, world }, index: number) => {
  const s = signed(world)
  const leg = await legOf(request, world, index)
  const res = await deliver(request, s.secret, callbackPath(leg.statusUrl), { status: 'completed', callSid: leg.legSid })
  expectAction(res, 'noop', `/call-status for volunteer ${index}'s leg`)
})

When("someone without the hub's secret posts a pickup for volunteer {int}'s leg", async ({ request, world }, index: number) => {
  const s = signed(world)
  const leg = await legOf(request, world, index)
  s.forged = await deliver(request, s.secret, callbackPath(leg.answerUrl), { callSid: leg.legSid }, { forge: true })
})

// ── Assertions: what the caller was told ──────────────────────────

Then('the caller hears the greeting and waits in the queue', async ({ world }) => {
  // handleIncomingCall: the greeting and hold music, i.e. the caller is in the queue.
  expectAction(signed(world).languageSelected, 'incoming-call', '/language-selected')
})

Then('the provider is told to take a voicemail', async ({ world }) => {
  expectAction(signed(world).queueExit, 'voicemail', '/queue-exit')
})

Then('the call is rejected at the first webhook', async ({ world }) => {
  expectAction(signed(world).incoming, 'reject', '/incoming')
})

Then('the forged webhook is refused with status {int}', async ({ world }, status: number) => {
  const { forged } = signed(world)
  expect(forged, 'no forged webhook was posted').toBeDefined()
  expect(forged!.status, forged!.body).toBe(status)
})

// ── Assertions: who was rung ──────────────────────────────────────

Then('the ringing service rang exactly volunteer(s) {string}', async ({ world }, list: string) => {
  const expected = indexList(list).map(i => volunteerAt(world, i).pubkey).sort()
  const ringSet = await ringDecision(signed(world))
  expect([...ringSet.volunteers].sort()).toEqual(expected)
})

Then('the ringing service rang exactly volunteer(s) {string} from the shift', async ({ world }, list: string) => {
  const expected = indexList(list).map(i => volunteerAt(world, i).pubkey).sort()
  const ringSet = await ringDecision(signed(world))
  expect([...ringSet.volunteers].sort()).toEqual(expected)
  expect(ringSet.usedFallback, 'the ring set came from the fallback group, not the shift').toBe(false)
})

Then('the ringing service rang exactly volunteer(s) {string} from the fallback group', async ({ world }, list: string) => {
  const expected = indexList(list).map(i => volunteerAt(world, i).pubkey).sort()
  const ringSet = await ringDecision(signed(world))
  expect([...ringSet.volunteers].sort()).toEqual(expected)
  expect(ringSet.usedFallback, 'the ring set came from the shift, not the fallback group').toBe(true)
})

Then('the ringing service rang nobody', async ({ world }) => {
  const ringSet = await ringDecision(signed(world))
  expect(ringSet.volunteers).toEqual([])
})

Then('the provider was asked to dial one leg to each of volunteer(s) {string}', async ({ request, world }, list: string) => {
  const s = signed(world)
  const indexes = indexList(list)
  // The dial returns before its legs are written; wait for that write, then read
  // what the provider was actually asked to place.
  await waitForDialledLegs(s, indexes.length)
  const trace = await providerTrace(request, s)
  expect(trace, 'the provider was asked to dial nothing').not.toBeNull()
  const dialled = trace!.legs.map(l => l.to).sort()
  expect(dialled).toEqual(indexes.map(i => volunteerAt(world, i).phone).sort())
  // Each leg's callbacks carry its own opaque token, never a pubkey or the hub.
  const tokens = new Set(trace!.legs.map(l => new URL(l.answerUrl).searchParams.get('callToken')))
  expect(tokens.size).toBe(indexes.length)
  for (const leg of trace!.legs) {
    expect(new URL(leg.answerUrl).searchParams.get('hub')).toBeNull()
    for (const i of indexes) expect(leg.answerUrl).not.toContain(volunteerAt(world, i).pubkey)
  }
})

Then('the provider was asked to dial nothing', async ({ request, world }) => {
  const s = signed(world)
  // Only meaningful once the ringing service has decided — the ring set says it has.
  await ringDecision(s)
  expect(await providerTrace(request, s)).toBeNull()
})

// ── Assertions: who won, and what the others got ─────────────────

Then("volunteer {int}'s leg is bridged to the caller", async ({ world }, index: number) => {
  const pickup = signed(world).pickups.find(p => p.volunteer === index)
  expect(pickup, `volunteer ${index} never picked up`).toBeDefined()
  expectAction(pickup!.response, 'call-answered', `/user-answer for volunteer ${index}`)
})

Then("volunteer {int}'s leg is hung up", async ({ world }, index: number) => {
  const pickups = signed(world).pickups.filter(p => p.volunteer === index)
  expect(pickups.length, `volunteer ${index} never picked up`).toBeGreaterThan(0)
  expectAction(pickups[pickups.length - 1].response, 'hangup', `/user-answer for volunteer ${index}`)
})

Then("volunteer {int}'s late pickup does not get the caller", async ({ world }, index: number) => {
  const pickups = signed(world).pickups.filter(p => p.volunteer === index)
  expect(pickups.length, `volunteer ${index} never picked up`).toBeGreaterThan(0)
  const late = pickups[pickups.length - 1].response
  // The call has ended, so its leg tokens are gone: the leg is refused — hung up,
  // or (with no token left to name the call's hub) not authenticated — never bridged.
  expect(late.action, `late /user-answer: HTTP ${late.status} ${late.body}`).not.toBe('call-answered')
  expect(late.status === 403 || late.action === 'hangup', `late /user-answer: HTTP ${late.status} ${late.body}`).toBe(true)
})

Then('exactly one of the pickups is bridged and the other is hung up', async ({ world }) => {
  const actions = signed(world).pickups.map(p => p.response.action).sort()
  expect(actions).toEqual(['call-answered', 'hangup'])
})

Then('the call is in progress and answered by volunteer {int}', async ({ request, world }, index: number) => {
  const call = await callFromApi(request, signed(world))
  expect(call.status).toBe('in-progress')
  expect(call.answeredBy).toBe(volunteerAt(world, index).pubkey)
})

Then('the call is in progress and answered by the volunteer whose leg was bridged', async ({ request, world }) => {
  const winner = signed(world).pickups.find(p => p.response.action === 'call-answered')
  expect(winner, 'no pickup was bridged').toBeDefined()
  const call = await callFromApi(request, signed(world))
  expect(call.status).toBe('in-progress')
  expect(call.answeredBy).toBe(volunteerAt(world, winner!.volunteer).pubkey)
})

Then('the call is still ringing with nobody on it', async ({ request, world }) => {
  const call = await callFromApi(request, signed(world))
  expect(call.status).toBe('ringing')
  expect(call.answeredBy).toBeNull()
})

Then(
  "the provider was told to stop every leg but volunteer {int}'s",
  async ({ request, world }, winnerIndex: number) => {
    const s = signed(world)
    const trace = await providerTrace(request, s)
    expect(trace).not.toBeNull()
    const winner = await legOf(request, world, winnerIndex)
    const losers = trace!.legs.filter(l => l.legSid !== winner.legSid).map(l => l.legSid).sort()
    expect(losers.length, 'there were no other legs to stop').toBeGreaterThan(0)
    expect([...trace!.cancelledLegSids].sort()).toEqual(losers)
  },
)

Then('the provider was told to stop every leg it dialled', async ({ request, world }) => {
  const trace = await providerTrace(request, signed(world))
  expect(trace, 'the provider was asked to dial nothing').not.toBeNull()
  expect(trace!.legs.length).toBeGreaterThan(0)
  expect([...trace!.cancelledLegSids].sort()).toEqual(trace!.legs.map(l => l.legSid).sort())
})

// ── Assertions: the record ────────────────────────────────────────

Then('the call history records the call as {string}', async ({ request, world }, status: string) => {
  const s = signed(world)
  const call = await callFromApi(request, s)
  expect(call.status).toBe(status)
  // Ended means moved out of the live table.
  expect(await TestDB.getActiveCallRouting(s.callSid!)).toBeNull()
})

Then('no call was recorded', async ({ request, world }) => {
  const s = signed(world)
  const { status } = await apiGet(request, `/hubs/${s.hubId}/calls/${encodeURIComponent(s.callSid!)}`)
  expect(status).toBe(404)
  expect(await TestDB.getActiveCallRouting(s.callSid!)).toBeNull()
})

Then('the hub audit log records volunteer {int} answering the call', async ({ request, world }, index: number) => {
  const { hubId } = signed(world)
  const { entries } = await listAuditLogViaApi(request, { hubId, limit: 100 })
  const answered = entries.filter(e => e.action === 'callAnswered')
  expect(answered.map(e => e.actorPubkey), 'callAnswered entries').toEqual([volunteerAt(world, index).pubkey])
})

Then('the hub audit log records the call as missed', async ({ request, world }) => {
  const { hubId, callSid } = signed(world)
  const { entries } = await listAuditLogViaApi(request, { hubId, limit: 100 })
  const missed = entries.filter(e => e.action === 'callMissed')
  expect(missed, `callMissed entries: ${JSON.stringify(entries.map(e => e.action))}`).toHaveLength(1)
  // The provider's call id is a key into its CDR, which holds the caller's number:
  // the audit row names the call by a keyed ref, never by the id (#2333).
  expect(JSON.stringify(missed[0])).not.toContain(callSid!)
  expect(entries.some(e => e.action === 'callAnswered')).toBe(false)
})

Then('the hub audit log records the call ending', async ({ request, world }) => {
  const { hubId } = signed(world)
  const { entries } = await listAuditLogViaApi(request, { hubId, limit: 100 })
  expect(entries.filter(e => e.action === 'callEnded'), `actions: ${entries.map(e => e.action).join(', ')}`).toHaveLength(1)
})
