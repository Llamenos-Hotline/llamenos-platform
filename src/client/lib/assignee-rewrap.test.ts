/**
 * The client half of the assignee re-wrap must not hand history to a key that
 * appeared after it was written unless that key is confirmed (#2143, #2148).
 *
 * The seam is `rewrapMessageKey`: whatever recipient list reaches it is what
 * gets content keys sealed to it. These tests drive `rewrapConversationForAssignee`
 * with server answers and assert on that list and on what is posted back.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AssigneeEnvelopeGapsResponse } from '@protocol/schemas'

vi.mock('./api/conversations', () => ({
  addAssigneeEnvelopes: vi.fn(),
  getAssigneeEnvelopeGaps: vi.fn(),
  listActiveConversationsInHub: vi.fn(),
}))
vi.mock('./platform', () => ({ rewrapMessageKey: vi.fn() }))
vi.mock('./auth', () => ({ useAuth: vi.fn() }))
vi.mock('./member-hubs', () => ({ useMemberHubIds: vi.fn() }))
vi.mock('./relay/hooks', () => ({ useRelaySubscriptions: vi.fn() }))
vi.mock('./relay/context', () => ({ useRelayState: vi.fn() }))

import { addAssigneeEnvelopes, getAssigneeEnvelopeGaps } from './api/conversations'
import { rewrapMessageKey } from './platform'
import { mayRewrapHistoryTo, rewrapConversationForAssignee } from './assignee-rewrap'

const OLD_KEY = 'a1'.repeat(32)
const NEW_KEY = 'b2'.repeat(32)
const MESSAGE_AT = '2026-10-01T12:00:00.000Z'
const BEFORE = '2026-10-01T11:00:00.000Z'
const AFTER = '2026-10-01T13:00:00.000Z'
const ENVELOPE = { pubkey: 'c3'.repeat(32), enc: 'd4'.repeat(32), ct: 'e5'.repeat(48) }

const sealedFor = (pubkey: string) => ({ pubkey, enc: 'f6'.repeat(32), ct: '07'.repeat(48) })

function gaps(
  recipients: AssigneeEnvelopeGapsResponse['recipients'],
  messages: Array<{ id: string; missing: string[] }>,
): AssigneeEnvelopeGapsResponse {
  return {
    assignedTo: '99'.repeat(32),
    recipients,
    messages: messages.map(m => ({
      id: m.id,
      createdAt: MESSAGE_AT,
      readerEnvelopes: [ENVELOPE],
      missingRecipients: m.missing,
    })),
  }
}

beforeEach(() => {
  vi.mocked(rewrapMessageKey).mockImplementation(async (_envelopes, recipients) => recipients.map(sealedFor))
  vi.mocked(addAssigneeEnvelopes).mockImplementation(async (_h, _c, body) => ({ added: body.envelopes.length }))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.resetAllMocks()
  vi.restoreAllMocks()
})

/** Serve `first` once, then an empty list, as the real server does once the gap is closed. */
function serve(first: AssigneeEnvelopeGapsResponse): void {
  vi.mocked(getAssigneeEnvelopeGaps)
    .mockResolvedValueOnce(first)
    .mockResolvedValue({ ...first, messages: [] })
}

describe('mayRewrapHistoryTo', () => {
  it('allows a key that predates the record — the normal claim path', () => {
    expect(mayRewrapHistoryTo({ keySetAt: BEFORE, confirmed: false }, MESSAGE_AT)).toBe(true)
  })

  it('refuses an unconfirmed key set after the record', () => {
    expect(mayRewrapHistoryTo({ keySetAt: AFTER, confirmed: false }, MESSAGE_AT)).toBe(false)
  })

  it('allows a confirmed key set after the record', () => {
    expect(mayRewrapHistoryTo({ keySetAt: AFTER, confirmed: true }, MESSAGE_AT)).toBe(true)
  })
})

describe('rewrapConversationForAssignee', () => {
  it('seals to a key that predates the message', async () => {
    serve(gaps([{ pubkey: OLD_KEY, keySetAt: BEFORE, confirmed: false }], [{ id: 'm1', missing: [OLD_KEY] }]))

    expect(await rewrapConversationForAssignee('hub', 'conv')).toBe(1)
    expect(rewrapMessageKey).toHaveBeenCalledWith([ENVELOPE], [OLD_KEY])
  })

  it('never offers an unconfirmed newer key to rewrapMessageKey, and still re-wraps the older one', async () => {
    serve(gaps(
      [
        { pubkey: OLD_KEY, keySetAt: BEFORE, confirmed: false },
        { pubkey: NEW_KEY, keySetAt: AFTER, confirmed: false },
      ],
      [{ id: 'm1', missing: [OLD_KEY, NEW_KEY] }],
    ))

    expect(await rewrapConversationForAssignee('hub', 'conv')).toBe(1)
    expect(rewrapMessageKey).toHaveBeenCalledTimes(1)
    expect(rewrapMessageKey).toHaveBeenCalledWith([ENVELOPE], [OLD_KEY])
    const posted = vi.mocked(addAssigneeEnvelopes).mock.calls.flatMap(call => call[2].envelopes)
    expect(posted.map(e => e.envelope.pubkey)).toEqual([OLD_KEY])
  })

  it('seals to a newer key once it is confirmed', async () => {
    serve(gaps([{ pubkey: NEW_KEY, keySetAt: AFTER, confirmed: true }], [{ id: 'm1', missing: [NEW_KEY] }]))

    expect(await rewrapConversationForAssignee('hub', 'conv')).toBe(1)
    expect(rewrapMessageKey).toHaveBeenCalledWith([ENVELOPE], [NEW_KEY])
  })

  it('skips a message whose only missing key is withheld, logs it, and does not throw', async () => {
    serve(gaps(
      [
        { pubkey: OLD_KEY, keySetAt: BEFORE, confirmed: false },
        { pubkey: NEW_KEY, keySetAt: AFTER, confirmed: false },
      ],
      [{ id: 'blocked', missing: [NEW_KEY] }, { id: 'open', missing: [OLD_KEY] }],
    ))

    expect(await rewrapConversationForAssignee('hub', 'conv-skip')).toBe(1)
    // The blocked message never reached the sealing call; the other one did.
    expect(rewrapMessageKey).toHaveBeenCalledTimes(1)
    expect(vi.mocked(addAssigneeEnvelopes).mock.calls[0][2].envelopes.map(e => e.messageId)).toEqual(['open'])
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('not re-wrapping history'))
  })

  it('posts nothing when every missing key is withheld', async () => {
    serve(gaps([{ pubkey: NEW_KEY, keySetAt: AFTER, confirmed: false }], [{ id: 'm1', missing: [NEW_KEY] }]))

    expect(await rewrapConversationForAssignee('hub', 'conv-none')).toBe(0)
    expect(rewrapMessageKey).not.toHaveBeenCalled()
    expect(addAssigneeEnvelopes).not.toHaveBeenCalled()
  })

  it('reports a withheld key once per conversation, not on every sweep', async () => {
    const withheld = gaps([{ pubkey: NEW_KEY, keySetAt: AFTER, confirmed: false }], [{ id: 'm1', missing: [NEW_KEY] }])
    vi.mocked(getAssigneeEnvelopeGaps).mockResolvedValue(withheld)

    await rewrapConversationForAssignee('hub', 'conv-once')
    await rewrapConversationForAssignee('hub', 'conv-once')
    expect(console.warn).toHaveBeenCalledTimes(1)
  })
})
