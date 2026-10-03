/**
 * End-to-end: real SIP calls through self-hosted Asterisk.
 *
 *   simulated carrier ──SIP INVITE──▶ Asterisk [from-trunk] ──Stasis──▶ ARI
 *     ──WebSocket──▶ sip-bridge ──signed webhooks──▶ worker (IVR, queue, ringing)
 *     ──/ring──▶ sip-bridge ──ARI originate──▶ PJSIP/<volunteer>@trunk ──▶ carrier
 *     (the volunteer's phone answers) ──▶ /user-answer ──▶ ARI mixing bridge
 *   worker ──play http://app:3000/api/ivr-audio/… (an operator's upload)
 *          or http://app:3000/api/ivr-speech/… (the worker's generated speech)──▶
 *     sip-bridge ──ARI sound:<url>──▶ Asterisk fetches it from the app ──RTP──▶
 *     carrier (recorded)
 *
 * Nothing is simulated on the hotline side: the worker only learns about a call
 * from the bridge's webhooks, and a volunteer is only "answered" because the
 * carrier's phone picked up the leg Asterisk dialled.
 *
 * The SIP trunk is what an operator provisions: every test creates it through
 * POST /provider-setup/create-sip-trunk, which writes it into the PBX over ARI.
 * The PBX ships with no trunk at all.
 *
 * Run with run-call-e2e.sh (it starts the app and the PBX stack on one network).
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ed25519 } from '@noble/curves/ed25519.js'
import { expect, test, type APIRequestContext } from '@playwright/test'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@shared/encoding'
import { LABEL_DEVICE_AUTH } from '@shared/crypto-labels'
import {
  ADMIN_SEED,
  addHubMemberViaApi,
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
  createUserViaApi,
  listAuditLogViaApi,
  seedHexToPubkey,
  setFallbackGroupViaApi,
} from '../../../../tests/api-helpers'
import { encodePcm16Wav, IVR_WAV_SAMPLE_RATE } from '../../../../src/client/lib/ivr-wav'
import { findClip, wavSamples } from './audio-match'

const CARRIER = process.env.E2E_CARRIER_CONTAINER ?? 'll-telephony-e2e-sip-carrier-1'
const HOTLINE_PBX = process.env.E2E_ASTERISK_CONTAINER ?? 'll-telephony-e2e-asterisk-1'
/** The carrier's SIP host, as the operator types it into the trunk form */
const CARRIER_HOST = 'sip-carrier'
/** The username/password the carrier issued for its registration trunk (carrier/pjsip.conf) */
const CARRIER_ISSUED_USERNAME = 'hotline-reg'
const CARRIER_ISSUED_PASSWORD = 'carrier-issued-e2e-only'
/** ARI and the bridge as the app is configured to reach them — their names on the compose network */
const WORKER_ARI_URL = process.env.E2E_WORKER_ARI_URL ?? 'http://asterisk:8088'
const WORKER_BRIDGE_URL = process.env.E2E_WORKER_BRIDGE_URL ?? 'http://sip-bridge:3000'
const ARI_REST_URL = process.env.E2E_ARI_REST_URL ?? 'http://127.0.0.1:8088/ari'
const ARI_USERNAME = process.env.ARI_USERNAME ?? 'llamenos'
const ARI_PASSWORD = process.env.ARI_PASSWORD ?? ''
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

/**
 * The caller dials the hotline and stays on the line for `holdSeconds`. The
 * carrier delivers it over the IP-authenticated trunk, or to the contact the
 * hotline registered when `via` is 'registration'.
 */
function placeCall(caller: string, hotline: string, holdSeconds: number, via: 'ip' | 'registration' = 'ip'): void {
  const context = via === 'ip' ? 'place-call' : 'place-call-registered'
  carrierCli(`dialplan set global CALLER_NUMBER ${caller}`)
  carrierCli(`channel originate Local/${hotline}@${context} application Wait ${holdSeconds}`)
}

/** Calls the carrier has finished, and calls it has in flight */
function carrierCallCounts(): { processed: number; active: number } {
  const out = carrierCli('core show channels count')
  const count = (re: RegExp) => Number(out.match(re)?.[1] ?? Number.NaN)
  return { processed: count(/^(\d+) calls? processed/m), active: count(/^(\d+) active calls?/m) }
}

