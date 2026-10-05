/**
 * Demo dataset BDD steps.
 *
 * Seeds the fixed fictional dataset through the dev route (same seeder the demo
 * reset endpoint runs) and verifies it through the real authenticated API as the
 * demo accounts themselves. Note/call decryption uses an independent HPKE
 * implementation (hpke-js) and the desktop client's wire format — so this checks
 * what the server sealed, not the server's own code path.
 *
 * The reset endpoint's success path needs DEMO_MODE=true on the server, which this
 * shared dev server deliberately does not run; its refusals and its wiring are
 * covered here and in unit tests, and the success path against a demo-mode server
 * is documented in the PR.
 *
 * The demo accounts' signing keys are generated per server process and never
 * committed, so the seeding step asks the server under test for them through
 * the secret-gated dev route and keeps them on the scenario's world.
 */
import { expect } from '@playwright/test'
import { CipherSuite, KemId, KdfId, AeadId } from 'hpke-js'
import { gcm } from '@noble/ciphers/aes.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { When, Then, After, getState, setState } from './fixtures'
import { getSharedState, setLastResponse } from './shared-state'
import { apiGet, apiPost, devDelete, devGet, devPost, seedHexToPubkey } from '../../api-helpers'
import { LABEL_CALL_META, LABEL_DEVICE_ENCRYPTION_SEED, LABEL_NOTE_KEY } from '@shared/crypto-labels'
import { DEMO_CALLS, DEMO_HUB } from '@worker/lib/demo-dataset'
import type { CallRecord } from '@protocol/schemas/calls'

const HUB = DEMO_HUB.id
const KEY = 'demo_dataset'

interface Counts {
  calls: number
  notes: number
  shifts: number
  contacts: number
  cases: number
  conversations: number
  audit: number
}

interface DemoCredential {
  name: string
  pubkey: string
  seedHex: string
}

interface DemoState {
  counts?: Counts
  identities?: DemoCredential[]
}

function state(world: Record<string, unknown>): DemoState {
  let s = getState<DemoState | undefined>(world, KEY)
  if (!s) {
    s = {}
    setState(world, KEY, s)
  }
  return s
}

function account(world: Record<string, unknown>, name: string): DemoCredential {
  const identities = state(world).identities
  if (!identities) throw new Error('Demo identities are fetched by "the demo dataset is seeded" — run that step first')
  const found = identities.find(i => i.name === name)
  if (!found) throw new Error(`Unknown demo account ${name}`)
  return found
}

const ADMIN = (world: Record<string, unknown>) => account(world, 'Demo Admin')
const VOLUNTEER = (world: Record<string, unknown>) => account(world, 'James Chen')

const hpke = new CipherSuite({ kem: KemId.DhkemX25519HkdfSha256, kdf: KdfId.HkdfSha256, aead: AeadId.Aes256Gcm })

function base64urlToBytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64url'))
}

/** Decrypt content sealed for a demo account: HPKE-open the key wrap (empty AAD), then AES-256-GCM (iv || ct, no AAD). */
async function decryptFor(
  seedHex: string,
  encryptedContent: string,
  envelope: { enc: string; ct: string },
  label: string,
): Promise<string> {
  const encryptionSeed = hkdf(sha256, hexToBytes(seedHex), new Uint8Array(0), utf8ToBytes(LABEL_DEVICE_ENCRYPTION_SEED), 32)
  const recipientKey = await hpke.importKey('raw', new Uint8Array(encryptionSeed).buffer, false)
  const contentKey = await hpke.open(
    { recipientKey, enc: hexToBytes(envelope.enc), info: utf8ToBytes(label) },
    new Uint8Array(base64urlToBytes(envelope.ct)).buffer,
  )
  const packed = hexToBytes(encryptedContent)
  return new TextDecoder().decode(gcm(new Uint8Array(contentKey), packed.slice(0, 12)).decrypt(packed.slice(12)))
}

interface NoteRow {
  authorPubkey: string
  callId: string
  encryptedContent: string
  authorEnvelope: { enc: string; ct: string }
  adminEnvelopes: Array<{ pubkey: string; enc: string; ct: string }>
}

const noteTextByCallId = new Map(DEMO_CALLS.filter(c => c.note).map(c => [`demo-${c.key}`, JSON.stringify({ text: c.note })]))

async function listNotes(request: Parameters<typeof apiGet>[0], seedHex: string): Promise<NoteRow[]> {
  const { status, data } = await apiGet<{ notes: NoteRow[] }>(request, `/hubs/${HUB}/notes?limit=100`, seedHex)
  expect(status).toBe(200)
  return data.notes
}

