package org.llamenos.hotline.ui.providersetup

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import org.llamenos.hotline.api.ProviderSetupRepository
import org.llamenos.hotline.api.TestConnectionResult
import org.llamenos.protocol.ProviderStatusResponse
import org.llamenos.protocol.ProviderStatus
import org.llamenos.protocol.StartOAuthResponse
import javax.inject.Inject

sealed interface ProviderSetupUiState {
    data object Loading : ProviderSetupUiState
    data class Connected(val status: ProviderStatusResponse) : ProviderSetupUiState
    data class Disconnected(val status: ProviderStatusResponse? = null) : ProviderSetupUiState
    data class Error(val message: String) : ProviderSetupUiState
}

@HiltViewModel
class ProviderSetupViewModel @Inject constructor(
    private val repository: ProviderSetupRepository,
) : ViewModel() {

    private val _uiState = MutableStateFlow<ProviderSetupUiState>(ProviderSetupUiState.Loading)
    val uiState: StateFlow<ProviderSetupUiState> = _uiState.asStateFlow()

    private val _selectedProvider = MutableStateFlow<String?>(null)
    val selectedProvider: StateFlow<String?> = _selectedProvider.asStateFlow()

    /**
     * The hub whose provider is being configured. A messaging webhook URL must
     * name it (`?hub=`): the server refuses an inbound message that names no hub,
     * because the deployment-wide sender cannot say which hub it is for (#2395).
     */
    val activeHubId: String? get() = repository.activeHubIdOrNull()

    private val _isTesting = MutableStateFlow(false)
    val isTesting: StateFlow<Boolean> = _isTesting.asStateFlow()

    private val _testResult = MutableStateFlow<TestConnectionResult?>(null)
    val testResult: StateFlow<TestConnectionResult?> = _testResult.asStateFlow()

    private val _isConfiguring = MutableStateFlow(false)
    val isConfiguring: StateFlow<Boolean> = _isConfiguring.asStateFlow()

    private val _configError = MutableStateFlow<String?>(null)
    val configError: StateFlow<String?> = _configError.asStateFlow()

    private val _configSuccess = MutableStateFlow(false)
    val configSuccess: StateFlow<Boolean> = _configSuccess.asStateFlow()

    fun selectProvider(provider: String) {
        _selectedProvider.value = provider
        _uiState.value = ProviderSetupUiState.Loading
        _testResult.value = null
        _configError.value = null
        loadStatus(provider)
    }

    fun loadStatus(provider: String) {
        viewModelScope.launch {
            _uiState.value = ProviderSetupUiState.Loading
            val result = repository.getProviderStatus(provider)
            result.fold(
                onSuccess = { status ->
                    _uiState.value = when (status.status) {
                        ProviderStatus.Connected -> ProviderSetupUiState.Connected(status)
                        else -> ProviderSetupUiState.Disconnected(status)
                    }
                },
                onFailure = { error ->
                    _uiState.value = ProviderSetupUiState.Error(
                        error.message ?: "Failed to load provider status",
                    )
                },
            )
        }
    }

    fun configureWithCredentials(provider: String, credentials: Map<String, String>) {
        viewModelScope.launch {
            _isConfiguring.value = true
            _configError.value = null
            _configSuccess.value = false
            val result = repository.configureProvider(provider, credentials)
            result.fold(
                onSuccess = {
                    _isConfiguring.value = false
                    _configSuccess.value = true
                    loadStatus(provider)
                },
                onFailure = { error ->
                    _isConfiguring.value = false
                    _configError.value = error.message ?: "Failed to configure provider"
                },
            )
        }
    }

    suspend fun startOAuth(provider: String, state: String): Result<StartOAuthResponse> {
        return repository.startOAuth(provider, state = state)
    }

    fun clearConfigSuccess() {
        _configSuccess.value = false
    }

    fun testConnection(provider: String? = null) {
        val target = provider ?: _selectedProvider.value ?: return
        viewModelScope.launch {
            _isTesting.value = true
            _testResult.value = null
            val result = repository.testProvider(target)
            result.fold(
                onSuccess = { result ->
                    _isTesting.value = false
                    _testResult.value = result
                    if (result.connected) {
                        loadStatus(target)
                    }
                },
                onFailure = { error ->
                    _isTesting.value = false
                    _testResult.value = TestConnectionResult(
                        connected = false,
                        latencyMs = 0L,
                        error = error.message ?: "Connection test failed",
                    )
                },
            )
        }
    }

    fun clearTestResult() {
        _testResult.value = null
    }

    fun clearConfigError() {
        _configError.value = null
    }

    fun refresh() {
        val provider = _selectedProvider.value ?: return
        loadStatus(provider)
    }
}
