/**
 * Tier 2 (spec §8) — the desktop voice stack, end to end, against the real
 * edge, PBX and relay (#1770). Run with run-desktop-sip-e2e.sh.
 *
 *   carrier ──INVITE──▶ Kamailio ──▶ Asterisk ──▶ bridge ──▶ worker ──/ring──▶ bridge
 *   Asterisk ──INVITE sip:vol_<pubkey16> over TLS via Kamailio──▶ llamenos-voice
 *   llamenos-voice ──DTLS-SRTP, ICE forced onto the TURN relay──▶ coturn ──▶ Asterisk
 *
 * The client is apps/desktop/voice/examples/sip_e2e — the SAME VoiceCore the
 * desktop shell drives, with file-backed audio instead of a sound card. What is
 * asserted, and where it is measured:
 *
 *   - audio the CLIENT sent reached the caller: a tone the client plays is
 *     found in the carrier's own recording of what the caller heard;
 *   - audio the CALLER sent reached the client: a different tone the carrier
 *     plays is found in the client's recording of what it received;
 *   - both directions crossed the relay: the client's ICE pair is `relay`, and
 *     the PBX's own RTP trace shows packets received from, and sent to, the
 *     relay's allocation address;
 *   - the media was DTLS-SRTP: Asterisk's own SIP trace has the SAVPF profile
 *     and a real fingerprint on both sides of the in-app leg;
 *   - the credential never touched disk: a client that registers and then
 *     abort()s — no shutdown, no destructors — leaves no file anywhere under its
 *     HOME containing the SIP password or the TURN credential.
 *
 * Receiving-end evidence on every claim: the client believing it is configured
 * correctly is not evidence (the three #1188 defects all looked like that).
 */
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type APIRequestContext } from '@playwright/test'
import { encodePcm16Wav } from '../../../../src/client/lib/ivr-wav'
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
import { wavSamples } from './audio-match'

const HOTLINE_PBX = process.env.E2E_ASTERISK_CONTAINER ?? 'll-desktop-sip-e2e-asterisk-1'
const CARRIER = process.env.E2E_CARRIER_CONTAINER ?? 'll-desktop-sip-e2e-sip-carrier-1'
const KAMAILIO_CONTAINER = process.env.E2E_KAMAILIO_CONTAINER ?? 'll-desktop-sip-e2e-kamailio-1'
const CARRIER_HOST = 'sip-carrier'
const WORKER_ARI_URL = process.env.E2E_WORKER_ARI_URL ?? 'http://asterisk:8088'
const WORKER_BRIDGE_URL = process.env.E2E_WORKER_BRIDGE_URL ?? 'http://sip-bridge:3000'
const ARI_REST_URL = process.env.E2E_ARI_REST_URL ?? 'http://127.0.0.1:38089/ari'
const ARI_USERNAME = process.env.ARI_USERNAME ?? 'llamenos'
const ARI_PASSWORD = process.env.ARI_PASSWORD ?? ''
const BRIDGE_SECRET = process.env.BRIDGE_SECRET ?? ''
const REGISTRAR_DOMAIN = process.env.E2E_REGISTRAR_DOMAIN ?? '127.0.0.1'
const CLIENT = process.env.E2E_SIP_CLIENT ?? ''
const CLIENT_LIB = process.env.E2E_SIP_CLIENT_LIB ?? ''
const EVIDENCE_DIR = process.env.E2E_EVIDENCE_DIR ?? mkdtempSync(join(tmpdir(), 'desktop-sip-evidence-'))
const ARI_AUTH = { Authorization: `Basic ${btoa(`${ARI_USERNAME}:${ARI_PASSWORD}`)}` }

/** Carrier numbers under this prefix ring forever (carrier/extensions.conf): the in-app leg is the one that answers. */
const UNANSWERED_PREFIX = '+1555021'
/** The tone the CLIENT sends, and the tone the CALLER sends — distinct, and far from the hotline's own prompts. */
const CLIENT_TONE_HZ = 1500
const CALLER_TONE_HZ = 440
const TALK_SECONDS = 10

test.setTimeout(240_000)

interface SipTokenResponse {
  provider: string
  sip: {
    domain: string
    transport: string
    username: string
    password: string
    mediaEncryption: string
    iceServers: Array<{ url: string; username?: string; credential?: string }>
    tlsTrustAnchorPem?: string
  }
}

