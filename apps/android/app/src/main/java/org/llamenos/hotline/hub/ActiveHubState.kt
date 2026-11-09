package org.llamenos.hotline.hub

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.merge
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.launch
import org.llamenos.hotline.di.ApplicationScope
import javax.inject.Inject
import javax.inject.Singleton

/**
 * What this session knows about which hubs the user belongs to (#2565).
 *
 * With no active hub, this is the difference between "the user belongs to no hub" —
 * nothing to browse — and "nobody knows", which a hub-owned screen must never present as
 * an empty list. An empty schedule for a hub that could not be reached tells a rostered
 * volunteer they are off shift.
 *
 * Browsing context only: incoming calls and notifications are handled for every member
 * hub whatever this says (multi-hub routing axiom).
 */
sealed interface HubMembership {
    /** Not asked yet this session, or the answer is still in flight. */
    data object Unknown : HubMembership

    /** The server answered, and the active hub was reconciled against its answer. */
    data object Loaded : HubMembership

    /** The server could not be asked, or did not answer. */
    data class Failed(val cause: Exception) : HubMembership
}

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

    private val _membership = MutableStateFlow<HubMembership>(HubMembership.Unknown)

    /**
     * What the session's latest hub-list load established; see [HubMembership]. Only
     * meaningful while [activeHubId] is null — a chosen hub is browsed whether or not the
     * list could be re-read since.
     */
    val membership: StateFlow<HubMembership> = _membership

    /** A hub-list load has started: until it settles, membership is not known. */
    fun beginMembershipLoad() {
        _membership.value = HubMembership.Unknown
    }

    /** The hub list was read and the active hub reconciled against it. */
    fun recordMembershipLoaded() {
        _membership.value = HubMembership.Loaded
    }

    /** The hub list could not be read. */
    fun recordMembershipFailed(cause: Exception) {
        _membership.value = HubMembership.Failed(cause)
    }

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

/**
 * Runs [load] each time what a hub-owned screen can show may have changed: a hub becomes
 * active, or — with none active — what is known about membership changes.
 *
 * Keying a screen on [ActiveHubState.activeHubId] alone is the defect in #2565: a screen
 * opened while the hub list is loading settles on "no hub", and when the load then FAILS
 * the active hub stays null, so the screen never loads again and shows an empty list for
 * a hub nobody could reach. Membership changes are ignored while a hub is active: that
 * hub is what is browsed, and its own change already reloads.
 */
fun ActiveHubState.launchOnBrowsingChange(scope: CoroutineScope, load: () -> Unit): Job =
    merge(
        activeHubId.filterNotNull(),
        membership.filter { activeHubId.value == null },
    )
        .onEach { load() }
        .launchIn(scope)
