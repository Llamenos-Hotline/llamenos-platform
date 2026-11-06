/**
 * #1034 — a firehose extraction report is hub content, sealed to the hub's
 * admin readers.
 *
 * It was sealed to the agent and the instance-wide ADMIN_DECRYPTION_PUBKEY
 * only: on a wizard-bootstrapped deployment (no such key) no hub admin could
 * ever read a report, and a second admin never could anywhere.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const readersFor = vi.hoisted(() => vi.fn())
vi.mock('@worker/lib/readers', () => ({ readersFor }))

import { FirehoseAgentService } from '@worker/services/firehose-agent'
import { createMockDb } from './mock-db'

const AGENT = 'a1'.repeat(32)
const ADMIN_ONE = 'b2'.repeat(32)
const ADMIN_TWO = 'c3'.repeat(32)
const OPERATOR = 'd4'.repeat(32)

function setup() {
  const { db } = createMockDb()
  const conversations = {
    create: vi.fn().mockResolvedValue({ id: 'conv-1' }),
    addMessage: vi.fn().mockResolvedValue({ id: 'msg-1' }),
  }
  const service = new FirehoseAgentService(
    db as never,
    {} as never,
    conversations as never,
    { log: vi.fn().mockResolvedValue(undefined) } as never,
    {} as never,
    'seal-key',
    // A deployment that DOES carry an instance key: it is still no reader.
    { ADMIN_DECRYPTION_PUBKEY: OPERATOR } as never,
  )
  const submit = (service as unknown as {
    submitExtractedReport: (conn: unknown, cluster: unknown, extraction: unknown) => Promise<string>
  }).submitExtractedReport.bind(service)
  const conn = { id: 'conn-1', hubId: 'hub-1', reportTypeId: 'rt-1', agentPubkey: AGENT }
  const cluster = { id: 'cl-1', messages: [{ id: 'm1', timestamp: '2026-11-06T00:00:00Z' }] }
  const extraction = { fields: { what: 'x' }, confidence: 0.9 }
  return { submit: () => submit(conn, cluster, extraction), conversations }
}

describe('firehose report recipients (#1034)', () => {
  beforeEach(() => readersFor.mockReset())

  it("seals to the agent and every admin of the connection's hub, and not to the instance key", async () => {
    readersFor.mockResolvedValue([ADMIN_ONE, ADMIN_TWO])
    const { submit, conversations } = setup()

    await submit()

    expect(readersFor).toHaveBeenCalledWith(expect.anything(), 'hub-1', 'admin')
    const message = conversations.addMessage.mock.calls[0][0] as { readerEnvelopes: Array<{ pubkey: string }> }
    expect(message.readerEnvelopes.map(e => e.pubkey)).toEqual([AGENT, ADMIN_ONE, ADMIN_TWO])
  })

  it('refuses a report no admin of the hub could read, so its messages are retried', async () => {
    readersFor.mockResolvedValue([])
    const { submit, conversations } = setup()

    await expect(submit()).rejects.toThrow(/no admin reader/)
    expect(conversations.create).not.toHaveBeenCalled()
  })
})
