import { useMemo } from 'react'
import { useConfig } from './config'

/**
 * IDs of every hub the authenticated user is a member of (sorted, stable
 * identity while the set is unchanged).
 *
 * This is deliberately NOT an instance-wide hub list. Membership comes from the
 * authenticated `GET /hubs`, which the server filters by the user's hub roles;
 * `ConfigProvider` holds the result and `AuthProvider` refreshes it while a
 * session exists. Before #1708 the public, pre-login `/config` roster was used
 * for the active hub, which is how a volunteer ended up browsing a hub they
 * were not in.
 *
 * The active hub is always included — it is by definition one the user can
 * browse, and it keeps single-hub behaviour intact while membership is loading.
 *
 * Multi-hub axiom: incoming calls and conversation events must be received for
 * every hub in this list, whichever hub is active in the UI.
 */
export function useMemberHubIds(): string[] {
  const { hubs, currentHubId } = useConfig()

  const key = [...new Set(currentHubId ? [...hubs.map(h => h.id), currentHubId] : hubs.map(h => h.id))].sort().join(',')
  // Re-derive the array only when the set changes so effects keyed on it don't churn.
  return useMemo(() => (key ? key.split(',') : []), [key])
}
