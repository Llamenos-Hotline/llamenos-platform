import { describe, expect, it, vi } from 'vitest'
import type { Database } from '../../db'
import {
  hashSignalQueueRecipientIdentifier,
  SignalMessageQueue,
} from '../../messaging/signal/queue'

const HMAC_SECRET = 'a'.repeat(64)
const SERVER_KEK = 'c'.repeat(64)

describe('SignalMessageQueue sensitive storage', () => {
  it('persists only the HMAC and ciphertext, then decrypts values for delivery', async () => {
    let inserted: Record<string, unknown> | undefined
    const values = vi.fn((row: Record<string, unknown>) => {
      inserted = row
      return { onConflictDoNothing: vi.fn(async () => []) }
    })
    const db = {
      insert: vi.fn(() => ({ values })),
      execute: vi.fn(async () => [{
        id: 'queue-id',
        hub_id: 'hub-id',
        conversation_id: 'conversation-id',
        recipient_identifier_ciphertext: inserted?.recipientIdentifierCiphertext as string,
        encrypted_body: inserted?.encryptedBody as string,
        media_url: null,
        media_type: null,
        retry_count: 0,
      }]),
    } as unknown as Database
    const queue = new SignalMessageQueue(db, HMAC_SECRET, SERVER_KEK)
    const recipientIdentifier = '+15551234567'
    const body = 'sensitive message body'

    await queue.enqueue({
      hubId: 'hub-id',
      conversationId: 'conversation-id',
      recipientIdentifier,
      body,
    })

    expect(inserted).toBeDefined()
    expect(inserted).not.toHaveProperty('recipientIdentifier')
    expect(inserted).not.toHaveProperty('body')
    expect(inserted?.recipientIdentifierHash).toBe(
      hashSignalQueueRecipientIdentifier(recipientIdentifier, HMAC_SECRET),
    )
    expect(inserted?.recipientIdentifierCiphertext).not.toContain(recipientIdentifier)
    expect(inserted?.encryptedBody).not.toContain(body)

    await expect(queue.claimBatch()).resolves.toEqual([
      expect.objectContaining({ recipientIdentifier, body }),
    ])
  })

  it('seals under SERVER_KEK, so HMAC_SECRET cannot open the stored values', async () => {
    let inserted: Record<string, unknown> | undefined
    const db = {
      insert: vi.fn(() => ({
        values: vi.fn((row: Record<string, unknown>) => {
          inserted = row
          return { onConflictDoNothing: vi.fn(async () => []) }
        }),
      })),
    } as unknown as Database
    await new SignalMessageQueue(db, HMAC_SECRET, SERVER_KEK).enqueue({
      hubId: 'hub-id',
      conversationId: 'conversation-id',
      recipientIdentifier: '+15551234567',
      body: 'sensitive message body',
    })

    const claimWith = (kek: string) => new SignalMessageQueue({
      execute: vi.fn(async () => [{
        id: 'queue-id',
        hub_id: 'hub-id',
        conversation_id: 'conversation-id',
        recipient_identifier_ciphertext: inserted?.recipientIdentifierCiphertext as string,
        encrypted_body: inserted?.encryptedBody as string,
        media_url: null,
        media_type: null,
        retry_count: 0,
      }]),
    } as unknown as Database, HMAC_SECRET, kek).claimBatch()

    await expect(claimWith(HMAC_SECRET)).rejects.toThrow()
    await expect(claimWith(SERVER_KEK)).resolves.toHaveLength(1)
  })
})
