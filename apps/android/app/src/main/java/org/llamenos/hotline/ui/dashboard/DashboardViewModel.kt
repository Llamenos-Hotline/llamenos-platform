package org.llamenos.hotline.ui.dashboard

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import androidx.annotation.StringRes
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import org.llamenos.hotline.R
import org.llamenos.hotline.api.AnalyticsRepository
import org.llamenos.hotline.api.ApiService
import org.llamenos.hotline.api.SessionState
import org.llamenos.hotline.api.ShiftClockRepository
import org.llamenos.hotline.api.WebSocketService
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.hub.ActiveHubState
import org.llamenos.hotline.model.ActiveCall
import org.llamenos.hotline.model.ActiveCallsResponse
import org.llamenos.hotline.model.BanRequest
import org.llamenos.hotline.model.LlamenosEvent
import org.llamenos.hotline.model.MeResponse
import org.llamenos.hotline.service.AttributedHubEvent
import org.llamenos.protocol.MyStatusResponse
import javax.inject.Inject

data class DashboardUiState(
    val signingPubkey: String = "",
    val isOnShift: Boolean = false,
    val isOnBreak: Boolean = false,
    val shiftStartedAt: String? = null,
    val activeCallCount: Int = 0,
    val callsToday: Int = 0,
    val answerRate: Float? = null,
    val avgDurationSeconds: Int? = null,
    val currentCall: ActiveCall? = null,
    /** Hub the [currentCall] belongs to — may differ from the active hub. */
    val currentCallHubId: String? = null,
    val isHangingUp: Boolean = false,
    val isReportingSpam: Boolean = false,
    val isBanning: Boolean = false,
    val connectionState: WebSocketService.ConnectionState = WebSocketService.ConnectionState.DISCONNECTED,
    val isRefreshing: Boolean = false,
    val isClockingInOut: Boolean = false,
    val isTogglingBreak: Boolean = false,
    @StringRes val errorRes: Int? = null,
)

/**
 * ViewModel for the dashboard screen.
 *
 * Manages shift status display, active call count, WebSocket connection state,
 * and real-time event processing. Subscribes to the WebSocket event flow to
 * react to incoming calls, shift updates, and note creation in real time.
 */
