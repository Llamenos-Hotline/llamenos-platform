package org.llamenos.hotline.model


// ── Generated re-exports ────────────────────────────────────────────────────

typealias SendMessageRequest = org.llamenos.protocol.SendMessageBody
typealias CreateMessageEnvelope = org.llamenos.protocol.SharedAdminEnvelope

// ── Wire types ──────────────────────────────────────────────────────────────
// Conversations and messages are decoded straight into the generated protocol
// types — `ConversationListResponse` / `ConversationListResponseConversation`
// and `MessageListResponse` / `Message`. They used to be hand-written here under
// UI-friendly names (`contactHash`, `assignedVolunteerPubkey`, `recipientEnvelopes`,
// `unreadCount`), none of which the server sends: the list failed to decode on
// the first row (#1344), and `unreadCount` has no source on the server at all
// (read state is server-owed — #2002).

/**
 * Decrypted message for UI display.
 * Client-only — never serialized or sent over the wire.
 */
data class DecryptedMessage(
    val id: String,
    val text: String,
    val direction: String,
    val channelType: String,
    val createdAt: String,
    val isRead: Boolean,
)
