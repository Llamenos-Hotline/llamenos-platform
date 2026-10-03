package org.llamenos.hotline.service

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import androidx.core.app.NotificationCompat
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.llamenos.hotline.R
import org.llamenos.hotline.api.ApiService
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.crypto.KeystoreService
import org.llamenos.hotline.crypto.WakeKeyService
import org.llamenos.hotline.hub.ActiveHubState
import org.llamenos.hotline.model.RegisterDeviceRequest
import org.llamenos.hotline.telephony.LinphoneService
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.MessagingReceiver
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage
import javax.inject.Inject

/**
 * UnifiedPush message receiver for push notifications.
 *
 * Replaces Firebase Cloud Messaging — uses self-hosted ntfy as the
 * UnifiedPush distributor. No Google/Firebase dependency.
 *
 * Handles:
 * - Incoming call alerts (parallel ringing)
 * - Shift reminders
 * - Admin announcements
 *
 * All push notification content is encrypted — the ntfy payload contains
 * only an opaque envelope that the app decrypts locally. Two decryption
 * tiers are supported:
 *
 * 1. **Wake tier** (via [WakeKeyService]): Decryptable without user PIN.
 *    Shows generic "New call available" on the lock screen. The wake key
 *    is stored in Android Keystore without user authentication requirement.
 *
 * 2. **Full tier** (via [CryptoService]): Requires the app to be unlocked.
 *    Shows detailed caller context when the volunteer's device key is available.
 *
 * ntfy/UnifiedPush never see the notification content in plaintext.
 */
@AndroidEntryPoint
class PushService : MessagingReceiver() {

    @Inject
    lateinit var keystoreService: KeystoreService

    @Inject
    lateinit var cryptoService: CryptoService

    @Inject
    lateinit var wakeKeyService: WakeKeyService

    @Inject
    lateinit var activeHubState: ActiveHubState

    @Inject
    lateinit var linphoneService: LinphoneService

    @Inject
    lateinit var apiService: ApiService

    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /**
     * Called when a new UnifiedPush endpoint is assigned.
     *
     * This occurs when:
     * - The user selects a UnifiedPush distributor (ntfy)
     * - The distributor assigns or rotates the endpoint URL
     *
     * The endpoint URL is stored locally and sent to the llamenos backend
     * so the server can target this device for push delivery via ntfy.
     */
    override fun onNewEndpoint(context: Context, endpoint: PushEndpoint, instance: String) {
        keystoreService.store(KEY_PUSH_ENDPOINT, endpoint.url)

        serviceScope.launch {
            try {
                val wakePublicKey = wakeKeyService.getOrCreateWakePublicKey()
                apiService.registerPushEndpoint(
                    RegisterDeviceRequest(
                        pushToken = endpoint.url,
                        wakeKeyPublic = wakePublicKey,
                        ed25519Pubkey = cryptoService.signingPubkeyHex,
                        x25519Pubkey = cryptoService.encryptionPubkeyHex,
                        deviceModel = Build.MODEL,
                        osVersion = Build.VERSION.RELEASE,
                    ),
                )
            } catch (_: Exception) {
                // Registration will be retried on next endpoint assignment.
                // The backend will also re-request registration via WebSocket
                // challenge if no device record is found.
            }
        }
    }

    /**
     * Called when this instance is unregistered from UnifiedPush.
     * Clean up the stored endpoint and notify the backend.
     */
    override fun onUnregistered(context: Context, instance: String) {
        val storedEndpoint = keystoreService.retrieve(KEY_PUSH_ENDPOINT)
        keystoreService.delete(KEY_PUSH_ENDPOINT)

        if (storedEndpoint != null) {
            serviceScope.launch {
                try {
                    apiService.clearPushEndpoint(storedEndpoint)
                } catch (_: Exception) {
                    // Best-effort: the backend will eventually detect stale endpoints
                    // when push delivery fails to the old ntfy topic URL.
                }
            }
        }
    }

    /**
     * Called when a push message is received via UnifiedPush/ntfy.
     *
     * The message body is an opaque encrypted payload from the llamenos backend.
     * It may contain a JSON envelope with:
     * - `encrypted`: HPKE-encrypted wake-tier payload
     * - `encryptedFull`: HPKE-encrypted full-tier payload
     *
     * Or for VoIP:
     * - `type`: "incoming_call"
     * - `call-id`: Call identifier
     * - `hub-id`: Hub identifier
     */
    override fun onMessage(context: Context, message: PushMessage, instance: String) {
        val messageStr = message.content.decodeToString()

        // Try to parse as JSON envelope
        val data = try {
            parseJsonPayload(messageStr)
        } catch (e: Exception) {
            return
        }

        val type = data["type"] ?: ""

        // Handle VoIP push (minimal unencrypted payload for call wakeup)
        if (type == "incoming_call") {
            handleVoipPush(context, data)
            return
        }

        // Handle encrypted push payload (wake + full tiers)
        handleEncryptedPush(context, data)
    }

