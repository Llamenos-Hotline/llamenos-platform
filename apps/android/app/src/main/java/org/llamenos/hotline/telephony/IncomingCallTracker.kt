package org.llamenos.hotline.telephony

import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * What the UI needs to render the ringing surface for one inbound in-app call.
 *
 * @param hubId Hub the INVITE arrived on, resolved from the registered account (or the
 *   push-wake mapping). Null when no hub could be resolved — the call can still be
 *   answered, but no post-answer hub switch will fire.
 */
data class RingingCallInfo(
    val callId: String,
    val remoteAddress: String,
    val remoteDisplayName: String?,
    val hubId: String?,
)

/**
 * State holder for the currently-ringing inbound in-app call.
 *
 * Pure JVM on purpose: [LinphoneService] maps liblinphone callbacks onto [onIncomingReceived]
 * and [onCallTerminated], and maps the accept/decline actions onto [clear], so the transition
 * logic is unit-testable without a Core. At most one call rings at a time on this surface —
 * a second INVITE replaces the first in the UI (liblinphone keeps ringing both; the user can
 * still answer the other from the notification stack).
 */
@Singleton
class IncomingCallTracker @Inject constructor() {
    private val _ringingCall = MutableStateFlow<RingingCallInfo?>(null)

    /** The inbound call currently ringing on this device, or null when nothing is ringing. */
    val ringingCall: StateFlow<RingingCallInfo?> = _ringingCall.asStateFlow()

    fun onIncomingReceived(info: RingingCallInfo) {
        _ringingCall.value = info
    }

    fun onCallTerminated(callId: String) {
        if (_ringingCall.value?.callId == callId) _ringingCall.value = null
    }

    /** Clears the ringing surface after the user accepted or declined. */
    fun clear() {
        _ringingCall.value = null
    }
}
