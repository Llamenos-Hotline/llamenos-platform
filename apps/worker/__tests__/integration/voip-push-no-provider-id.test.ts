/**
 * #2374 — an incoming call's VoIP push must not carry the telephony provider's call id,
 * and the push must still lead a client to the right call.
 *
 * `active_calls.call_id` is the provider's identifier for the call (the webhook's
 * `CallSid`): a key into the provider's CDR, which holds the caller's number. The VoIP
 * push used to put it, with the caller's last four digits, into the payload sent to APNs
 * and to ntfy — so Apple (holding the key and the device it reached) and the provider
 * (holding the key and the number) could be compelled to assemble a caller's identity from
 * two parties we do not control, on every incoming call, with nothing failing.
 *
 * This drives the production path: the real `startParallelRinging` → the real
 * `createServices` registry on real PostgreSQL → the real `dispatchVoipPushFromService`
 * → the real APNs client and `NtfyClient`. Only the network is replaced (`fetch`), and it is
 * replaced by a recorder that keeps every byte that would have left: URL, headers and body.
 * A test that only checked "a push was sent" passes against the leak.
 *
 * The other half is the hard bound: a push that cannot be matched is a missed crisis call.
 * The client's only handle on the call is the push's `call-id`, so the same test resolves it
 * the way a woken client does — through the calls API, hub-scoped — and answers the call it
 * found.
 *
 * Requires postgres at DATABASE_URL; each run creates and drops its own database.
 */

// pg-array-patch must be imported before any schema is loaded.
import '../../db/pg-array-patch'
import '../mocks/llamenos-crypto-ffi'

import { generateKeyPairSync } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { KIND_CALL_RING } from '@shared/event-kinds'
import { callRecordResponseSchema } from '@protocol/schemas/calls'
import type { WsEventMessage } from '@protocol/schemas/ws-messages'
import { insertHubFounder } from '../helpers/hub-founder'
import type { Database } from '../../db'
import * as schema from '../../db/schema'
import { createServices, type Services } from '../../services'
import { startParallelRinging } from '../../services/ringing'
import { initConnectionManager, type ConnectionState } from '../../lib/ws-manager'
import callsRoutes from '../../routes/calls'
import type { AppEnv, Env } from '../../types'

vi.mock('@llamenos/crypto/ffi', async () => await import('../mocks/llamenos-crypto-ffi'))

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

