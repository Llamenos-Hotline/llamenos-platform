/**
 * End-to-end: a call RINGS a volunteer's registered in-app endpoint.
 *
 *   volunteer's app ──REGISTER/TLS──▶ Kamailio ──UDP──▶ Asterisk
 *   caller ──INVITE──▶ carrier ──▶ Kamailio ──dispatcher──▶ Asterisk
 *     Asterisk ──▶ bridge ──▶ worker
 *     worker: scheduled ∩ clocked-in → available → reachable at the PBX
 *     worker ──/ring { volunteers, appTargets }──▶ bridge
 *     bridge ──originate PJSIP/vol_<pubkey16>──▶ Asterisk
 *   Asterisk ──INVITE sip:vol_<pubkey16>──▶ the volunteer's app  ◀── THIS
 *
 * Why this test exists: before it, a volunteer's endpoint could REGISTER and
 * was still inert, because nothing in the product ever sent it an INVITE
 * (#1188). Registration was never the hard part. So the assertion is made at
 * the RECEIVING end — the INVITE as the volunteer's UA received it, plus
 * Asterisk's own SIP trace — not that our code called a function.
 *
 * It also pins the two rules that must not drift:
 *   - ring = scheduled_now ∩ clocked_in holds for in-app exactly as for PSTN:
 *     scheduled-but-not-clocked-in gets NO INVITE, and the same volunteer gets
 *     one as soon as they clock in;
 *   - the in-app leg rings ALONGSIDE the phone leg, and whichever loses is
 *     cancelled.
 *
 * Not covered, deliberately: two-way audio. The UA answers 180 Ringing (what a
 * ringing device sends) and declines; answering needs the DTLS-SRTP agreement
 * that is a separate item of #1188.
 *
 * Run with run-inapp-ring-e2e.sh (it starts the app, SIP edge and PBX stack).
 */
import { execFileSync } from 'node:child_process'
import { isIP } from 'node:net'
import { expect, test, type APIRequestContext } from '@playwright/test'
import {
  apiGet,
  apiPatch,
  apiPost,
  addHubMemberViaApi,
  clockInViaApi,
  createShiftViaApi,
  createUserViaApi,
  setFallbackGroupViaApi,
  updateUserViaApi,
} from '../../../../tests/api-helpers'
import { SipUa } from './sip-ua'

const HOTLINE_PBX = process.env.E2E_ASTERISK_CONTAINER ?? 'll-telephony-inapp-e2e-asterisk-1'
const CARRIER = process.env.E2E_CARRIER_CONTAINER ?? 'll-telephony-inapp-e2e-sip-carrier-1'
const CARRIER_HOST = 'sip-carrier'
const WORKER_ARI_URL = process.env.E2E_WORKER_ARI_URL ?? 'http://asterisk:8088'
const WORKER_BRIDGE_URL = process.env.E2E_WORKER_BRIDGE_URL ?? 'http://sip-bridge:3000'
const ARI_REST_URL = process.env.E2E_ARI_REST_URL ?? 'http://127.0.0.1:8088/ari'
const ARI_USERNAME = process.env.ARI_USERNAME ?? 'llamenos'
const ARI_PASSWORD = process.env.ARI_PASSWORD ?? ''
const BRIDGE_SECRET = process.env.BRIDGE_SECRET ?? ''
/** The client-facing TLS listener owned by Kamailio. */
const SIP_EDGE_HOST = process.env.E2E_SIP_EDGE_HOST ?? '127.0.0.1'
const SIP_EDGE_TLS_PORT = Number(process.env.E2E_SIP_EDGE_TLS_PORT ?? 5061)
const KAMAILIO_CONTAINER = process.env.E2E_KAMAILIO_CONTAINER ?? 'll-telephony-inapp-e2e-kamailio-1'
const REGISTRAR_DOMAIN = process.env.E2E_REGISTRAR_DOMAIN ?? '127.0.0.1'

/** Carrier numbers under this prefix ring forever (carrier/extensions.conf) */
const UNANSWERED_PREFIX = '+1555021'

const ARI_AUTH = { Authorization: `Basic ${btoa(`${ARI_USERNAME}:${ARI_PASSWORD}`)}` }

interface SipTokenResponse {
  provider: string
  sip: { domain: string; transport: string; username: string; password: string }
}

interface CallRecord {
  id: string
  callerLast4?: string
  answeredBy?: string | null
  status?: string
}

