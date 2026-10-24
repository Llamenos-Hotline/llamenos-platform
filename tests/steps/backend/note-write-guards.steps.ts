/**
 * Note and message write guards (#2112, #2113).
 *
 * Every request goes through the real authenticated API as a real volunteer or
 * the real admin; "stored" is asserted from the row in Postgres and from a
 * decrypt with the recipient's own key, not from the status code alone.
 */
import { expect } from '@playwright/test'
import { Given, When, Then, Before, After, getState, setState } from './fixtures'
import {
  apiGet,
  apiPatch,
  apiPost,
  createHubViaApi,
  createVolunteerViaApi,
  deleteHubViaApi,
  uniquePhone,
  ADMIN_SEED,
} from '../../api-helpers'
import {
  adminHpkeRecipient,
  decryptContent,
  encryptContent,
  generateContentKey,
  hpkeRecipientForSeed,
  unwrapKey,
  wrapKeyForRecipient,
} from '../../crypto-helpers'
import { simulateCallForNote, simulateIncomingMessage } from '../../simulation-helpers'
import { TestDB } from '../../db-helpers'
import { LABEL_NOTE_KEY } from '@shared/crypto-labels'

interface Volunteer {
  seedHex: string
  pubkey: string
}

interface SealedNote {
  plaintext: string
  encryptedContent: string
  authorEnvelope: { ct: string; enc: string }
  adminEnvelopes: Array<{ pubkey: string; ct: string; enc: string }>
}

interface GuardState {
  hubs: Record<string, string>
  ownedHubs: string[]
  calls: Record<string, string>
  volunteers: Record<string, Volunteer>
  conversationId?: string
  lastStatus?: number
  lastNoteId?: string
  lastSealed?: SealedNote
}

const STATE_KEY = 'note_write_guards'

function s(world: Record<string, unknown>): GuardState {
  return getState<GuardState>(world, STATE_KEY)
}

function hubId(world: Record<string, unknown>, label: string): string {
  const id = s(world).hubs[label]
  expect(id, `hub "${label}" not set up`).toBeTruthy()
  return id
}

function callId(world: Record<string, unknown>, label: string): string {
  const id = s(world).calls[label]
  expect(id, `call of hub "${label}" not set up`).toBeTruthy()
  return id
}

function volunteer(world: Record<string, unknown>, name: string): Volunteer {
  const v = s(world).volunteers[name]
  expect(v, `volunteer "${name}" not set up`).toBeTruthy()
  return v
}

Before(async ({ world }) => {
  setState<GuardState>(world, STATE_KEY, { hubs: {}, ownedHubs: [], calls: {}, volunteers: {} })
})

After(async ({ request, world }) => {
  for (const id of s(world)?.ownedHubs ?? []) {
    await deleteHubViaApi(request, id)
  }
})

/** Seal `plaintext` the way a client does: one content key, wrapped per recipient. */
async function seal(
  plaintext: string,
  author: Volunteer,
  adminRecipients: Array<{ pubkeyHex: string; skHex: string }>,
): Promise<SealedNote> {
  const contentKey = generateContentKey()
  const encryptedContent = encryptContent(plaintext, contentKey, LABEL_NOTE_KEY)
  const authorKey = hpkeRecipientForSeed(author.seedHex)
  const authorEnvelope = await wrapKeyForRecipient(contentKey, authorKey.pubkeyHex, authorKey.skHex, LABEL_NOTE_KEY)
  const adminEnvelopes = await Promise.all(
    adminRecipients.map(async (r) => ({
      pubkey: r.pubkeyHex,
      ...(await wrapKeyForRecipient(contentKey, r.pubkeyHex, r.skHex, LABEL_NOTE_KEY)),
    })),
  )
  return { plaintext, encryptedContent, authorEnvelope, adminEnvelopes }
}

async function postNote(
  request: import('@playwright/test').APIRequestContext,
  world: Record<string, unknown>,
  author: Volunteer,
  hub: string,
  target: { callId?: string; conversationId?: string },
  sealed: SealedNote,
) {
  const res = await apiPost<{ note?: { id: string } }>(
    request,
    `/hubs/${hub}/notes`,
    {
      ...target,
      encryptedContent: sealed.encryptedContent,
      authorEnvelope: sealed.authorEnvelope,
      adminEnvelopes: sealed.adminEnvelopes,
    },
    author.seedHex,
  )
  s(world).lastStatus = res.status
  s(world).lastNoteId = res.data?.note?.id
  s(world).lastSealed = sealed
  return res
}

// ── Given ───────────────────────────────────────────────────────────

