package org.llamenos.hotline.model

import kotlinx.serialization.Serializable

/**
 * Request body for POST /api/devices/register.
 *
 * Registers or updates a device push endpoint on the backend.
 * The [pushToken] is the full UnifiedPush endpoint URL that the
 * backend will POST encrypted payloads to.
 */
@Serializable
data class RegisterDeviceRequest(
    val platform: String = "android",
    val pushToken: String,
    val wakeKeyPublic: String,
    val ed25519Pubkey: String? = null,
    val x25519Pubkey: String? = null,
    val deviceName: String? = null,
    val deviceModel: String? = null,
    val osVersion: String? = null,
    val appVersion: String? = null,
)

/**
 * Request body for DELETE /api/devices/push-token.
 *
 * Removes the device record for the given push endpoint URL.
 * Called when the UnifiedPush distributor unregisters the device.
 */
@Serializable
data class ClearPushTokenRequest(
    val pushToken: String,
)

/**
 * Request body for POST /api/devices/voip-token.
 *
 * Registers the token the backend's incoming-call ring path reads
 * (`getVoipTokens()` only returns devices with a non-null voipToken).
 * On Android the "token" is the same UnifiedPush endpoint URL registered
 * as [RegisterDeviceRequest.pushToken]; iOS uses a PushKit device token.
 */
@Serializable
data class VoipTokenRequest(
    val platform: String = "android",
    val voipToken: String,
)