/** The recording as the worker's AsteriskAdapter fetches it (see fetch-recording.ts) */
function fetchRecording(callSid: string): { byteLength: number; magic: string } | null {
  const out = execFileSync('bun', [fileURLToPath(new URL('fetch-recording.ts', import.meta.url)), callSid], { encoding: 'utf8' })
  const lastLine = out.trim().split('\n').pop() ?? 'null'
  return JSON.parse(lastLine) as { byteLength: number; magic: string } | null
}

const ARI_AUTH = { Authorization: `Basic ${btoa(`${ARI_USERNAME}:${ARI_PASSWORD}`)}` }

async function ari<T>(path: string): Promise<T> {
  const res = await fetch(`${ARI_REST_URL}${path}`, { headers: ARI_AUTH })
  expect(res.ok, `ARI GET ${path}`).toBe(true)
  return (await res.json()) as T
}

/** HTTP status of an ARI GET, for an object that may not exist */
async function ariStatus(path: string): Promise<number> {
  const res = await fetch(`${ARI_REST_URL}${path}`, { headers: ARI_AUTH })
  await res.body?.cancel()
  return res.status
}

/** Put the PBX back to how it ships: no SIP trunk. Test setup only — the app has no route for this. */
async function removeTrunk(): Promise<void> {
  const objects = [['registration', 'trunk'], ['identify', 'trunk'], ['endpoint', 'trunk'], ['aor', 'trunk'], ['auth', 'trunk-auth']]
  for (const [type, id] of objects) {
    const res = await fetch(`${ARI_REST_URL}/asterisk/config/dynamic/res_pjsip/${type}/${id}`, { method: 'DELETE', headers: ARI_AUTH })
    await res.body?.cancel()
    expect([204, 404], `ARI DELETE ${type}/${id}`).toContain(res.status)
  }
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

interface TrunkForm {
  domain: string
  username?: string
  password?: string
}

/** The operator provisions the PBX's SIP trunk to their carrier, through the app */
async function createTrunk(request: APIRequestContext, trunk: TrunkForm): Promise<void> {
  const res = await apiPost<Record<string, unknown>>(request, '/provider-setup/create-sip-trunk', { provider: 'asterisk', ...trunk })
  expect(res.status, JSON.stringify(res.data)).toBe(200)
  expect(res.data).toMatchObject({ sipProvider: trunk.domain })
  expect(res.data.sipUsername).toBe(trunk.username)
  // A carrier-issued password goes to the PBX and nowhere else.
  expect(JSON.stringify(res.data)).not.toContain(CARRIER_ISSUED_PASSWORD)
}

/**
 * A hub with its own hotline number, served by this Asterisk, whose fallback
 * group (nobody is on shift) is one volunteer with the given phone number, and
 * whose IVR offers `languages` (one: no menu).
 * The Asterisk provider is configured and, unless `trunk` is null, the SIP
 * trunk provisioned (IP-authenticated to the carrier by default).
 */
async function provisionHotline(
  request: APIRequestContext,
  volunteerPhone: string,
  trunk: TrunkForm | null = { domain: CARRIER_HOST },
  languages: string[] = ['en'],
) {
  const hotline = uniqueNumber('+1555010')
  const hub = await apiPost<{ hub: { id: string } }>(request, '/hubs', {
    name: `Asterisk E2E ${hotline}`,
    phoneNumber: hotline,
  })
  expect(hub.status, JSON.stringify(hub.data)).toBe(201)
  const hubId = hub.data.hub.id
  // One language by default: no spoken menu for the call to sit through.
  expect((await apiPatch(request, `/hubs/${hubId}/settings/ivr-languages`, { enabledLanguages: languages })).status).toBe(200)

  const configured = await apiPost(request, '/provider-setup/configure', {
    provider: 'asterisk',
    phoneNumber: hotline,
    credentials: {
      ariUrl: WORKER_ARI_URL,
      ariUsername: ARI_USERNAME,
      ariPassword: ARI_PASSWORD,
      bridgeCallbackUrl: WORKER_BRIDGE_URL,
      bridgeSecret: BRIDGE_SECRET,
    },
  })
  expect(configured.status, JSON.stringify(configured.data)).toBe(200)

  const volunteer = await createUserViaApi(request, { name: 'E2E Volunteer', phone: volunteerPhone })
  await addHubMemberViaApi(request, hubId, volunteer.pubkey)
  await setFallbackGroupViaApi(request, [volunteer.pubkey], hubId)
  if (trunk) await createTrunk(request, trunk)
  return { hotline, hubId, volunteer }
}

/** An answered call runs its course: the volunteer answers, talks, hangs up, and both legs are released */
async function expectAnsweredAndCompleted(request: APIRequestContext, hubId: string, caller: string, volunteerPubkey: string) {
  const callerLast4 = caller.slice(-4)
  await expect
    .poll(() => activeCall(request, hubId, callerLast4), { timeout: 30_000, message: 'call answered by the volunteer' })
    .toMatchObject({ answeredBy: volunteerPubkey, status: 'in-progress' })
  await expect
    .poll(() => historyCall(request, hubId, callerLast4), { timeout: 30_000, message: 'call completed in history' })
    .toMatchObject({ answeredBy: volunteerPubkey, status: 'completed' })
  await expect.poll(async () => (await channelsFor(caller)).length, { timeout: 15_000 }).toBe(0)
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

test('the carrier cannot reach the hotline until the operator provisions the SIP trunk', async ({ request }) => {
  const { hotline, hubId, volunteer } = await provisionHotline(request, uniqueNumber('+1555020'), null)
  await removeTrunk()
  expect(await ariStatus('/asterisk/config/dynamic/res_pjsip/endpoint/trunk')).toBe(404)

  // No trunk: the carrier's INVITE matches no endpoint and Asterisk refuses it.
  const refused = uniqueNumber('+1555779')
  const before = carrierCallCounts().processed
  placeCall(refused, hotline, 20)
  await expect
    .poll(carrierCallCounts, { timeout: 15_000, message: 'the carrier gave up on the call' })
    .toEqual({ processed: before + 1, active: 0 })
  expect(await historyCall(request, hubId, refused.slice(-4))).toBeUndefined()
  expect(await activeCall(request, hubId, refused.slice(-4))).toBeUndefined()

  // The operator provisions the trunk; the carrier's next call reaches the hotline.
  await createTrunk(request, { domain: CARRIER_HOST })
  const caller = uniqueNumber('+1555779')
  carrierCli('dialplan set global VOLUNTEER_TALK_SECONDS 4')
  placeCall(caller, hotline, 60)
  await expectAnsweredAndCompleted(request, hubId, caller, volunteer.pubkey)
})

test('a provisioned SIP trunk survives an Asterisk restart', async ({ request }) => {
  const { hotline, hubId, volunteer } = await provisionHotline(request, uniqueNumber('+1555020'))

  execFileSync('docker', ['restart', HOTLINE_PBX])
  // Back once the bridge has re-registered its Stasis app with the new Asterisk.
  await expect
    .poll(async () => {
      try {
        return (await ari<Array<{ name: string }>>('/applications')).map((a) => a.name)
      } catch {
        return []
      }
    }, { timeout: 60_000, message: 'the bridge reconnected to the restarted PBX' })
    .toContain('llamenos')

  // Nothing re-provisioned the trunk: the call is routed by the one written before the restart.
  const caller = uniqueNumber('+1555780')
  carrierCli('dialplan set global VOLUNTEER_TALK_SECONDS 4')
  placeCall(caller, hotline, 60)
  await expectAnsweredAndCompleted(request, hubId, caller, volunteer.pubkey)
})

test('a registration trunk registers with the credentials the carrier issued, and routes a call both ways', async ({ request }) => {
  const { hotline, hubId, volunteer } = await provisionHotline(request, uniqueNumber('+1555020'), {
    domain: CARRIER_HOST,
    username: CARRIER_ISSUED_USERNAME,
    password: CARRIER_ISSUED_PASSWORD,
  })

  // The carrier accepted the hotline's REGISTER: it holds a contact for the trunk.
  await expect
    .poll(() => carrierCli('pjsip show contacts'), { timeout: 30_000, message: 'the hotline registered with the carrier' })
    .toMatch(/Contact:\s+hotline-reg\/sip:hotline-reg@/)

  // Inbound to the registered contact; outbound to the volunteer authenticates
  // with the same credentials (the carrier challenges the hotline-reg endpoint).
  const caller = uniqueNumber('+1555781')
  carrierCli('dialplan set global VOLUNTEER_TALK_SECONDS 4')
  placeCall(caller, hotline, 60, 'registration')
  await expectAnsweredAndCompleted(request, hubId, caller, volunteer.pubkey)
})

// ---- What the caller hears ----

/** An admin-signed request header, for a body the JSON helpers cannot send */
function adminAuthorization(method: string, path: string): string {
  const pubkey = seedHexToPubkey(ADMIN_SEED)
  const timestamp = Date.now()
  const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(16)))
  const message = utf8ToBytes(`${LABEL_DEVICE_AUTH}:${pubkey}:${timestamp}:${method}:${path}:${nonce}`)
  const token = bytesToHex(ed25519.sign(message, hexToBytes(ADMIN_SEED)))
  return `Bearer ${JSON.stringify({ pubkey, timestamp, token, nonce })}`
}

