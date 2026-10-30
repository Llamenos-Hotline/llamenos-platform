package org.llamenos.hotline.service

import android.os.Build
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.llamenos.hotline.api.ApiService
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.di.ApplicationScope
import org.llamenos.hotline.model.RegisterDeviceRequest
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Registers this device's identity keys with the server.
 *
 * The server seals records (inbound messages, call metadata) to the
 * `devices.x25519_pubkey` it holds for a user, so a device that never reached
 * `POST /api/devices/register` is invisible to it: nothing is sealed to the
 * phone however the rest of the pipeline behaves. Identity registration is
 * therefore part of enrolment and unlock, and independent of push — a phone
 * with no UnifiedPush distributor installed (the default) still has keys to
 * register. [PushRegistrationManager] attaches the push endpoint to the same
 * server-side device later, when a distributor assigns one.
 *
 * Multi-hub axiom: registration is per-device, not per-hub; nothing here
 * reads or depends on the active hub.
 */
@Singleton
class DeviceRegistrationManager @Inject constructor(
    private val apiService: ApiService,
    private val cryptoService: CryptoService,
    @ApplicationScope private val scope: CoroutineScope,
) {

    private val mutex = Mutex()

    /** The keys last accepted by the server in this process; the server may have been reset since, so never persisted. */
    private var registeredKeys: Pair<String, String>? = null

    /**
     * Fire-and-forget form for the login/unlock paths. A failure leaves the
     * device unregistered and is retried by the next call (every unlock).
     */
    fun ensureRegistered() {
        scope.launch { register() }
    }

    /**
     * Register the device keys unless this process already did for these
     * exact keys. Fails when the keys are locked or the server refuses or
     * cannot be reached — the caller decides how loudly to surface that.
     */
    suspend fun register(): Result<Unit> = mutex.withLock {
        val ed25519 = cryptoService.signingPubkeyHex
        val x25519 = cryptoService.encryptionPubkeyHex
        if (ed25519 == null || x25519 == null) {
            return@withLock Result.failure(IllegalStateException("Device keys are locked"))
        }
        if (registeredKeys == (ed25519 to x25519)) return@withLock Result.success(Unit)
        try {
            apiService.registerDevice(
                RegisterDeviceRequest(
                    ed25519Pubkey = ed25519,
                    x25519Pubkey = x25519,
                    deviceModel = Build.MODEL,
                    osVersion = Build.VERSION.RELEASE,
                ),
            )
            registeredKeys = ed25519 to x25519
            Result.success(Unit)
        } catch (e: Exception) {
            Log.w(TAG, "Device identity registration failed: ${e.message}")
            Result.failure(e)
        }
    }

    private companion object {
        const val TAG = "DeviceRegistration"
    }
}
