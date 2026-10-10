package org.llamenos.hotline.hub

import org.llamenos.hotline.model.LlamenosEvent
import org.llamenos.hotline.service.AttributedHubEvent
import java.util.concurrent.ConcurrentHashMap
import javax.inject.Inject
import javax.inject.Singleton

data class HubActivityState(
    val isOnShift: Boolean = false,
    val activeCallCount: Int = 0,
    val unreadMessageCount: Int = 0,
    val unreadConversationCount: Int = 0,
)

/**
 * Tracks per-hub activity state derived from hub-attributed relay events.
 *
 * State is maintained in-memory as a [ConcurrentHashMap] keyed by hub ID.
 * Callers feed events via [handle]; UI reads current state via [state].
 * [markHubOpened] resets unread counters when the user navigates to a hub.
 */
@Singleton
class HubActivityService @Inject constructor() {

    private val states = ConcurrentHashMap<String, HubActivityState>()

    /** Returns the current [HubActivityState] for [hubId], or a default empty state. */
    fun state(hubId: String): HubActivityState = states.getOrDefault(hubId, HubActivityState())

    /**
     * Process an [AttributedHubEvent] and update the corresponding hub's state.
     *
     * Uses sealed-class pattern matching so all event types are handled exhaustively
     * at compile time. Unknown/irrelevant events leave the state unchanged.
     */
    fun handle(attributed: AttributedHubEvent<LlamenosEvent>) {
        states.compute(attributed.hubId) { _, current ->
            val s = current ?: HubActivityState()
            when (val event = attributed.event) {
                is LlamenosEvent.CallRing ->
                    s.copy(activeCallCount = s.activeCallCount + 1)
                is LlamenosEvent.CallAnswered ->
                    s.copy(activeCallCount = maxOf(0, s.activeCallCount - 1))
                is LlamenosEvent.CallEnded ->
                    s.copy(activeCallCount = maxOf(0, s.activeCallCount - 1))
                is LlamenosEvent.VoicemailNew ->
                    s.copy(activeCallCount = maxOf(0, s.activeCallCount - 1))
                is LlamenosEvent.ShiftUpdate -> when (event.status) {
                    "started" -> s.copy(isOnShift = true)
                    "ended" -> s.copy(isOnShift = false)
                    else -> s
                }
                is LlamenosEvent.MessageNew ->
                    s.copy(unreadMessageCount = s.unreadMessageCount + 1)
                is LlamenosEvent.ConversationAssigned ->
                    s.copy(unreadConversationCount = s.unreadConversationCount + 1)
                is LlamenosEvent.ConversationClosed ->
                    s.copy(unreadConversationCount = maxOf(0, s.unreadConversationCount - 1))
                is LlamenosEvent.CallUpdate,
                is LlamenosEvent.NoteCreated,
                is LlamenosEvent.ConversationNew,
                is LlamenosEvent.PresenceSummary,
                is LlamenosEvent.PresenceDetail,
                is LlamenosEvent.MessageStatus,
                is LlamenosEvent.DeviceWipe,
                is LlamenosEvent.Unknown -> s
            }
        }
    }

    /**
     * Reset unread message and conversation counts for [hubId].
     * Called when the user opens/navigates to a hub to mark its content as seen.
     */
    fun markHubOpened(hubId: String) {
        states.compute(hubId) { _, current ->
            (current ?: HubActivityState()).copy(
                unreadMessageCount = 0,
                unreadConversationCount = 0,
            )
        }
    }
}