/** The operator uploads a prompt through the settings API, as the admin UI does */
async function uploadPrompt(request: APIRequestContext, promptType: string, language: string, body: Uint8Array, contentType: string) {
  const path = `/api/settings/ivr-audio/${promptType}/${language}`
  const res = await request.put(path, {
    headers: { Authorization: adminAuthorization('PUT', path), 'Content-Type': contentType },
    data: Buffer.from(body),
  })
  return { status: res.status(), body: await res.text() }
}

/** The caller's next call is recorded, as heard, under this name (carrier/extensions.conf [caller-hears]) */
function recordNextCallAs(name: string): void {
  carrierCli(`dialplan set global HEARD_AS ${name}`)
}

/** What the caller heard on the call recorded under `name`: 8 kHz 16-bit samples, or null before it exists */
function heard(name: string): Int16Array | null {
  let wav: Buffer
  try {
    wav = execFileSync('docker', ['exec', CARRIER, 'cat', `/tmp/heard-${name}.wav`], { stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
  const data = wav.indexOf('data')
  if (data < 0) return null
  const pcm = wav.subarray(data + 8)
  return new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + (pcm.byteLength & ~1)))
}

const TONE_HZ = 1000
const WINDOW = 800

/** The 100 ms windows of 8 kHz audio in which a `hz` tone (Goertzel) is clearly present */
function toneWindows(samples: Int16Array, hz: number): number[] {
  const coeff = 2 * Math.cos((2 * Math.PI * hz) / IVR_WAV_SAMPLE_RATE)
  const windows: number[] = []
  for (let start = 0; start + WINDOW <= samples.length; start += WINDOW) {
    let s1 = 0
    let s2 = 0
    for (let i = 0; i < WINDOW; i++) {
      const s0 = samples[start + i] + coeff * s1 - s2
      s2 = s1
      s1 = s0
    }
    const amplitude = (2 * Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2))) / WINDOW
    // The upload is at half scale (~16 000); anything near silence is far below this.
    if (amplitude > 2_000) windows.push(start / WINDOW)
  }
  return windows
}

