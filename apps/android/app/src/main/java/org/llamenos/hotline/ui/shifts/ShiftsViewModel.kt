package org.llamenos.hotline.ui.shifts

import androidx.annotation.StringRes
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
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
import org.llamenos.hotline.api.ApiException
import org.llamenos.hotline.api.ApiService
import org.llamenos.hotline.api.ShiftClockRepository
import org.llamenos.hotline.hub.ActiveHubState
import org.llamenos.hotline.model.ShiftResponse
import org.llamenos.hotline.model.ShiftsListResponse
import org.llamenos.hotline.telephony.SipRegistrar
import org.llamenos.protocol.CreateShiftJoinRequestBody
import org.llamenos.protocol.SharedCreateShiftJoinRequestBodyType
import org.llamenos.protocol.ShiftJoinRequestResponse
import javax.inject.Inject

data class ShiftsUiState(
    val shifts: List<ShiftResponse> = emptyList(),
    /** When this device clocked in to the active hub; null while clocked out of it. */
    val clockedInAt: String? = null,
    /** shiftId → join/leave request awaiting admin review, submitted from this screen. */
    val pendingRequests: Map<String, SharedCreateShiftJoinRequestBodyType> = emptyMap(),
    val isLoading: Boolean = false,
    val isRefreshing: Boolean = false,
    val isClockingInOut: Boolean = false,
    val error: String? = null,
    /** Set when clocked in but this device could not be registered to ring. */
    @StringRes val callSetupErrorRes: Int? = null,
    val showDropConfirmation: String? = null, // shift ID if dialog is showing
)

/**
 * ViewModel for the Shifts feature.
 *
 * Manages shift listing, clock in/out, and join/leave requests for the active hub.
 * Shifts are grouped by day for display and include status badges
 * showing availability and assignment.
 *
 * Signing up for or dropping a shift submits a join/leave request for admin
 * review — volunteers never edit a shift's roster directly.
 */
