package org.llamenos.hotline.hub

import android.util.Log
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import org.llamenos.hotline.api.ApiException
import org.llamenos.hotline.api.ApiService
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.model.Hub
import org.llamenos.hotline.model.HubsListResponse
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
    }
}
