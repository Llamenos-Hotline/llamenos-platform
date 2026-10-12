package org.llamenos.hotline.model

import kotlinx.serialization.Serializable

/**
 * Request body for `POST /api/invites/redeem`.
 *
 * Mirrors `redeemInviteBodySchema` in packages/protocol/schemas/invites.ts.
 * The server verifies [token] as an Ed25519 signature over the nonce-less
 * device-auth message (`llamenos:device-auth-no-nonce:v1`) for
 * `POST:/api/invites/redeem` — there is deliberately no nonce field, which is
 * what makes this token useless against every other endpoint.
 */
@Serializable
data class RedeemInviteRequest(
    val code: String,
    val pubkey: String,
    val timestamp: Long,
    val token: String,
)

/**
 * Parses an invite code out of free-form user input.
 *
 * Accepts a bare UUID (`3f6f...-...`) or any text containing one, so a
 * volunteer can paste the full invite link the admin copied from the desktop
 * app (`https://<hub>/onboarding?code=<uuid>`) instead of transcribing the
 * code by hand.
 */
object InviteCodeParser {

    private val INVITE_CODE_REGEX =
        Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")

    /** Returns the normalized (lowercase) invite code, or null if none was found. */
    fun extract(input: String): String? =
        INVITE_CODE_REGEX.find(input.trim())?.value?.lowercase()
}
