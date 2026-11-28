package org.llamenos.hotline.ui.contacts

import org.llamenos.hotline.model.ContactDetail
import org.llamenos.hotline.model.ContactTimelineEvent
import org.llamenos.protocol.ContactTimelineDetailResponse

/**
 * `GET /contacts/:hash` is the contact's timeline: the contact's notes and conversations
 * (PROTOCOL §4.29, `contactTimelineDetailResponseSchema`): note and conversation rows, the
 * same shapes as `GET /notes` and `GET /conversations` list. There is no
 * `/contacts/:hash/timeline` and no `{ contact }` wrapper — the screens used to call the
 * former and decode the latter, so neither ever showed anything (#1730, #2002).
 *
 * Notes and conversation content is end-to-end encrypted, so an event carries what the
 * row itself says in the clear — its id, when it happened, and a conversation's channel
 * and status — and no body.
 */
internal fun ContactTimelineDetailResponse.toTimelineEvents(): List<ContactTimelineEvent> {
    val notes = notes.map { note ->
        ContactTimelineEvent(id = note.id, type = "note", timestamp = note.createdAt)
    }
    val conversations = conversations.map { conversation ->
        ContactTimelineEvent(
            id = conversation.id,
            type = "conversation",
            timestamp = conversation.createdAt,
            summary = conversation.channelType,
            status = conversation.status?.value,
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
