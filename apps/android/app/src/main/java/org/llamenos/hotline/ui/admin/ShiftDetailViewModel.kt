package org.llamenos.hotline.ui.admin

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import org.llamenos.hotline.api.ApiService
import org.llamenos.hotline.model.ShiftResponse
import org.llamenos.hotline.model.ShiftsListResponse
import org.llamenos.hotline.model.User
import org.llamenos.hotline.model.UsersListResponse
import org.llamenos.protocol.UpdateShiftBody
import javax.inject.Inject

data class ShiftDetailUiState(
    val shift: ShiftResponse? = null,
    val allVolunteers: List<User> = emptyList(),
    val assignedPubkeys: Set<String> = emptySet(),
    val isLoading: Boolean = false,
    val isSaving: Boolean = false,
    val error: String? = null,
    val saveSuccess: Boolean = false,
)

@HiltViewModel
class ShiftDetailViewModel @Inject constructor(
    private val apiService: ApiService,
) : ViewModel() {

    private val _uiState = MutableStateFlow(ShiftDetailUiState())
    val uiState: StateFlow<ShiftDetailUiState> = _uiState.asStateFlow()

    fun loadShift(shiftId: String) {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoading = true, error = null) }
            try {
                val shiftsResponse = apiService.request<ShiftsListResponse>(
                    "GET", apiService.hp("/api/shifts"),
                )
                val shift = shiftsResponse.shifts.find { it.id == shiftId }

                val volResponse = apiService.request<UsersListResponse>(
                    "GET", "/api/users",
                )

                val assignedPubkeys = shift?.userPubkeys?.toSet() ?: emptySet()

                _uiState.update {
                    it.copy(
                        shift = shift,
                        allVolunteers = volResponse.users,
                        assignedPubkeys = assignedPubkeys,
                        isLoading = false,
                    )
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(isLoading = false, error = e.message ?: "Failed to load shift")
                }
            }
        }
    }

    fun toggleVolunteer(pubkey: String) {
        _uiState.update { state ->
            val current = state.assignedPubkeys
            val updated = if (pubkey in current) current - pubkey else current + pubkey
            state.copy(assignedPubkeys = updated)
        }
    }

    fun saveAssignments() {
        val shift = _uiState.value.shift ?: return
        viewModelScope.launch {
            _uiState.update { it.copy(isSaving = true, error = null) }
            try {
                // Only the volunteer roster changes here — `days`, `encryptedName`,
                // `startTime` and `endTime` are omitted so they are never touched by
                // this screen (see issue #1149: a resend-everything update silently
                // rewrote recurrence from this same code path before).
                val request = UpdateShiftBody(
                    userPubkeys = _uiState.value.assignedPubkeys.toList(),
                )
                // PATCH — see AdminViewModel.updateShift: `PUT /api/shifts/:id`
                // is not mounted and answered 404, so saving a roster from this
                // screen never reached the server (#1724).
                apiService.requestNoContent("PATCH", apiService.hp("/api/shifts/${shift.id}"), request)
                _uiState.update { it.copy(isSaving = false, saveSuccess = true) }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(isSaving = false, error = e.message ?: "Failed to save assignments")
                }
            }
        }
    }

    fun dismissError() {
        _uiState.update { it.copy(error = null) }
    }
}
