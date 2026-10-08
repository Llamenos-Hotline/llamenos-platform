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
import org.llamenos.protocol.SharedEntry
import org.llamenos.hotline.model.AuditLogResponse
import org.llamenos.hotline.model.ShiftResponse
import org.llamenos.hotline.model.ShiftsListResponse
import org.llamenos.hotline.model.User
import org.llamenos.hotline.model.UsersListResponse
import javax.inject.Inject

data class VolunteerDetailUiState(
    val volunteer: User? = null,
    val shifts: List<ShiftResponse> = emptyList(),
    val auditEntries: List<SharedEntry> = emptyList(),
    val isLoading: Boolean = false,
    val isLoadingAudit: Boolean = false,
    val error: String? = null,
)

@HiltViewModel
class UserDetailViewModel @Inject constructor(
    private val apiService: ApiService,
) : ViewModel() {

    private val _uiState = MutableStateFlow(VolunteerDetailUiState())
    val uiState: StateFlow<VolunteerDetailUiState> = _uiState.asStateFlow()

    fun loadUser(pubkey: String) {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoading = true, error = null) }
            try {
                val volResponse = apiService.request<UsersListResponse>(
                    "GET", "/api/users",
                )
                val volunteer = volResponse.users.find { it.pubkey == pubkey }
                _uiState.update {
                    it.copy(volunteer = volunteer, isLoading = false)
                }

                // Load shifts in background
                loadShifts(pubkey)
                loadAuditEntries(pubkey)
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(isLoading = false, error = e.message ?: "Failed to load user")
                }
            }
        }
    }

    private fun loadShifts(pubkey: String) {
        viewModelScope.launch {
            try {
                val response = apiService.request<ShiftsListResponse>(
                    "GET", apiService.hp("/api/shifts"),
                )
                // Filter shifts that include this volunteer
                val assigned = response.shifts.filter { pubkey in it.userPubkeys }
                _uiState.update { it.copy(shifts = assigned) }
            } catch (_: Exception) {
                // Shifts are supplementary — silently fail
            }
        }
    }

    private fun loadAuditEntries(pubkey: String) {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoadingAudit = true) }
            try {
                val response = apiService.request<AuditLogResponse>(
                    "GET", apiService.hp("/api/audit") + "?actorPubkey=$pubkey&limit=20",
                )
                _uiState.update {
                    it.copy(auditEntries = response.entries, isLoadingAudit = false)
                }
            } catch (_: Exception) {
                _uiState.update { it.copy(isLoadingAudit = false) }
            }
        }
    }

    fun dismissError() {
        _uiState.update { it.copy(error = null) }
    }
}