const DB_NAME = `voip_push_ref_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
const HMAC_SECRET = 'a'.repeat(64)

// What a Twilio/SignalWire call looks like, and the UUID form the other providers use.
// (`call_id` is the primary key, so each test mints its own.)
const twilioSid = () => `CA${crypto.randomUUID().replaceAll('-', '')}`
const uuidCallId = () => crypto.randomUUID()
const CALLER_NUMBER = '+15557654321'
const CALLER_LAST4 = '4321'

const IOS_VOIP_TOKEN = 'ios-voip-token-0123456789abcdef'
const NTFY_ENDPOINT = 'http://ntfy.test:80/up-voip-endpoint'

function urlFor(name: string): string {
  const url = new URL(DATABASE_URL)
  url.pathname = `/${name}`
  return url.toString()
}

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })

const env = {
  ENVIRONMENT: 'test',
  HMAC_SECRET,
  SERVER_KEK: 'c'.repeat(64),
  APNS_KEY_P8: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
  APNS_KEY_ID: 'TESTKEYID',
  APNS_TEAM_ID: 'TESTTEAMID',
  NTFY_URL: 'http://ntfy.test:80',
} as Env

let sql: ReturnType<typeof postgres>
let db: Database
let services: Services
let counter = 0
const nextId = () => `${++counter}-${Math.random().toString(36).slice(2, 8)}`

/** Everything one outbound request would have put on the wire. */
interface Sent {
  channel: 'apns' | 'ntfy'
  url: string
  headers: string
  body: string
}

let sent: Sent[] = []
let fetchSpy: ReturnType<typeof vi.spyOn>

function record(input: unknown, init?: RequestInit): void {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
  const headers = init?.headers instanceof Headers
    ? [...init.headers.entries()]
    : Object.entries((init?.headers ?? {}) as Record<string, string>)
  sent.push({
    channel: url.startsWith(NTFY_ENDPOINT) ? 'ntfy' : 'apns',
    url,
    headers: JSON.stringify(headers),
    body: typeof init?.body === 'string' ? init.body : String(init?.body ?? ''),
  })
}

/** The `call-id` / `hub-id` pair a client reads out of a VoIP push body. */
function pushedCall(s: Sent): { callId: string; hubId: string; type: string } {
  const payload = JSON.parse(s.body) as Record<string, string>
  return { callId: payload['call-id'], hubId: payload['hub-id'], type: payload.type }
}

function everythingSent(): string {
  return sent.map(s => `${s.url}\n${s.headers}\n${s.body}`).join('\n')
}

async function createHub(): Promise<string> {
  const id = `hub-${nextId()}`
  await services.settings.createHub({
    id, name: `Hub ${id}`, slug: id, status: 'active', createdBy: 'integration-test',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  } as never, await insertHubFounder(db))
  return id
}

/** An on-shift, clocked-in volunteer who takes in-app calls and has an iOS and an Android VoIP token. */
async function createReachableVolunteer(hubId: string): Promise<string> {
  const pubkey = `${(++counter).toString(16).padStart(2, '0')}`.repeat(32)
  await services.identity.createUser({
    pubkey, name: 'Volunteer', phone: '+10000000000', roleIds: ['role-volunteer'],
    encryptedSecretKey: 'not-used-here', hubId,
  })
  await services.identity.updateUser(pubkey, { callPreference: 'browser' } as never, true)
  await services.identity.registerVoipToken(pubkey, { platform: 'ios', voipToken: IOS_VOIP_TOKEN })
  await services.identity.registerVoipToken(pubkey, { platform: 'android', voipToken: NTFY_ENDPOINT })

  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  await services.shifts.create(hubId, {
    id: crypto.randomUUID(),
    encryptedName: 'encrypted-shift-name',
    startTime: `${pad((now.getUTCHours() + 23) % 24)}:00`,
    endTime: `${pad((now.getUTCHours() + 1) % 24)}:00`,
    days: [0, 1, 2, 3, 4, 5, 6],
    userPubkeys: [pubkey],
  } as never)
  await services.activeShifts.clockIn(pubkey, hubId)
  return pubkey
}

/** `GET /calls/active` for a hub, over the real registry — what a client woken by a push calls. */
async function listActiveCalls(hubId: string) {
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('pubkey', 'a'.repeat(64))
    c.set('permissions', ['*'])
    c.set('services', services as unknown as AppEnv['Variables']['services'])
    c.set('allRoles', [])
    c.set('requestId', 'voip-push-ref')
    c.set('hubId', hubId)
    c.env = {} as AppEnv['Bindings']
    await next()
  })
  app.route('/', callsRoutes)
  const res = await app.request('/active')
  expect(res.status).toBe(200)
  const body = await res.json() as { calls: unknown[] }
  return body.calls.map(call => callRecordResponseSchema.parse(call))
}

/** Rings `callSid` in `hubId` and waits until both transports have been handed their push. */
async function ringAndCollectPushes(hubId: string, callSid: string): Promise<void> {
  sent = []
  const result = await startParallelRinging(callSid, CALLER_NUMBER, 'http://localhost', env, services, hubId)
  expect(result, 'the ring itself must succeed for the push to be the thing under test').toEqual({ ringing: true, volunteersNotified: 1 })
  // The push is dispatched fire-and-forget, after the ring returns.
  await vi.waitFor(() => {
    expect(sent.map(s => s.channel).sort()).toEqual(['apns', 'ntfy'])
  })
}

beforeAll(async () => {
  const admin = postgres(DATABASE_URL, { max: 1 })
  try {
    await admin.unsafe(`CREATE DATABASE ${DB_NAME}`)
  } finally {
    await admin.end()
  }
  const migrate = spawnSync('bun', ['--no-env-file', 'scripts/run-migrations.ts'], {
    cwd: REPO_ROOT,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: urlFor(DB_NAME) },
    encoding: 'utf-8',
    timeout: 120_000,
  })
  if (migrate.status !== 0) throw new Error(`migrations failed:\n${migrate.stdout}\n${migrate.stderr}`)

  sql = postgres(urlFor(DB_NAME), { max: 4 })
  db = drizzle(sql, { schema }) as unknown as Database
  services = createServices(db, { hmacSecret: HMAC_SECRET, serverKek: 'c'.repeat(64), env: { ENVIRONMENT: 'test' } })
  await services.settings.ensureInit()
}, 180_000)

afterAll(async () => {
  await sql?.end()
  const admin = postgres(DATABASE_URL, { max: 1 })
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`)
  } finally {
    await admin.end()
  }
}, 60_000)

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    record(input, init)
    return new Response(null, { status: 200 })
  })
})

afterEach(() => {
  fetchSpy.mockRestore()
})

