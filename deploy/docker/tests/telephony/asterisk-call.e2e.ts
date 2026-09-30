/**
 * End-to-end: real SIP calls through self-hosted Asterisk.
 *
 *   simulated carrier ──SIP INVITE──▶ Asterisk [from-trunk] ──Stasis──▶ ARI
 *     ──WebSocket──▶ sip-bridge ──signed webhooks──▶ worker (IVR, queue, ringing)
 *     ──/ring──▶ sip-bridge ──ARI originate──▶ PJSIP/<volunteer>@trunk ──▶ carrier
 *     (the volunteer's phone answers) ──▶ /user-answer ──▶ ARI mixing bridge
 *
 * Nothing is simulated on the hotline side: the worker only learns about a call
 * from the bridge's webhooks, and a volunteer is only "answered" because the
 * carrier's phone picked up the leg Asterisk dialled.
 *
 * Run with run-call-e2e.sh (it starts the PBX stack and an isolated worker).
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, test, type APIRequestContext } from '@playwright/test'
import {
  addHubMemberViaApi,
  apiGet,
  apiPost,
  createUserViaApi,
  listAuditLogViaApi,
  setFallbackGroupViaApi,
} from '../../../../tests/api-helpers'

const CARRIER = process.env.E2E_CARRIER_CONTAINER ?? 'll-telephony-e2e-sip-carrier-1'
const ARI_REST_URL = process.env.E2E_ARI_REST_URL ?? 'http://127.0.0.1:8088/ari'
const ARI_USERNAME = process.env.ARI_USERNAME ?? 'llamenos'
const ARI_PASSWORD = process.env.ARI_PASSWORD ?? ''
const BRIDGE_URL = process.env.E2E_BRIDGE_URL ?? 'http://127.0.0.1:3200'
const BRIDGE_SECRET = process.env.BRIDGE_SECRET ?? ''

/** Carrier numbers under this prefix ring forever (see carrier/extensions.conf) */
const UNANSWERED_PREFIX = '+1555021'

interface CallRecord {
  id: string
  callerLast4?: string
  answeredBy?: string | null
  status?: string
}

interface AriChannel {
  id: string
  caller: { number: string }
  dialplan: { exten: string }
}

let serial = 0
/** A fresh E.164 number (the worker rate-limits per caller) */
function uniqueNumber(prefix: string): string {
  serial += 1
  return `${prefix}${String(Date.now() + serial).slice(-6)}`
}

function carrierCli(command: string): string {
  return execFileSync('docker', ['exec', CARRIER, 'asterisk', '-rx', command], { encoding: 'utf8' })
}

/** The caller dials the hotline and stays on the line for `holdSeconds` */
function placeCall(caller: string, hotline: string, holdSeconds: number): void {
  carrierCli(`dialplan set global CALLER_NUMBER ${caller}`)
  carrierCli(`channel originate Local/${hotline}@place-call application Wait ${holdSeconds}`)
}

/** The recording as the worker's AsteriskAdapter fetches it (see fetch-recording.ts) */
function fetchRecording(callSid: string): { byteLength: number; magic: string } | null {
  const out = execFileSync('bun', [fileURLToPath(new URL('fetch-recording.ts', import.meta.url)), callSid], { encoding: 'utf8' })
  const lastLine = out.trim().split('\n').pop() ?? 'null'
  return JSON.parse(lastLine) as { byteLength: number; magic: string } | null
}

async function ari<T>(path: string): Promise<T> {
  const res = await fetch(`${ARI_REST_URL}${path}`, {
    headers: { Authorization: `Basic ${btoa(`${ARI_USERNAME}:${ARI_PASSWORD}`)}` },
  })
  expect(res.ok, `ARI GET ${path}`).toBe(true)
  return (await res.json()) as T
}

/** Channels on the hotline PBX that carry this caller's number (their leg and any volunteer legs) */
async function channelsFor(caller: string): Promise<AriChannel[]> {
  return (await ari<AriChannel[]>('/channels')).filter((ch) => ch.caller.number === caller)
}

async function activeCall(request: APIRequestContext, hubId: string, callerLast4: string): Promise<CallRecord | undefined> {
  const { status, data } = await apiGet<{ calls: CallRecord[] }>(request, `/hubs/${hubId}/calls/active`)
  expect(status).toBe(200)
  return data.calls.find((c) => c.callerLast4 === callerLast4)
}

async function historyCall(request: APIRequestContext, hubId: string, callerLast4: string): Promise<CallRecord | undefined> {
  const { status, data } = await apiGet<{ calls: CallRecord[] }>(request, `/hubs/${hubId}/calls/history`)
  expect(status).toBe(200)
  return data.calls.find((c) => c.callerLast4 === callerLast4)
}

async function auditActions(request: APIRequestContext, hubId: string): Promise<string[]> {
  const audit = await listAuditLogViaApi(request, { hubId, limit: 100 })
  return audit.entries.map((e) => e.action)
}

/**
 * A hub with its own hotline number, served by this Asterisk, whose fallback
 * group (nobody is on shift) is one volunteer with the given phone number.
 */
