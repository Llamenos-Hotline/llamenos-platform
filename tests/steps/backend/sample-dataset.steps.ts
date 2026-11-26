/**
 * Sample dataset BDD steps.
 *
 * Seeds the fixed fictional dataset through `POST /api/test-seed-sample` and
 * verifies it through the real authenticated API as the sample accounts
 * themselves. Note/call decryption uses an independent HPKE implementation
 * (hpke-js) and the desktop client's wire format — so this checks what the
 * server sealed, not the server's own code path.
 *
 * The sample accounts' signing keys are generated per server process and never
 * committed, so the seeding step asks the server under test for them through
 * the secret-gated dev route and keeps them on the scenario's world.
 *
 * #1604 removed three further scenarios here that drove `POST /api/demo/reset`,
 * the demo product's admin-authenticated full wipe. The endpoint is gone with
 * demo mode; `POST /api/test-reset` + `POST /api/test-seed-sample` is the
 * surviving equivalent and is covered on the dev surface.
 */
import { expect } from '@playwright/test'
import { hexToBytes } from '@noble/hashes/utils.js'
import { gcm } from '@noble/ciphers/aes.js'
import { When, Then, After, getState, setState } from './fixtures'
import { apiGet, devDelete, devGet, devPost, seedHexToPubkey } from '../../api-helpers'
import { importedDeviceHpkeRecipient } from '../../crypto-helpers'
import { shapeContentAadHexMock, shapeOpenMock } from '../../mocks/hpke-mock'
import type { Shape } from '@shared/crypto-shapes'
import { SAMPLE_CALLS, SAMPLE_HUB } from '@worker/lib/sample-dataset'
import type { CallRecord } from '@protocol/schemas/calls'

const HUB = SAMPLE_HUB.id
const KEY = 'sample_dataset'

interface Counts {
  calls: number
  notes: number
  shifts: number
  contacts: number
  cases: number
  conversations: number
  audit: number
}

interface SampleCredential {
  name: string
  pubkey: string
  seedHex: string
}

interface SampleState {
  counts?: Counts
  identities?: SampleCredential[]
}

function state(world: Record<string, unknown>): SampleState {
  let s = getState<SampleState | undefined>(world, KEY)
  if (!s) {
    s = {}
    setState(world, KEY, s)
  }
  return s
}

function account(world: Record<string, unknown>, name: string): SampleCredential {
  const identities = state(world).identities
  if (!identities) throw new Error('Sample identities are fetched by "the sample dataset is seeded" — run that step first')
  const found = identities.find(i => i.name === name)
  if (!found) throw new Error(`Unknown sample account ${name}`)
  return found
}

const ADMIN = (world: Record<string, unknown>) => account(world, 'Sample Admin')
const VOLUNTEER = (world: Record<string, unknown>) => account(world, 'James Chen')

/**
 * Decrypt content the sample seeder sealed for a sample account, as `shape`.
 *
 * `apps/worker/lib/sample-crypto.ts` seals both layers through the crate's shape
 * API, so the shape decides the label and both AADs (spec D1): the note shape
 * carries the canonical pair, the call-metadata shape the stored-record (empty)
 * pair. This reader opens through the shape mirror in tests/mocks/hpke-mock.ts —
 * pinned byte-for-byte against the crate's v2 vectors — rather than restating
 * either convention here. Envelopes are lowercase hex (spec D2).
 *
 * Sample accounts are imported-device identities: their X25519 key is HKDF'd from
 * the signing seed, exactly as the desktop derives it on `device_import_and_load`.
 */
async function decryptFor(
  seedHex: string,
  encryptedContent: string,
  envelope: { enc: string; ct: string },
  shape: Extract<Shape, 'note-key' | 'call-meta-key'>,
): Promise<string> {
  const reader = importedDeviceHpkeRecipient(seedHex)
  const contentKey = await shapeOpenMock(shape, reader.skHex, [], { enc: envelope.enc, ct: envelope.ct })
  const data = hexToBytes(encryptedContent)
  const aad = hexToBytes(shapeContentAadHexMock(shape))
  return new TextDecoder().decode(gcm(contentKey, data.slice(0, 12), aad).decrypt(data.slice(12)))
}