/** Seconds of a `hz` test tone in 8 kHz audio */
function toneSeconds(samples: Int16Array, hz = TONE_HZ): number {
  return (toneWindows(samples, hz).length * WINDOW) / IVR_WAV_SAMPLE_RATE
}

/** When, in seconds into the call, a `hz` tone is first heard */
function toneOnset(samples: Int16Array, hz: number): number {
  const first = toneWindows(samples, hz)[0]
  if (first === undefined) throw new Error(`no ${hz} Hz tone was heard`)
  return (first * WINDOW) / IVR_WAV_SAMPLE_RATE
}

/** A 2 s PCM WAV test tone at `hz`, as the admin UI uploads it */
function testTone(hz: number): Uint8Array {
  const tone = Float32Array.from({ length: 2 * IVR_WAV_SAMPLE_RATE }, (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / IVR_WAV_SAMPLE_RATE))
  return encodePcm16Wav(tone, IVR_WAV_SAMPLE_RATE)
}

/** The caller dials, the hotline turns them away; returns what they heard once the call has ended */
async function callTurnedAway(caller: string, hotline: string, name: string): Promise<Int16Array> {
  recordNextCallAs(name)
  const before = carrierCallCounts().processed
  placeCall(caller, hotline, 30)
  // The hotline ends the call itself, long before the caller would have hung up.
  await expect
    .poll(carrierCallCounts, { timeout: 20_000, message: `the hotline ended call ${name}` })
    .toEqual({ processed: before + 1, active: 0 })
  await expect.poll(() => heard(name) !== null, { timeout: 5_000, message: `the carrier's recording of ${name}` }).toBe(true)
  const audio = heard(name)
  if (!audio) throw new Error(`the carrier's recording of ${name} disappeared`)
  return audio
}