interface AriChannel {
  id: string
  name: string
  state: string
}

let serial = 0
function uniqueNumber(prefix: string): string {
  serial += 1
  return `${prefix}${String(Date.now() + serial).slice(-6)}`
}

function pbxCli(command: string): string {
  return execFileSync('docker', ['exec', HOTLINE_PBX, 'asterisk', '-rx', command], { encoding: 'utf8' })
}

function carrierCli(command: string): string {
  return execFileSync('docker', ['exec', CARRIER, 'asterisk', '-rx', command], { encoding: 'utf8' })
}

async function configureKamailioIngressForTest(): Promise<void> {
  const kamailioIp = execFileSync(
    'docker',
    ['inspect', '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', KAMAILIO_CONTAINER],
    { encoding: 'utf8' },
  ).trim()
  if (isIP(kamailioIp) !== 4) throw new Error('Could not resolve the test Kamailio container address')

  for (const [type, fields] of [
    ['endpoint', {
      context: 'from-trunk',
      disallow: 'all',
      allow: 'ulaw,alaw',
      direct_media: 'no',
      identify_by: 'ip',
    }],
    ['identify', { endpoint: 'kamailio-ingress', match: kamailioIp }],
  ] as const) {
    const response = await fetch(
      `${ARI_REST_URL}/asterisk/config/dynamic/res_pjsip/${type}/kamailio-ingress`,
      {
        method: 'PUT',
        headers: { ...ARI_AUTH, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: Object.entries(fields).map(([attribute, value]) => ({ attribute, value })) }),
      },
    )
    expect(response.ok, `Asterisk accepts the test ${type} configuration`).toBe(true)
  }
}

/** The caller dials the hotline and stays on the line for `holdSeconds`. */
function placeCall(caller: string, hotline: string, holdSeconds: number): void {
  carrierCli(`dialplan set global CALLER_NUMBER ${caller}`)
  carrierCli(`channel originate Local/${hotline}@place-call application Wait ${holdSeconds}`)
}

/**
 * The PBX's own SIP trace since `since`. `pjsip set logger on` writes every
 * SIP message the PBX sends and receives to its console, which is this
 * container's stdout — the receiving end's account of what was dialled.
 */
function pbxSipLog(since: string): string {
  return execFileSync('docker', ['logs', '--since', since, HOTLINE_PBX], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  })
}

async function ari<T>(path: string): Promise<T> {
  const res = await fetch(`${ARI_REST_URL}${path}`, { headers: ARI_AUTH })
  expect(res.ok, `ARI GET ${path}`).toBe(true)
  return (await res.json()) as T
}

/** ARI's endpoint state — the same read the ringing path makes to decide reachability. */
async function endpointState(username: string): Promise<string> {
  const endpoints = await ari<Array<{ resource?: string; state?: string }>>('/endpoints/PJSIP')
  return endpoints.find((e) => e.resource === username)?.state ?? 'absent'
}

/** Channels the PBX has towards volunteer app endpoints right now. */
async function inAppChannels(): Promise<AriChannel[]> {
  const channels = await ari<AriChannel[]>('/channels')
  return channels.filter((c) => c.name.startsWith('PJSIP/vol_'))
}

async function activeCall(request: APIRequestContext, hubId: string, callerLast4: string): Promise<CallRecord | undefined> {
  const { data } = await apiGet<{ calls: CallRecord[] }>(request, `/hubs/${hubId}/calls/active`)
  return data.calls?.find((c) => c.callerLast4 === callerLast4)
}

async function historyCall(request: APIRequestContext, hubId: string, callerLast4: string): Promise<CallRecord | undefined> {
  const { data } = await apiGet<{ calls: CallRecord[] }>(request, `/hubs/${hubId}/calls/history`)
  return data.calls?.find((c) => c.callerLast4 === callerLast4)
}

/**
 * A hub served by this Asterisk with its SIP trunk to the carrier, and one
 * volunteer who takes calls on both their phone and in the app. Nobody is on
 * shift and the fallback group is empty: each test establishes the roster it
 * needs, so the shift rule is never satisfied by accident.
 */
