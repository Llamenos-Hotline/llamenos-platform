package org.llamenos.hotline.api

import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.model.RecoveryLivenessRequest
import org.llamenos.protocol.MyShareEnvelopeResponse
import org.llamenos.protocol.ShareLivenessChallengeRequest
import org.llamenos.protocol.ShareLivenessChallengeResponse
import java.net.URLEncoder
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Recovery-share liveness (#2782): a holder proves to a hub that this device can
 * still produce its Shamir share, so admins see the share as healthy only when
 * it was actually demonstrated.
 *
 * The flow is challenge → sign in Rust → submit. The server verifies the proof
 * against the key the enrolling client derived from this holder's share; a
 * proof that does not verify is recorded against the holder and surfaces here
 * as an [ApiException] (403), never as success.
 */
@Singleton
class RecoveryLivenessRepository @Inject constructor(
    private val apiService: ApiService,
    private val cryptoService: CryptoService,
) {
    /**
     * This user's own share envelope for [hubId], or null when they hold no share
     * there (the server's single 403 for not-a-member / not-a-holder / no group).
     */
    suspend fun getMyShareEnvelope(hubId: String): MyShareEnvelopeResponse? = try {
        apiService.request(
            "GET",
            "/api/recovery-group/shares/my?hubId=${URLEncoder.encode(hubId, Charsets.UTF_8.name())}",
        )
    } catch (e: ApiException) {
        if (e.code == 403) null else throw e
    }

    /** Prove liveness of the share sealed in [shareEnvelope] for [hubId]. */
    suspend fun proveLiveness(hubId: String, shareEnvelope: String) {
        val issued: ShareLivenessChallengeResponse = apiService.request(
            "POST",
            "/api/recovery-group/shares/liveness/challenge",
            ShareLivenessChallengeRequest(hubID = hubId),
        )
        val proof = cryptoService.recoveryShareLivenessProof(
            shareEnvelopeJson = shareEnvelope,
            hubId = hubId,
            challengeHex = issued.challenge,
        )
        apiService.submitShareLivenessProof(
            RecoveryLivenessRequest(hubId = hubId, challenge = issued.challenge, proof = proof),
        )
    }
}
