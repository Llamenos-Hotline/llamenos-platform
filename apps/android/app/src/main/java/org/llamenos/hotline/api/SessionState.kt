package org.llamenos.hotline.api

import org.llamenos.hotline.crypto.KeyValueStore
import org.llamenos.core.CryptoException
import org.llamenos.core.mobileResolveAdminReaders
import org.llamenos.hotline.crypto.NoAdminReaderException
import org.llamenos.protocol.HubReadersResponse
import org.llamenos.protocol.ReaderPurpose
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Holds runtime session state fetched from the API (e.g., GET /api/auth/me).
 * Injected as a singleton so all ViewModels share the same state.
 */
@Singleton
class SessionState @Inject constructor(
    private val keyValueStore: KeyValueStore,
) {
    /**
     * The hub's admin reader set — every key hub content must be sealed to so that
     * every admin of that hub can read it (#1035).
     *
     * Asked of the server at write time, for the hub the row lands in: the
     * registered device X25519 keys of every member holding the admin minimum
     * there, plus the hub's escrow key. [hubId] is the hub of the ROW being
     * written (a call's hub for a call note), `null` for the hub being browsed
     * (a row that does not exist yet). The instance-wide `adminDecryptionPubkey`
     * `/auth/me` still publishes is one env-configured key — one admin at most,
     * none on a wizard-bootstrapped deployment — and is never consulted.
     *
     * Which entries count is decided by the crate (`mobileResolveAdminReaders`):
     * malformed keys dropped, duplicates removed.
     *
     * @throws NoAdminReaderException when the hub has no admin able to read. The
     *   caller reports it and writes nothing; it never substitutes another key.
     */
    suspend fun adminReaders(apiService: ApiService, hubId: String? = null): List<String> {
        val route = "/api/readers?purpose=${ReaderPurpose.Admin.value}"
        val response = apiService.request<HubReadersResponse>(
            "GET",
            if (hubId != null) apiService.hubPath(hubId, route) else apiService.activeHubPath(route),
        )
        return try {
            mobileResolveAdminReaders(response.recipients)
        } catch (_: CryptoException.NoAdminReader) {
            throw NoAdminReaderException()
        }
    }

    /** Clear session state (on logout). */
    fun clear() {
        // Nothing is cached: reader sets are asked of the server at write time.
        // Drops the key a pre-#1035 build persisted, which nothing reads any more.
        keyValueStore.delete(LEGACY_KEY_ADMIN_DECRYPTION_PUBKEY)
    }

    private companion object {
        const val LEGACY_KEY_ADMIN_DECRYPTION_PUBKEY = "admin-decryption-pubkey"
    }
}
