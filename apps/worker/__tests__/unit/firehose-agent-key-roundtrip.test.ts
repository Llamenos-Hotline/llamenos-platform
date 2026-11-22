/**
 * #1288 — the firehose agent's key is an X25519 ENCRYPTION key.
 *
 * It was an Ed25519 signing key. An Ed25519 pubkey and an X25519 pubkey are
 * both 64 hex characters and DHKEM(X25519) accepts any 32 bytes as a recipient,
 * so every window key sealed to the agent was well-formed and permanently
 * unopenable — no error at write time, none at read time. A shape assertion
 * (`/^[0-9a-f]{64}$/`) passes on the wrong key, so these tests assert the only
 * thing that matters: the agent can actually DECRYPT what is sealed to it.
 *
 * Flow under test, with the real generator, the real observer and the real
 * agent code, and no stand-in for the key:
 *   generateAgentKeypair -> observer seals the window key to agentPubkey and
 *   encrypts a message -> the agent unseals the key and decrypts the message.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { hexToBytes } from '@shared/encoding'
import { LABEL_FIREHOSE_AGENT_SEAL } from '@shared/crypto-labels'
import { generateAgentKeypair, unsealAgentKey } from '@worker/lib/agent-identity'
import { observeFirehoseMessage, clearWindowKeyCache } from '@worker/messaging/firehose-observer'
import { FirehoseAgentService } from '@worker/services/firehose-agent'
import type { FirehoseService } from '@worker/services/firehose'
import { createMockDb } from './mock-db'

const SEAL_KEY = 'a'.repeat(64)
const CONNECTION_ID = 'conn-1288'

interface WindowKeyRow {
  id: string
  connectionId: string
  sealedKey: string
  windowStart: Date
  windowEnd: Date
}
interface BufferRow {
  id: string
  encryptedContent: string
  encryptedSenderInfo: string
  windowKeyId: string
  signalTimestamp: Date
}

/** An in-memory FirehoseService holding exactly what the observer and agent touch. */
function setup() {
  const windowKeys: WindowKeyRow[] = []
  const buffer: BufferRow[] = []
  const { sealedAgentKey, pubkey } = generateAgentKeypair(CONNECTION_ID, SEAL_KEY, LABEL_FIREHOSE_AGENT_SEAL)

  const conn = {
    id: CONNECTION_ID,
    hubId: 'hub-1',
    status: 'active',
    agentPubkey: pubkey,
    sealedAgentKey,
    bufferTtlDays: 7,
    extractionIntervalSec: 3600,
    inferenceEndpoint: null,
  }

  const firehose = {
    findConnectionBySignalGroup: vi.fn().mockResolvedValue(conn),
    getConnection: vi.fn().mockResolvedValue(conn),
    getCurrentWindowKey: vi.fn(async () => windowKeys.at(-1) ?? null),
    createWindowKey: vi.fn(async (data: Omit<WindowKeyRow, 'id'>) => {
      const row = { ...data, id: `wk-${windowKeys.length + 1}` }
      windowKeys.push(row)
      return row
    }),
    getWindowKey: vi.fn(async (id: string) => windowKeys.find((w) => w.id === id) ?? null),
    addBufferMessage: vi.fn(async (_connId: string, data: Omit<BufferRow, 'id'>) => {
      buffer.push({ ...data, id: `msg-${buffer.length + 1}` })
    }),
    incrementWindowKeyMessageCount: vi.fn().mockResolvedValue(undefined),
  }

  const { db } = createMockDb()
  const agentService = new FirehoseAgentService(
    db as never,
    firehose as never,
    {} as never,
    { log: vi.fn().mockResolvedValue(undefined) } as never,
    {} as never,
    SEAL_KEY,
    {},
  )

  return { firehose, windowKeys, buffer, agentService, conn }
}

describe('firehose agent key is an X25519 encryption key (#1288)', () => {
  beforeEach(() => clearWindowKeyCache())

  it('the agent decrypts a message the observer buffered for it', async () => {
    const { firehose, buffer, windowKeys, agentService, conn } = setup()

    const buffered = await observeFirehoseMessage(firehose as unknown as FirehoseService, {
      signalGroupId: 'group-1',
      senderIdentifier: '+15551234567',
      senderIdentifierHash: 'hash-1',
      senderUsername: 'witness',
      content: 'car on fire at 5th and Main',
      timestamp: new Date('2026-11-22T10:00:00Z'),
      hubId: conn.hubId,
    })
    expect(buffered).toBe(true)
    expect(windowKeys).toHaveLength(1)
    expect(buffer).toHaveLength(1)

    // What the server does at startAgent(): unseal the stored secret key.
    const agentSecretKey = hexToBytes(
      unsealAgentKey(CONNECTION_ID, conn.sealedAgentKey, SEAL_KEY, LABEL_FIREHOSE_AGENT_SEAL),
    )

    // Drop the observer's cache entry: a restarted server holds only the DB row,
    // so the agent can read the window key only by opening the HPKE seal.
    clearWindowKeyCache()

    const internals = agentService as unknown as {
      unsealWindowKey: (id: string, sk: Uint8Array) => Promise<Uint8Array>
      decryptWithWindowKey: (hex: string, key: Uint8Array) => string
    }
    const windowKey = await internals.unsealWindowKey(windowKeys[0].id, agentSecretKey)
    expect(windowKey).toHaveLength(32)

    expect(internals.decryptWithWindowKey(buffer[0].encryptedContent, windowKey)).toBe(
      'car on fire at 5th and Main',
    )
    const sender = JSON.parse(internals.decryptWithWindowKey(buffer[0].encryptedSenderInfo, windowKey))
    expect(sender.username).toBe('witness')
  })

  it('refuses to buffer for a connection whose agent key is not a valid encryption-key encoding', async () => {
    const { firehose, buffer, conn } = setup()
    firehose.findConnectionBySignalGroup.mockResolvedValue({ ...conn, agentPubkey: 'not-a-key' })

    const buffered = await observeFirehoseMessage(firehose as unknown as FirehoseService, {
      signalGroupId: 'group-1',
      senderIdentifier: '+15551234567',
      senderIdentifierHash: 'hash-1',
      senderUsername: 'witness',
      content: 'x',
      timestamp: new Date('2026-11-22T10:00:00Z'),
      hubId: conn.hubId,
    })
    expect(buffered).toBe(false)
    expect(buffer).toHaveLength(0)
    expect(firehose.createWindowKey).not.toHaveBeenCalled()
  })
})