async function provisionHotline(request: APIRequestContext, volunteerPhone: string) {
  const hotline = uniqueNumber('+1555010')
  const hub = await apiPost<{ hub: { id: string } }>(request, '/hubs', {
    name: `In-app ring E2E ${hotline}`,
    phoneNumber: hotline,
  })
  expect(hub.status, 'the test hotline hub is created').toBe(201)
  const hubId = hub.data.hub.id
  // One language: no spoken menu for the call to sit through.
  expect((await apiPatch(request, `/hubs/${hubId}/settings/ivr-languages`, { enabledLanguages: ['en'] })).status).toBe(200)

  const configured = await apiPost(request, '/provider-setup/configure', {
    provider: 'asterisk',
    phoneNumber: hotline,
    credentials: {
      ariUrl: WORKER_ARI_URL,
      ariUsername: ARI_USERNAME,
      ariPassword: ARI_PASSWORD,
      bridgeCallbackUrl: WORKER_BRIDGE_URL,
      bridgeSecret: BRIDGE_SECRET,
      sipDomain: REGISTRAR_DOMAIN,
    },
  })
  expect(configured.status, 'Asterisk provider configuration succeeds').toBe(200)

  const trunk = await apiPost(request, '/provider-setup/create-sip-trunk', { provider: 'asterisk', domain: CARRIER_HOST })
  expect(trunk.status, 'the test carrier trunk is configured').toBe(200)

  const volunteer = await createUserViaApi(request, { name: 'In-app E2E Volunteer', phone: volunteerPhone })
  await addHubMemberViaApi(request, hubId, volunteer.pubkey)
  // 'both': the volunteer takes calls on their phone AND in the app. Phone-only
  // is the default, and it refuses a SIP token outright (#1188).
  await updateUserViaApi(request, volunteer.pubkey, { callPreference: 'both' })
  await setFallbackGroupViaApi(request, [], hubId)
  return { hotline, hubId, volunteer }
}

/**
 * The volunteer's app: fetch its SIP credential, REGISTER over verified TLS
 * through Kamailio, and wait until the PBX reports the endpoint `online` — the
 * state the ringing path requires, which depends on the UA answering OPTIONS.
 */
async function registerVolunteerApp(
  request: APIRequestContext,
  volunteer: { pubkey: string; seedHex: string },
): Promise<{ ua: SipUa; aor: string }> {
  const token = await apiGet<SipTokenResponse>(request, '/telephony/sip-token', volunteer.seedHex)
  expect(token.status, 'the volunteer SIP token is issued').toBe(200)
  const aor = `vol_${volunteer.pubkey.slice(0, 16)}`
  expect(token.data.sip.username).toBe(aor)

  const ua = await SipUa.connect({
    host: SIP_EDGE_HOST,
    port: SIP_EDGE_TLS_PORT,
    domain: REGISTRAR_DOMAIN,
    username: token.data.sip.username,
    password: token.data.sip.password,
    caPem: sipEdgeTrustAnchor(),
  })
  expect(await ua.register(), 'REGISTER with the issued credential').toBe(200)
  await expect
    .poll(() => endpointState(aor), { timeout: 60_000, message: 'the PBX reports the volunteer endpoint online' })
    .toBe('online')
  return { ua, aor }
}

function sipEdgeTrustAnchor(): string {
  const pem = execFileSync(
    'docker',
    ['exec', KAMAILIO_CONTAINER, 'cat', '/var/lib/llamenos/sip-tls/kamailio.pem'],
    { encoding: 'utf8' },
  )
  if (!pem.includes('-----BEGIN CERTIFICATE-----') || pem.includes('PRIVATE KEY')) {
    throw new Error('Kamailio did not publish a certificate-only SIP TLS trust anchor')
  }
  return pem
}

/** A shift covering every hour of every day, so "scheduled now" is unambiguous. */
async function scheduleAlwaysOn(request: APIRequestContext, hubId: string, pubkey: string): Promise<void> {
  await createShiftViaApi(request, {
    hubId,
    // start == end is the 24-hour window: a 00:00–23:59 shift is off-shift at
    // 23:59 UTC, which has bitten this codebase before.
    startTime: '00:00',
    endTime: '00:00',
    days: [0, 1, 2, 3, 4, 5, 6],
    userPubkeys: [pubkey],
  })
}

test.beforeAll(async () => {
  // Every SIP message the PBX sends and receives, in its container log: the
  // receiving end's own account of the INVITE.
  pbxCli('pjsip set logger on')
  await configureKamailioIngressForTest()
})

