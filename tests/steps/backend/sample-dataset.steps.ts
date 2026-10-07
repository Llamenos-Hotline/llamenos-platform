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
import { bytesToHex } from '@noble/hashes/utils.js'
import { When, Then, After, getState, setState } from './fixtures'
import { apiGet, devDelete, devGet, devPost, seedHexToPubkey } from '../../api-helpers'
import { decryptContent, importedDeviceHpkeRecipient, unwrapKey } from '../../crypto-helpers'
import { LABEL_CALL_META, LABEL_NOTE_KEY } from '@shared/crypto-labels'
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

function base64urlToHex(value: string): string {
  return bytesToHex(new Uint8Array(Buffer.from(value, 'base64url')))
}

/**
 * Decrypt content the sample seeder sealed for a sample account.
 *
 * `apps/worker/lib/sample-crypto.ts` writes the **canonical** envelope format —
 * `contentAad(label)` on the content layer, `keyWrapAad(label)` on the key wrap
 * — for every label it uses, LABEL_CALL_META included. This reader used to pass
 * an empty AAD on both layers, which is the *stored-record* convention
 * (`apps/worker/lib/crypto.ts`), and so could never open anything the seeder
 * wrote: both sample-dataset decryption scenarios failed with `OpenError`. Which of the
 * two conventions applies is a property of the writer, never of the label — see
 * `@shared/envelope-aad`.
 *
 * It now goes through the shared canonical readers instead of a second
 * hand-rolled HPKE suite, so there is one implementation to keep correct.
 *
 * Sample accounts are imported-device identities: their X25519 key is HKDF'd from
 * the signing seed, exactly as the desktop derives it on `device_import_and_load`.
 */
async function decryptFor(
  seedHex: string,
  encryptedContent: string,
  envelope: { enc: string; ct: string },
  label: string,
): Promise<string> {
  const reader = importedDeviceHpkeRecipient(seedHex)
  const contentKey = await unwrapKey(base64urlToHex(envelope.ct), envelope.enc, reader.skHex, label)
  return decryptContent(encryptedContent, contentKey, label)
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
    const plaintext = await decryptFor(volunteer.seedHex, note.encryptedContent, note.authorEnvelope, LABEL_NOTE_KEY)
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
    const plaintext = await decryptFor(admin.seedHex, note.encryptedContent, envelope!, LABEL_NOTE_KEY)
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
    const meta = JSON.parse(await decryptFor(admin.seedHex, call.encryptedContent!, envelope!, LABEL_CALL_META)) as { answeredBy: string | null; callerNumber: string }
    expect(meta.callerNumber).toBe(`+1555555${call.callerLast4}`)
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
