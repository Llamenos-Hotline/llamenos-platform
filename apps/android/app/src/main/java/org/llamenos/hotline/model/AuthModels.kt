package org.llamenos.hotline.model

import kotlinx.serialization.Serializable

/**
 * Re-export generated MeResponse from protocol package for backward compatibility.
 * The generated type includes all fields from the API schema.
 */
typealias MeResponse = org.llamenos.protocol.MeResponse

/**
 * Subset of `GET /api/auth/me` carrying the relay-event keys (#2999): one per
 * (hub, epoch), for the current and previous epoch of every active hub the user
 * belongs to. The element type is the generated protocol type.
 */
@Serializable
data class AuthMeEventKeysResponse(
    val adminDecryptionPubkey: String? = null,
    val serverEventKeys: List<org.llamenos.protocol.RelayEventKey> = emptyList(),
) {
    /** The keys as the crate's UniFFI record, for `CryptoService.setServerEventKeys`. */
    fun toFfiKeys(): List<org.llamenos.core.ServerEventKey> = serverEventKeys.map {
        org.llamenos.core.ServerEventKey(hubId = it.hubID, epoch = it.epoch.toULong(), keyHex = it.keyHex)
    }
}
