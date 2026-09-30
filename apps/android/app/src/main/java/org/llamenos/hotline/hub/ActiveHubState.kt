package org.llamenos.hotline.hub

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import org.llamenos.hotline.di.ApplicationScope
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Single source of truth for the currently active hub ID.
 *
 * Both ApiService and HubRepository inject this to break the circular dependency
 * that would arise if either owned the other. Neither owns this class.
 *
 * Uses an in-memory MutableStateFlow for immediate UI updates on hub switch,
 * with DataStore persistence in the background. This avoids the latency of
 * waiting for DataStore disk I/O before the UI recomposes (critical on slow
 * CI emulators with swiftshader where disk ops take hundreds of milliseconds).
 */
@Singleton
class ActiveHubState @Inject constructor(
    private val dataStore: DataStore<Preferences>,
    @ApplicationScope private val scope: CoroutineScope,
) {
    companion object {
        private val ACTIVE_HUB_KEY = stringPreferencesKey("activeHubId")
    }

    private val _activeHubId = MutableStateFlow<String?>(null)

    val activeHubId: StateFlow<String?> = _activeHubId

    private val hydrated = CompletableDeferred<Unit>()

    init {
        // Hydrate from DataStore on startup, then keep in-memory state as source of truth.
        scope.launch {
            dataStore.data
                .map { prefs -> prefs[ACTIVE_HUB_KEY] }
                .collect { persisted ->
                    // Only update from DataStore if we haven't set a value yet (startup hydration)
                    // or if an external process changed it.
                    _activeHubId.compareAndSet(null, persisted)
                    hydrated.complete(Unit)
                }
        }
    }

    /**
     * Suspends until the persisted choice has been read. A null [activeHubId] before this
     * means "not loaded yet", not "no hub chosen" — deciding on it would overwrite the
     * user's own choice.
     */
    suspend fun awaitHydrated() = hydrated.await()

    private val _refreshTrigger = MutableSharedFlow<Unit>(extraBufferCapacity = 1)

    /**
     * Emits when a forced refresh is requested, regardless of whether the hub ID changed.
     *
     * ViewModels subscribe to this to re-fetch hub-scoped data when external state
     * changes (e.g., a test simulates a new active call and needs the UI to pick it up).
     * This avoids the StateFlow conflation problem where setting the hub back to its
     * current value doesn't trigger a new emission.
     */
    val refreshTrigger: SharedFlow<Unit> = _refreshTrigger.asSharedFlow()

    suspend fun setActiveHub(hubId: String) {
        // Update in-memory state immediately for instant UI recomposition.
        _activeHubId.value = hubId
        // Persist to DataStore in the background (non-blocking for the caller).
        dataStore.edit { prefs -> prefs[ACTIVE_HUB_KEY] = hubId }
    }

    /**
     * Signal all subscribers to re-fetch their hub-scoped data.
     * Does not change the active hub ID — purely a refresh signal.
     */
    suspend fun triggerRefresh() {
        _refreshTrigger.emit(Unit)
    }

    suspend fun clearActiveHub() {
        _activeHubId.value = null
        dataStore.edit { prefs -> prefs.remove(ACTIVE_HUB_KEY) }
    }
}
