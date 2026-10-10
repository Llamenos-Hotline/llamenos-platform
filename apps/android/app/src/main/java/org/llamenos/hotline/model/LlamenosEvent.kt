package org.llamenos.hotline.model

/**
 * Typed application events parsed from relay messages.
 *
 * Server events arrive as encrypted envelopes via [WebSocketService].
 * After server-event-key decryption, the plaintext JSON is parsed into one of
 * these sealed subtypes based on the "type" field.
 *
 * The [Unknown] variant captures event types this client version does
 * not yet handle, ensuring forward compatibility with server updates.
 */
sealed class LlamenosEvent {

    /** A new call is ringing -- all on-shift volunteers receive this. */
    data class CallRing(val callId: String) : LlamenosEvent()

    /** A call status update (ringing, in-progress, etc.). */
    data class CallUpdate(val callId: String, val status: String) : LlamenosEvent()

    /** A call has ended (answered by another volunteer or caller hung up). */
    data class CallEnded(val callId: String) : LlamenosEvent()

    /** A new voicemail was left by a caller. */
    data class VoicemailNew(val callId: String) : LlamenosEvent()

    /** Summary of volunteer presence/availability. */
    data class PresenceSummary(val hasAvailable: Boolean) : LlamenosEvent()

    /** Detailed presence info for admins (available/onCall/total counts). */
    data class PresenceDetail(val available: Int, val onCall: Int, val total: Int) : LlamenosEvent()

    /** A shift's status has changed (assignment, clock in/out by another volunteer). */
    data class ShiftUpdate(val shiftId: String, val status: String) : LlamenosEvent()

    /** A new note was created (by the current user or an admin). */
    data class NoteCreated(val noteId: String) : LlamenosEvent()

    /** A new message arrived in a conversation. */
    data class MessageNew(val conversationId: String) : LlamenosEvent()

    /** Message delivery status update (sent, delivered, read, failed). */
    data class MessageStatus(val conversationId: String, val messageId: String, val status: String) : LlamenosEvent()

    /** A new conversation was created. */
    data class ConversationNew(val conversationId: String) : LlamenosEvent()

    /** A conversation was assigned to a volunteer. */
    data class ConversationAssigned(
        val conversationId: String,
        val assignedTo: String?,
    ) : LlamenosEvent()

    /** A conversation was closed. */
    data class ConversationClosed(val conversationId: String) : LlamenosEvent()

    /** A call was answered by a volunteer. */
    data class CallAnswered(val callId: String, val answeredBy: String) : LlamenosEvent()

    data class DeviceWipe(
        val targetDevicePubkey: String,
        val reason: String,
        val serverSignature: String,
    ) : LlamenosEvent()

    /** An event type this client version does not recognize. */
    data class Unknown(val type: String) : LlamenosEvent()
}