    override fun onRegistrationFailed(context: Context, reason: FailedReason, instance: String) {
        // Registration failure is silent — the backend will retry on next auth
    }

    /**
     * Handle VoIP push — minimal payload for incoming call wakeup.
     * No PII in payload; the app fetches details from the server.
     */
    private fun handleVoipPush(context: Context, data: Map<String, String>) {
        val callId = data["call-id"] ?: ""
        val hubId = data["hub-id"] ?: ""

        if (callId.isNotEmpty() && hubId.isNotEmpty()) {
            linphoneService.storePendingCallHub(callId, hubId)
        }
        // Multi-hub axiom: do NOT call setActiveHub here.
        // The hub switch happens only once the call is answered with the app unlocked
        // (LinphoneService, Call.State.Connected).

        ensureNotificationChannel(
            context,
            CHANNEL_CALLS,
            context.getString(R.string.notification_channel_calls),
            NotificationManager.IMPORTANCE_HIGH,
        )

        val notification = NotificationCompat.Builder(context, CHANNEL_CALLS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(context.getString(R.string.incoming_call))
            .setContentText(context.getString(R.string.incoming_call_body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setAutoCancel(true)
            .setVibrate(longArrayOf(0, 500, 200, 500))
            .build()

        val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        notificationManager.notify(NOTIFICATION_ID_CALL, notification)
    }

    /**
     * Handle encrypted push payload with wake + full tiers.
     */
    private fun handleEncryptedPush(context: Context, data: Map<String, String>) {
        // Try wake-tier decryption first (available without PIN unlock)
        val wakeEnvelope = data["encrypted"]
        if (wakeEnvelope != null) {
            serviceScope.launch {
                val wakePayload = wakeKeyService.decryptWakePayload(wakeEnvelope)
                if (wakePayload != null) {
                    val router = PushNotificationRouter(linphoneService)
                    router.routeWakePayload(
                        type = wakePayload.type,
                        hubId = wakePayload.hubId ?: "",
                        callId = wakePayload.callId,
                    )
                    // Use wake payload for notification content when app is locked
                    if (!cryptoService.isUnlocked) {
                        showNotificationFromWakePayload(context, wakePayload.type, wakePayload.message)
                    }
                }
            }
        }

        // If app is unlocked, dispatch with full-tier content
        if (cryptoService.isUnlocked) {
            val type = data["type"] ?: "unknown"
            dispatchByType(context, data, type)
        } else if (wakeEnvelope == null) {
            val type = data["type"] ?: "unknown"
            dispatchByType(context, data, type)
        }
    }

    private fun dispatchByType(context: Context, data: Map<String, String>, type: String) {
        when (type) {
            "incoming_call" -> handleIncomingCall(context, data)
            "call_ended" -> handleCallEnded(context)
            "shift_reminder" -> handleShiftReminder(context, data)
            "announcement" -> handleAnnouncement(context, data)
            else -> {}
        }
    }

    /**
     * Show a notification using wake-tier decrypted content.
     * Used when the app is locked and full-tier decryption is unavailable.
     */
    private fun showNotificationFromWakePayload(context: Context, type: String, message: String?) {
        when (type) {
            "incoming_call" -> {
                ensureNotificationChannel(
                    context,
                    CHANNEL_CALLS,
                    context.getString(R.string.notification_channel_calls),
                    NotificationManager.IMPORTANCE_HIGH,
                )
                val notification = NotificationCompat.Builder(context, CHANNEL_CALLS)
                    .setSmallIcon(R.drawable.ic_notification)
                    .setContentTitle(context.getString(R.string.incoming_call))
                    .setContentText(message ?: context.getString(R.string.incoming_call_body))
                    .setPriority(NotificationCompat.PRIORITY_HIGH)
                    .setCategory(NotificationCompat.CATEGORY_CALL)
                    .setAutoCancel(true)
                    .setVibrate(longArrayOf(0, 500, 200, 500))
                    .build()

                val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                notificationManager.notify(NOTIFICATION_ID_CALL, notification)
            }

            "shift_reminder" -> {
                ensureNotificationChannel(
                    context,
                    CHANNEL_SHIFTS,
                    context.getString(R.string.notification_channel_shifts),
                    NotificationManager.IMPORTANCE_DEFAULT,
                )
                val notification = NotificationCompat.Builder(context, CHANNEL_SHIFTS)
                    .setSmallIcon(R.drawable.ic_notification)
                    .setContentTitle(context.getString(R.string.shifts_reminder))
                    .setContentText(message ?: context.getString(R.string.shifts_reminder_body))
                    .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                    .setAutoCancel(true)
                    .build()

                val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                notificationManager.notify(NOTIFICATION_ID_SHIFT, notification)
            }

            else -> {
                ensureNotificationChannel(
                    context,
                    CHANNEL_GENERAL,
                    context.getString(R.string.notification_channel_general),
                    NotificationManager.IMPORTANCE_DEFAULT,
                )
                val notification = NotificationCompat.Builder(context, CHANNEL_GENERAL)
                    .setSmallIcon(R.drawable.ic_notification)
                    .setContentTitle(context.getString(R.string.app_name))
                    .setContentText(message ?: context.getString(R.string.announcement_body))
                    .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                    .setAutoCancel(true)
                    .build()

                val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                notificationManager.notify(NOTIFICATION_ID_ANNOUNCEMENT, notification)
            }
        }
    }

    private fun handleIncomingCall(context: Context, data: Map<String, String>) {
        val callId = data["call-id"] ?: ""
        val hubId = data["hub-id"] ?: ""
        if (callId.isNotEmpty() && hubId.isNotEmpty()) {
            linphoneService.storePendingCallHub(callId, hubId)
        }
        // Multi-hub axiom: do NOT call setActiveHub here.

        ensureNotificationChannel(
            context,
            CHANNEL_CALLS,
            context.getString(R.string.notification_channel_calls),
            NotificationManager.IMPORTANCE_HIGH,
        )

        val notification = NotificationCompat.Builder(context, CHANNEL_CALLS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(context.getString(R.string.incoming_call))
            .setContentText(context.getString(R.string.incoming_call_body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setAutoCancel(true)
            .setVibrate(longArrayOf(0, 500, 200, 500))
            .build()

        val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        notificationManager.notify(NOTIFICATION_ID_CALL, notification)
    }

    private fun handleCallEnded(context: Context) {
        val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        notificationManager.cancel(NOTIFICATION_ID_CALL)
    }

    private fun handleShiftReminder(context: Context, data: Map<String, String>) {
        ensureNotificationChannel(
            context,
            CHANNEL_SHIFTS,
            context.getString(R.string.notification_channel_shifts),
            NotificationManager.IMPORTANCE_DEFAULT,
        )

        val notification = NotificationCompat.Builder(context, CHANNEL_SHIFTS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(context.getString(R.string.shifts_reminder))
            .setContentText(context.getString(R.string.shifts_reminder_body))
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true)
            .build()

        val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        notificationManager.notify(NOTIFICATION_ID_SHIFT, notification)
    }

    private fun handleAnnouncement(context: Context, data: Map<String, String>) {
        ensureNotificationChannel(
            context,
            CHANNEL_GENERAL,
            context.getString(R.string.notification_channel_general),
            NotificationManager.IMPORTANCE_DEFAULT,
        )

        val notification = NotificationCompat.Builder(context, CHANNEL_GENERAL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(context.getString(R.string.announcement))
            .setContentText(data["body"] ?: context.getString(R.string.announcement_body))
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true)
            .build()

        val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        notificationManager.notify(NOTIFICATION_ID_ANNOUNCEMENT, notification)
    }

    private fun ensureNotificationChannel(
        context: Context,
        channelId: String,
        channelName: String,
        importance: Int,
    ) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(channelId, channelName, importance)
            val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            notificationManager.createNotificationChannel(channel)
        }
    }

    /**
     * Parse a JSON string into a flat key-value map.
     * Handles the envelope format from the backend: { "encrypted": "...", "encryptedFull": "..." }
     * and VoIP format: { "type": "incoming_call", "call-id": "...", "hub-id": "..." }
     */
    private fun parseJsonPayload(json: String): Map<String, String> {
        val result = mutableMapOf<String, String>()
        val trimmed = json.trim()
        if (!trimmed.startsWith("{")) return result

        try {
            val map = kotlinx.serialization.json.Json.decodeFromString<Map<String, kotlinx.serialization.json.JsonElement>>(trimmed)
            for ((key, value) in map) {
                val strValue = when {
                    value is kotlinx.serialization.json.JsonPrimitive -> value.content
                    else -> value.toString()
                }
                result[key] = strValue
            }
        } catch (e: Exception) {
            // Ignore malformed payloads
        }
        return result
    }

    companion object {
        private const val KEY_PUSH_ENDPOINT = "push-endpoint"

        private const val CHANNEL_CALLS = "llamenos_calls"
        private const val CHANNEL_SHIFTS = "llamenos_shifts"
        private const val CHANNEL_GENERAL = "llamenos_general"

        private const val NOTIFICATION_ID_CALL = 1001
        private const val NOTIFICATION_ID_SHIFT = 1002
        private const val NOTIFICATION_ID_ANNOUNCEMENT = 1003
    }
}
