package org.llamenos.hotline.model

import kotlinx.serialization.Serializable

/**
 * Re-export generated MeResponse from protocol package for backward compatibility.
 * The generated type includes all fields from the API schema.
 */
typealias MeResponse = org.llamenos.protocol.MeResponse

/**
 * Subset of `GET /api/auth/me` carrying the relay event decryption keys.
 *
 * The server returns `serverEventKeyHex` / `serverEventKeyPrevHex`
 * (`apps/worker/routes/auth.ts`), but the protocol schema
 * (`packages/protocol/schemas/auth.ts`) does not declare them yet — the
 * generated [MeResponse] therefore drops them. Decoded with this local model
 * until the schema catches up; iOS does the same (`AuthMeResponse`).
 */
@Serializable
data class AuthMeEventKeysResponse(
    val adminDecryptionPubkey: String? = null,
    val serverEventKeyHex: String? = null,
    val serverEventKeyPrevHex: String? = null,
)