@HiltViewModel
class DashboardViewModel @Inject constructor(
    private val cryptoService: CryptoService,
    private val webSocketService: WebSocketService,
    private val apiService: ApiService,
    private val sessionState: SessionState,
    private val activeHubState: ActiveHubState,
    private val analyticsRepository: AnalyticsRepository,
    private val shiftClockRepository: ShiftClockRepository,
) : ViewModel() {

    private val _uiState = MutableStateFlow(DashboardUiState())
    val uiState: StateFlow<DashboardUiState> = _uiState.asStateFlow()

    init {
        val signingPubkey = cryptoService.signingPubkeyHex ?: ""
        _uiState.value = DashboardUiState(signingPubkey = signingPubkey)

        viewModelScope.launch { loadAdminDecryptionPubkey() }
        webSocketService.connect()

        // Subscribe to connection state changes
        viewModelScope.launch {
            webSocketService.connectionState.collect { state ->
                _uiState.update { it.copy(connectionState = state) }
            }
        }

        // Relay events from EVERY member hub. Each carries the hub the server published it
        // to; a call ringing on a hub other than the active one must still reach the
        // volunteer (multi-hub routing axiom) — never filter on the active hub here.
        viewModelScope.launch {
            webSocketService.typedEvents.collect { attributed -> handleEvent(attributed) }
        }

        // Reload hub-scoped data when the active hub changes
        activeHubState.activeHubId
            .filterNotNull()
            .onEach { refresh() }
            .launchIn(viewModelScope)

        // Also refresh when explicitly signaled (e.g., after a test simulates a call).
        // This avoids the StateFlow conflation problem where re-setting the same hub ID
        // doesn't trigger a new emission.
        activeHubState.refreshTrigger
            .onEach { refresh() }
            .launchIn(viewModelScope)

        // Clock state for the hub being viewed; other member hubs keep their own.
        combine(shiftClockRepository.clockedIn, activeHubState.activeHubId) { clockedIn, hubId ->
            hubId?.let { clockedIn[it] }
        }
            .onEach { startedAt ->
                _uiState.update { it.copy(isOnShift = startedAt != null, shiftStartedAt = startedAt) }
            }
            .launchIn(viewModelScope)
    }

    /**
     * React to a relay event from any member hub by updating dashboard state.
     * Call lookups go to the hub the event came from, not the active hub.
     */
    internal fun handleEvent(attributed: AttributedHubEvent<LlamenosEvent>) {
        val hubId = attributed.hubId
        when (val event = attributed.event) {
            is LlamenosEvent.CallRing -> {
                _uiState.update { it.copy(activeCallCount = it.activeCallCount + 1) }
                viewModelScope.launch { fetchActiveCall(hubId) }
            }
            is LlamenosEvent.CallEnded -> {
                _uiState.update {
                    val ended = it.currentCall?.id == event.callId
                    it.copy(
                        activeCallCount = maxOf(0, it.activeCallCount - 1),
                        currentCall = if (ended) null else it.currentCall,
                        currentCallHubId = if (ended) null else it.currentCallHubId,
                    )
                }
            }
            is LlamenosEvent.CallUpdate -> {
                viewModelScope.launch { fetchActiveCall(hubId) }
            }
            is LlamenosEvent.ShiftUpdate -> {
                // Schedule changes do not change this device's clock-in state.
            }
            is LlamenosEvent.NoteCreated -> {
                // Notes list will refresh via its own ViewModel
            }
            is LlamenosEvent.MessageNew -> {
                // Conversations list will refresh via its own ViewModel
            }
            is LlamenosEvent.ConversationAssigned,
            is LlamenosEvent.ConversationClosed -> {
                // Conversations list will refresh via its own ViewModel
            }
            is LlamenosEvent.VoicemailNew -> {
                // Voicemail notifications handled by call UI
            }
            is LlamenosEvent.PresenceSummary -> {
                // Presence updates could refresh availability indicators
            }
            is LlamenosEvent.CallAnswered -> {
                viewModelScope.launch { fetchActiveCall(hubId) }
            }
            is LlamenosEvent.PresenceDetail -> {
                // Admin-only detailed presence — dashboard could show counts
            }
            is LlamenosEvent.MessageStatus -> {
                // Message delivery status — handled by ConversationsViewModel
            }
            is LlamenosEvent.ConversationNew -> {
                // New conversation — handled by ConversationsViewModel
            }
            is LlamenosEvent.DeviceWipe -> {
                // Device wipe handled by DeviceWipeReceiptScreen
            }
            is LlamenosEvent.Unknown -> {
                // Forward compatibility — ignore unknown events
            }
        }
    }

    /**
     * Load the admin decryption pubkey from GET /api/auth/me into the session.
     * (Server event keys for the relay are loaded by [WebSocketService].)
     */
    private suspend fun loadAdminDecryptionPubkey() {
        try {
            val me = apiService.request<MeResponse>("GET", "/api/auth/me")
            sessionState.adminDecryptionPubkey = me.adminDecryptionPubkey
        } catch (_: Exception) {
            // Non-fatal — retried on the next dashboard load.
        }
    }

    /**
     * Refresh health check against the active hub. `my-status` needs no permission
     * beyond authentication, so it cannot fail for a role that lacks call access.
     */
    private suspend fun checkHubReachable(): Boolean {
        return try {
            apiService.request<MyStatusResponse>("GET", apiService.hp("/api/shifts/my-status"))
            true
        } catch (e: Exception) {
            android.util.Log.w("DashboardViewModel", "my-status check failed: ${e.message}")
            false
        }
    }

    /**
     * Quick clock in to the active hub from the dashboard.
     */
    fun clockIn() {
        clockAction(R.string.dashboard_error_clock_in) { hubId -> shiftClockRepository.clockIn(hubId) }
    }

    /**
     * Quick clock out of the active hub from the dashboard.
     */
    fun clockOut() {
        clockAction(R.string.dashboard_error_clock_out) { hubId -> shiftClockRepository.clockOut(hubId) }
    }

    private fun clockAction(@StringRes failure: Int, action: suspend (hubId: String) -> Unit) {
        // Explicit user action in the hub being browsed — the only place the active hub decides.
        val hubId = activeHubState.activeHubId.value
        if (hubId == null) {
            _uiState.update { it.copy(errorRes = failure) }
            return
        }
        viewModelScope.launch {
            _uiState.update { it.copy(isClockingInOut = true, errorRes = null) }
            try {
                action(hubId)
            } catch (_: Exception) {
                _uiState.update { it.copy(errorRes = failure) }
            }
            _uiState.update { it.copy(isClockingInOut = false) }
        }
    }

    /**
     * Toggle break status.
     */
    fun toggleBreak() {
        viewModelScope.launch {
            _uiState.update { it.copy(isTogglingBreak = true, errorRes = null) }
            val newBreakState = !_uiState.value.isOnBreak
            try {
                apiService.requestNoContent(
                    "PATCH",
                    "/api/auth/me/availability",
                    mapOf("onBreak" to newBreakState),
                )
                _uiState.update {
                    it.copy(isOnBreak = newBreakState, isTogglingBreak = false)
                }
            } catch (_: Exception) {
                _uiState.update {
                    it.copy(
                        isTogglingBreak = false,
                        errorRes = R.string.dashboard_error_break,
                    )
                }
            }
        }
    }

    // MARK: - Call Actions

    /**
     * Hang up the current active call.
     */
    fun hangupCall() {
        val callId = _uiState.value.currentCall?.id ?: return
        val path = currentCallPath("/api/calls/$callId/hangup")
        viewModelScope.launch {
            _uiState.update { it.copy(isHangingUp = true) }
            try {
                apiService.requestNoContent("POST", path)
                _uiState.update { it.copy(currentCall = null, currentCallHubId = null, isHangingUp = false) }
            } catch (_: Exception) {
                _uiState.update { it.copy(isHangingUp = false, errorRes = R.string.call_actions_ban_failed) }
            }
        }
    }

    /**
     * Report the current active call as spam.
     */
    fun reportSpam() {
        val callId = _uiState.value.currentCall?.id ?: return
        val path = currentCallPath("/api/calls/$callId/spam")
        viewModelScope.launch {
            _uiState.update { it.copy(isReportingSpam = true) }
            try {
                apiService.requestNoContent("POST", path)
                _uiState.update { it.copy(isReportingSpam = false) }
            } catch (_: Exception) {
                _uiState.update { it.copy(isReportingSpam = false, errorRes = R.string.call_actions_ban_failed) }
            }
        }
    }

    /**
     * Ban the caller and hang up the call.
     */
    fun banAndHangup(reason: String?) {
        val callId = _uiState.value.currentCall?.id ?: return
        val path = currentCallPath("/api/calls/$callId/ban")
        viewModelScope.launch {
            _uiState.update { it.copy(isBanning = true) }
            try {
                if (reason != null) {
                    apiService.requestNoContent("POST", path, BanRequest(reason))
                } else {
                    apiService.requestNoContent("POST", path)
                }
                _uiState.update { it.copy(currentCall = null, currentCallHubId = null, isBanning = false) }
            } catch (_: Exception) {
                _uiState.update { it.copy(isBanning = false, errorRes = R.string.call_actions_ban_failed) }
            }
        }
    }

    /**
     * Path for an action on the current call, scoped to the hub the call belongs to.
     * Falls back to the active hub for calls loaded by a dashboard refresh.
     */
    private fun currentCallPath(path: String): String {
        val hubId = _uiState.value.currentCallHubId
        return if (hubId != null) apiService.hubPath(hubId, path) else apiService.hp(path)
    }

    /**
     * Fetch the volunteer's active call from the API.
     *
     * @param hubId the hub to query — the hub a relay event came from. Null means the
     *   active hub (dashboard refresh).
     */
    private suspend fun fetchActiveCall(hubId: String? = null) {
        try {
            val path = if (hubId != null) apiService.hubPath(hubId, "/api/calls/active") else apiService.hp("/api/calls/active")
            val response = apiService.request<ActiveCallsResponse>("GET", path)
            val call = response.calls.firstOrNull()
            if (call != null) {
                if (org.llamenos.hotline.BuildConfig.DEBUG) android.util.Log.d("DashboardViewModel", "fetchActiveCall: found call id=${call.id} status=${call.status}")
            }
            val callHubId = if (call != null) hubId ?: activeHubState.activeHubId.value else null
            _uiState.update { it.copy(currentCall = call, currentCallHubId = callHubId) }
        } catch (e: Exception) {
            // Non-fatal — active call will be updated on next event.
            // Log for CI diagnostics — silent 401s from replay detection or
            // missing user registration are invisible without this.
            android.util.Log.w("DashboardViewModel", "fetchActiveCall failed: ${e.message}")
        }
    }

    /**
     * Load analytics stats (answer rate, avg duration) for the dashboard stat cards.
     * Non-fatal — stat cards stay hidden if the fetch fails.
     */
    private suspend fun loadAnalyticsStats() {
        try {
            val callMetrics = analyticsRepository.getCallMetrics()
            val personalStats = analyticsRepository.getPersonalStats()
            _uiState.update {
                it.copy(
                    answerRate = callMetrics.answerRate.toFloat(),
                    avgDurationSeconds = personalStats.avgDurationSeconds.toInt(),
                    callsToday = personalStats.callsToday.toInt().coerceAtLeast(it.callsToday),
                )
            }
        } catch (_: Exception) {
            // Non-fatal: stat cards simply won't show until next refresh
        }
    }

    /**
     * Pull-to-refresh on the dashboard.
     */
    fun refresh() {
        viewModelScope.launch {
            if (org.llamenos.hotline.BuildConfig.DEBUG) android.util.Log.d("DashboardViewModel", "refresh() started")
            _uiState.update { it.copy(isRefreshing = true, errorRes = null) }
            if (!checkHubReachable()) {
                _uiState.update { it.copy(errorRes = R.string.dashboard_error_refresh) }
            }
            fetchActiveCall()
            loadAnalyticsStats()
            _uiState.update { it.copy(isRefreshing = false) }
        }
    }

    /**
     * Dismiss the error message.
     */
    fun dismissError() {
        _uiState.update { it.copy(errorRes = null) }
    }

    override fun onCleared() {
        super.onCleared()
        webSocketService.disconnect()
    }
}
