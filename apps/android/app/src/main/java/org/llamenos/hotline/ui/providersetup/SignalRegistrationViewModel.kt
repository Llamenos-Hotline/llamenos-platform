package org.llamenos.hotline.ui.providersetup

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.llamenos.hotline.api.ProviderSetupRepository
import org.llamenos.hotline.api.SignalRegisterRequest
import org.llamenos.protocol.SignalRegistrationState
import org.llamenos.protocol.SignalRegistrationStatus
import javax.inject.Inject

@HiltViewModel
class SignalRegistrationViewModel @Inject constructor(
    private val repository: ProviderSetupRepository,
) : ViewModel() {

    private val _state = MutableStateFlow<SignalRegistrationState?>(null)
    val state: StateFlow<SignalRegistrationState?> = _state.asStateFlow()

    private val _verificationCode = MutableStateFlow("")
    val verificationCode: StateFlow<String> = _verificationCode.asStateFlow()

    private val _isLoading = MutableStateFlow(false)
    val isLoading: StateFlow<Boolean> = _isLoading.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    private val _isVerifying = MutableStateFlow(false)
    val isVerifying: StateFlow<Boolean> = _isVerifying.asStateFlow()

    private val _isUnregistering = MutableStateFlow(false)
    val isUnregistering: StateFlow<Boolean> = _isUnregistering.asStateFlow()

    // Only `pending` is polled: the bridge confirms an SMS registration on its own while
    // it is pending, whereas `verifying` is waiting on a code from the admin and nothing
    // on the server changes until one is submitted.
    private var pollJob: Job? = null

    fun startRegistration(
        bridgeUrl: String,
        phoneNumber: String,
        method: String = "sms",
    ) {
        viewModelScope.launch {
            _isLoading.value = true
            _error.value = null
            val request = SignalRegisterRequest(
                bridgeUrl = bridgeUrl,
                phoneNumber = phoneNumber,
                method = method,
            )
            val result = repository.startSignalRegistration(request)
            result.fold(
                onSuccess = { registration ->
                    _state.value = registration
                    _isLoading.value = false
                    if (registration.status == SignalRegistrationStatus.Pending) {
                        startPolling()
                    }
                },
                onFailure = { error ->
                    _error.value = error.message ?: "Failed to start Signal registration"
                    _isLoading.value = false
                },
            )
        }
    }

    fun loadStatus() {
        viewModelScope.launch {
            _isLoading.value = true
            _error.value = null
            val result = repository.getSignalStatus()
            result.fold(
                onSuccess = { registration ->
                    _state.value = registration
                    _isLoading.value = false
                    if (registration.status == SignalRegistrationStatus.Pending) {
                        startPolling()
                    }
                },
                onFailure = { error ->
                    _error.value = error.message ?: "Failed to load Signal status"
                    _isLoading.value = false
                },
            )
        }
    }

    fun verifyCode() {
        val registration = _state.value ?: return
        val code = _verificationCode.value
        if (code.isBlank()) return

        viewModelScope.launch {
            _isVerifying.value = true
            _error.value = null
            val result = repository.verifySignalCode(registration.id, code)
            result.fold(
                onSuccess = { updated ->
                    _state.value = updated
                    _isVerifying.value = false
                    _verificationCode.value = ""
                    if (updated.status == SignalRegistrationStatus.Pending) {
                        startPolling()
                    }
                },
                onFailure = { error ->
                    _error.value = error.message ?: "Verification failed"
                    _isVerifying.value = false
                },
            )
        }
    }

    fun unregister() {
        val registration = _state.value ?: return
        viewModelScope.launch {
            _isUnregistering.value = true
            _error.value = null
            stopPolling()
            val result = repository.unregisterSignal(registration.id)
            result.fold(
                onSuccess = {
                    _state.value = null
                    _isUnregistering.value = false
                },
                onFailure = { error ->
                    _error.value = error.message ?: "Failed to unregister"
                    _isUnregistering.value = false
                },
            )
        }
    }

    fun updateVerificationCode(code: String) {
        _verificationCode.value = code
    }

    fun startPolling() {
        stopPolling()
        pollJob = viewModelScope.launch {
            var delayMs = POLL_INITIAL_DELAY_MS
            while (isActive) {
                delay(delayMs)
                delayMs = (delayMs * 2).coerceAtMost(POLL_MAX_DELAY_MS)
                val current = _state.value ?: break
                if (current.status != SignalRegistrationStatus.Pending) {
                    break
                }
                val result = repository.getSignalStatus()
                result.fold(
                    onSuccess = { updated ->
                        _state.value = updated
                        if (updated.status != SignalRegistrationStatus.Pending) {
                            stopPolling()
                        }
                    },
                    onFailure = {
                        stopPolling()
                    },
                )
            }
        }
    }

    companion object {
        private const val POLL_INITIAL_DELAY_MS = 3_000L
        private const val POLL_MAX_DELAY_MS = 30_000L
    }

    fun stopPolling() {
        pollJob?.cancel()
        pollJob = null
    }

    fun clearError() {
        _error.value = null
    }

    override fun onCleared() {
        super.onCleared()
        stopPolling()
    }
}
