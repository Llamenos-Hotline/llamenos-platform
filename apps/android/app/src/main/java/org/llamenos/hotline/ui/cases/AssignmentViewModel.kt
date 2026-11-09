package org.llamenos.hotline.ui.cases

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import org.llamenos.hotline.api.ApiService
import javax.inject.Inject

data class VolunteerSuggestion(
    val pubkey: String,
    val score: Int,
    val workloadScore: Int,
    val languageScore: Int,
    val specializationScore: Int,
    val availabilityScore: Int,
    val reasons: List<String>,
    val activeCaseCount: Int,
    val maxCases: Int,
    val matchedSpecializations: List<String>,
)

data class SuggestAssigneesResponse(
    val suggestions: List<VolunteerSuggestion>,
)

data class AssignmentUiState(
    val suggestions: List<VolunteerSuggestion> = emptyList(),
    val isLoading: Boolean = false,
    val isAssigning: Boolean = false,
    val error: String? = null,
    val assignedSuccess: Boolean = false,
)

@HiltViewModel
class AssignmentViewModel @Inject constructor(
    private val apiService: ApiService,
) : ViewModel() {

    private val _uiState = MutableStateFlow(AssignmentUiState())
    val uiState: StateFlow<AssignmentUiState> = _uiState.asStateFlow()

    fun loadSuggestions(recordId: String, language: String? = null) {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoading = true, error = null) }
            try {
                var path = apiService.activeHubPath("/api/records/$recordId/suggest-assignees")
                if (language != null) path += "?language=$language"
                val response = apiService.request<SuggestAssigneesResponse>("GET", path)
                _uiState.update { it.copy(suggestions = response.suggestions, isLoading = false) }
            } catch (e: Exception) {
                _uiState.update { it.copy(isLoading = false, error = e.message) }
            }
        }
    }

    fun assign(recordId: String, pubkey: String, onSuccess: () -> Unit) {
        viewModelScope.launch {
            _uiState.update { it.copy(isAssigning = true, error = null) }
            try {
                apiService.request<Map<String, Any>>(
                    "POST",
                    apiService.activeHubPath("/api/records/$recordId/assign"),
                    body = mapOf("pubkeys" to listOf(pubkey)),
                )
                _uiState.update { it.copy(isAssigning = false, assignedSuccess = true) }
                onSuccess()
            } catch (e: Exception) {
                _uiState.update { it.copy(isAssigning = false, error = e.message) }
            }
        }
    }

    fun dismissError() {
        _uiState.update { it.copy(error = null) }
    }
}
