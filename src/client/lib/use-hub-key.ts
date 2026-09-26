/**
 * React bindings for the hub-key lifecycle (see hub-key-manager.ts).
 *
 * - useHubKeyLifecycle: mounted once in the authenticated layout. Whenever the
 *   device is unlocked and the active hub changes, it loads that hub's key into
 *   Rust (creating it for a creator whose hub has none), and — for admins who
 *   hold it — re-wraps it once per session for the current member set so
 *   members added since the last distribution receive an envelope.
 * - useHubKeyRotation: returns the departure handler admin screens call after
 *   removing or deactivating a member.
 */
import { useCallback, useEffect, useRef } from 'react'
import { useAuth } from './auth'
import { useConfig } from './config'
import { queryClient } from './query-client'
import { getActiveHub } from './api/client'
import { distributeHubKey, ensureHubKey, rotateHubKey, HubKeyUnavailableError } from './hub-key-manager'
import { tagKeys } from './queries/tags'
import { teamKeys } from './queries/teams'

/** Hub-key distribution needs key management plus the member device registry. */
function canDistribute(hasPermission: (p: string) => boolean): boolean {
  return hasPermission('hubs:manage-keys') && hasPermission('users:manage-devices')
}

function invalidateHubScopedQueries(): void {
  queryClient.invalidateQueries({ queryKey: tagKeys.all })
  queryClient.invalidateQueries({ queryKey: teamKeys.all })
}

export function useHubKeyLifecycle(): void {
  const { isKeyUnlocked, publicKey, hasPermission } = useAuth()
  const { currentHubId, hubs } = useConfig()
  const distributed = useRef(new Set<string>())
  const hubCreatedBy = hubs.find(h => h.id === currentHubId)?.createdBy
  const canManageKeys = canDistribute(hasPermission)

  useEffect(() => {
    if (!isKeyUnlocked) distributed.current.clear()
  }, [isKeyUnlocked])

  useEffect(() => {
    if (!isKeyUnlocked || !publicKey || !currentHubId) return
    let cancelled = false
    const hubId = currentHubId
    ensureHubKey(hubId, { selfPubkey: publicKey, hubCreatedBy, canManageKeys })
      .then(async (result) => {
        if (cancelled) return
        invalidateHubScopedQueries()
        if (result === 'unavailable') {
          console.warn(`[hub-key] No key envelope for hub ${hubId}; hub-encrypted data is unavailable`)
          return
        }
        if (canManageKeys && result === 'loaded' && !distributed.current.has(hubId)) {
          distributed.current.add(hubId)
          await distributeHubKey(hubId)
        }
      })
      .catch((err: unknown) => {
        console.error(`[hub-key] Hub key setup failed for hub ${hubId}:`, err)
      })
    return () => { cancelled = true }
  }, [isKeyUnlocked, publicKey, currentHubId, hubCreatedBy, canManageKeys])
}

/**
 * Returns a handler that rotates the active hub's key after `pubkey` leaves
 * it (removed, deleted or deactivated). No-op for callers who cannot manage
 * hub keys. When this client does not hold the hub's key there is nothing it
 * can rotate — that is logged, not thrown. Any other failure rejects so the
 * caller can surface it.
 */
export function useHubKeyRotation(): (departedPubkey: string) => Promise<void> {
  const { hasPermission } = useAuth()
  const canManageKeys = canDistribute(hasPermission)
  return useCallback(async (departedPubkey: string) => {
    const hubId = getActiveHub()
    if (!canManageKeys || !hubId) return
    try {
      await rotateHubKey(hubId, [departedPubkey])
    } catch (err) {
      if (err instanceof HubKeyUnavailableError) {
        console.warn(`[hub-key] Cannot rotate hub ${hubId}: this device holds no key for it`)
        return
      }
      throw err
    } finally {
      invalidateHubScopedQueries()
    }
  }, [canManageKeys])
}