let serial = 0
function uniqueNumber(prefix: string): string {
  serial += 1
  return `${prefix}${String(Date.now() + serial).slice(-6)}`
}

const pbxCli = (command: string) => execFileSync('docker', ['exec', HOTLINE_PBX, 'asterisk', '-rx', command], { encoding: 'utf8' })
const carrierCli = (command: string) => execFileSync('docker', ['exec', CARRIER, 'asterisk', '-rx', command], { encoding: 'utf8' })

function pbxSipLog(since: string): string {
  const raw = execFileSync('docker', ['logs', '--since', since, HOTLINE_PBX], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  })
  // Same normalisation as run-android-sip-e2e.sh: colour escapes, CRLF, and
  // Asterisk's "[timestamp] " prefix on every line.
  return raw
    .split('\n')
    .map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').replace(/\r$/, '').replace(/^\[[0-9-]+ [0-9:.]+\] /, ''))
    .join('\n')
}

/** The trace cut into whole SIP messages on pjsip's "<--- Transmitting/Received … --->" markers. */
function sipMessages(trace: string): string[] {
  return trace
    .split(/^<--- (?:Transmitting|Received) SIP (?:request|response).*$/m)
    .slice(1)
    .map((m) => m.trim())
}

async function ari<T>(path: string): Promise<T> {
  const res = await fetch(`${ARI_REST_URL}${path}`, { headers: ARI_AUTH })
  expect(res.ok, `ARI GET ${path}`).toBe(true)
  return (await res.json()) as T
}

async function endpointState(username: string): Promise<string> {
  const endpoints = await ari<Array<{ resource?: string; state?: string }>>('/endpoints/PJSIP')
  return endpoints.find((e) => e.resource === username)?.state ?? 'absent'
}

async function configureKamailioIngressForTest(): Promise<void> {
  const kamailioIp = execFileSync(
    'docker',
    ['inspect', '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', KAMAILIO_CONTAINER],
    { encoding: 'utf8' },
  ).trim()
  if (isIP(kamailioIp) !== 4) throw new Error('Could not resolve the test Kamailio container address')
  for (const [type, fields] of [
    ['endpoint', { context: 'from-trunk', disallow: 'all', allow: 'ulaw,alaw', direct_media: 'no', identify_by: 'ip' }],
    ['identify', { endpoint: 'kamailio-ingress', match: kamailioIp }],
  ] as const) {
    const response = await fetch(`${ARI_REST_URL}/asterisk/config/dynamic/res_pjsip/${type}/kamailio-ingress`, {
      method: 'PUT',
      headers: { ...ARI_AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: Object.entries(fields).map(([attribute, value]) => ({ attribute, value })) }),
    })
    expect(response.ok, `Asterisk accepts the test ${type} configuration`).toBe(true)
  }
}

/** A hub on this Asterisk with its carrier trunk, and one volunteer who takes phone AND in-app calls, on shift. */
async function provisionOnShiftVolunteer(request: APIRequestContext) {
  const hotline = uniqueNumber('+1555011')
  const hub = await apiPost<{ hub: { id: string } }>(request, '/hubs', { name: `Desktop SIP E2E ${hotline}`, phoneNumber: hotline })
  expect(hub.status, 'the test hotline hub is created').toBe(201)
  const hubId = hub.data.hub.id
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
  expect((await apiPost(request, '/provider-setup/create-sip-trunk', { provider: 'asterisk', domain: CARRIER_HOST })).status).toBe(200)

  const volunteer = await createUserViaApi(request, { name: 'Desktop SIP E2E Volunteer', phone: uniqueNumber(UNANSWERED_PREFIX) })
  await addHubMemberViaApi(request, hubId, volunteer.pubkey)
  await updateUserViaApi(request, volunteer.pubkey, { callPreference: 'both' })
  await setFallbackGroupViaApi(request, [], hubId)
  // start == end is the 24-hour window (a 00:00–23:59 shift is off-shift at 23:59 UTC).
  await createShiftViaApi(request, { hubId, startTime: '00:00', endTime: '00:00', days: [0, 1, 2, 3, 4, 5, 6], userPubkeys: [volunteer.pubkey] })
  await clockInViaApi(request, hubId, volunteer.seedHex)
  return { hotline, hubId, volunteer }
}

