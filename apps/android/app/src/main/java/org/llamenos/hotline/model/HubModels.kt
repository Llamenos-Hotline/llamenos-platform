package org.llamenos.hotline.model

import kotlinx.serialization.Serializable

// ── Generated response types ────────────────────────────────────────────────

/**
 * A hub representing a hotline operation.
 * Uses the generated HubResponse type. Extension properties in Extensions.kt
 * provide statusString (HubStatus enum → String).
 */
typealias Hub = org.llamenos.protocol.SharedHub

/**
 * Response from GET /api/hubs.
 */
typealias HubsListResponse = org.llamenos.protocol.HubListResponse

// ── Client-specific types ───────────────────────────────────────────────────

/**
 * Response from POST /api/hubs.
 */
@Serializable
data class CreateHubResponse(
    val hub: org.llamenos.protocol.SharedHub,
)

/**
 * Response from PATCH /api/hubs/:id.
 */
@Serializable
data class UpdateHubResponse(
    val hub: org.llamenos.protocol.SharedHub,
)

/**
 * Request body for PATCH /api/hubs/:id.
 * Uses the generated UpdateHubBody.
 */
typealias UpdateHubRequest = org.llamenos.protocol.UpdateHubBody
