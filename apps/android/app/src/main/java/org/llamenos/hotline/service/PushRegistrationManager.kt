package org.llamenos.hotline.service

import android.os.Build
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.llamenos.hotline.api.ApiService
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.crypto.KeyValueStore
import org.llamenos.hotline.crypto.WakeKeyService
import org.llamenos.hotline.di.ApplicationScope
import org.llamenos.hotline.model.RegisterDeviceRequest
import org.llamenos.hotline.model.VoipTokenRequest
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Owns UnifiedPush distributor registration and mirroring the assigned
 * endpoint to the backend.
 *
 * Breakdown of the two registrations the backend needs per endpoint:
 *
 * - `POST /api/devices/register` (`pushToken` + `wakeKeyPublic`) drives the
 *   encrypted wake-tier push path (shift reminders, announcements).
 * - `POST /api/devices/voip-token` (`voipToken`) drives the incoming-call
 *   ring path — `ringing.ts` reads `getVoipTokens()`, which only returns
 *   devices with a non-null `voipToken`. On Android the "token" is the same
 *   UnifiedPush endpoint URL; the route already applies the ntfy origin
 *   allow-list to `://` URLs.
 *
 * The single source of truth for the endpoint is the value delivered by the
 * distributor via `onNewEndpoint`, mirrored to both backend columns in one
 * operation so they cannot drift. A pending marker in the keystore makes the
 * mirror eventually consistent across process death and backend outages: it
 * is written before the first attempt and cleared only on success, and every
 * [ensureRegistered] (login/unlock) retries while it is set.
 *
 * Multi-hub axiom: registration is per-device, not per-hub. One registration
 * serves every member hub; nothing here reads or depends on the active hub.
 */
@Singleton
class PushRegistrationManager @Inject constructor(
    private val gateway: UnifiedPushGateway,
    private val apiService: ApiService,
    private val keystoreService: KeyValueStore,
    private val wakeKeyService: WakeKeyService,
    private val cryptoService: CryptoService,
    @ApplicationScope private val scope: CoroutineScope,
) {

    enum class DistributorState {
        /** No registration attempt has completed in this process run. */
        UNKNOWN,

        /** A distributor is selected and `register()` was invoked. */
        REGISTERED,

        /** No UnifiedPush distributor is installed — surface the localized install-ntfy UI. */
        NO_DISTRIBUTOR,
    }

    private val _distributorState = MutableStateFlow(DistributorState.UNKNOWN)
    val distributorState: StateFlow<DistributorState> = _distributorState.asStateFlow()

    private val registrationMutex = Mutex()

    /**
     * Ensure the app is registered with the current or default UnifiedPush
     * distributor. Called after login and unlock; idempotent and hub-neutral.
     * Also retries a pending backend endpoint mirror from a previous failed
     * or interrupted `onNewEndpoint`.
     */
    fun ensureRegistered() {
        scope.launch {
            registrationMutex.withLock {
                val selected = try {
                    gateway.selectCurrentOrDefaultDistributor()
                } catch (_: Exception) {
                    false
                }
                if (!selected) {
                    _distributorState.value = DistributorState.NO_DISTRIBUTOR
                    return@withLock
                }
                try {
                    gateway.register()
                    _distributorState.value = DistributorState.REGISTERED
                } catch (_: Exception) {
                    // Distributor unreachable right now; retried on next unlock
                    // or when the distributor re-announces itself.
                }
                retryPendingBackendRegistrationLocked()
            }
        }
    }

    /**
     * Distributor assigned (or rotated) an endpoint. Store it — the local
     * source of truth — and mirror it to the backend exactly once.
     */
    fun onNewEndpoint(endpointUrl: String) {
        keystoreService.store(KEY_PUSH_ENDPOINT, endpointUrl)
        scope.launch {
            registrationMutex.withLock {
                registerEndpointWithBackendLocked(endpointUrl)
            }
        }
    }

    /**
     * Distributor dropped this registration (app data cleared, distributor
     * uninstalled). Clean up local + backend state, then try to re-register —
     * a replacement or default distributor may be available.
     */
    fun onUnregistered() {
        val storedEndpoint = keystoreService.retrieve(KEY_PUSH_ENDPOINT)
        keystoreService.delete(KEY_PUSH_ENDPOINT)
        keystoreService.delete(KEY_PUSH_BACKEND_PENDING)
        _distributorState.value = DistributorState.UNKNOWN

        scope.launch {
            registrationMutex.withLock {
                if (storedEndpoint != null) {
                    try {
                        apiService.clearPushEndpoint(storedEndpoint)
                    } catch (_: Exception) {
                        // Best-effort: the backend prunes stale endpoints when
                        // delivery to the dead ntfy topic keeps failing.
                    }
                }
            }
        }
        ensureRegistered()
    }

    /** Registration attempt rejected by the distributor — surfaced via state. */
    fun onRegistrationFailed() {
        _distributorState.value = DistributorState.UNKNOWN
    }

    private suspend fun retryPendingBackendRegistrationLocked() {
        if (keystoreService.retrieve(KEY_PUSH_BACKEND_PENDING) == null) return
        val endpoint = keystoreService.retrieve(KEY_PUSH_ENDPOINT) ?: return
        registerEndpointWithBackendLocked(endpoint)
    }

    /**
     * Mirror the endpoint to the backend: one device record carrying both the
     * wake-tier `pushToken` and the call-wake `voipToken` (same URL on
     * Android). The pending marker is set before the first attempt so a
     * process death mid-registration still heals on the next unlock.
     */
    private suspend fun registerEndpointWithBackendLocked(endpointUrl: String) {
        keystoreService.store(KEY_PUSH_BACKEND_PENDING, VALUE_PENDING)
        try {
            val wakePublicKey = wakeKeyService.getOrCreateWakePublicKey()
            apiService.registerPushEndpoint(
                RegisterDeviceRequest(
                    pushToken = endpointUrl,
                    wakeKeyPublic = wakePublicKey,
                    ed25519Pubkey = cryptoService.signingPubkeyHex,
                    x25519Pubkey = cryptoService.encryptionPubkeyHex,
                    deviceModel = Build.MODEL,
                    osVersion = Build.VERSION.RELEASE,
                ),
            )
            apiService.registerVoipToken(VoipTokenRequest(voipToken = endpointUrl))
            keystoreService.delete(KEY_PUSH_BACKEND_PENDING)
        } catch (_: Exception) {
            // Marker stays set; retried by the next ensureRegistered().
        }
    }

    companion object {
        private const val KEY_PUSH_ENDPOINT = "push-endpoint"
        private const val KEY_PUSH_BACKEND_PENDING = "push-endpoint-backend-pending"
        private const val VALUE_PENDING = "1"
    }
}
