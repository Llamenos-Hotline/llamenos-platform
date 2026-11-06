/**
 * Hub-owned rows on screen are bound to the hub they were loaded in (#2459, #2461).
 *
 * Calls, records, shifts, ring groups, notes, reports, contacts and the audit log
 * belong to one hub. With no active hub there is no question to ask the server —
 * `activeHubPath()` throws `NoActiveHubError` before any request. A view that
 * treats that as "nothing to do" leaves its previous answer standing: another
 * hub's rows, on screen, outside any hub.
 *
 * So a view never holds hub-owned rows directly. It holds them tagged with the hub
 * they came from, and is handed them back only while that hub is still the active
 * one. With no active hub it gets `empty` and `noHub: true` — which it renders as
 * "no hub selected", a different claim from "this hub has no calls".
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useQuery, type QueryKey, type UseQueryOptions, type UseQueryResult } from '@tanstack/react-query'
import { getActiveHub, subscribeActiveHub, NoActiveHubError } from '@/lib/api/client'

/** The hub every hub-owned request is currently addressed to; re-renders when it changes. */
export function useActiveHubId(): string | null {
  return useSyncExternalStore(subscribeActiveHub, getActiveHub, getActiveHub)
}

export interface HubOwned<T> {
  /** What was loaded in the ACTIVE hub — `empty` when no hub is active or nothing has loaded for it yet. */
  data: T
  /** No hub is active: nothing can be asked, and the view must say a hub is needed. */
  noHub: boolean
  loading: boolean
  /**
   * Ask again, in whichever hub is active now. `background` is a poll: it does not
   * flip `loading`, and its error reaches `onError` flagged as background.
   */
  reload: (opts?: { background?: boolean }) => void
  /** Update the loaded rows locally; dropped if the hub they were loaded in is no longer active. */
  setData: (update: (prev: T) => T) => void
}

interface Loaded<T> {
  /** The hub the rows were loaded in, or `PLATFORM` for deployment-level rows. */
  owner: string
  value: T
}

/** Owner tag for deployment-level rows (the platform audit chain): no hub's, so no hub change clears them. */
const PLATFORM = '\u0000platform'

/**
 * Load hub-owned rows for a view. `load` must be stable (`useCallback`) — a new
 * `load` re-runs it, exactly as a change of active hub does. Errors other than
 * "no hub" go to `onError`; the rows already loaded in this same hub stay, since
 * they are still this hub's.
 *
 * `ownedBy: 'platform'` is for a view that shows deployment-level rows through
 * the same screen as a hub's (the audit page's platform chain). Those belong to
 * no hub, so they neither need one nor are cleared when it changes.
 */
export function useHubOwned<T>(
  load: () => Promise<T>,
  { empty, onError, ownedBy = 'active-hub' }: {
    empty: T
    onError: (err: unknown, ctx: { background: boolean }) => void
    ownedBy?: 'active-hub' | 'platform'
  },
): HubOwned<T> {
  const hubId = useActiveHubId()
  const owner = ownedBy === 'platform' ? PLATFORM : hubId
  const [loaded, setLoaded] = useState<Loaded<T> | null>(null)
  const [loading, setLoading] = useState(owner !== null)
  const generation = useRef(0)
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError
  const currentOwner = useCallback(() => (ownedBy === 'platform' ? PLATFORM : getActiveHub()), [ownedBy])

  const reload = useCallback((opts?: { background?: boolean }) => {
    const background = opts?.background ?? false
    const gen = ++generation.current
    const askedIn = currentOwner()
    if (!askedIn) {
      setLoaded(null)
      setLoading(false)
      return
    }
    if (!background) setLoading(true)
    load().then(
      (value) => {
        // An answer for a hub that is no longer active is not this view's answer.
        if (gen !== generation.current || currentOwner() !== askedIn) return
        setLoaded({ owner: askedIn, value })
      },
      (err: unknown) => {
        if (gen !== generation.current) return
        if (err instanceof NoActiveHubError) {
          setLoaded(null)
          return
        }
        onErrorRef.current(err, { background })
      },
    ).finally(() => {
      if (gen === generation.current) setLoading(false)
    })
    // `owner` is a dependency so that a change of active hub asks again.
  }, [load, owner, currentOwner])

  useEffect(() => { reload() }, [reload])

  const setData = useCallback((update: (prev: T) => T) => {
    setLoaded(prev => (prev && prev.owner === currentOwner() ? { ...prev, value: update(prev.value) } : prev))
  }, [currentOwner])

  // Bound at render, not only when the next load settles: the frame after the hub
  // changes must not show the previous hub's rows either.
  const current = owner !== null && loaded?.owner === owner ? loaded.value : empty
  return { data: current, noHub: owner === null, loading: owner !== null && loading, reload, setData }
}

/**
 * `useQuery` for a hub-owned resource. The cache outlives the page (the
 * `QueryClientProvider` sits above the `<main key={currentHubId}>` remount), so a
 * key without the hub in it hands hub B the rows cached for hub A, and keeps
 * handing them out after the hub is cleared — React Query keeps `data` when the
 * refetch then throws `NoActiveHubError`. The active hub is appended to the key,
 * and with no hub the query is disabled and its `data` is `undefined`.
 */
export function useHubQuery<TData, TKey extends QueryKey>(
  options: Omit<UseQueryOptions<TData, Error, TData, readonly [...TKey, string | null]>, 'queryKey' | 'enabled'> & {
    queryKey: TKey
    enabled?: boolean
  },
): UseQueryResult<TData, Error> & { noHub: boolean } {
  const hubId = useActiveHubId()
  const result = useQuery({
    ...options,
    queryKey: [...options.queryKey, hubId] as const,
    enabled: hubId !== null && (options.enabled ?? true),
  })
  return Object.assign(result, { noHub: hubId === null })
}
