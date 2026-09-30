package org.llamenos.hotline.api

import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.protocol.InviteValidationResponse
import org.llamenos.protocol.RedeemInviteBody
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Enrolment by invite: the path that registers a fresh device identity with the server.
 *
 * Both endpoints are public. Validation needs no identity at all; redemption proves
 * ownership of the new device key in its body (see
 * [CryptoService.createInviteRedemptionToken]).
 */
@Singleton
class InviteRepository @Inject constructor(
    private val apiService: ApiService,
    private val cryptoService: CryptoService,
) {

    /** `GET /api/invites/validate/:code` — whether the code can still be redeemed. */
    suspend fun validate(code: String): InviteValidationResponse =
        apiService.request("GET", "/api/invites/validate/$code", signed = false)

    /**
     * `POST /api/invites/redeem` — registers this device's signing key under the invite.
     * The device keys must be unlocked.
     */
    suspend fun redeem(code: String) {
        val proof = cryptoService.createInviteRedemptionToken(REDEEM_PATH)
        apiService.requestNoContent(
            "POST",
            REDEEM_PATH,
            RedeemInviteBody(
                code = code,
                pubkey = proof.pubkey,
                timestamp = proof.timestamp.toDouble(),
                token = proof.token,
            ),
            signed = false,
        )
    }

    companion object {
        const val REDEEM_PATH = "/api/invites/redeem"
    }
}
