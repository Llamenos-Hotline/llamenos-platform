/**
 * #1136: a rate-limited WebSocket event was being marked 'delivered' in the durable
 * outbox even though publishToHub dropped it — the one safety net meant to redrive a
 * dropped event was recording the drop as a success instead.
 *
 * These tests exercise the REAL publishEvent/drainOutbox against a stubbed
 * EventOutbox and a stubbed ConnectionManager, asserting that:
 *   - a successful publishToHub() marks the outbox row delivered
 *   - a dropped (rate-limited) publishToHub() leaves it pending for redrive
 *     (via markFailed, never markDelivered)
 *
 * NOTE: apps/worker/__tests__/unit/ws-events.test.ts documents that vi.mock of this
 * module in ringing-service.test.ts poisons the module cache for Bun-test style
 * cross-file state. This file instead mocks only the leaf dependency
 * (../../lib/ws-manager's getConnectionManager) and imports the real ws-events.ts —
 * verified to run cleanly alongside the rest of the unit suite.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { KIND_CALL_RING } from '@shared/event-kinds'
import type { Env } from '../../types'

const mockConnectionManager = {
  publishToHub: vi.fn<(hubId: string, kind: number, payload: string, epoch: number) => boolean>(),
}

vi.mock('../../lib/ws-manager', () => ({
  getConnectionManager: () => mockConnectionManager,
}))

function makeOutbox() {
  return {
    enqueue: vi.fn().mockResolvedValue(1),
    markDelivered: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
    drainBatch: vi.fn().mockResolvedValue([]),
  }
}

function makeEnv(): Env {
  return {} as Env
}

describe('publishEvent — outbox delivery tracking (#1136)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
  })

  it('marks the outbox row delivered when publishToHub succeeds', async () => {
    mockConnectionManager.publishToHub.mockReturnValue(true)
    const { publishEvent, setEventOutbox } = await import('../../lib/ws-events')
    const outbox = makeOutbox()
    setEventOutbox(outbox as never)

    publishEvent(makeEnv(), KIND_CALL_RING, { type: 'call:ring', callId: 'CA-1' }, 'hub-1')
    // publishEvent's outbox path is a fire-and-forget promise chain — flush microtasks.
    await new Promise((r) => setTimeout(r, 0))

    expect(outbox.enqueue).toHaveBeenCalledTimes(1)
    expect(outbox.markDelivered).toHaveBeenCalledWith(1)
    expect(outbox.markFailed).not.toHaveBeenCalled()
  })

  it('does NOT mark delivered — and instead marks failed for redrive — when publishToHub drops the event (rate limited)', async () => {
    mockConnectionManager.publishToHub.mockReturnValue(false)
    const { publishEvent, setEventOutbox } = await import('../../lib/ws-events')
    const outbox = makeOutbox()
    setEventOutbox(outbox as never)

    publishEvent(makeEnv(), KIND_CALL_RING, { type: 'call:ring', callId: 'CA-2' }, 'hub-1')
    await new Promise((r) => setTimeout(r, 0))

    expect(outbox.enqueue).toHaveBeenCalledTimes(1)
    expect(outbox.markDelivered).not.toHaveBeenCalled()
    expect(outbox.markFailed).toHaveBeenCalledWith(1, expect.stringContaining('rate limited'))
  })
})

describe('drainOutbox — redrive tracking (#1136)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
  })

  it('marks a drained event delivered when publishToHub succeeds', async () => {
    mockConnectionManager.publishToHub.mockReturnValue(true)
    const { drainOutbox, setEventOutbox } = await import('../../lib/ws-events')
    const outbox = makeOutbox()
    outbox.drainBatch.mockResolvedValue([
      { id: 7, event: { hubId: 'hub-1', kind: KIND_CALL_RING, epoch: 1, payload: 'p' } },
    ])
    setEventOutbox(outbox as never)

    const delivered = await drainOutbox()

    expect(delivered).toBe(1)
    expect(outbox.markDelivered).toHaveBeenCalledWith(7)
    expect(outbox.markFailed).not.toHaveBeenCalled()
  })

  it('leaves a still-rate-limited event pending (markFailed, not markDelivered) rather than counting it delivered', async () => {
    mockConnectionManager.publishToHub.mockReturnValue(false)
    const { drainOutbox, setEventOutbox } = await import('../../lib/ws-events')
    const outbox = makeOutbox()
    outbox.drainBatch.mockResolvedValue([
      { id: 8, event: { hubId: 'hub-1', kind: KIND_CALL_RING, epoch: 1, payload: 'p' } },
    ])
    setEventOutbox(outbox as never)

    const delivered = await drainOutbox()

    expect(delivered).toBe(0)
    expect(outbox.markDelivered).not.toHaveBeenCalled()
    expect(outbox.markFailed).toHaveBeenCalledWith(8, expect.stringContaining('rate limited'))
  })
})