/** The REAL credential, as the shell would fetch it, written where only this test reads it. */
async function issueCredential(request: APIRequestContext, seedHex: string, name: string) {
  const token = await apiGet<SipTokenResponse>(request, '/telephony/sip-token', seedHex)
  expect(token.status, 'the volunteer SIP token is issued').toBe(200)
  const { sip } = token.data
  expect(sip.transport).toBe('tls')
  expect(sip.mediaEncryption).toBe('dtls-srtp')
  expect(sip.tlsTrustAnchorPem).toContain('-----BEGIN CERTIFICATE-----')
  const turn = sip.iceServers.find((s) => s.url.startsWith('turn:') && s.username && s.credential)
  expect(turn, 'a TURN relay with a time-limited credential is issued').toBeTruthy()
  const path = join(EVIDENCE_DIR, `${name}-sip-params.json`)
  writeFileSync(path, JSON.stringify(sip))
  chmodSync(path, 0o600)
  return { sip, path, turnCredential: turn?.credential ?? '' }
}

interface ClientRun {
  lines: string[]
  exited: Promise<number | null>
  waitFor(prefix: string, timeoutMs: number): Promise<string>
}

/**
 * Start the headless client with an isolated HOME/XDG tree, so ANY file
 * liblinphone writes — in its state dir or at an ambient default — is under
 * `home`. Core dumps off: a crash-mode dump would itself hold the password.
 */
function startClient(home: string, env: Record<string, string>): ClientRun {
  const child = spawn('bash', ['-c', 'ulimit -c 0; exec "$0"', CLIENT], {
    cwd: home,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: home,
      XDG_DATA_HOME: join(home, '.local/share'),
      XDG_CONFIG_HOME: join(home, '.config'),
      LD_LIBRARY_PATH: CLIENT_LIB,
      SIP_E2E_STATE_DIR: join(home, 'voice-state'),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const lines: string[] = []
  const waiters: Array<{ prefix: string; resolve: (l: string) => void }> = []
  const onLine = (line: string) => {
    lines.push(line)
    for (const w of waiters.filter((w) => line.startsWith(w.prefix))) {
      waiters.splice(waiters.indexOf(w), 1)
      w.resolve(line)
    }
  }
  let buffered = ''
  child.stdout.on('data', (chunk: Buffer) => {
    buffered += chunk.toString()
    const parts = buffered.split('\n')
    buffered = parts.pop() ?? ''
    parts.forEach(onLine)
  })
  child.stderr.on('data', (chunk: Buffer) => lines.push(...chunk.toString().split('\n').filter(Boolean).map((l) => `stderr: ${l}`)))
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code, signal) => resolve(signal ? null : code)))
  return {
    lines,
    exited,
    waitFor(prefix, timeoutMs) {
      const seen = lines.find((l) => l.startsWith(prefix))
      if (seen) return Promise.resolve(seen)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`client never printed ${prefix}:\n${lines.join('\n')}`)), timeoutMs)
        waiters.push({ prefix, resolve: (l) => { clearTimeout(timer); resolve(l) } })
        void exited.then(() => {
          const late = lines.find((l) => l.startsWith(prefix))
          clearTimeout(timer)
          if (late) resolve(late)
          else reject(new Error(`client exited before printing ${prefix}:\n${lines.join('\n')}`))
        })
      })
    },
  }
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? filesUnder(p) : [p]
  })
}

/** A `seconds`-long 16-bit mono tone at 8 kHz. */
function toneWav(hz: number, seconds: number): Uint8Array {
  const rate = 8000
  return encodePcm16Wav(Float32Array.from({ length: seconds * rate }, (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / rate)), rate)
}

function wavRate(wav: Uint8Array): number {
  return new DataView(wav.buffer, wav.byteOffset, wav.byteLength).getUint32(24, true)
}

/** Seconds of audio, in 100 ms windows, in which a `hz` tone clearly dominates (Goertzel). */
function toneSeconds(samples: Int16Array, rate: number, hz: number): number {
  const window = Math.round(rate / 10)
  const coeff = 2 * Math.cos((2 * Math.PI * hz) / rate)
  let windows = 0
  for (let start = 0; start + window <= samples.length; start += window) {
    let s1 = 0
    let s2 = 0
    for (let i = 0; i < window; i++) {
      const s0 = samples[start + i] + coeff * s1 - s2
      s2 = s1
      s1 = s0
    }
    const amplitude = (2 * Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2))) / window
    if (amplitude > 2_000) windows++
  }
  return windows / 10
}

