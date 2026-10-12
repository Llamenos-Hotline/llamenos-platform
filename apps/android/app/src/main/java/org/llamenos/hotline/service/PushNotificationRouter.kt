package org.llamenos.hotline.service

import org.llamenos.hotline.telephony.LinphoneService

/**
 * Pure routing helper for push notification wake payloads.
 *
 * Extracted from PushService to be unit-testable without Firebase.
 *
 * Multi-hub routing axiom: the active hub context must NEVER be switched
 * from a background wake-payload handler. Push notifications arrive for
 * any hub the user belongs to, regardless of which hub is active in the UI.
 *
 * The only correct places for setActiveHub are:
 * - When the user explicitly taps a notification (notification tap handler).
 * - When the app is unlocked and the user answers the call: storePendingCallHub records the
 *   call's hub here, and LinphoneService switches to it when the incoming call reaches
 *   Connected — never on the ring (IncomingReceived).
 */
class PushNotificationRouter(
    private val linphoneService: LinphoneService,
) {


    fun routeWakePayload(type: String, hubId: String, callId: String?) {
        when (type) {
            "incoming_call" -> {
                if (!callId.isNullOrEmpty() && hubId.isNotEmpty()) {
                    linphoneService.storePendingCallHub(callId, hubId)
                }
            }
            else -> {}
        }
    }
}
