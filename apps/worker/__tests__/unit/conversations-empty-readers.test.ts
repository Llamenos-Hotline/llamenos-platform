/**
 * The empty-reader crisis contract on POST /conversations/:id/messages.
 *
 * When the deployment has no admin decryption key AND the author has no
 * registered X25519 device, `messageReaders` returns an empty list. The
 * documented contract (see `apps/worker/lib/device-recipients.ts`) is
 * loud-but-stored: the reply still goes to the contact and a record is still
 * persisted — never a substituted key, never a silent drop. Before this was
 * handled, `encryptMessageForStorage` threw on the empty list, so the reply
 * was neither sent nor stored: a dropped crisis message.
 *
 * The mock env in the test helper sets no ADMIN_DECRYPTION_PUBKEY, and the
 * identity service below resolves the author to zero devices — together the
 * empty-reader case, through the real route.
 */
import { describe, it, expect, vi } from 'vitest'
import conversationsRoutes from '../../routes/conversations'
import { createTestApp, sendJSON, VALID_PUBKEY } from '../helpers/openapi-validation'

function createSmsServices() {
  const addMessage = vi.fn().mockResolvedValue({ id: 'msg-out-1' })
  // The messaging adapter is not configured in this test — the route treats
  // that as "stored as sent", the same outcome the contact-identifier failure
  // path has always had.
  const getContactIdentifier = vi.fn().mockRejectedValue(new Error('sms adapter not configured'))
  const getHpkeRecipients = vi.fn().mockResolvedValue([])
  const services = {
    conversations: {
      getById: vi.fn().mockResolvedValue({
        id: 'conv-sms',
        channelType: 'sms',
        assignedTo: VALID_PUBKEY,
        hubId: 'hub-1',
      }),
      addMessage,
      getContactIdentifier,
    },
    identity: { getHpkeRecipients },
    audit: { log: vi.fn().mockResolvedValue(undefined) },
  }
  return { services: services as never, addMessage, getContactIdentifier, getHpkeRecipients }
}

describe('POST /conversations/:id/messages — empty-reader crisis contract', () => {
  it('still sends and stores the reply when no HPKE recipient exists anywhere', async () => {
    const { services, addMessage, getContactIdentifier, getHpkeRecipients } = createSmsServices()
    const app = createTestApp({
      prefix: '/conversations',
      routes: conversationsRoutes,
      authenticated: true,
      services,
    })

    const res = await sendJSON(app, '/conversations/conv-sms/messages', {
      plaintextForSending: 'We hear you. Help is on the way.',
    })

    // The reply was dispatched, not refused: the route got as far as resolving
    // the contact identifier for the channel send.
    expect(getContactIdentifier).toHaveBeenCalledWith('conv-sms')
    // ...and a record was still stored. Zero envelopes and no content: no
    // plaintext is persisted, and no envelope claims a reader who cannot read.
    expect(addMessage).toHaveBeenCalledTimes(1)
    const stored = addMessage.mock.calls[0][0]
    expect(stored.readerEnvelopes).toEqual([])
    expect(stored.encryptedContent).toBe('')
    // The author's device list was genuinely consulted (not skipped).
    expect(getHpkeRecipients).toHaveBeenCalledWith(VALID_PUBKEY)
    expect(res.status).toBe(201)
  })
})