Given('hub {string} and hub {string} exist for note guards', async ({ request, world, workerHub }, a: string, b: string) => {
  const st = s(world)
  st.hubs[a] = workerHub
  const other = await createHubViaApi(request, `bdd-note-guard-${b}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  st.hubs[b] = other
  st.ownedHubs.push(other)
})

Given('a volunteer {string} who is a member of hub {string} for note guards', async ({ request, world }, name: string, hubLabel: string) => {
  const user = await createVolunteerViaApi(request, { name, hubId: hubId(world, hubLabel), phone: uniquePhone() })
  s(world).volunteers[name] = { seedHex: user.seedHex, pubkey: user.pubkey }
})

Given('a call rings in hub {string} for note guards', async ({ request, world }, hubLabel: string) => {
  s(world).calls[hubLabel] = await simulateCallForNote(request, hubId(world, hubLabel))
})

Given('an SMS conversation in hub {string} for note guards', async ({ request, world }, hubLabel: string) => {
  const { conversationId } = await simulateIncomingMessage(request, {
    senderNumber: uniquePhone(),
    body: 'Help, I need assistance',
    channel: 'sms',
    hubId: hubId(world, hubLabel),
  })
  s(world).conversationId = conversationId
})

Given('{string} has posted a well-formed note to hub {string} on the {string} call', async ({ request, world }, name: string, hubLabel: string, callLabel: string) => {
  const vera = volunteer(world, name)
  const sealed = await seal('original note text', vera, [adminHpkeRecipient()])
  const res = await postNote(request, world, vera, hubId(world, hubLabel), { callId: callId(world, callLabel) }, sealed)
  expect(res.status, 'the well-formed note this scenario starts from').toBe(201)
})

// ── When ────────────────────────────────────────────────────────────

When('{string} posts a note to hub {string} on the {string} call with no admin envelopes', async ({ request, world }, name: string, hubLabel: string, callLabel: string) => {
  const vera = volunteer(world, name)
  const sealed = await seal('note nobody could read', vera, [])
  await postNote(request, world, vera, hubId(world, hubLabel), { callId: callId(world, callLabel) }, sealed)
})

When('{string} posts a note to hub {string} on the {string} call sealed only to herself', async ({ request, world }, name: string, hubLabel: string, callLabel: string) => {
  const vera = volunteer(world, name)
  const own = hpkeRecipientForSeed(vera.seedHex)
  // A non-empty set that no admin holds a key for: shape-valid, unreadable by an admin.
  const sealed = await seal('note only its author can read', vera, [own])
  await postNote(request, world, vera, hubId(world, hubLabel), { callId: callId(world, callLabel) }, sealed)
})

When('{string} posts a well-formed note to hub {string} on call {string}', async ({ request, world }, name: string, hubLabel: string, id: string) => {
  const vera = volunteer(world, name)
  const sealed = await seal('note on a call that is not real', vera, [adminHpkeRecipient()])
  await postNote(request, world, vera, hubId(world, hubLabel), { callId: id }, sealed)
})

When('{string} posts a well-formed note to hub {string} on the {string} call', async ({ request, world }, name: string, hubLabel: string, callLabel: string) => {
  const vera = volunteer(world, name)
  const sealed = await seal('the text vera wrote', vera, [adminHpkeRecipient()])
  await postNote(request, world, vera, hubId(world, hubLabel), { callId: callId(world, callLabel) }, sealed)
})

When('{string} posts a well-formed note to hub {string} on conversation {string}', async ({ request, world }, name: string, hubLabel: string, id: string) => {
  const vera = volunteer(world, name)
  const sealed = await seal('note on a conversation that is not real', vera, [adminHpkeRecipient()])
  await postNote(request, world, vera, hubId(world, hubLabel), { conversationId: id }, sealed)
})

When('{string} edits that note with new content and no admin envelopes', async ({ request, world }, name: string) => {
  const vera = volunteer(world, name)
  const noteId = s(world).lastNoteId
  expect(noteId, 'a note to edit').toBeTruthy()
  const sealed = await seal('rewritten so no admin can read it', vera, [])
  const hub = Object.values(s(world).hubs)[0]
  const res = await apiPatch(
    request,
    `/hubs/${hub}/notes/${noteId}`,
    { encryptedContent: sealed.encryptedContent, authorEnvelope: sealed.authorEnvelope, adminEnvelopes: [] },
    vera.seedHex,
  )
  s(world).lastStatus = res.status
})

async function sendMessage(
  request: import('@playwright/test').APIRequestContext,
  world: Record<string, unknown>,
  recipient: { pubkeyHex: string; skHex: string },
) {
  const contentKey = generateContentKey()
  const encryptedContent = encryptContent('a client-sealed reply', contentKey, LABEL_NOTE_KEY)
  const envelope = await wrapKeyForRecipient(contentKey, recipient.pubkeyHex, recipient.skHex, LABEL_NOTE_KEY)
  const hub = hubId(world, 'Alpha')
  const res = await apiPost(
    request,
    `/hubs/${hub}/conversations/${s(world).conversationId}/messages`,
    { encryptedContent, readerEnvelopes: [{ pubkey: recipient.pubkeyHex, ...envelope }] },
    ADMIN_SEED,
  )
  s(world).lastStatus = res.status
}

When('the admin sends a message into that conversation sealed only to a non-admin key', async ({ request, world }) => {
  const other = hpkeRecipientForSeed(volunteer(world, 'Vera').seedHex)
  await sendMessage(request, world, other)
})

When('the admin sends a message into that conversation sealed to the admin key', async ({ request, world }) => {
  await sendMessage(request, world, adminHpkeRecipient())
})

// ── Then ────────────────────────────────────────────────────────────

Then('the note write is refused with status {int}', async ({ world }, status: number) => {
  expect(s(world).lastStatus).toBe(status)
})

Then('the note write succeeds', async ({ world }) => {
  expect(s(world).lastStatus).toBe(201)
})

async function notesFor(
  request: import('@playwright/test').APIRequestContext,
  hub: string,
  call: string,
): Promise<number> {
  const res = await apiGet<{ notes: unknown[]; total: number }>(request, `/hubs/${hub}/notes?callId=${encodeURIComponent(call)}`)
  expect(res.status).toBe(200)
  return res.data.total
}

Then('hub {string} holds no note for call {string}', async ({ request, world }, hubLabel: string, id: string) => {
  expect(await notesFor(request, hubId(world, hubLabel), id)).toBe(0)
})

Then('hub {string} holds no note for the {string} call', async ({ request, world }, hubLabel: string, callLabel: string) => {
  expect(await notesFor(request, hubId(world, hubLabel), callId(world, callLabel))).toBe(0)
})

Then('the note row is stored in hub {string} against the {string} call', async ({ world }, hubLabel: string, callLabel: string) => {
  const noteId = s(world).lastNoteId
  expect(noteId, 'the stored note id').toBeTruthy()
  const row = await TestDB.getRow('notes', noteId!)
  expect(row, 'the notes row').not.toBeNull()
  expect(row!.hub_id).toBe(hubId(world, hubLabel))
  expect(row!.call_id).toBe(callId(world, callLabel))
})

/** Decrypt the stored note with one reader's own envelope and secret key. */
async function openStoredNote(
  request: import('@playwright/test').APIRequestContext,
  world: Record<string, unknown>,
  reader: { skHex: string },
  pick: (note: { authorEnvelope?: { ct: string; enc: string }; adminEnvelopes?: Array<{ pubkey: string; ct: string; enc: string }> }) => { ct: string; enc: string } | undefined,
): Promise<string> {
  const res = await apiGet<{ notes: Array<{ id: string; encryptedContent: string; authorEnvelope?: { ct: string; enc: string }; adminEnvelopes?: Array<{ pubkey: string; ct: string; enc: string }> }> }>(
    request,
    `/hubs/${hubId(world, 'Alpha')}/notes`,
  )
  const note = res.data.notes.find((n) => n.id === s(world).lastNoteId)
  expect(note, 'the stored note as the admin lists it').toBeTruthy()
  const envelope = pick(note!)
  expect(envelope, 'an envelope for this reader').toBeTruthy()
  const key = await unwrapKey(envelope!.ct, envelope!.enc, reader.skHex, LABEL_NOTE_KEY)
  return decryptContent(note!.encryptedContent, key, LABEL_NOTE_KEY)
}

Then('{string} can decrypt the stored note to the text she wrote', async ({ request, world }, name: string) => {
  const own = hpkeRecipientForSeed(volunteer(world, name).seedHex)
  const text = await openStoredNote(request, world, own, (n) => n.authorEnvelope)
  expect(text).toBe(s(world).lastSealed!.plaintext)
})

Then('the admin can decrypt the stored note to the text she wrote', async ({ request, world }) => {
  const admin = adminHpkeRecipient()
  const text = await openStoredNote(request, world, admin, (n) => n.adminEnvelopes?.find((e) => e.pubkey === admin.pubkeyHex))
  expect(text).toBe(s(world).lastSealed!.plaintext)
})

Then('the stored note can still be decrypted by the admin to its original text', async ({ request, world }) => {
  const admin = adminHpkeRecipient()
  const text = await openStoredNote(request, world, admin, (n) => n.adminEnvelopes?.find((e) => e.pubkey === admin.pubkeyHex))
  expect(text).toBe('original note text')
})
