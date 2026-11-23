import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The offline write queue survives an app restart — with NO hub key loaded.
 *
 * No desktop client generates or loads a hub key (#1042), so a queue sealed
 * under the hub key could never be persisted: every queued note, message and
 * report vanished when the app restarted while offline. The queue is per-device
 * data and is sealed under a device-local key instead.
 *
 * This drives the real path — the `offlineQueue` singleton, platform.ts and the
 * Tauri IPC mock (tests/mocks/tauri-core.ts, the JS mirror of
 * apps/desktop/src/crypto.rs) — and simulates the restart by resetting the
 * module registry: the mock's CryptoState and every module's in-memory state
 * are gone, only localStorage remains, as after a real relaunch.
 */

import { offlineQueueStorageKey } from './offline-queue'

type Invoke = <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>

const PIN = '12345678'

/** Fresh modules: a cold start of the webview and of the Rust CryptoState. */
async function coldStart() {
  vi.resetModules()
  // Re-registered per start so the factory imports a FRESH mock module — its
  // CryptoState starts empty, exactly like a relaunched Rust process.
  vi.doMock('@tauri-apps/api/core', async () => await import('../../../tests/mocks/tauri-core'))
  const { invoke } = (await import('@tauri-apps/api/core')) as unknown as { invoke: Invoke }
  const keyManager = await import('./key-manager')
  const { offlineQueue } = await import('./offline-queue')
  return { invoke, keyManager, offlineQueue }
}

describe('offline queue across a restart, with no hub key', () => {
  beforeEach(() => {
    vi.stubEnv('PLAYWRIGHT_TEST', 'true')
    localStorage.clear()
  })

  afterEach(() => {
    vi.doUnmock('@tauri-apps/api/core')
    vi.unstubAllEnvs()
  })

  it('reads every queued operation back after the app restarts', { timeout: 120_000 }, async () => {
    // ── First run: device unlocked, offline, three writes queued ──
    const first = await coldStart()
    const encrypted = await first.invoke<{ state: { signingPubkeyHex: string } }>(
      'device_generate_and_load', { pin: PIN, deviceId: 'offline-queue-restart' },
    )
    first.keyManager.markUnlocked(encrypted.state.signingPubkeyHex)

    // The state every desktop client is in: no hub key at all.
    await expect(
      first.invoke('encrypt_hub_field', { hubId: 'hub-1', plaintext: 'x', label: 'llamenos:drafts' }),
    ).rejects.toThrow('Hub key not loaded')

    const ids = [
      await first.offlineQueue.enqueue('/notes', 'POST', '{"encryptedContent":"note-body"}'),
      await first.offlineQueue.enqueue('/conversations/c1/messages', 'POST', '{"ciphertext":"msg-body"}'),
      await first.offlineQueue.enqueue('/reports', 'POST', '{"encryptedContent":"report-body"}'),
    ]

    const stored = localStorage.getItem(offlineQueueStorageKey(encrypted.state.signingPubkeyHex))
    expect(stored, 'the queue must be persisted, not held in memory only').not.toBeNull()
    for (const body of ['note-body', 'msg-body', 'report-body']) {
      expect(stored).not.toContain(body)
    }
    first.offlineQueue.destroy()

    // ── Restart: CryptoState and all webview memory are gone ──
    const second = await coldStart()
    expect(await second.invoke<boolean>('is_crypto_unlocked')).toBe(false)
    expect(second.offlineQueue.pendingCount).toBe(0)

    // Unlock with the PIN; the singleton opens the persisted queue on unlock.
    const state = await second.invoke<{ signingPubkeyHex: string }>(
      'unlock_with_pin', { data: encrypted, pin: PIN },
    )
    second.keyManager.markUnlocked(state.signingPubkeyHex)

    await vi.waitFor(() => expect(second.offlineQueue.hydrated).toBe(true))
    const restored = second.offlineQueue.getQueue()
    expect(restored.map(op => op.id)).toEqual(ids)
    expect(restored.map(op => op.type)).toEqual(['note:create', 'message:send', 'report:create'])
    expect(restored[0].body).toBe('{"encryptedContent":"note-body"}')
    second.offlineQueue.destroy()
  })

  it('refuses to queue a write it cannot seal, instead of keeping it in memory', { timeout: 60_000 }, async () => {
    const { offlineQueue } = await coldStart()
    // Device key locked: nothing can seal the queue.
    await expect(offlineQueue.enqueue('/notes', 'POST', '{}')).rejects.toThrow(/seal the offline queue/)
    expect(offlineQueue.pendingCount).toBe(0)
    expect(localStorage.length).toBe(0)
    offlineQueue.destroy()
  })
})

describe('offline queue across a change of device identity (#2948)', () => {
  beforeEach(() => {
    vi.stubEnv('PLAYWRIGHT_TEST', 'true')
    localStorage.clear()
  })

  afterEach(() => {
    vi.doUnmock('@tauri-apps/api/core')
    vi.unstubAllEnvs()
  })

  it('does not try to open one identity\'s queue under another identity\'s key', { timeout: 120_000 }, async () => {
    // ── Identity A queues a write while offline, then the device is re-keyed ──
    const first = await coldStart()
    const a = await first.invoke<{ state: { signingPubkeyHex: string } }>(
      'device_generate_and_load', { pin: PIN, deviceId: 'identity-a' },
    )
    first.keyManager.markUnlocked(a.state.signingPubkeyHex)
    const aId = await first.offlineQueue.enqueue('/notes', 'POST', '{"encryptedContent":"a-note"}')
    first.offlineQueue.destroy()

    // ── Restart; a DIFFERENT identity unlocks on the same webview storage ──
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const second = await coldStart()
    const b = await second.invoke<{ state: { signingPubkeyHex: string } }>(
      'device_generate_and_load', { pin: PIN, deviceId: 'identity-b' },
    )
    expect(b.state.signingPubkeyHex).not.toBe(a.state.signingPubkeyHex)
    second.keyManager.markUnlocked(b.state.signingPubkeyHex)

    // B's queue opens (empty), with nothing reported — A's blob is not B's to open.
    await vi.waitFor(() => expect(second.offlineQueue.hydrated).toBe(true))
    expect(second.offlineQueue.getQueue()).toEqual([])
    expect(second.offlineQueue.unreadable).toBeNull()
    expect(errors).not.toHaveBeenCalled()

    // B's own writes persist without touching A's.
    const bId = await second.offlineQueue.enqueue('/notes', 'POST', '{"encryptedContent":"b-note"}')
    second.offlineQueue.destroy()

    // ── A returns (same device key): A's write is still there, B's is not ──
    const third = await coldStart()
    const restoredA = await third.invoke<{ signingPubkeyHex: string }>(
      'unlock_with_pin', { data: a, pin: PIN },
    )
    third.keyManager.markUnlocked(restoredA.signingPubkeyHex)
    await vi.waitFor(() => expect(third.offlineQueue.hydrated).toBe(true))
    expect(third.offlineQueue.getQueue().map(op => op.id)).toEqual([aId])
    expect(third.offlineQueue.getQueue().map(op => op.id)).not.toContain(bId)
    third.offlineQueue.destroy()
    errors.mockRestore()
  })

  it('drops the previous identity\'s in-memory queue when another identity unlocks without a restart', { timeout: 120_000 }, async () => {
    const run = await coldStart()
    const a = await run.invoke<{ state: { signingPubkeyHex: string } }>(
      'device_generate_and_load', { pin: PIN, deviceId: 'identity-a' },
    )
    run.keyManager.markUnlocked(a.state.signingPubkeyHex)
    await run.offlineQueue.enqueue('/notes', 'POST', '{"encryptedContent":"a-note"}')
    expect(run.offlineQueue.pendingCount).toBe(1)

    const b = await run.invoke<{ state: { signingPubkeyHex: string } }>(
      'device_generate_and_load', { pin: PIN, deviceId: 'identity-b' },
    )
    run.keyManager.markUnlocked(b.state.signingPubkeyHex)
    await vi.waitFor(() => expect(run.offlineQueue.pendingCount).toBe(0))
    run.offlineQueue.destroy()
  })
})