test('a call INVITEs the volunteer\'s registered app, alongside their phone, and cancels the leg that loses', async ({ request }) => {
  // A phone that rings forever, so the in-app leg is not racing a pickup.
  const { hotline, hubId, volunteer } = await provisionHotline(request, uniqueNumber(UNANSWERED_PREFIX))
  await scheduleAlwaysOn(request, hubId, volunteer.pubkey)
  await clockInViaApi(request, hubId, volunteer.seedHex)

  const { ua, aor } = await registerVolunteerApp(request, volunteer)
  const since = new Date().toISOString()
  try {
    const caller = uniqueNumber('+1555779')
    const callerLast4 = caller.slice(-4)
    placeCall(caller, hotline, 60)

    await expect
      .poll(() => activeCall(request, hubId, callerLast4), { timeout: 30_000, message: 'the call is ringing' })
      .toMatchObject({ status: 'ringing' })

    // THE ASSERTION THIS TEST EXISTS FOR: an INVITE arrived at the volunteer's
    // own endpoint, addressed to their AOR — read at the receiving end.
    const invite = await ua.waitForRequest('INVITE', 45_000)
    expect(invite, 'the volunteer\'s registered endpoint received an INVITE').not.toBeNull()
    if (!invite) throw new Error('no INVITE')
    expect(invite.uri).toContain(`sip:${aor}`)
    // The caller's number is not carried into the app: its UI shows the last
    // four, from the push, and the INVITE does not widen that.
    expect(invite.raw).not.toContain(caller)

    // The PBX's own SIP trace agrees — the same INVITE, from its side.
    expect(pbxSipLog(since)).toContain(`INVITE sip:${aor}@`)

    // Both legs rang: the in-app channel is up at the PBX while the phone
    // leg rings on at the carrier.
    expect((await inAppChannels()).length, 'one in-app leg at the PBX').toBe(1)
    expect(carrierCli('core show channels count')).not.toMatch(/^0 active calls/m)

    // The losing leg is cancelled. The volunteer declines in the app, and the
    // PBX tears that leg down without touching the caller or the phone leg.
    ua.declineInvite(invite)
    await expect
      .poll(async () => (await inAppChannels()).length, { timeout: 20_000, message: 'the declined in-app leg is gone' })
      .toBe(0)
    await expect
      .poll(() => activeCall(request, hubId, callerLast4), { timeout: 20_000, message: 'the caller is still being rung' })
      .toMatchObject({ status: 'ringing' })
  } finally {
    ua.close()
  }
})

test('a volunteer who is scheduled but has not clocked in gets no INVITE — and gets one as soon as they do', async ({ request }) => {
  // A phone that rings forever, so the in-app INVITE is the only thing this
  // test is waiting on.
  const { hotline, hubId, volunteer } = await provisionHotline(request, uniqueNumber(UNANSWERED_PREFIX))
  await scheduleAlwaysOn(request, hubId, volunteer.pubkey)

  const { ua, aor } = await registerVolunteerApp(request, volunteer)
  try {
    // Scheduled, registered, reachable — and NOT clocked in.
    const firstCaller = uniqueNumber('+1555780')
    placeCall(firstCaller, hotline, 30)
    await expect
      .poll(() => activeCall(request, hubId, firstCaller.slice(-4)), { timeout: 30_000, message: 'the call reached the hub' })
      .toMatchObject({ status: 'ringing' })

    expect(
      await ua.waitForRequest('INVITE', 20_000),
      'a volunteer who has not clocked in must not be INVITEd',
    ).toBeNull()
    expect(await inAppChannels()).toEqual([])
    await expect
      .poll(() => historyCall(request, hubId, firstCaller.slice(-4)), { timeout: 60_000, message: 'the call ends unanswered' })
      .toMatchObject({ status: 'unanswered' })

    // The volunteer's own consent arrives: now the same call rings them.
    // Without this half the test would pass for any reason at all.
    await clockInViaApi(request, hubId, volunteer.seedHex)
    const secondCaller = uniqueNumber('+1555781')
    placeCall(secondCaller, hotline, 60)

    const invite = await ua.waitForRequest('INVITE', 45_000)
    expect(invite, 'a clocked-in volunteer is INVITEd').not.toBeNull()
    expect(invite?.uri).toContain(`sip:${aor}`)
    if (invite) ua.declineInvite(invite)
  } finally {
    ua.close()
  }
})