test('a turned-away caller hears the prompt the operator uploaded, fetched by the PBX from the app', async ({ request }) => {
  const { hotline, hubId } = await provisionHotline(request, uniqueNumber(UNANSWERED_PREFIX))
  // Rate limiting: one call a minute.
  expect((await apiPatch(request, `/hubs/${hubId}/settings/spam`, { rateLimitEnabled: true, maxCallsPerMinute: 1 })).status).toBe(200)

  // The first call uses up the caller's budget: routed as usual, nobody answers, they hang up.
  const caller = uniqueNumber('+1555782')
  placeCall(caller, hotline, 4)
  await expect
    .poll(() => historyCall(request, hubId, caller.slice(-4)), { timeout: 30_000, message: 'the first call ended' })
    .toMatchObject({ status: 'unanswered' })
  await expect.poll(carrierCallCounts, { timeout: 15_000 }).toMatchObject({ active: 0 })

  // No prompt uploaded: the hotline tells the caller why, in its own generated voice (#1347).
  const rateLimited = generatedSpeech('en', 'prompt:rateLimited')
  const spoken = await callTurnedAway(caller, hotline, `${caller}-none`)
  expectHeard(spoken, [rateLimited])

  // A browser recording is refused, whatever it says it is; a PCM WAV is accepted.
  const webm = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81])
  expect(await uploadPrompt(request, 'rateLimited', 'en', webm, 'audio/wav')).toEqual({ status: 400, body: JSON.stringify({ error: 'Not a WAV file' }) })
  const uploaded = await uploadPrompt(request, 'rateLimited', 'en', testTone(TONE_HZ), 'audio/wav')
  expect(uploaded.status, uploaded.body).toBe(200)

  try {
    // Now the caller hears the whole 2 s prompt before the hotline hangs up —
    // the operator's recording, instead of the generated one.
    const told = await callTurnedAway(caller, hotline, `${caller}-uploaded`)
    expect(toneSeconds(told)).toBeGreaterThanOrEqual(1.5)
    expect(findClip(told, rateLimited)?.score ?? 0).toBeLessThan(0.3)
  } finally {
    await apiDelete(request, '/settings/ivr-audio/rateLimited/en')
  }
})

/** Distinct tones, so the recording shows which prompt the caller heard, and in what order */
const GREETING_HZ = 600
const HOLD_HZ = 1400

test('a caller hears the uploaded greeting, then the hold message, before they are queued', async ({ request }) => {
  const { hotline, hubId } = await provisionHotline(request, uniqueNumber(UNANSWERED_PREFIX))

  // The keys the admin UI uploads (voice-prompts-section.tsx): what a cloud
  // provider plays, the PBX must play too (#1346).
  for (const [promptType, hz] of [['greeting', GREETING_HZ], ['pleaseHold', HOLD_HZ]] as const) {
    const uploaded = await uploadPrompt(request, promptType, 'en', testTone(hz), 'audio/wav')
    expect(uploaded.status, uploaded.body).toBe(200)
  }

  try {
    const caller = uniqueNumber('+1555783')
    const name = `${caller}-queued`
    recordNextCallAs(name)
    placeCall(caller, hotline, 10)
    await expect
      .poll(() => activeCall(request, hubId, caller.slice(-4)), { timeout: 20_000, message: 'the caller is queued and ringing' })
      .toMatchObject({ status: 'ringing' })
    await expect
      .poll(() => historyCall(request, hubId, caller.slice(-4)), { timeout: 30_000, message: 'the caller hung up' })
      .toMatchObject({ status: 'unanswered' })
    await expect.poll(() => heard(name) !== null, { timeout: 5_000, message: `the carrier's recording of ${name}` }).toBe(true)
    const audio = heard(name)
    if (!audio) throw new Error(`the carrier's recording of ${name} disappeared`)

    // Both whole 2 s prompts, greeting first.
    expect(toneSeconds(audio, GREETING_HZ)).toBeGreaterThanOrEqual(1.5)
    expect(toneSeconds(audio, HOLD_HZ)).toBeGreaterThanOrEqual(1.5)
    expect(toneOnset(audio, GREETING_HZ)).toBeLessThan(toneOnset(audio, HOLD_HZ))
  } finally {
    await apiDelete(request, '/settings/ivr-audio/greeting/en')
    await apiDelete(request, '/settings/ivr-audio/pleaseHold/en')
  }
})

