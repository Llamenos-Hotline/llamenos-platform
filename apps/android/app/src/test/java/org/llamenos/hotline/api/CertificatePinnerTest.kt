package org.llamenos.hotline.api

import okhttp3.CertificatePinner
import org.junit.Test
import java.security.cert.Certificate
import java.security.cert.CertificateFactory
import javax.net.ssl.SSLPeerUnverifiedException
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class CertificatePinnerTest {

    @Test
    fun `certificate pinner does not contain REPLACE_AFTER_DEPLOYMENT placeholder`() {
        // Ensure old placeholder values from before deployment are gone.
        // If this test fails, ApiService.certificatePinner still has pre-deployment stubs.
        // Replace with real hashes — see docs/security/CERTIFICATE_PINS.md.
        //
        // Uses the public `pins` list rather than toString() to avoid
        // format-dependent parsing across OkHttp versions.
        val hasPlaceholder = ApiService.certificatePinner.pins.any { pin ->
            pin.toString().contains("REPLACE_AFTER_DEPLOYMENT")
        }
        assertFalse(
            hasPlaceholder,
            "CertificatePinner contains REPLACE_AFTER_DEPLOYMENT placeholder — " +
            "replace with real hashes. See docs/security/CERTIFICATE_PINS.md"
        )
    }

    @Test
    fun `default pin hashes contain at least two entries`() {
        // Must have at least 2 distinct CA pins for backup (RFC 7469 §2.5 recommendation).
        // Pinning is now dynamic: certificatePinner starts as CertificatePinner.DEFAULT and
        // is built per-hostname via buildPinner(). Verify DEFAULT_PIN_HASHES directly.
        val count = ApiService.DEFAULT_PIN_HASHES.size
        assertTrue(
            count >= 2,
            "ApiService.DEFAULT_PIN_HASHES must have at least 2 pins (ISRG Root X1, X2, YR, YE). Found: $count"
        )
    }

    @Test
    fun `buildPinner returns pinner with default hashes for public hostname`() {
        // Verify buildPinner() applies all DEFAULT_PIN_HASHES to the given hostname.
        val hostname = "app.example.org"
        val pinner = ApiService.buildPinner(hostname)
        val pinCount = pinner.pins.size
        assertTrue(
            pinCount >= 2,
            "buildPinner must produce a pinner with at least 2 pins. Found: $pinCount"
        )
    }

    // ------------------------------------------------------------------
    // Chain behaviour (#2505). The invariant is about chains, not about hash literals:
    // a chain containing ANY pinned root is accepted, a chain containing none is refused.
    // Real Let's Encrypt certificates, captured from the live test sites on 2026-11-06;
    // OkHttp's pin check does not look at validity dates, and the platform trust manager
    // that validates the chain before it runs is not under test here.
    // ------------------------------------------------------------------

    private val host = "valid-isrgrootx1.letsencrypt.org"

    private fun chain(vararg resources: String): List<Certificate> = resources.flatMap { name ->
        val stream = javaClass.classLoader!!.getResourceAsStream("certs/$name")
            ?: error("Missing test fixture on classpath: certs/$name")
        stream.use { CertificateFactory.getInstance("X.509").generateCertificates(it).toList() }
    }

    private val legacyPinner: CertificatePinner =
        ApiService.buildPinner(host, listOf(ApiService.ISRG_ROOT_X1_HASH, ApiService.ISRG_ROOT_X2_HASH))

    /** Leaf + YR1 + the self-signed Root YR: what the chain builder returns once YR is a trust anchor. */
    private val yrAnchored = arrayOf("le-chain-yr.pem", "isrg-root-yr.pem")

    /** Leaf + YE1 + the self-signed Root YE. */
    private val yeAnchored = arrayOf("le-chain-ye.pem", "isrg-root-ye.pem")

    /** Leaf + YR1 + Root YR cross-signed by X1 + Root X1: what the chain builder returns today. */
    private val yrViaX1 = arrayOf("le-chain-yr.pem", "isrg-root-yr-by-x1.pem", "isrg-root-x1.pem")

    /** Leaf + YE1 + Root YE cross-signed by X2 + Root X2. */
    private val yeViaX2 = arrayOf("le-chain-ye.pem", "isrg-root-ye-by-x2.pem", "isrg-root-x2.pem")

    @Test
    fun `a chain anchored by any pinned root is accepted`() {
        val pinner = ApiService.buildPinner(host)
        for ((name, resources) in mapOf(
            "anchored at ISRG Root YR" to yrAnchored,
            "anchored at ISRG Root YE" to yeAnchored,
            "anchored at ISRG Root X1 via the YR cross-sign" to yrViaX1,
            "anchored at ISRG Root X2 via the YE cross-sign" to yeViaX2,
            "ISRG Root X1 alone" to arrayOf("isrg-root-x1.pem"),
            "ISRG Root X2 alone" to arrayOf("isrg-root-x2.pem"),
        )) {
            try {
                pinner.check(host, chain(*resources))
            } catch (e: SSLPeerUnverifiedException) {
                throw AssertionError("a chain $name must be accepted: ${e.message}", e)
            }
        }
    }

    @Test
    fun `a chain anchored by an unpinned root is refused`() {
        // A well-formed leaf for the right host, signed by a CA whose key is not pinned: what a
        // coerced or mis-issued certificate from another CA looks like. Adding roots to the pin
        // set must never turn into "accept any chain".
        val pinner = ApiService.buildPinner(host)
        assertFailsWith<SSLPeerUnverifiedException> {
            pinner.check(host, chain("unpinned-chain.pem"))
        }
        // Appending a genuine Let's Encrypt intermediate (YR1, whose key is not pinned either) to
        // the forged leaf does not change that: only a pinned KEY on the chain counts.
        val forgedLeafWithYr1 = chain("unpinned-chain.pem").take(1) + chain("le-chain-yr.pem").drop(1)
        assertFailsWith<SSLPeerUnverifiedException> { pinner.check(host, forgedLeafWithYr1) }
    }

    @Test
    fun `the Gen-Y pins are what accept a Y-anchored chain`() {
        // The #2505 outage in miniature: with only X1 / X2 pinned, a chain a trust store anchors at
        // Root YR / YE carries no pinned key and is refused. This is the half that proves the new
        // pins are doing the work rather than the chain being accepted for some other reason.
        assertFailsWith<SSLPeerUnverifiedException> { legacyPinner.check(host, chain(*yrAnchored)) }
        assertFailsWith<SSLPeerUnverifiedException> { legacyPinner.check(host, chain(*yeAnchored)) }
        // The chains served today still pass the old pin set, so the old pin set is not
        // "already broken" and nothing here depends on the trust stores having moved.
        legacyPinner.check(host, chain(*yrViaX1))
        legacyPinner.check(host, chain(*yeViaX2))
    }
}
