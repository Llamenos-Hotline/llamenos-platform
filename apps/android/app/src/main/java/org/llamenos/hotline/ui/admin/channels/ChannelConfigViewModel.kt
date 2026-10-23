package org.llamenos.hotline.ui.admin.channels

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import org.llamenos.hotline.api.A2pRegistrationDto
import org.llamenos.hotline.api.MessagingConfigDto
import org.llamenos.hotline.api.MessagingConfigRepository
import org.llamenos.hotline.hub.ActiveHubState
import javax.inject.Inject

data class ChannelConfigUiState(
    val config: MessagingConfigDto? = null,
    val a2pRegistration: A2pRegistrationDto? = null,
    val isLoading: Boolean = false,
    val error: String? = null,
    val testResults: Map<String, Boolean> = emptyMap(),
)

enum class ChannelType(val key: String, val displayName: String, val iconName: String) {
    SMS("sms", "SMS", "sms"),
    WHATSAPP("whatsapp", "WhatsApp", "chat"),
    SIGNAL("signal", "Signal", "security"),
    TELEGRAM("telegram", "Telegram", "send"),
    RCS("rcs", "RCS", "smartphone"),
}

@HiltViewModel
class ChannelConfigViewModel @Inject constructor(
    private val repository: MessagingConfigRepository,
    private val activeHubState: ActiveHubState,
) : ViewModel() {

    private val _state = MutableStateFlow(ChannelConfigUiState())
    val state: StateFlow<ChannelConfigUiState> = _state.asStateFlow()

    fun loadConfig() {
        viewModelScope.launch {
            _state.value = _state.value.copy(isLoading = true, error = null)
            try {
                val config = repository.getConfig()
                _state.value = _state.value.copy(config = config, isLoading = false)
            } catch (e: Exception) {
                _state.value = _state.value.copy(error = e.message, isLoading = false)
            }
        }
    }

    fun updateConfig(updates: Map<String, Any?>) {
        viewModelScope.launch {
            try {
                val config = repository.updateConfig(updates)
                _state.value = _state.value.copy(config = config)
            } catch (e: Exception) {
                _state.value = _state.value.copy(error = e.message)
            }
        }
    }

    fun testChannel(channel: String) {
        viewModelScope.launch {
            try {
                val connected = repository.testChannel(channel)
                _state.value = _state.value.copy(
                    testResults = _state.value.testResults + (channel to connected),
                )
            } catch (_: Exception) {
                _state.value = _state.value.copy(
                    testResults = _state.value.testResults + (channel to false),
                )
            }
        }
    }

    /**
     * A2P registration is per hub; the SMS screen configures the hub the user is browsing.
     * With no active hub there is nothing to load, and saying so beats rendering
     * "not submitted" for a hub nobody asked about.
     */
    private fun activeHubOrError(): String? {
        val hubId = activeHubState.activeHubId.value
        if (hubId == null) _state.value = _state.value.copy(error = "No active hub")
        return hubId
    }

    fun loadA2pStatus() {
        val hubId = activeHubOrError() ?: return
        viewModelScope.launch {
            try {
                val registration = repository.getA2pStatus(hubId)
                _state.value = _state.value.copy(a2pRegistration = registration)
            } catch (e: Exception) {
                _state.value = _state.value.copy(error = e.message)
            }
        }
    }

    fun submitBrand(hubId: String, brandInfo: Map<String, Any>) {
        viewModelScope.launch {
            try {
                val result = repository.submitBrand(hubId, brandInfo)
                _state.value = _state.value.copy(a2pRegistration = result)
            } catch (e: Exception) {
                _state.value = _state.value.copy(error = e.message)
            }
        }
    }

    fun submitCampaign(registrationId: String, hubId: String, campaignInfo: Map<String, Any>) {
        viewModelScope.launch {
            try {
                val result = repository.submitCampaign(registrationId, hubId, campaignInfo)
                _state.value = _state.value.copy(a2pRegistration = result)
            } catch (e: Exception) {
                _state.value = _state.value.copy(error = e.message)
            }
        }
    }

    fun skipA2p() {
        val hubId = activeHubOrError() ?: return
        viewModelScope.launch {
            try {
                val result = repository.skipA2p(hubId)
                _state.value = _state.value.copy(a2pRegistration = result)
            } catch (e: Exception) {
                _state.value = _state.value.copy(error = e.message)
            }
        }
    }
}