@HiltViewModel
class ShiftsViewModel @Inject constructor(
    private val apiService: ApiService,
    private val activeHubState: ActiveHubState,
    private val shiftClockRepository: ShiftClockRepository,
    private val sipRegistrar: SipRegistrar,
) : ViewModel() {

    private val _uiState = MutableStateFlow(ShiftsUiState())
    val uiState: StateFlow<ShiftsUiState> = _uiState.asStateFlow()

    init {
        activeHubState.activeHubId
            .filterNotNull()
            .onEach { refresh() }
            .launchIn(viewModelScope)

        combine(shiftClockRepository.clockedIn, activeHubState.activeHubId) { clockedIn, hubId ->
            hubId?.let { clockedIn[it] }
        }
            .onEach { startedAt -> _uiState.update { it.copy(clockedInAt = startedAt) } }
            .launchIn(viewModelScope)
    }

    /**
     * Load available shifts from the API.
     */
    fun loadShifts() {
        viewModelScope.launch {
            _uiState.update {
                it.copy(
                    isLoading = it.shifts.isEmpty(),
                    isRefreshing = it.shifts.isNotEmpty(),
                    error = null,
                )
            }

            try {
                val response = apiService.request<ShiftsListResponse>("GET", apiService.hp("/api/shifts"))
                _uiState.update {
                    it.copy(
                        shifts = response.shifts,
                        isLoading = false,
                        isRefreshing = false,
                    )
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isLoading = false,
                        isRefreshing = false,
                        error = e.message ?: "Failed to load shifts",
                    )
                }
            }
        }
    }

    /**
     * Refresh all shift data (pull-to-refresh).
     */
    fun refresh() {
        loadShifts()
    }

    /**
     * Clock in to the active hub's shift roster.
     *
     * [microphoneGranted] is the outcome of the runtime `RECORD_AUDIO` request the screen makes
     * first (see [org.llamenos.hotline.telephony.rememberMicrophoneRequest]). A refusal does not
     * stop the clock-in — the volunteer still receives calls on their phone — but it does mean
     * this device cannot answer in the app, which is said plainly rather than discovered when a
     * call connects with no microphone.
     */
    fun clockIn(microphoneGranted: Boolean = true) {
        clockAction("Failed to clock in") { hubId ->
            shiftClockRepository.clockIn(hubId)
            if (microphoneGranted) {
                reportCallSetup(sipRegistrar.registerMemberHubs())
            } else {
                _uiState.update { it.copy(callSetupErrorRes = R.string.incoming_call_microphone_required) }
            }
        }
    }

    /**
     * Clock out of the active hub's shift roster.
     */
    fun clockOut() {
        clockAction("Failed to clock out") { hubId ->
            shiftClockRepository.clockOut(hubId)
            _uiState.update { it.copy(callSetupErrorRes = null) }
            reportCallSetup(sipRegistrar.syncWithShift(shiftClockRepository.clockedIn.value.isNotEmpty()))
        }
    }

    private fun clockAction(failure: String, action: suspend (hubId: String) -> Unit) {
        // Explicit user action in the hub being browsed — the only place the active hub decides.
        val hubId = activeHubState.activeHubId.value
        if (hubId == null) {
            _uiState.update { it.copy(error = failure) }
            return
        }
        viewModelScope.launch {
            _uiState.update { it.copy(isClockingInOut = true, error = null) }
            try {
                action(hubId)
                _uiState.update { it.copy(isClockingInOut = false) }
            } catch (e: Exception) {
                _uiState.update { it.copy(isClockingInOut = false, error = e.message ?: failure) }
            }
        }
    }

    /**
     * Retry registering this device for in-app calls after a failed attempt.
     *
     * Gated on the microphone the same way clocking in is: registering a device that cannot
     * capture audio puts it into parallel ringing only to answer into silence, so the retry is
     * refused and the reason restated instead. Leaving it unregistered also means the call rings
     * a volunteer who CAN answer it.
     */
    fun retryCallSetup(microphoneGranted: Boolean = true) {
        if (!microphoneGranted) {
            _uiState.update { it.copy(callSetupErrorRes = R.string.incoming_call_microphone_required) }
            return
        }
        viewModelScope.launch {
            reportCallSetup(sipRegistrar.registerMemberHubs())
        }
    }

    /**
     * Request to join an available shift. An admin approves or rejects it.
     */
    fun signUp(shiftId: String) {
        submitRequest(shiftId, SharedCreateShiftJoinRequestBodyType.Join, "Failed to sign up for shift")
    }

    /**
     * Show the drop confirmation dialog for a shift.
     */
    fun showDropConfirmation(shiftId: String) {
        _uiState.update { it.copy(showDropConfirmation = shiftId) }
    }

    /**
     * Dismiss the drop confirmation dialog.
     */
    fun dismissDropConfirmation() {
        _uiState.update { it.copy(showDropConfirmation = null) }
    }

    /**
     * Request to leave an assigned shift after user confirmation. An admin approves or rejects it.
     */
    fun dropShift(shiftId: String) {
        _uiState.update { it.copy(showDropConfirmation = null) }
        submitRequest(shiftId, SharedCreateShiftJoinRequestBodyType.Leave, "Failed to drop shift")
    }

    private fun submitRequest(shiftId: String, type: SharedCreateShiftJoinRequestBodyType, failure: String) {
        val hubId = activeHubState.activeHubId.value
        if (hubId == null) {
            _uiState.update { it.copy(error = failure) }
            return
        }
        viewModelScope.launch {
            _uiState.update { it.copy(error = null) }
            try {
                val created = apiService.request<ShiftJoinRequestResponse>(
                    "POST",
                    "/api/hubs/$hubId/shifts/requests",
                    CreateShiftJoinRequestBody(shiftID = shiftId, type = type),
                )
                markPending(created.shiftID, created.type)
            } catch (e: ApiException) {
                // 409: a request for this shift is already awaiting review.
                if (e.code == 409) markPending(shiftId, type)
                else _uiState.update { it.copy(error = e.message.ifBlank { failure }) }
            } catch (e: Exception) {
                _uiState.update { it.copy(error = e.message ?: failure) }
            }
        }
    }

    private fun markPending(shiftId: String, type: SharedCreateShiftJoinRequestBodyType) {
        _uiState.update { it.copy(pendingRequests = it.pendingRequests + (shiftId to type)) }
    }

    /**
     * Clear the error state.
     */
    fun clearError() {
        _uiState.update { it.copy(error = null, callSetupErrorRes = null) }
    }

    private fun reportCallSetup(result: SipRegistrar.Result?) {
        when (result) {
            is SipRegistrar.Result.Failed ->
                _uiState.update { it.copy(callSetupErrorRes = R.string.dashboard_error_in_app_calls_unavailable) }
            is SipRegistrar.Result.Registered, is SipRegistrar.Result.NotAvailable ->
                _uiState.update { it.copy(callSetupErrorRes = null) }
            null -> {}
        }
    }
}
