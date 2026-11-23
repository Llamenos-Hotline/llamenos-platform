package org.llamenos.hotline.api

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject

/**
 * What to tell a user when a request failed: the HTTP status and the server's reason for an
 * [ApiException] ("HTTP 403: Forbidden"), the exception's own message for anything else
 * (a connection or decode failure), and [fallback] only when there is nothing at all to say.
 *
 * Never the exception class name — "MissingFieldException" tells a volunteer nothing, and a
 * bare "Forbidden" with no status hides that the server refused them rather than failed (#2121).
 */
fun Throwable.failureMessage(fallback: String): String = when (this) {
    is ApiException -> {
        val reason = serverReason(message)
        if (reason.isEmpty()) "HTTP $code" else "HTTP $code: $reason"
    }
    else -> message?.takeIf { it.isNotBlank() } ?: fallback
}

/** The `error` / `message` string of a JSON error body, else the body itself, trimmed. */
private fun serverReason(body: String): String {
    val trimmed = body.trim()
    val parsed = runCatching { Json.parseToJsonElement(trimmed) }.getOrNull()
    if (parsed is JsonObject) {
        for (key in listOf("error", "message")) {
            val value = parsed[key]
            if (value is JsonPrimitive && value.isString && value.content.isNotBlank()) return value.content
        }
    }
    return trimmed.take(MAX_REASON_LENGTH)
}

private const val MAX_REASON_LENGTH = 200