async function countRows(request: Parameters<typeof apiGet>[0], world: Record<string, unknown>): Promise<Counts> {
  const seed = ADMIN(world).seedHex
  const get = async <T>(path: string) => {
    const res = await apiGet<T>(request, `/hubs/${HUB}${path}`, seed)
    expect(res.status, path).toBe(200)
    return res.data
  }
  return {
    calls: (await get<{ total: number }>('/calls/history?limit=100')).total,
    notes: (await get<{ total: number }>('/notes?limit=100')).total,
    shifts: (await get<{ shifts: unknown[] }>('/shifts')).shifts.length,
    contacts: (await get<{ contacts: unknown[] }>('/directory?limit=100')).contacts.length,
    cases: (await get<{ records: unknown[] }>('/records?limit=100')).records.length,
    conversations: (await get<{ conversations: unknown[] }>('/conversations?limit=100')).conversations.length,
    audit: (await get<{ total: number }>('/audit?limit=100')).total,
  }
}

After({ tags: '@demo-dataset' }, async ({ request }) => {
  await devDelete(request, '/test-seed-demo')
})

// ── Seeding ──────────────────────────────────────────────────────

When('the demo dataset is seeded', async ({ request, world }) => {
  const { status } = await devPost(request, '/test-seed-demo', {})
  expect(status).toBe(200)
  const res = await devGet<{ identities: DemoCredential[] }>(request, '/test-demo-identities')
  expect(res.status).toBe(200)
  for (const identity of res.data.identities) expect(seedHexToPubkey(identity.seedHex)).toBe(identity.pubkey)
  state(world).identities = res.data.identities
})

// ── Counts ───────────────────────────────────────────────────────

Then('the demo hub has {int} calls in its history', async ({ request, world }, expected: number) => {
  const { status, data } = await apiGet<{ total: number; calls: unknown[] }>(request, `/hubs/${HUB}/calls/history?limit=100`, ADMIN(world).seedHex)
  expect(status).toBe(200)
  expect(data.total).toBe(expected)
  expect(data.calls).toHaveLength(expected)
})

Then('the demo hub has {int} shifts covering all {int} days', async ({ request, world }, shiftCount: number, dayCount: number) => {
  const { status, data } = await apiGet<{ shifts: Array<{ days: number[] }> }>(request, `/hubs/${HUB}/shifts`, ADMIN(world).seedHex)
  expect(status).toBe(200)
  expect(data.shifts).toHaveLength(shiftCount)
  const days = new Set(data.shifts.flatMap(s => s.days))
  expect([...days].sort()).toEqual(Array.from({ length: dayCount }, (_, i) => i))
})

Then('the demo volunteer is on shift now', async ({ request, world }) => {
  const { status, data } = await apiGet<{ onShift: boolean; currentShift: { encryptedName: string } | null }>(
    request, `/hubs/${HUB}/shifts/my-status`, VOLUNTEER(world).seedHex,
  )
  expect(status).toBe(200)
  expect(data.onShift).toBe(true)
  expect(data.currentShift).not.toBeNull()
})

Then('the demo hub has {int} contacts', async ({ request, world }, expected: number) => {
  const { status, data } = await apiGet<{ contacts: unknown[] }>(request, `/hubs/${HUB}/directory?limit=100`, ADMIN(world).seedHex)
  expect(status).toBe(200)
  expect(data.contacts).toHaveLength(expected)
})

Then('the demo hub has {int} cases', async ({ request, world }, expected: number) => {
  const { status, data } = await apiGet<{ records: unknown[] }>(request, `/hubs/${HUB}/records?limit=100`, ADMIN(world).seedHex)
  expect(status).toBe(200)
  expect(data.records).toHaveLength(expected)
})

Then('the demo hub has one conversation for each configured messaging channel', async ({ request, world }) => {
  const config = await request.get('/api/config')
  const { channels } = await config.json() as { channels: Record<string, boolean> }
  const messagingChannels = ['sms', 'whatsapp', 'signal', 'rcs', 'telegram']
  const configured = messagingChannels.filter(c => channels[c]).sort()
  expect(configured.length).toBeGreaterThan(0)

  const { status, data } = await apiGet<{ conversations: Array<{ channelType: string }> }>(
    request, `/hubs/${HUB}/conversations?limit=100`, ADMIN(world).seedHex,
  )
  expect(status).toBe(200)
  expect(data.conversations.map(c => c.channelType).sort()).toEqual(configured)
})

