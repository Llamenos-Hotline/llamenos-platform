package org.llamenos.hotline.hub

import android.util.Log
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import org.llamenos.hotline.api.ApiService
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.model.Hub
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
     * Switch to a different hub.
     *
     * 1. Persist the new active hub ID via ActiveHubState immediately so the UI updates without delay.
     * 2. If the hub key is not cached, fetch it in the background. Key fetch failures are logged
     *    but do not block the switch — the hub key is only required for E2EE operations (note
     *    decryption), not for hub switching itself.
     */
    suspend fun switchHub(hubId: String) {
        // Set active hub first — UI should update immediately, key fetch is secondary.
        activeHubState.setActiveHub(hubId)
        if (!cryptoService.hasHubKey(hubId)) {
            try {
                val envelope = apiService.getHubKey(hubId)
                cryptoService.loadHubKey(hubId, envelope)
            } catch (_: Exception) {
                // Key fetch failure is non-fatal.
            }
        }
    }

    /**
     * Load hub keys for all hubs eagerly (called after login).
     * Failures are logged and skipped — missing keys mean relay events from that hub
     * cannot be decrypted, which is acceptable.
     */
    suspend fun loadAllHubKeys(hubs: List<Hub>) = coroutineScope {
        hubs.map { hub ->
            async {
                runCatching {
                    if (!cryptoService.hasHubKey(hub.id)) {
                        val envelope = apiService.getHubKey(hub.id)
                        cryptoService.loadHubKey(hub.id, envelope)
                    }
                }.onFailure { _ ->
                }
            }
        }.forEach { it.await() }
    }

    /**
     * Initialize hub selection after login. If no hub is persisted, select the first one.
     */
    suspend fun loadInitialHub(hubs: List<Hub>) {
        if (activeHubState.activeHubId.value != null) return
        hubs.firstOrNull()?.id?.let { switchHub(it) }
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
