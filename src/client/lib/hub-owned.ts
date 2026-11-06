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
  /** Ask again, in whichever hub is active now. */
  reload: () => void
  /** Update the loaded rows locally; dropped if the hub they were loaded in is no longer active. */
  setData: (update: (prev: T) => T) => void
}

interface Loaded<T> {
  hubId: string
  value: T
}

/**
 * Load hub-owned rows for a view. `load` must be stable (`useCallback`) — a new
 * `load` re-runs it, exactly as a change of active hub does. Errors other than
 * "no hub" go to `onError`; the rows already loaded in this same hub stay, since
 * they are still this hub's.
 */
export function useHubOwned<T>(
  load: () => Promise<T>,
  { empty, onError }: { empty: T; onError: (err: unknown) => void },
): HubOwned<T> {
  const hubId = useActiveHubId()
  const [loaded, setLoaded] = useState<Loaded<T> | null>(null)
  const [loading, setLoading] = useState(hubId !== null)
  const generation = useRef(0)
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  const reload = useCallback(() => {
    const gen = ++generation.current
    const askedIn = getActiveHub()
    if (!askedIn) {
      setLoaded(null)
      setLoading(false)
      return
    }
    setLoading(true)
    load().then(
      (value) => {
        // An answer for a hub that is no longer active is not this view's answer.
        if (gen !== generation.current || getActiveHub() !== askedIn) return
        setLoaded({ hubId: askedIn, value })
      },
      (err: unknown) => {
        if (gen !== generation.current) return
        if (err instanceof NoActiveHubError) {
          setLoaded(null)
          return
        }
        onErrorRef.current(err)
      },
    ).finally(() => {
      if (gen === generation.current) setLoading(false)
    })
  }, [load, hubId])

  useEffect(() => { reload() }, [reload])

  const setData = useCallback((update: (prev: T) => T) => {
    setLoaded(prev => (prev && prev.hubId === getActiveHub() ? { ...prev, value: update(prev.value) } : prev))
  }, [])

  // Bound at render, not only when the next load settles: the frame after the hub
  // changes must not show the previous hub's rows either.
  const current = hubId !== null && loaded?.hubId === hubId ? loaded.value : empty
  return { data: current, noHub: hubId === null, loading: hubId !== null && loading, reload, setData }
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
