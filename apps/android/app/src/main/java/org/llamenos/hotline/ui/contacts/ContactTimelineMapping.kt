package org.llamenos.hotline.ui.contacts

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import org.llamenos.hotline.model.ContactDetail
import org.llamenos.hotline.model.ContactTimelineEvent
import org.llamenos.protocol.ContactTimelineDetailResponse

/**
 * `GET /contacts/:hash` is the contact's timeline: the contact's notes and conversations
 * (PROTOCOL §4.29, `contactTimelineDetailResponseSchema`), as raw rows. There is no
 * `/contacts/:hash/timeline` and no `{ contact }` wrapper — the screens used to call the
 * former and decode the latter, so neither ever showed anything (#1730, #2002).
 *
 * Notes and conversation content is end-to-end encrypted, so an event carries what the
 * row itself says in the clear — its id, when it happened, and a conversation's channel
 * and status — and no body.
 */
internal fun ContactTimelineDetailResponse.toTimelineEvents(): List<ContactTimelineEvent> {
    val notes = notes.mapNotNull { row ->
        val fields = row.asRow() ?: return@mapNotNull null
        val id = fields.string("id") ?: return@mapNotNull null
        val at = fields.string("createdAt") ?: return@mapNotNull null
        ContactTimelineEvent(id = id, type = "note", timestamp = at)
    }
    val conversations = conversations.mapNotNull { row ->
        val fields = row.asRow() ?: return@mapNotNull null
        val id = fields.string("id") ?: return@mapNotNull null
        val at = fields.string("createdAt") ?: return@mapNotNull null
        ContactTimelineEvent(
            id = id,
            type = "conversation",
            timestamp = at,
            summary = fields.string("channelType"),
            status = fields.string("status"),
        )
    }
    // ISO-8601 instants from one source sort lexicographically; newest first.
    return (notes + conversations).sortedByDescending { it.timestamp }
}

/**
 * The profile header for [contactHash], derived from the same response: how many notes and
 * conversations there are and when the first and latest happened. Calls and reports are not
 * part of this route's payload, so those counts stay at zero — which is also what
 * `GET /contacts` reports for them today.
 */
internal fun ContactTimelineDetailResponse.toContactDetail(contactHash: String): ContactDetail {
    val events = toTimelineEvents()
    return ContactDetail(
        contactHash = contactHash,
        firstSeen = events.lastOrNull()?.timestamp.orEmpty(),
        lastSeen = events.firstOrNull()?.timestamp.orEmpty(),
        conversationCount = events.count { it.type == "conversation" },
        noteCount = events.count { it.type == "note" },
    )
}

private fun JsonElement.asRow(): JsonObject? = this as? JsonObject

private fun JsonObject.string(key: String): String? =
    (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