interface NoteRow {
  authorPubkey: string
  callId: string
  encryptedContent: string
  authorEnvelope: { enc: string; ct: string }
  adminEnvelopes: Array<{ pubkey: string; enc: string; ct: string }>
}

const noteTextByCallId = new Map(SAMPLE_CALLS.filter(c => c.note).map(c => [`sample-${c.key}`, JSON.stringify({ text: c.note })]))

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

After({ tags: '@sample-dataset' }, async ({ request }) => {
  await devDelete(request, '/test-seed-sample')
})

// ── Seeding ──────────────────────────────────────────────────────

When('the sample dataset is seeded', async ({ request, world }) => {
  const { status } = await devPost(request, '/test-seed-sample', {})
  expect(status).toBe(200)
  const res = await devGet<{ identities: SampleCredential[] }>(request, '/test-sample-identities')
  expect(res.status).toBe(200)
  for (const identity of res.data.identities) expect(seedHexToPubkey(identity.seedHex)).toBe(identity.pubkey)
  state(world).identities = res.data.identities
})

// ── Counts ───────────────────────────────────────────────────────

Then('the sample hub has {int} calls in its history', async ({ request, world }, expected: number) => {
  const { status, data } = await apiGet<{ total: number; calls: unknown[] }>(request, `/hubs/${HUB}/calls/history?limit=100`, ADMIN(world).seedHex)
  expect(status).toBe(200)
  expect(data.total).toBe(expected)
  expect(data.calls).toHaveLength(expected)
})

Then('the sample hub has {int} shifts covering all {int} days', async ({ request, world }, shiftCount: number, dayCount: number) => {
  const { status, data } = await apiGet<{ shifts: Array<{ days: number[] }> }>(request, `/hubs/${HUB}/shifts`, ADMIN(world).seedHex)
  expect(status).toBe(200)
  expect(data.shifts).toHaveLength(shiftCount)
  const days = new Set(data.shifts.flatMap(s => s.days))
  expect([...days].sort()).toEqual(Array.from({ length: dayCount }, (_, i) => i))
})

Then('the sample volunteer is on shift now', async ({ request, world }) => {
  const { status, data } = await apiGet<{ onShift: boolean; currentShift: { encryptedName: string } | null }>(
    request, `/hubs/${HUB}/shifts/my-status`, VOLUNTEER(world).seedHex,
  )
  expect(status).toBe(200)
  expect(data.onShift).toBe(true)
  expect(data.currentShift).not.toBeNull()
})

Then('the sample hub has {int} contacts', async ({ request, world }, expected: number) => {
  const { status, data } = await apiGet<{ contacts: unknown[] }>(request, `/hubs/${HUB}/directory?limit=100`, ADMIN(world).seedHex)
  expect(status).toBe(200)
  expect(data.contacts).toHaveLength(expected)
})

Then('the sample hub has {int} cases', async ({ request, world }, expected: number) => {
  const { status, data } = await apiGet<{ records: unknown[] }>(request, `/hubs/${HUB}/records?limit=100`, ADMIN(world).seedHex)
  expect(status).toBe(200)
  expect(data.records).toHaveLength(expected)
})

