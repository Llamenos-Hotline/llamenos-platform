/**
 * The logger never writes a provider identifier (#2333).
 *
 * `callSid` used to be blanked only because its name happened to contain "sid"; a
 * `callId` — which IS the provider's id for the call — and any interpolated message
 * went straight through. Asserted on what the process actually wrote.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLogger } from '@worker/lib/logger'
import { providerRef } from '@worker/lib/provider-ref'

const CALL_SID = 'CA0123456789abcdef0123456789abcdef'
const RECORDING_SID = 'RE89abcdef0123456789abcdef01234567'
const UUID_CALL_ID = '3f1c0d52-8d2e-4f6b-9a41-7c1e2b5d9e10'

let written: string[]
let saved: string | undefined
beforeEach(() => {
  saved = process.env.HMAC_SECRET
  process.env.HMAC_SECRET = 'ab'.repeat(32)
  written = []
  const capture = (chunk: string | Uint8Array) => {
    written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  }
  vi.spyOn(process.stdout, 'write').mockImplementation(capture)
  vi.spyOn(process.stderr, 'write').mockImplementation(capture)
})
afterEach(() => {
  vi.restoreAllMocks()
  if (saved === undefined) delete process.env.HMAC_SECRET
  else process.env.HMAC_SECRET = saved
})

const lastLine = () => JSON.parse(written[written.length - 1] ?? '{}') as Record<string, unknown>

describe('logger', () => {
  it('logs a provider-identifier field as a keyed ref under <key>Ref, at every level', () => {
    const log = createLogger('test.provider-ids')
    log.error('caller will get no answer', { callSid: CALL_SID, callId: UUID_CALL_ID, parentCallSid: CALL_SID, recordingSid: RECORDING_SID, hubId: 'hub-1' })
    const line = lastLine()
    expect(line).toMatchObject({
      callSidRef: providerRef(CALL_SID),
      callIdRef: providerRef(UUID_CALL_ID),
      parentCallSidRef: providerRef(CALL_SID),
      recordingSidRef: providerRef(RECORDING_SID),
      hubId: 'hub-1',
    })
    const raw = written.join('')
    for (const id of [CALL_SID, UUID_CALL_ID, RECORDING_SID]) expect(raw).not.toContain(id)
  })

  it('follows one call across lines: the same id is the same ref', () => {
    const log = createLogger('test.provider-ids')
    log.info('Incoming call', { callSid: CALL_SID })
    const first = lastLine().callSidRef
    log.warn('Queue hangup', { callId: CALL_SID })
    expect(lastLine().callIdRef).toBe(first)
  })

  it('scrubs a SID out of the message and out of an error the provider wrote', () => {
    const log = createLogger('test.provider-ids')
    log.warn(`ringVolunteers retry 2 for callSid=${CALL_SID}`, { error: new Error(`Call ${CALL_SID} is not in progress`) })
    const raw = written.join('')
    expect(raw).not.toContain(CALL_SID)
    expect(raw).toContain(providerRef(CALL_SID))
  })

  it('does not rewrite messageId, which the messaging code uses for its own queue ids', () => {
    createLogger('test.provider-ids').warn('Message moved to dead-letter queue', { messageId: 'queue-row-7' })
    expect(lastLine().messageId).toBe('queue-row-7')
  })
})