/**
 * The clip the app serves as generated speech for a prompt (`prompt:<key>`)
 * or a language-menu option (`menu:<digit>`) in `locale`, fetched through the
 * signed URL the worker hands the PBX (fetch-speech.ts).
 */
function generatedSpeech(locale: string, spec: string): { locale: string; text: string; samples: Int16Array } {
  const out = execFileSync('bun', [fileURLToPath(new URL('fetch-speech.ts', import.meta.url)), locale, spec], { encoding: 'utf8' })
  const { text, wav } = JSON.parse(out.trim().split('\n').pop() ?? '') as { text: string; wav: string }
  return { locale, text, samples: wavSamples(Buffer.from(wav, 'base64')) }
}

/** Each clip was heard whole, in this order: the samples the app served, through the phone line */
function expectHeard(recording: Int16Array, clips: Array<{ locale: string; text: string; samples: Int16Array }>): void {
  let previous = -1
  for (const clip of clips) {
    const match = findClip(recording, clip.samples)
    const what = `${clip.locale}: "${clip.text}"`
    expect(match?.score ?? 0, `the caller heard ${what}`).toBeGreaterThan(0.9)
    expect(match!.at, `${what} after the clip before it`).toBeGreaterThan(previous)
    previous = match!.at
  }
}

/** A caller who presses nothing, on a hub with a language menu, until they hang up; returns what they heard */
async function callThroughMenu(request: APIRequestContext, hubId: string, caller: string, hotline: string): Promise<Int16Array> {
  const name = `${caller}-menu`
  recordNextCallAs(name)
  placeCall(caller, hotline, 30)
  await expect
    .poll(() => historyCall(request, hubId, caller.slice(-4)), { timeout: 60_000, message: 'the caller hung up' })
    .toMatchObject({ status: 'unanswered' })
  await expect.poll(() => heard(name) !== null, { timeout: 5_000, message: `the carrier's recording of ${name}` }).toBe(true)
  const audio = heard(name)
  if (!audio) throw new Error(`the carrier's recording of ${name} disappeared`)
  return audio
}

test('a caller in a language nobody recorded hears the menu and every prompt, generated by the hotline (#1347)', async ({ request }) => {
  // Spanish and French, and not one uploaded prompt.
  const { hotline, hubId } = await provisionHotline(request, uniqueNumber(UNANSWERED_PREFIX), undefined, ['es', 'fr'])
  // A French number: pressing nothing, the caller is served in the language their number suggests.
  const audio = await callThroughMenu(request, hubId, uniqueNumber('+3361'), hotline)

  expectHeard(audio, [
    generatedSpeech('es', 'menu:1'),
    generatedSpeech('fr', 'menu:2'),
    generatedSpeech('fr', 'prompt:greeting'),
    generatedSpeech('fr', 'prompt:pleaseHold'),
  ])
})

test('a caller whose language no offline voice speaks is spoken to in the declared fallback, not in noise (#1347)', async ({ request }) => {
  const { hotline, hubId } = await provisionHotline(request, uniqueNumber(UNANSWERED_PREFIX), undefined, ['es', 'fr'])
  // A Philippine number: Tagalog, which espeak-ng cannot speak — so English (SPEECH_FALLBACK_LANGUAGE).
  const audio = await callThroughMenu(request, hubId, uniqueNumber('+6391'), hotline)

  expectHeard(audio, [
    generatedSpeech('en', 'prompt:greeting'),
    generatedSpeech('en', 'prompt:pleaseHold'),
  ])
})
