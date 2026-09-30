package org.llamenos.hotline.ui.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import org.llamenos.hotline.RelayUrlValidator
import org.llamenos.hotline.api.WebSocketService
import org.llamenos.hotline.crypto.CryptoService
import javax.inject.Inject

/**
 * State machine steps for the device linking flow.
 */
enum class DeviceLinkStep {
    /** Camera is active, waiting for QR code scan. */
    SCANNING,
    /** QR scanned, connecting to ephemeral provisioning room. */
    CONNECTING,
    /** SAS verification code displayed for user confirmation. */
    VERIFYING,
    /** Receiving and decrypting provisioning data from the desktop. */
    IMPORTING,
    /** Device link completed successfully. */
    COMPLETE,
    /** An error occurred during the process. */
    ERROR,
}

data class DeviceLinkUiState(
    val step: DeviceLinkStep = DeviceLinkStep.SCANNING,
    val sasCode: String = "",
    val error: String? = null,
    val provisioningRoomId: String? = null,
    val relayUrl: String? = null,
)

/**
 * ViewModel for the device linking flow.
 *
 * Manages the state machine for linking this device to an existing identity
 * on a desktop app via QR code scanning and ephemeral ECDH key exchange.
 *
 * Flow:
 * 1. Scan QR code containing provisioning room ID + relay URL
 * 2. Generate ephemeral keypair and join the provisioning room
 * 3. Derive shared secret via ECDH with the desktop's ephemeral key
 * 4. Display SAS verification code for user to compare
 * 5. Receive encrypted provisioning data, decrypt with shared secret
 * 6. Create device keys linked to the same user identity
 */
@HiltViewModel
class DeviceLinkViewModel @Inject constructor(
    private val cryptoService: CryptoService,
    private val webSocketService: WebSocketService,
) : ViewModel() {

    private val _uiState = MutableStateFlow(DeviceLinkUiState())
    val uiState: StateFlow<DeviceLinkUiState> = _uiState.asStateFlow()

    private var sharedSecret: String? = null

    /**
     * Process a scanned QR code containing provisioning room data.
     *
     * Expected format: "llamenos:provision:<roomId>:<relayUrl>"
     *
     * Validates the relay URL using [RelayUrlValidator]:
     * - Must use `wss://` or `https://` scheme (rejects plaintext `ws://`)
     * - Host must not be loopback, RFC 1918 private, or link-local (SSRF prevention)
     */
    fun onQRCodeScanned(rawValue: String) {
        val parts = rawValue.split(":")
        if (parts.size < 4 || parts[0] != "llamenos" || parts[1] != "provision") {
            _uiState.update {
                it.copy(
                    step = DeviceLinkStep.ERROR,
                    error = "Invalid QR code format",
                )
            }
            return
        }

        val roomId = parts[2]
        val relayUrl = parts.drop(3).joinToString(":")

        if (!RelayUrlValidator.isValidRelayUrl(relayUrl)) {
            _uiState.update {
                it.copy(
                    step = DeviceLinkStep.ERROR,
                    error = "Invalid relay URL: must use wss:// and not be a private or reserved address",
                )
            }
            return
        }

        _uiState.update {
            it.copy(
                step = DeviceLinkStep.CONNECTING,
                provisioningRoomId = roomId,
                relayUrl = relayUrl,
                error = null,
            )
        }

        connectToProvisioningRoom(roomId, relayUrl)
    }

    /**
     * Connect to the ephemeral provisioning room and initiate ECDH.
     */
    private fun connectToProvisioningRoom(roomId: String, relayUrl: String) {
        viewModelScope.launch {
            try {
                // Generate our ephemeral key — secret is held in Rust, never in JVM
                val ephemeral = cryptoService.generateEphemeralKey()

                // In production, we would:
                // 1. Connect to the relay at relayUrl
                // 2. Subscribe to events in the provisioning room
                // 3. Send our ephemeral public key (ephemeral.publicKeyHex)
                // 4. Wait for the desktop's ephemeral public key
                // 5. Derive shared secret via ECDH (Rust holds the secret)

                // Simulate connection delay
                delay(1500)

                // Mock: derive shared secret with a placeholder "desktop" key
                val mockDesktopPublic = ByteArray(32).apply {
                    java.security.SecureRandom().nextBytes(this)
                }.joinToString("") { "%02x".format(it) }

                // ECDH is performed entirely in Rust — ephemeral secret
                // is zeroized in Rust after this call
                val derivedSecret = cryptoService.ecdhComplete(mockDesktopPublic)
                sharedSecret = derivedSecret

                // Derive SAS code
                val sasCode = cryptoService.deriveSASCode(derivedSecret)

                _uiState.update {
                    it.copy(
                        step = DeviceLinkStep.VERIFYING,
                        sasCode = sasCode,
                    )
                }
            } catch (e: Exception) {
                // Clean up ephemeral key on error
                cryptoService.clearEphemeralKey()
                _uiState.update {
                    it.copy(
                        step = DeviceLinkStep.ERROR,
                        error = e.message ?: "Failed to connect to provisioning room",
                    )
                }
            }
        }
    }

    /**
     * User has confirmed the SAS code matches. Proceed to import.
     */
    fun confirmSASCode() {
        val secret = sharedSecret ?: run {
            _uiState.update {
                it.copy(
                    step = DeviceLinkStep.ERROR,
                    error = "No shared secret available",
                )
            }
            return
        }

        _uiState.update { it.copy(step = DeviceLinkStep.IMPORTING) }

        viewModelScope.launch {
            try {
                // Simulated — see the KDoc above. A real implementation would:
                // 1. Send SAS confirmation to the provisioning room
                // 2. Wait for the encrypted device key bundle from the desktop
                // 3. Decrypt it via decrypt_provisioned_bundle (inside Rust)
                // 4. Adopt BOTH transported seeds; derive neither from the other
                delay(2000)

                _uiState.update {
                    it.copy(step = DeviceLinkStep.COMPLETE)
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        step = DeviceLinkStep.ERROR,
                        error = e.message ?: "Failed to import identity",
                    )
                }
            }
        }
    }

    /**
     * Cancel the device linking process.
     */
    fun cancel() {
        sharedSecret = null
        cryptoService.clearEphemeralKey()
        _uiState.update { DeviceLinkUiState() }
    }

    /**
     * Retry after an error.
     */
    fun retry() {
        sharedSecret = null
        cryptoService.clearEphemeralKey()
        _uiState.update { DeviceLinkUiState() }
    }
}
