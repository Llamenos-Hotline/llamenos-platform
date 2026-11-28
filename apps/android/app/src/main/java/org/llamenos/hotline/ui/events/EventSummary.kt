package org.llamenos.hotline.ui.events

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * The plaintext an event's summary is sealed from: the same `{title, description, status}`
 * object the case summary carries ([org.llamenos.hotline.ui.cases.DecryptedSummary]).
 *
 * Built with a JSON encoder, not string interpolation: a backslash, newline or
 * control character in what the volunteer typed is escaped, so the sealed
 * document always parses. It is sealed with `CasePurpose.SUMMARY` and never
 * leaves the device as plaintext.
 */
internal fun eventSummaryJson(title: String, description: String, status: String): String =
    buildJsonObject {
        put("title", title.trim())
        put("description", description.trim())
        // The status VALUE (the entity type's `statuses[].value`): it lives only here, and the
        // server never receives it (#2779).
        put("status", status)
    }.toString()
