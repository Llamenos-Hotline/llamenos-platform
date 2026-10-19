package org.llamenos.hotline.hub

import android.util.Log
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.SerializationException
import org.llamenos.hotline.api.ApiException
import org.llamenos.hotline.api.ApiService
import org.llamenos.hotline.crypto.CryptoException
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.model.Hub
import org.llamenos.hotline.model.HubsListResponse
import org.llamenos.protocol.HubKeyEnvelopeResponse
import java.io.IOException
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Orchestrates hub switching. Injects ActiveHubState and ApiService independently;
 * does not create a circular dependency because neither ApiService nor ActiveHubState
 * owns the other.
 */
@Singleton
class HubRepository @Inject constructor(
    private val apiService: ApiService,
    private val cryptoService: CryptoService,
    private val activeHubState: ActiveHubState,
) {

    /**
     * Wrapped hub-key envelopes for every hub whose key is currently loaded in Rust.
     *
     * The Rust store has no per-hub removal, so evicting one hub's key means clearing
     * them all and re-unwrapping the survivors from here — locally, with no network.
     * The envelopes are HPKE-wrapped to this device's key; holding them exposes nothing
     * the server does not already serve this device.
     */
    private val heldEnvelopes = mutableMapOf<String, HubKeyEnvelopeResponse>()
    private val keyCacheMutex = Mutex()

    /** Outcome of fetching one hub's key envelope. */
    private sealed interface KeyFetch {
        data class Fetched(val envelope: HubKeyEnvelopeResponse) : KeyFetch
        /** 403/404: not a member any more, or excluded from the current key. */
        data object Revoked : KeyFetch
        /** Network, auth or server failure — the cached key, if any, is kept. */
        data object Unavailable : KeyFetch
    }

    /**
     * Switch to a different hub.
     *
     * 1. Persist the new active hub ID via ActiveHubState immediately so the UI updates without delay.
     * 2. Refresh the hub key. Failures do not block the switch — the hub key is only required
     *    for E2EE operations, not for hub switching itself.
     */
    suspend fun switchHub(hubId: String) {
        // Set active hub first — UI should update immediately, key fetch is secondary.
        activeHubState.setActiveHub(hubId)
        refreshHubKey(hubId)
    }

    /**
     * Fetch [hubId]'s current key and replace the cached one.
     *
     * Always asks the server: a cached key may predate a rotation, and a member removed
     * from the hub must not keep it. A 403 (no longer a member) or 404 (excluded from the
     * current key's envelopes) evicts the cached key; a network failure is retried and,
     * if it persists, leaves the cached key in place.
     */
    suspend fun refreshHubKey(hubId: String) {
        applyFetches(mapOf(hubId to fetchHubKey(hubId)))
    }

    /**
     * Refresh the keys of every hub in [hubs] — the server's authoritative member-hub
     * list — and evict the key of any held hub that is no longer on it.
     */
    suspend fun loadAllHubKeys(hubs: List<Hub>) {
        val fetched = coroutineScope {
            hubs.map { hub -> async { hub.id to fetchHubKey(hub.id) } }.awaitAll().toMap()
        }
        val dropped = keyCacheMutex.withLock { heldEnvelopes.keys - fetched.keys }
        applyFetches(fetched + dropped.associateWith { KeyFetch.Revoked })
    }

    private suspend fun fetchHubKey(hubId: String): KeyFetch {
        var attempt = 0
        while (true) {
            try {
                return KeyFetch.Fetched(apiService.getHubKey(hubId))
            } catch (e: ApiException) {
                // 5xx/429 were already retried by RetryInterceptor.
                if (e.code == 403 || e.code == 404) {
                    Log.w(TAG, "hub key for $hubId revoked (HTTP ${e.code})")
                    return KeyFetch.Revoked
                }
                Log.w(TAG, "hub key for $hubId unavailable (HTTP ${e.code})")
                return KeyFetch.Unavailable
            } catch (e: SerializationException) {
                Log.w(TAG, "hub key for $hubId unreadable: ${e.message}")
                return KeyFetch.Unavailable
            } catch (e: IOException) {
                if (attempt >= KEY_FETCH_RETRIES) {
                    Log.w(TAG, "hub key for $hubId unavailable (${e.message})")
                    return KeyFetch.Unavailable
                }
            }
            delay(KEY_FETCH_BACKOFF_MS shl attempt)
            attempt++
        }
    }

    /** Load fetched keys and evict revoked ones, as one step against the Rust store. */
    private suspend fun applyFetches(results: Map<String, KeyFetch>) = keyCacheMutex.withLock {
        for ((hubId, result) in results) {
            if (result is KeyFetch.Fetched && unwrap(hubId, result.envelope)) {
                heldEnvelopes[hubId] = result.envelope
            }
        }
        val revoked = results.filterValues { it == KeyFetch.Revoked }.keys
        if (revoked.isEmpty()) return@withLock
        heldEnvelopes.keys.removeAll(revoked)
        cryptoService.clearHubKeysOnly()
        val survivors = heldEnvelopes.toMap()
        heldEnvelopes.clear()
        for ((hubId, envelope) in survivors) {
            if (unwrap(hubId, envelope)) heldEnvelopes[hubId] = envelope
        }
    }

    private suspend fun unwrap(hubId: String, envelope: HubKeyEnvelopeResponse): Boolean =
        try {
            cryptoService.loadHubKey(hubId, envelope)
            true
        } catch (e: CryptoException) {
            // Locked, or an envelope this device cannot open.
            Log.w(TAG, "hub key for $hubId not loaded: ${e.message}")
            false
        }

    /**
     * Give a signed-in user a hub to browse (#1340), from the hubs the server says they
     * belong to. Runs when the unlocked app opens and on the dashboard's pull-to-refresh
     * (a hub admin may have added the user since). Browsing context only: it never
     * replaces a hub the user chose and still belongs to, and it runs in the foreground,
     * never from a background event.
     *
     * An unregistered identity, or no network, has no hub list to choose from; that is
     * logged and the current choice is left alone.
     */
    suspend fun selectInitialHub() {
        val hubs = try {
            apiService.request<HubsListResponse>("GET", "/api/hubs").hubs
        } catch (e: ApiException) {
            Log.w(TAG, "hub list unavailable (HTTP ${e.code}); active hub unchanged")
            return
        } catch (e: IOException) {
            Log.w(TAG, "hub list unavailable (${e.message}); active hub unchanged")
            return
        }
        loadInitialHub(hubs)
    }

    /**
     * Keep the persisted hub if the user is still a member of it; otherwise select their
     * first hub, or none if they belong to none.
     */
    suspend fun loadInitialHub(hubs: List<Hub>) {
        activeHubState.awaitHydrated()
        val current = activeHubState.activeHubId.value
        if (current != null && hubs.any { it.id == current }) return
        val first = hubs.firstOrNull()
        when {
            first != null -> switchHub(first.id)
            current != null -> activeHubState.clearActiveHub()
        }
    }

    private companion object {
        const val TAG = "HubRepository"
        /** Retries after the first attempt for a network failure fetching a hub key. */
        const val KEY_FETCH_RETRIES = 2
        const val KEY_FETCH_BACKOFF_MS = 1_000L
    }

    /**
     * Ensure an active hub is selected whenever the user lands on the dashboard with
     * no persisted choice — after a fresh login and on session restore (PIN unlock).
     * No-op when a hub is already selected (restored from DataStore, or chosen by the
     * user in Hub Management).
     *
     * Hub-list fetch failures are non-fatal: the dashboard stays hub-less until the
     * user picks a hub or a later attempt succeeds.
     */
    suspend fun ensureInitialHub() {
        if (activeHubState.activeHubId.value != null) return
        val hubs = runCatching { apiService.getHubs() }.getOrNull()?.hubs ?: return
        loadInitialHub(hubs)
    }
}
