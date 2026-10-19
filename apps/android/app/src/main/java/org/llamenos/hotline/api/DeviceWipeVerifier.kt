package org.llamenos.hotline.api

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

/**
 * A remote wipe command that has passed [DeviceWipeVerifier] — the only shape in
 * which a wipe ever reaches the code that destroys this device's keys.
 *
 * @property reason the server's wipe reason (`user-erasure`, `device-revocation`,
 *   `admin-erasure`). Display-only: the server's signature does not cover it.
 */
data class DeviceWipeCommand(val reason: String)

/**
 * Decides whether a relay `device:wipe` frame is a genuine wipe aimed at this device.
 *
 * The server sends the wipe as a top-level relay frame, not an encrypted hub event
 * (`apps/worker/lib/ws-manager.ts` `sendSignedWipeToUser`):
 *
 *   `{type:"device:wipe", targetUserId?, targetDevicePubkey?, reason, timestamp, sig, ts}`
 *
 * where `sig` is the server's Ed25519 signature over the UTF-8 string
 * `"{WS_PROTOCOL_VERSION}:device:wipe:{target}:{ts}"` and `target` is the key the
 * server routed the frame by — the signing pubkey this device authenticated the
 * relay socket with. Verifying against *our own* authenticated pubkey therefore
 * binds the command to this device: a wipe signed for anyone else fails.
 *
 * Every check fails closed. A destructive command that cannot be verified — no
 * advertised server key, no authenticated identity, a bad or missing signature, a
 * stale timestamp, a target that names another device — is dropped.
 */
object DeviceWipeVerifier {

    /** `WS_PROTOCOL_VERSION` in `packages/protocol/schemas/ws-messages.ts`. */
    internal const val WS_PROTOCOL_VERSION = 1

    /** A wipe older than this is refused, bounding replay of a captured frame. */
    internal const val MAX_AGE_MS = 5 * 60 * 1000L

    /** Tolerated clock skew for a timestamp in the future (matches `packages/crypto/src/erasure.rs`). */
    internal const val CLOCK_SKEW_MS = 30_000L

    /**
     * @param frame the parsed top-level relay frame (its `type` is `device:wipe`)
     * @param devicePubkey the signing pubkey this device authenticated the socket with
     * @param serverPubkey the server's Ed25519 key, from `GET /api/config`
     * @param verifySignature Ed25519 verify over (messageHex, signatureHex, pubkeyHex)
     * @return the verified command, or null when any check fails
     */
    fun verify(
        frame: JsonObject,
        devicePubkey: String?,
        serverPubkey: String?,
        nowMs: Long,
        verifySignature: (messageHex: String, signatureHex: String, pubkeyHex: String) -> Boolean,
    ): DeviceWipeCommand? {
        if (devicePubkey.isNullOrEmpty() || serverPubkey.isNullOrEmpty()) return null

        val sig = frame.string("sig") ?: return null
        val ts = frame["ts"]?.let { runCatching { it.jsonPrimitive.longOrNull }.getOrNull() } ?: return null

        // A target the frame names explicitly must be this device. Neither field is
        // covered by the signature, but a mismatch means the command is not for us.
        frame.string("targetDevicePubkey")?.let { if (it != devicePubkey) return null }
        frame.string("targetUserId")?.let { if (it != devicePubkey) return null }

        if (ts > nowMs + CLOCK_SKEW_MS) return null
        if (nowMs - ts > MAX_AGE_MS) return null

        val message = "$WS_PROTOCOL_VERSION:device:wipe:$devicePubkey:$ts"
        val messageHex = message.toByteArray(Charsets.UTF_8).joinToString("") { "%02x".format(it) }
        if (!verifySignature(messageHex, sig, serverPubkey)) return null

        return DeviceWipeCommand(reason = frame.string("reason") ?: "")
    }

    private fun JsonObject.string(key: String): String? =
        this[key]?.let { runCatching { it.jsonPrimitive.content }.getOrNull() }?.takeIf { it.isNotEmpty() }
}
