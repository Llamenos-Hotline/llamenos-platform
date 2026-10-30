/**
 * processCallRecording (#2309): an opted-in call recording is copied into the
 * server's own sealed storage, THEN deleted at the provider, then transcribed
 * from our copy's audio. If the copy cannot be made the provider copy is kept
 * — it is the only one — and that comes back as `kept`, never as deleted.
 */
import { describe, it, expect, vi } from 'vitest'

const { maybeTranscribe } = vi.hoisted(() => ({ maybeTranscribe: vi.fn() }))
vi.mock('@worker/services/transcription', () => ({ maybeTranscribe }))

import { processCallRecording } from '@worker/services/call-recordings'
import type { DeleteHeldOptions } from '@worker/services/provider-recordings'

const ROW = { id: 'row-1', hubId: 'hub-1', callId: 'call-1', recordingSid: 'RE1', kind: 'call' } as never

function setup(opts: { copyError?: Error; deletionError?: string; answeredBy?: string } = {}) {
  const order: string[] = []
  const audio = new ArrayBuffer(16)
  const adapter = { getRecordingAudio: vi.fn() } as never
  const services = {
    providerRecordings: {
      track: vi.fn(async () => { order.push('track') }),
      // Mirrors ProviderRecordingsService.deleteHeld: the pre-deletion step
      // runs first, and its failure keeps the provider copy.
      deleteHeld: vi.fn(async (_resolve: unknown, _filter: unknown, options: DeleteHeldOptions = {}) => {
        try {
          await options.beforeDelete?.(ROW, adapter)
        } catch (err) {
          return { deleted: 0, failed: [{ callId: 'call-1', kind: 'call', error: `the server could not keep its own copy, so the provider's copy is kept: ${(err as Error).message}` }] }
        }
        if (opts.deletionError) return { deleted: 0, failed: [{ callId: 'call-1', kind: 'call', error: opts.deletionError }] }
        order.push('deleteAtProvider')
        return { deleted: 1, failed: [] }
      }),
    },
    callRecordings: {
      copyFromProvider: vi.fn(async () => {
        if (opts.copyError) throw opts.copyError
        order.push('copy')
        return audio
      }),
    },
  } as never
  maybeTranscribe.mockReset().mockImplementation(async () => { order.push('transcribe') })
  const run = () => processCallRecording({
    env: {} as never,
    services,
    adapter,
    hubId: 'hub-1',
    callSid: 'call-1',
    recordingSid: 'RE1',
    answeredBy: opts.answeredBy ?? 'vol-pubkey',
  })
  return { order, services: services as any, adapter, audio, run }
}

describe('processCallRecording', () => {
  it('tracks, copies, deletes at the provider, then transcribes from the copy', async () => {
    const { order, services, adapter, audio, run } = setup()
    await expect(run()).resolves.toEqual({ providerCopy: 'deleted' })
    expect(order).toEqual(['track', 'copy', 'deleteAtProvider', 'transcribe'])
    expect(services.providerRecordings.track).toHaveBeenCalledWith({ hubId: 'hub-1', callId: 'call-1', recordingSid: 'RE1', kind: 'call', adapter })
    expect(services.callRecordings.copyFromProvider).toHaveBeenCalledWith(adapter, { hubId: 'hub-1', callId: 'call-1', recordingSid: 'RE1' })
    const [, filter] = services.providerRecordings.deleteHeld.mock.calls[0]
    expect(filter).toEqual({ hubId: 'hub-1', callIds: ['call-1'], kind: 'call' })
    expect(maybeTranscribe).toHaveBeenCalledWith(expect.objectContaining({ hubId: 'hub-1', callId: 'call-1', audio, userPubkey: 'vol-pubkey' }))
  })

  it('keeps the provider copy and says so when our copy could not be made', async () => {
    const { order, run } = setup({ copyError: new Error('the provider returned no audio for the call recording') })
    const outcome = await run()
    expect(outcome.providerCopy).toBe('kept')
    expect(outcome).toMatchObject({ error: expect.stringMatching(/could not keep its own copy.*no audio/) })
    expect(order, 'never deleted at the provider, never transcribed').toEqual(['track'])
  })

  it('reports a refused provider deletion as kept — and still transcribes from our copy', async () => {
    const { order, run } = setup({ deletionError: 'Twilio recording deletion failed: 500' })
    await expect(run()).resolves.toEqual({ providerCopy: 'kept', error: 'Twilio recording deletion failed: 500' })
    expect(order).toEqual(['track', 'copy', 'transcribe'])
  })

  it('does not transcribe a call nobody answered', async () => {
    const { order, run } = setup({ answeredBy: '' })
    await expect(run()).resolves.toEqual({ providerCopy: 'deleted' })
    expect(order).toEqual(['track', 'copy', 'deleteAtProvider'])
  })

  it('a transcription failure does not change the outcome', async () => {
    const { run } = setup()
    maybeTranscribe.mockRejectedValue(new Error('whisper down'))
    await expect(run()).resolves.toEqual({ providerCopy: 'deleted' })
  })
})
