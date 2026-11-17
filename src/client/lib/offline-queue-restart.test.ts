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

type Invoke = <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>

const PIN = '12345678'
const STORAGE_KEY = 'llamenos-offline-queue'

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

    const stored = localStorage.getItem(STORAGE_KEY)
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
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    offlineQueue.destroy()
  })
})
