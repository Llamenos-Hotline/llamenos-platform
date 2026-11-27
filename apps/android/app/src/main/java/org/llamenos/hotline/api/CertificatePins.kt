package org.llamenos.hotline.api

import okhttp3.CertificatePinner

/**
 * The Android client's compiled-in TLS trust decision, and nothing else.
 *
 * This file exists on its own so the trust-anchor gate (`TRUST_ANCHOR_FILES`,
 * orchestrator/src/config.ts) can hold it WHOLE-FILE: a change here is a change
 * to which certificates every installed client accepts, and recovery needs an
 * app-store release. It used to live inside [ApiService], the client's entire
 * HTTP surface, so every routine API addition demanded a TLS sign-off — which
 * trains the one human in the loop to approve without reading (#3057).
 *
 * Keep it that way: add nothing here that is not a pin, the pinning policy, or the
 * construction of a [CertificatePinner]. [ApiService] and [WebSocketService] only
 * APPLY what this object returns; the trust signatures (`TRUST_SIGNATURES`) still hold
 * any change to the lines where they apply it.
 *
 * The pin set is the four Let's Encrypt ROOTS, not an intermediate or the leaf, so routine
 * leaf and intermediate rotation never breaks it. Four, because Let's Encrypt's Gen-Y
 * hierarchy (Root YR / Root YE) is served cross-signed by X1 / X2 today, so the validated
 * chain still ends at X1 / X2. The day a platform trust store anchors Root YR / Root YE,
 * Android's chain builder stops there and X1 / X2 are no longer on the chain; without the
 * Y pins every client would hard-fail while the web stayed healthy (#2505). A client
 * accepts a chain that contains ANY pinned key.
 *
 * Every value was derived from the certificate Let's Encrypt publishes, never copied:
 *   curl -s https://letsencrypt.org/certs/isrgrootx1.pem \
 *     | openssl x509 -pubkey -noout | openssl pkey -pubin -outform der \
 *     | openssl dgst -sha256 -binary | base64
 * `CertificatePinDerivationTest` re-derives all four from the PEM fixtures in
 * `src/test/resources/certs/` on every run. Change iOS, desktop and
 * `network_security_config.xml` together (docs/security/CERTIFICATE_PINS.md).
 */
object CertificatePins {
    /** Let's Encrypt ISRG Root X1 — RSA 4096. */
    const val ISRG_ROOT_X1_HASH = "sha256/C5+lpZ7tcVwmwQIMcRtPbsQtWLABXhQzejna0wHFr8M="

    /** ISRG Root X2 — ECDSA P-384 (`isrg-root-x2.pem`). */
    const val ISRG_ROOT_X2_HASH = "sha256/diGVwiVYbubAI3RW4hB9xU8e/CH2GnkuvVFZE8zmgzI="

    /** ISRG Root YR — RSA 4096, Gen-Y (`gen-y/root-yr.pem`; the cross-signed copy has the same key). */
    const val ISRG_ROOT_YR_HASH = "sha256/fk6IOKit1ild5647BH06ujSIq5XbCgqlbYl6ANhhi88="

    /** ISRG Root YE — ECDSA P-384, Gen-Y (`gen-y/root-ye.pem`; the cross-signed copy has the same key). */
    const val ISRG_ROOT_YE_HASH = "sha256/sCkq5UWXjg+7mKu9lMhhYF5bGLsy7VI/UNW3tccdR7w="

    /** Default pin hashes applied to whichever hub host the user configures. */
    val DEFAULT_PIN_HASHES = listOf(
        ISRG_ROOT_X1_HASH,
        ISRG_ROOT_X2_HASH,
        ISRG_ROOT_YR_HASH,
        ISRG_ROOT_YE_HASH,
    )

    /**
     * Build a [CertificatePinner] for the given hostname with the provided
     * pin hashes. Used when the hub URL is configured or when dynamic pins
     * are fetched from the server.
     *
     * Hard fail: OkHttp CertificatePinner rejects mismatches unconditionally.
     * No cleartext fallback. No soft-fail mode.
     *
     * @param hostname The hub server hostname (e.g. "app.example.org")
     * @param hashes SHA-256 SPKI hashes prefixed with "sha256/"
     */
    fun buildPinner(hostname: String, hashes: List<String> = DEFAULT_PIN_HASHES): CertificatePinner {
        val builder = CertificatePinner.Builder()
        for (hash in hashes) {
            builder.add(hostname, hash)
        }
        return builder.build()
    }

    /**
     * The hostname a hub URL is pinned for. Lives here, beside the localhost
     * exemption it feeds, so no line outside this file decides which host the
     * pin set is applied to.
     */
    fun hostOf(url: String): String = try {
        java.net.URI(url).host ?: url
    } catch (_: Exception) {
        url
    }

    /**
     * The pinner a client must use for [hostname]: none for local development
     * (`localhost` / `127.0.0.1`), the [DEFAULT_PIN_HASHES] set for every other host.
     * Callers cannot choose the hashes — that choice is the trust decision.
     */
    fun pinnerFor(hostname: String): CertificatePinner {
        val isLocalhost = hostname == "localhost" || hostname == "127.0.0.1"
        return if (isLocalhost) CertificatePinner.DEFAULT else buildPinner(hostname, DEFAULT_PIN_HASHES)
    }
}
