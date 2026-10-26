package org.llamenos.hotline.telephony

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import javax.inject.Inject
import javax.inject.Singleton

/**
 * A call a note can be filed against: its id and the hub it belongs to.
 *
 * A note is posted to the hub the call lives in — the server refuses a call id that is
 * not that hub's (#2125) — and that hub need not be the one being browsed, so the hub
 * travels with the id. Never the caller's number.
 */
data class CallRef(val id: String, val hubId: String)

/**
 * The volunteer's own call that just ended, held so the dashboard can offer "Add Note"
 * and the note editor can open on it.
 *
 * In memory only — never written to disk, DataStore or the keystore. It lives until the
 * prompt is dismissed, a note is saved against the call, or the app locks, logs out or
 * panic-wipes: every one of those drops the unlocked screens (`popUpTo(0)`), which
 * clears the dashboard's view model, which calls [clear] from `onCleared()`.
 *
 * Singleton because the dashboard (which sets it) and the note editor (which releases
 * it on save) are different navigation destinations with their own view models.
 */
@Singleton
class EndedCallHold @Inject constructor() {
    private val _held = MutableStateFlow<CallRef?>(null)
    val held: StateFlow<CallRef?> = _held.asStateFlow()

    fun hold(call: CallRef) {
        _held.value = call
    }

    /** A note was filed against [callId]: it is no longer waiting to be written up. */
    fun release(callId: String) {
        _held.value = _held.value?.takeUnless { it.id == callId }
    }

    fun clear() {
        _held.value = null
    }
}
