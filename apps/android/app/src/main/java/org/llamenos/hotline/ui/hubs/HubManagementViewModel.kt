package org.llamenos.hotline.ui.hubs

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import org.llamenos.hotline.api.ApiService
import org.llamenos.hotline.hub.ActiveHubState
import org.llamenos.hotline.hub.HubRepository
import org.llamenos.hotline.model.CreateHubRequest
import org.llamenos.hotline.model.CreateHubResponse
import org.llamenos.hotline.model.Hub
import javax.inject.Inject

/**
 * UI state for the hub management screens.
 */
data class HubListState(
    val hubs: List<Hub> = emptyList(),
    val isLoading: Boolean = false,
    val isRefreshing: Boolean = false,
    val error: String? = null,

    // Create hub
    val isCreating: Boolean = false,
    val createError: String? = null,
    val createSuccess: Boolean = false,

    // Switching state (active hub ID is a separate StateFlow — see HubManagementViewModel.activeHubId)
    val isSwitching: Boolean = false,
)

/**
 * ViewModel for hub management screens (list + create).
 *
 * Loads hubs from GET /api/hubs and supports creating new hubs
 * via POST /api/hubs. Hub switching delegates to [HubRepository] which
 * fetches the E2EE key envelope and persists the active hub via [ActiveHubState].
 */
@HiltViewModel
class HubManagementViewModel @Inject constructor(
    private val apiService: ApiService,
    private val hubRepository: HubRepository,
    private val activeHubState: ActiveHubState,
) : ViewModel() {

    private val _uiState = MutableStateFlow(HubListState())
    val uiState: StateFlow<HubListState> = _uiState.asStateFlow()

    /** The currently active hub ID, driven by persisted ActiveHubState. */
    val activeHubId: StateFlow<String?> = activeHubState.activeHubId

    init {
        loadHubs()
    }

    /**
     * Load all hubs from GET /api/hubs.
     */
    fun loadHubs() {
        viewModelScope.launch {
            _uiState.update {
                it.copy(
                    isLoading = it.hubs.isEmpty(),
                    isRefreshing = it.hubs.isNotEmpty(),
                    error = null,
                )
            }
            try {
                val response = apiService.getHubs()
                _uiState.update {
                    it.copy(
                        hubs = response.hubs,
                        isLoading = false,
                        isRefreshing = false,
                    )
                }
                // Pre-fetch hub keys for all hubs in the background so relay events
                // from any hub can be decrypted immediately without waiting for hub switch.
                viewModelScope.launch {
                    hubRepository.loadAllHubKeys(response.hubs)
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isLoading = false,
                        isRefreshing = false,
                        error = e.message ?: "Failed to load hubs",
                    )
                }
            }
        }
    }

    /**
     * Create a new hub via POST /api/hubs.
     */
    fun createHub(name: String, description: String?, phoneNumber: String?) {
        viewModelScope.launch {
            _uiState.update { it.copy(isCreating = true, createError = null, createSuccess = false) }
            try {
                val request = CreateHubRequest(
                    name = name,
                    description = description?.takeIf { it.isNotBlank() },
                    phoneNumber = phoneNumber?.takeIf { it.isNotBlank() },
                )
                apiService.request<CreateHubResponse>("POST", "/api/hubs", request)
                _uiState.update { it.copy(isCreating = false, createSuccess = true) }
                loadHubs()
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isCreating = false,
                        createError = e.message ?: "Failed to create hub",
                    )
                }
            }
        }
    }

    /**
     * Switch the active hub.
     *
     * Delegates to HubRepository which fetches the E2EE key envelope,
     * unwraps it, and persists the active hub ID via ActiveHubState.
     * On failure, sets the error field in uiState.
     */
    fun switchHub(hub: Hub) {
        viewModelScope.launch {
            _uiState.update { it.copy(isSwitching = true) }
            try {
                hubRepository.switchHub(hub.id)
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                _uiState.update { it.copy(error = e.message) }
            } finally {
                _uiState.update { it.copy(isSwitching = false) }
            }
        }
    }

    fun refresh() {
        loadHubs()
    }

    fun dismissError() {
        _uiState.update { it.copy(error = null) }
    }

    fun dismissCreateError() {
        _uiState.update { it.copy(createError = null) }
    }

    fun clearCreateSuccess() {
        _uiState.update { it.copy(createSuccess = false) }
    }
}