describe.each([
  ['a Twilio-style CallSid', twilioSid],
  ['a UUID call id (Vonage, Plivo, Telnyx, Bandwidth)', uuidCallId],
])('VoIP push for %s', (_label, mintCallId) => {
  let hubId: string
  let volunteer: string
  let providerCallId: string

  beforeEach(async () => {
    providerCallId = mintCallId()
    hubId = await createHub()
    volunteer = await createReachableVolunteer(hubId)
  })

  it('puts nothing the provider issued, and nothing about the caller, on APNs or ntfy', async () => {
    await ringAndCollectPushes(hubId, providerCallId)

    // Both transports were exercised — the assertion below is not vacuous.
    expect(sent.find(s => s.channel === 'apns')?.url).toContain(IOS_VOIP_TOKEN)
    expect(sent.find(s => s.channel === 'ntfy')?.url).toBe(NTFY_ENDPOINT)

    const wire = everythingSent()
    expect(wire).not.toContain(providerCallId)
    expect(wire).not.toContain(providerCallId.toLowerCase())
    expect(wire).not.toContain(providerCallId.toUpperCase())
    expect(wire).not.toContain(CALLER_LAST4)
    expect(wire).not.toContain(CALLER_NUMBER)
    // Nor anything shaped like a provider SID, whatever the value.
    expect(wire).not.toMatch(/\b[A-Z]{2}[0-9a-f]{32}\b/)

    // What is sent is exactly: an incoming-call marker, our hub, and an opaque reference.
    for (const s of sent) {
      // APNs adds its own empty `aps` envelope; nothing of ours rides in it.
      const { aps, ...ours } = JSON.parse(s.body) as { aps?: Record<string, unknown> } & Record<string, string>
      expect(Object.keys(ours).sort()).toEqual(['call-id', 'hub-id', 'type'])
      if (s.channel === 'apns') expect(aps ?? {}).toEqual({})
      else expect(aps).toBeUndefined()
      expect(pushedCall(s)).toMatchObject({ type: 'incoming_call', hubId })
    }
  })

  it('still leads the client to the right call, which it can answer', async () => {
    await ringAndCollectPushes(hubId, providerCallId)

    const pushes = sent.map(pushedCall)
    // Both transports name the same call — the one the volunteer's devices ring for.
    expect(new Set(pushes.map(p => p.callId)).size).toBe(1)
    const [{ callId: ref, hubId: pushHubId }] = pushes

    // A client woken by the push has only `call-id` and `hub-id`. It lists the hub's
    // live calls and matches the reference.
    const resolved = (await listActiveCalls(pushHubId)).filter(call => call.pushRef === ref)
    expect(resolved).toHaveLength(1)
    expect(resolved[0].id).toBe(providerCallId)
    expect(resolved[0].status).toBe('ringing')

    // …and answering what it found takes the call, first pickup wins.
    const answered = await services.calls.answerCall(pushHubId, resolved[0].id, volunteer)
    expect(answered).toMatchObject({ callId: providerCallId, answeredBy: volunteer, status: 'in-progress' })
  })
})

describe('VoIP push — two calls ringing at once', () => {
  it('resolves each push to its own call, never to the other', async () => {
    const hubId = await createHub()
    await createReachableVolunteer(hubId)

    const firstSid = twilioSid()
    await ringAndCollectPushes(hubId, firstSid)
    const first = pushedCall(sent[0]).callId
    const secondSid = twilioSid()
    await ringAndCollectPushes(hubId, secondSid)
    const second = pushedCall(sent[0]).callId

    expect(first).not.toBe(second)
    const live = await listActiveCalls(hubId)
    expect(live.find(call => call.pushRef === first)?.id).toBe(firstSid)
    expect(live.find(call => call.pushRef === second)?.id).toBe(secondSid)
  })

  it('a reference is not derived from the provider id — the same id on a later call gets a new one', async () => {
    const hubIdA = await createHub()
    const hubIdB = await createHub()
    await createReachableVolunteer(hubIdA)
    await createReachableVolunteer(hubIdB)

    const sid = twilioSid()
    await ringAndCollectPushes(hubIdA, sid)
    const inA = pushedCall(sent[0]).callId
    // The provider reuses nothing in practice, but the ref must not be a function of the id:
    // otherwise whoever learned one mapping (Apple + the provider) could compute the next.
    await services.calls.endCall(hubIdA, sid)
    await ringAndCollectPushes(hubIdB, sid)
    const inB = pushedCall(sent[0]).callId

    expect(inA).not.toBe(inB)
  })
})

describe('call:ring relay event', () => {
  it('carries the same reference as the push, so a client holding both can pair them', async () => {
    const hubId = await createHub()
    await createReachableVolunteer(hubId)

    const mgr = initConnectionManager(new Uint8Array(32).fill(7))
    const frames: string[] = []
    const state: ConnectionState = {
      pubkey: 'relay-listener',
      ws: { send: (m: string) => frames.push(m) } as unknown as WebSocket,
      hubs: new Set([hubId]),
      lastReplayAt: 0,
    }
    expect(mgr.register(state)).toBe(true)
    mgr.subscribe(state, hubId, [KIND_CALL_RING])

    const sid = twilioSid()
    await ringAndCollectPushes(hubId, sid)

    const events = frames.map(f => JSON.parse(f) as WsEventMessage).filter(e => e.type === 'event')
    expect(events).toHaveLength(1)
    // No SERVER_SECRET in this env, so the relay payload is plaintext JSON.
    const content = JSON.parse(events[0].payload) as { type: string; callId: string; pushRef: string }
    expect(content).toMatchObject({ type: 'call:ring', callId: sid })
    expect(content.pushRef).toBe(pushedCall(sent[0]).callId)
  })
})
