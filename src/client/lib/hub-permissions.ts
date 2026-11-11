import { useEffect, useState } from 'react'
import { ApiError, getMyHubPermissions } from './api'

/** Transient failures are retried this many times, backing off linearly. */
const MAX_RETRIES = 4
const RETRY_BASE_MS = 3_000

interface Known {
  /** Whose answers these are — a different account must never inherit them. */
  owner: string
  byHub: Record<string, string[]>
}

/**
 * What the signed-in user may do in `hubId`, as the SERVER resolves it for that
 * hub (#1101) — or `undefined` while that is not yet known.
 *
 * Browsing context only. This feeds what the UI renders for the hub being looked
 * at; nothing about call routing, relay subscriptions or notification handling
 * may read it, because the user is a member of several hubs and must keep
 * receiving from all of them (multi-hub axiom).
 *
 * - Answers are cached per hub, so switching back to a hub applies its last known
 *   set at once; every visit still revalidates, so a role revoked server-side
 *   propagates on the next switch (and on `revision`, which the caller bumps when
 *   `/auth/me` is re-read).
 * - A 403/404 is an answer: the server says the user holds nothing in that hub.
 * - Any other failure keeps whatever was last known and retries a few times
 *   (network/5xx only). It
 *   never invents an answer: "the request failed" says nothing about authority.
 */
export function useHubPermissions(
  pubkey: string | null,
  hubId: string | undefined,
  revision: unknown,
): string[] | undefined {
  const [known, setKnown] = useState<Known | null>(null)

  useEffect(() => {
    if (!pubkey) {
      setKnown(null)
      return
    }
    if (!hubId) return

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const record = (permissions: string[]) => {
      if (cancelled) return
      setKnown(k => ({
        owner: pubkey,
        byHub: { ...(k?.owner === pubkey ? k.byHub : {}), [hubId]: permissions },
      }))
    }
    const ask = (attempt: number) => {
      getMyHubPermissions(hubId)
        .then(res => record(res.permissions))
        .catch(err => {
          if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
            record([])
            return
          }
          // A 4xx other than the two above (401: the session is gone) will not
          // change by asking again.
          const retryable = !(err instanceof ApiError) || err.status >= 500
          if (!cancelled && retryable && attempt < MAX_RETRIES) {
            timer = setTimeout(() => ask(attempt + 1), RETRY_BASE_MS * (attempt + 1))
          }
        })
    }
    ask(0)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [pubkey, hubId, revision])

  if (!hubId || !pubkey || known?.owner !== pubkey) return undefined
  return known.byHub[hubId]
}