Then('the sample hub has one conversation for each configured messaging channel', async ({ request, world }) => {
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

Then('the sample hub audit log is a valid hash chain with entries', async ({ request, world }) => {
  const list = await apiGet<{ total: number }>(request, `/hubs/${HUB}/audit?limit=100`, ADMIN(world).seedHex)
  expect(list.status).toBe(200)
  expect(list.data.total).toBeGreaterThan(0)
  const verify = await apiGet<{ valid: boolean; totalEntries: number }>(request, `/hubs/${HUB}/audit/verify`, ADMIN(world).seedHex)
  expect(verify.status).toBe(200)
  expect(verify.data.valid).toBe(true)
  expect(verify.data.totalEntries).toBe(list.data.total)
})

// ── Idempotency ──────────────────────────────────────────────────

When('the sample hub row counts are recorded', async ({ request, world }) => {
  state(world).counts = await countRows(request, world)
})

Then('the sample hub row counts are unchanged', async ({ request, world }) => {
  const before = state(world).counts
  expect(before).toBeDefined()
  expect(await countRows(request, world)).toEqual(before)
})

// ── Decryption round-trips ───────────────────────────────────────

Then('every note written by the sample volunteer decrypts to its authored text for that volunteer', async ({ request, world }) => {
  const volunteer = VOLUNTEER(world)
  const notes = await listNotes(request, volunteer.seedHex)
  const expected = SAMPLE_CALLS.filter(c => c.note && c.answeredBy === 'james')
  expect(notes).toHaveLength(expected.length)
  expect(notes.length).toBeGreaterThan(0)
  for (const note of notes) {
    expect(note.authorPubkey).toBe(volunteer.pubkey)
    const plaintext = await decryptFor(volunteer.seedHex, note.encryptedContent, note.authorEnvelope, 'note-key')
    expect(plaintext).toBe(noteTextByCallId.get(note.callId))
  }
})

Then('every sample note decrypts to its authored text for the sample admin', async ({ request, world }) => {
  const admin = ADMIN(world)
  const notes = await listNotes(request, admin.seedHex)
  expect(notes).toHaveLength(noteTextByCallId.size)
  for (const note of notes) {
    const envelope = note.adminEnvelopes.find(e => e.pubkey === admin.pubkey)
    expect(envelope, `admin envelope for ${note.callId}`).toBeDefined()
    const plaintext = await decryptFor(admin.seedHex, note.encryptedContent, envelope!, 'note-key')
    expect(plaintext).toBe(noteTextByCallId.get(note.callId))
  }
})

Then('every sample call record decrypts for the sample admin with the fictional caller number', async ({ request, world }) => {
  const admin = ADMIN(world)
  const { status, data } = await apiGet<{ calls: CallRecord[] }>(
    request, `/hubs/${HUB}/calls/history?limit=100`, admin.seedHex,
  )
  expect(status).toBe(200)
  expect(data.calls).toHaveLength(SAMPLE_CALLS.length)
  for (const call of data.calls) {
    const envelope = call.adminEnvelopes?.find(e => e.pubkey === admin.pubkey)
    expect(envelope, `admin envelope for ${call.id}`).toBeDefined()
    expect(call.encryptedContent, `encrypted metadata for ${call.id}`).toBeTruthy()
    const meta = JSON.parse(await decryptFor(admin.seedHex, call.encryptedContent!, envelope!, 'call-meta-key')) as { answeredBy: string | null; callerNumber: string }
    const sample = SAMPLE_CALLS.find(c => `sample-${c.key}` === call.id)
    expect(sample, `sample call for ${call.id}`).toBeDefined()
    expect(meta.callerNumber).toBe(sample!.callerNumber)
    expect(call).not.toHaveProperty('callerLast4')
    expect(meta.callerNumber).toMatch(/^\+155555501\d\d$/)
  }
})

Then('the sample volunteer sees only their own notes and the sample admin sees all of them', async ({ request, world }) => {
  const volunteerNotes = await listNotes(request, VOLUNTEER(world).seedHex)
  const adminNotes = await listNotes(request, ADMIN(world).seedHex)
  expect(volunteerNotes.length).toBeGreaterThan(0)
  expect(volunteerNotes.length).toBeLessThan(adminNotes.length)
  expect(volunteerNotes.every(n => n.authorPubkey === VOLUNTEER(world).pubkey)).toBe(true)
  expect(new Set(adminNotes.map(n => n.authorPubkey)).size).toBeGreaterThan(1)
})