async function provisionHotline(request: APIRequestContext, volunteerPhone: string) {
  const hotline = uniqueNumber('+1555010')
  const hub = await apiPost<{ hub: { id: string } }>(request, '/hubs', {
    name: `Asterisk E2E ${hotline}`,
    phoneNumber: hotline,
  })
  expect(hub.status, JSON.stringify(hub.data)).toBe(201)
  const hubId = hub.data.hub.id

  const configured = await apiPost(request, '/provider-setup/configure', {
    provider: 'asterisk',
    phoneNumber: hotline,
    credentials: {
      ariUrl: ARI_REST_URL.replace(/\/ari$/, ''),
      ariUsername: ARI_USERNAME,
      ariPassword: ARI_PASSWORD,
      bridgeCallbackUrl: BRIDGE_URL,
      bridgeSecret: BRIDGE_SECRET,
    },
  })
  expect(configured.status, JSON.stringify(configured.data)).toBe(200)

  const volunteer = await createUserViaApi(request, { name: 'E2E Volunteer', phone: volunteerPhone })
  await addHubMemberViaApi(request, hubId, volunteer.pubkey)
  await setFallbackGroupViaApi(request, [volunteer.pubkey], hubId)
  return { hotline, hubId, volunteer }
}

test('an inbound SIP call rings the volunteer, bridges them to the caller, and is recorded', async ({ request }) => {
  const { hotline, hubId, volunteer } = await provisionHotline(request, uniqueNumber('+1555020'))
  const caller = uniqueNumber('+1555777')
  const callerLast4 = caller.slice(-4)

  carrierCli('dialplan set global VOLUNTEER_TALK_SECONDS 12')
  placeCall(caller, hotline, 60)

  // The worker learnt about the call, rang the volunteer's phone, and accepted
  // the volunteer's pickup: the call is in progress and answered by them.
  await expect
    .poll(() => activeCall(request, hubId, callerLast4), { timeout: 30_000, message: 'call answered by the volunteer' })
    .toMatchObject({ answeredBy: volunteer.pubkey, status: 'in-progress' })

  // On the PBX: the caller and the volunteer's leg share one mixing bridge.
  const callerLeg = (await channelsFor(caller)).find((ch) => ch.dialplan.exten === hotline)
  if (!callerLeg) throw new Error('the caller leg is not up on the hotline PBX')
  const bridges = await ari<Array<{ bridge_type: string; channels: string[] }>>('/bridges')
  const bridge = bridges.find((b) => b.channels.includes(callerLeg.id))
  if (!bridge) throw new Error('the caller is not in a bridge')
  expect(bridge.bridge_type).toBe('mixing')
  expect(bridge.channels).toHaveLength(2)

  // The volunteer hangs up: their leg's `completed` status ends the call...
  await expect
    .poll(() => historyCall(request, hubId, callerLast4), { timeout: 30_000, message: 'call completed in history' })
    .toMatchObject({ answeredBy: volunteer.pubkey, status: 'completed' })
  // ...and the caller is released with them, not left alone in the bridge.
  await expect.poll(async () => (await channelsFor(caller)).length, { timeout: 15_000 }).toBe(0)

  const actions = await auditActions(request, hubId)
  expect(actions).toContain('callAnswered')
  expect(actions).toContain('callEnded')

  // The bridged call was recorded, and the worker's own adapter can fetch the
  // audio from the bridge by call SID.
  await expect
    .poll(() => fetchRecording(callerLeg.id), { timeout: 15_000, message: 'call recording available' })
    .not.toBeNull()
  const recording = fetchRecording(callerLeg.id)
  if (!recording) throw new Error('the call recording disappeared')
  expect(recording.magic).toBe('RIFF')
  // 12 s of 8 kHz 16-bit mono is ~190 KB; anything near the header size means nothing was captured.
  expect(recording.byteLength).toBeGreaterThan(50_000)
})

test('a caller who hangs up while the volunteer phone rings ends as unanswered, and the ringing stops', async ({ request }) => {
  const { hotline, hubId } = await provisionHotline(request, uniqueNumber(UNANSWERED_PREFIX))
  const caller = uniqueNumber('+1555778')
  const callerLast4 = caller.slice(-4)

  // The multi-language menu waits 8 s for a digit; hang up once the phone is ringing.
  placeCall(caller, hotline, 14)

  await expect
    .poll(() => activeCall(request, hubId, callerLast4), { timeout: 20_000, message: 'call ringing' })
    .toMatchObject({ status: 'ringing' })
  await expect
    .poll(async () => (await channelsFor(caller)).length, { timeout: 10_000, message: 'volunteer leg dialled' })
    .toBe(2)

  // The caller's hangup reaches the worker (queue-exit: hangup) and ends the call.
  await expect
    .poll(() => historyCall(request, hubId, callerLast4), { timeout: 30_000, message: 'call unanswered in history' })
    .toMatchObject({ status: 'unanswered' })
  expect(await auditActions(request, hubId)).toContain('callMissed')

  // Nobody is left ringing a volunteer for a caller who is gone.
  await expect.poll(async () => (await channelsFor(caller)).length, { timeout: 10_000 }).toBe(0)
  expect(carrierCli('core show channels count')).toMatch(/^0 active calls/m)
})
