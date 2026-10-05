package org.llamenos.hotline.api

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.model.InviteCodeParser
import org.llamenos.hotline.model.RedeemInviteRequest
import org.llamenos.protocol.InviteValidationResponse
import java.io.IOException
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Enrollment via invite-code redemption (#1345).
 *
 * Wraps the public invite routes in apps/worker/routes/invites.ts:
 * - POST /api/invites/redeem — registers this device's identity against an
 *   invite code. The request body carries its own Ed25519 token signed over
 *   the nonce-less device-auth message (see [CryptoService.createAuthTokenWithoutNonce]);
 *   after a successful redemption the identity is a hub member and every
 *   subsequent request authenticates through [AuthInterceptor] as usual.
 *
 * The redeem endpoint is NOT hub-scoped: the server resolves the invite's hub
 * (`services.identity.redeemInvite`) and writes the hub membership, so the
 * client must not prefix the path with `/api/hubs/<hub>`.
 */
@Singleton
class InviteRepository @Inject constructor(
    private val apiService: ApiService,
    private val cryptoService: CryptoService,
) {

    companion object {
        const val REDEEM_PATH = "/api/invites/redeem"
    }

    /** `GET /api/invites/validate/:code` — whether the code can still be redeemed. */
    suspend fun validate(code: String): InviteValidationResponse =
        apiService.request("GET", "/api/invites/validate/$code", signed = false)

    /**
     * Redeem an invite code for the current device identity.
     *
     * [code] may be a bare UUID or a full invite URL — it is normalized via
     * [InviteCodeParser] before sending.
     *
     * @return [Result.success] once the server has registered the identity as
     *   a hub member; [Result.failure] with [ApiException] (HTTP status in
     *   [ApiException.code]) or [IOException] on failure.
     */
    suspend fun redeemInvite(code: String): Result<Unit> = withContext(Dispatchers.IO) {
        runCatching {
            val normalized = InviteCodeParser.extract(code)
                ?: throw IllegalArgumentException("No invite code found in input")

            val token = cryptoService.createAuthTokenWithoutNonce("POST", REDEEM_PATH)

            apiService.requestNoContent(
                "POST",
                REDEEM_PATH,
                RedeemInviteRequest(
                    code = normalized,
                    pubkey = token.pubkey,
                    timestamp = token.timestamp,
                    token = token.token,
                ),
            )
        }
    }
}