function carrierHeard(name: string): Uint8Array | null {
  try {
    return execFileSync('docker', ['exec', CARRIER, 'cat', `/tmp/heard-${name}.wav`], { stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

/** The relay's address (run-desktop-sip-e2e.sh) and the relay port range coturn allocates from (docker-compose.dev.yml). */
const TURN_RELAY_IP = process.env.TURN_RELAY_IP ?? ''
const RELAY_PORTS = { min: Number(process.env.TURN_RELAY_MIN_PORT ?? 49160), max: Number(process.env.TURN_RELAY_MAX_PORT ?? 49200) }

/**
 * RTP the PBX itself exchanged with the TURN relay since `since`, from
 * Asterisk's own `rtp set debug` trace: packets it received FROM, and sent TO,
 * an address:port inside coturn's relay allocation range. The PBX's account,
 * not the client's — the client saying "relay" is not evidence on its own.
 */
function rtpViaRelay(since: string): { got: number; sent: number } {
  const trace = pbxSipLog(since)
  const viaRelay = (re: RegExp) =>
    [...trace.matchAll(re)].filter((m) => m[1] === TURN_RELAY_IP && Number(m[2]) >= RELAY_PORTS.min && Number(m[2]) <= RELAY_PORTS.max).length
  return {
    got: viaRelay(/Got\s+RTP packet from\s+([\d.]+):(\d+)/g),
    sent: viaRelay(/Sent RTP packet to\s+([\d.]+):(\d+)/g),
  }
}

test.beforeAll(async () => {
  expect(CLIENT, 'E2E_SIP_CLIENT names the built sip_e2e binary (run-desktop-sip-e2e.sh)').not.toBe('')
  expect(TURN_RELAY_IP, 'TURN_RELAY_IP names the relay address (run-desktop-sip-e2e.sh)').not.toBe('')
  pbxCli('pjsip set logger on')
  pbxCli('rtp set debug on')
  await configureKamailioIngressForTest()
})

test('a client that registers and then dies uncleanly leaves the credential on no file anywhere', async ({ request }) => {
  const { volunteer } = await provisionOnShiftVolunteer(request)
  const { path, sip, turnCredential } = await issueCredential(request, volunteer.seedHex, 'abort')
  const home = mkdtempSync(join(tmpdir(), 'desktop-sip-home-'))

  const run = startClient(home, { SIP_E2E_PARAMS: path, SIP_E2E_MODE: 'abort-after-register' })
  // Registered first — otherwise the scan below proves nothing.
  await run.waitFor('SIP_E2E_REGISTERED_ABORTING', 60_000)
  expect(await run.exited, 'abort() is a signal death, not an exit').toBeNull()

  const files = filesUnder(home)
  for (const secret of [sip.password, turnCredential]) {
    const holders = files.filter((f) => readFileSync(f).includes(Buffer.from(secret)))
    expect(holders, 'no file under the client HOME holds a credential after an unclean exit').toEqual([])
  }
})

test('the desktop media path carries audio both ways through the TURN relay, DTLS-SRTP end to end (echo call)', async ({ request }) => {
  // The plan's Tier 2 shape (Task 5): the client calls the PBX's echo target,
  // so everything it sends must come back — its OWN recording then proves
  // the path in both directions, with nothing on the far side but Asterisk.
  const { volunteer } = await provisionOnShiftVolunteer(request)
  const { path, sip } = await issueCredential(request, volunteer.seedHex, 'echo')
  const home = mkdtempSync(join(tmpdir(), 'desktop-sip-home-'))
  const play = join(EVIDENCE_DIR, 'echo-sends.wav')
  const record = join(EVIDENCE_DIR, 'echo-heard.wav')
  writeFileSync(play, toneWav(CLIENT_TONE_HZ, 60))
  const since = new Date().toISOString()

  const run = startClient(home, {
    SIP_E2E_PARAMS: path,
    SIP_E2E_MODE: 'echo',
    SIP_E2E_ECHO_URI: `sip:e2eecho@${sip.domain}`,
    SIP_E2E_PLAY_WAV: play,
    SIP_E2E_RECORD_WAV: record,
    SIP_E2E_TALK_SECS: String(TALK_SECONDS),
    SIP_E2E_FORCE_RELAY: '1',
  })
  try {
    await run.waitFor('SIP_E2E_REGISTERED', 60_000)
    await run.waitFor('SIP_E2E_ACTIVE', 60_000)
    expect(await run.exited, `the client measured RTP both ways and exited cleanly:\n${run.lines.join('\n')}`).toBe(0)

    // (1) The client's own counters, and the ICE pair the media used.
    const stats = run.lines.find((l) => l.startsWith('SIP_E2E_STATS')) ?? ''
    expect(stats).toContain('media_path=Some(Relay)')
    expect(Number(/rtp_packets_received=(\d+)/.exec(stats)?.[1])).toBeGreaterThan(100)
    expect(Number(/rtp_packets_sent=(\d+)/.exec(stats)?.[1])).toBeGreaterThan(100)

    // (2) The client's tone went out AND came back: it is in what the client
    // received, which only the echo of what it sent can put there.
    const heard = new Uint8Array(readFileSync(record))
    expect(toneSeconds(wavSamples(heard), wavRate(heard), CLIENT_TONE_HZ), 'seconds of its own tone the client heard echoed').toBeGreaterThanOrEqual(3)

    // (3) Through OUR relay, by the PBX's own RTP trace: media arrived from,
    // and was sent to, the relay's allocation — in both directions.
    const relayed = rtpViaRelay(since)
    expect(relayed.got, 'RTP packets the PBX received from the TURN relay').toBeGreaterThan(100)
    expect(relayed.sent, 'RTP packets the PBX sent to the TURN relay').toBeGreaterThan(100)

    // (4) DTLS-SRTP, from Asterisk's own trace: the client's offer and the
    // PBX's answer for this call.
    const trace = pbxSipLog(since)
    writeFileSync(join(EVIDENCE_DIR, 'echo-asterisk-sip.log'), trace)
    const leg = sipMessages(trace).filter((m) => m.includes('e2eecho@'))
    const offer = leg.find((m) => m.startsWith('INVITE sip:e2eecho@') && m.includes('m=audio'))
    const answer = leg.find((m) => m.startsWith('SIP/2.0 200 OK') && m.includes('m=audio'))
    expect(offer, "the client's INVITE reached the PBX with an SDP offer").toBeTruthy()
    expect(answer, "the PBX answered with SDP").toBeTruthy()
    for (const sdp of [offer ?? '', answer ?? '']) {
      expect(sdp).toMatch(/^m=audio \d+ UDP\/TLS\/RTP\/SAVPF? /m)
      expect(sdp).not.toMatch(/^m=audio \d+ RTP\/AVPF? /m)
      expect(sdp).toMatch(/^a=fingerprint:SHA-256 [0-9A-F]{2}:/im)
    }
    expect(offer).toMatch(/^a=candidate.* typ relay/m)
  } finally {
    writeFileSync(join(EVIDENCE_DIR, 'echo-client.log'), run.lines.join('\n'))
  }
})

test('the desktop client answers a real inbound call with two-way audio through the TURN relay', async ({ request }) => {
  const { hotline, volunteer } = await provisionOnShiftVolunteer(request)
  const { path, sip } = await issueCredential(request, volunteer.seedHex, 'answer')
  const aor = sip.username
  const home = mkdtempSync(join(tmpdir(), 'desktop-sip-home-'))
  const play = join(EVIDENCE_DIR, 'client-sends.wav')
  const record = join(EVIDENCE_DIR, 'client-heard.wav')
  writeFileSync(play, toneWav(CLIENT_TONE_HZ, 60))

  const run = startClient(home, {
    SIP_E2E_PARAMS: path,
    SIP_E2E_MODE: 'answer',
    SIP_E2E_PLAY_WAV: play,
    SIP_E2E_RECORD_WAV: record,
    SIP_E2E_TALK_SECS: String(TALK_SECONDS),
    SIP_E2E_FORCE_RELAY: '1',
  })
  try {
    await run.waitFor('SIP_E2E_REGISTERED', 60_000)
    await expect
      .poll(() => endpointState(aor), { timeout: 60_000, message: 'the PBX reports the desktop endpoint online' })
      .toBe('online')

    const since = new Date().toISOString()
    const heardAs = `desktop-${Date.now()}`
    carrierCli(`dialplan set global HEARD_AS ${heardAs}`)
    carrierCli(`dialplan set global CALLER_TONE_HZ ${CALLER_TONE_HZ}`)
    carrierCli(`dialplan set global CALLER_NUMBER ${uniqueNumber('+1555783')}`)
    carrierCli(`channel originate Local/${hotline}@place-call extension s@caller-talks`)

    await run.waitFor('SIP_E2E_INCOMING', 60_000)
    await run.waitFor('SIP_E2E_ACTIVE', 30_000)
    expect(await run.exited, `the client measured RTP both ways and exited cleanly:\n${run.lines.join('\n')}`).toBe(0)
    writeFileSync(join(EVIDENCE_DIR, 'client.log'), run.lines.join('\n'))

    // (1) The client's own counters, and the ICE pair the media used.
    const stats = run.lines.find((l) => l.startsWith('SIP_E2E_STATS')) ?? ''
    expect(stats).toContain('media_path=Some(Relay)')
    expect(Number(/rtp_packets_received=(\d+)/.exec(stats)?.[1])).toBeGreaterThan(100)
    expect(Number(/rtp_packets_sent=(\d+)/.exec(stats)?.[1])).toBeGreaterThan(100)

    // (2) Caller → client: the caller's tone is in what the client recorded.
    const clientHeard = new Uint8Array(readFileSync(record))
    expect(toneSeconds(wavSamples(clientHeard), wavRate(clientHeard), CALLER_TONE_HZ), "seconds of the caller's tone the client received").toBeGreaterThanOrEqual(3)

    // (3) Client → caller: the client's tone is in what the CARRIER recorded
    // the caller hearing — measured at the far end of the PSTN leg.
    carrierCli('channel request hangup all')
    await expect.poll(() => carrierHeard(heardAs) !== null, { timeout: 20_000, message: "the carrier's recording of the call" }).toBe(true)
    const callerHeard = carrierHeard(heardAs) as Uint8Array
    writeFileSync(join(EVIDENCE_DIR, 'caller-heard.wav'), callerHeard)
    expect(toneSeconds(wavSamples(callerHeard), wavRate(callerHeard), CLIENT_TONE_HZ), "seconds of the client's tone the caller heard").toBeGreaterThanOrEqual(3)

    // (4) Through OUR relay, by the PBX's own RTP trace: media arrived from,
    // and was sent to, the relay's allocation — in both directions.
    const relayed = rtpViaRelay(since)
    expect(relayed.got, 'RTP packets the PBX received from the TURN relay').toBeGreaterThan(100)
    expect(relayed.sent, 'RTP packets the PBX sent to the TURN relay').toBeGreaterThan(100)

    // (5) DTLS-SRTP, from the PBX's own SIP trace of the IN-APP leg only (the
    // carrier leg is plain G.711 by design and is excluded by its AOR).
    const trace = pbxSipLog(since)
    writeFileSync(join(EVIDENCE_DIR, 'asterisk-sip.log'), trace)
    const inAppLeg = sipMessages(trace).filter((m) => m.includes(`sip:${aor}@`))
    const offer = inAppLeg.find((m) => m.startsWith(`INVITE sip:${aor}@`) && m.includes('m=audio'))
    const answer = inAppLeg.find((m) => m.startsWith('SIP/2.0 200 OK') && m.includes('m=audio'))
    expect(offer, "the PBX's INVITE to the desktop endpoint carried an SDP offer").toBeTruthy()
    expect(answer, "the desktop client's 200 OK carried an SDP answer").toBeTruthy()
    for (const sdp of [offer ?? '', answer ?? '']) {
      expect(sdp).toMatch(/^m=audio \d+ UDP\/TLS\/RTP\/SAVPF? /m)
      expect(sdp).not.toMatch(/^m=audio \d+ RTP\/AVPF? /m)
      expect(sdp).toMatch(/^a=fingerprint:SHA-256 [0-9A-F]{2}:/im)
    }
    // The client offered the relay it was issued.
    expect(answer).toMatch(/^a=candidate.* typ relay/m)
  } finally {
    writeFileSync(join(EVIDENCE_DIR, 'client.log'), run.lines.join('\n'))
  }
})