Then('the demo hub audit log is a valid hash chain with entries', async ({ request, world }) => {
  const list = await apiGet<{ total: number }>(request, `/hubs/${HUB}/audit?limit=100`, ADMIN(world).seedHex)
  expect(list.status).toBe(200)
  expect(list.data.total).toBeGreaterThan(0)
  const verify = await apiGet<{ valid: boolean; totalEntries: number }>(request, `/hubs/${HUB}/audit/verify`, ADMIN(world).seedHex)
  expect(verify.status).toBe(200)
  expect(verify.data.valid).toBe(true)
  expect(verify.data.totalEntries).toBe(list.data.total)
})

// ── Idempotency ──────────────────────────────────────────────────

When('the demo hub row counts are recorded', async ({ request, world }) => {
  state(world).counts = await countRows(request, world)
})

Then('the demo hub row counts are unchanged', async ({ request, world }) => {
  const before = state(world).counts
  expect(before).toBeDefined()
  expect(await countRows(request, world)).toEqual(before)
})

// ── Decryption round-trips ───────────────────────────────────────

Then('every note written by the demo volunteer decrypts to its authored text for that volunteer', async ({ request, world }) => {
  const volunteer = VOLUNTEER(world)
  const notes = await listNotes(request, volunteer.seedHex)
  const expected = DEMO_CALLS.filter(c => c.note && c.answeredBy === 'james')
  expect(notes).toHaveLength(expected.length)
  expect(notes.length).toBeGreaterThan(0)
  for (const note of notes) {
    expect(note.authorPubkey).toBe(volunteer.pubkey)
    const plaintext = await decryptFor(volunteer.seedHex, note.encryptedContent, note.authorEnvelope, LABEL_NOTE_KEY)
    expect(plaintext).toBe(noteTextByCallId.get(note.callId))
  }
})

Then('every demo note decrypts to its authored text for the demo admin', async ({ request, world }) => {
  const admin = ADMIN(world)
  const notes = await listNotes(request, admin.seedHex)
  expect(notes).toHaveLength(noteTextByCallId.size)
  for (const note of notes) {
    const envelope = note.adminEnvelopes.find(e => e.pubkey === admin.pubkey)
    expect(envelope, `admin envelope for ${note.callId}`).toBeDefined()
    const plaintext = await decryptFor(admin.seedHex, note.encryptedContent, envelope!, LABEL_NOTE_KEY)
    expect(plaintext).toBe(noteTextByCallId.get(note.callId))
  }
})

Then('every demo call record decrypts for the demo admin with the fictional caller number', async ({ request, world }) => {
  const admin = ADMIN(world)
  const { status, data } = await apiGet<{ calls: CallRecord[] }>(
    request, `/hubs/${HUB}/calls/history?limit=100`, admin.seedHex,
  )
  expect(status).toBe(200)
  expect(data.calls).toHaveLength(DEMO_CALLS.length)
  for (const call of data.calls) {
    const envelope = call.adminEnvelopes?.find(e => e.pubkey === admin.pubkey)
    expect(envelope, `admin envelope for ${call.id}`).toBeDefined()
    expect(call.encryptedContent, `encrypted metadata for ${call.id}`).toBeTruthy()
    const meta = JSON.parse(await decryptFor(admin.seedHex, call.encryptedContent!, envelope!, LABEL_CALL_META)) as { answeredBy: string | null; callerNumber: string }
    expect(meta.callerNumber).toBe(`+1555555${call.callerLast4}`)
    expect(meta.callerNumber).toMatch(/^\+155555501\d\d$/)
  }
})

Then('the demo volunteer sees only their own notes and the demo admin sees all of them', async ({ request, world }) => {
  const volunteerNotes = await listNotes(request, VOLUNTEER(world).seedHex)
  const adminNotes = await listNotes(request, ADMIN(world).seedHex)
  expect(volunteerNotes.length).toBeGreaterThan(0)
  expect(volunteerNotes.length).toBeLessThan(adminNotes.length)
  expect(volunteerNotes.every(n => n.authorPubkey === VOLUNTEER(world).pubkey)).toBe(true)
  expect(new Set(adminNotes.map(n => n.authorPubkey)).size).toBeGreaterThan(1)
})

// ── Demo reset endpoint ──────────────────────────────────────────

When('the demo admin requests a demo reset', async ({ request, world }) => {
  setLastResponse(world, await apiPost(request, '/demo/reset', {}, ADMIN(world).seedHex))
})

When('the demo volunteer requests a demo reset', async ({ request, world }) => {
  setLastResponse(world, await apiPost(request, '/demo/reset', {}, VOLUNTEER(world).seedHex))
})

When('an unauthenticated client requests a demo reset', async ({ request, world }) => {
  const res = await request.post('/api/demo/reset', { data: {} })
  setLastResponse(world, { status: res.status(), data: await res.json().catch(() => null) })
  expect(getSharedState(world).lastResponse).toBeDefined()
})
