package org.llamenos.hotline.api

import org.junit.Test
import java.security.MessageDigest
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.util.Base64
import javax.xml.parsers.DocumentBuilderFactory
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Regression test for #1593: the ISRG Root X2 SPKI pin was hand-transcribed
 * incorrectly in both `ApiService.ISRG_ROOT_X2_HASH` and the production
 * `network_security_config.xml` `<pin-set>`. The wrong value
 * ("diGVwiVYbubAI3RW4hB9xU8e/CH2GGvrTcuvhPy/MzA=") shared a 29-character
 * prefix with the real digest ("diGVwiVYbubAI3RW4hB9xU8e/CH2GnkuvVFZE8zmgzI=")
 * and then diverged — invisible on a casual read, since two independent
 * SHA-256 digests cannot share a prefix that long by chance.
 *
 * A test that merely re-asserts a literal hash (as the pre-existing
 * `CertificatePinnerTest` did via "at least 2 pins") catches nothing: a wrong
 * hand-typed literal in the test would just agree with the wrong hand-typed
 * literal in production code. This test instead DERIVES the expected digest
 * at run time from the actual ISRG Root X1 / X2 certificates (test fixtures
 * under `src/test/resources/certs/`, downloaded from
 * https://letsencrypt.org/certs/ and independently verified against the
 * publicly published whole-certificate SHA-256 fingerprints:
 *   X1 = 96:BC:EC:06:26:49:76:F3:74:60:77:9A:CF:28:C5:A7:CF:E8:A3:C0:AA:E1:1A:8F:FC:EE:05:C0:BD:DF:08:C6
 *   X2 = 69:72:9B:8E:15:A8:6E:FC:17:7A:57:AF:B7:17:1D:FC:64:AD:D2:8C:2F:CA:8C:F1:50:7E:34:45:3C:CB:14:70
 *
 * Before the #1593 fix, `ApiService X1 and X2 pins match digests derived from
 * the real ISRG root certificates` failed: it computed
 * "diGVwiVYbubAI3RW4hB9xU8e/CH2GnkuvVFZE8zmgzI=" from isrg-root-x2.pem and
 * compared it against the shipped `ISRG_ROOT_X2_HASH` of
 * "sha256/diGVwiVYbubAI3RW4hB9xU8e/CH2GGvrTcuvhPy/MzA=" — a mismatch. Likewise
 * `network_security_config pin-set matches digests derived from the real ISRG
 * root certificates` failed comparing the derived digest against the second
 * `<pin>` entry in the XML.
 *
 * To regenerate the certificate fixtures (e.g. on a future root rotation):
 *   curl -s https://letsencrypt.org/certs/isrgrootx1.pem   > certs/isrg-root-x1.pem
 *   curl -s https://letsencrypt.org/certs/isrg-root-x2.pem > certs/isrg-root-x2.pem
 *
 * The `network_security_config.xml` fixture is copied automatically at build time by the
 * `copyProductionNetworkSecurityConfig` Gradle task (see app/build.gradle.kts) from
 * `src/main/res/xml/network_security_config.xml` — NOT hand-maintained — because the debug
 * build variant overrides that resource with a pin-less config, so the merged Android
 * resources `testDebugUnitTest` sees never contain the production `<pin-set>`.
 */
class CertificatePinDerivationTest {

    private fun loadCertificate(resourceName: String): X509Certificate {
        val stream = javaClass.classLoader!!.getResourceAsStream(resourceName)
            ?: error("Missing test fixture on classpath: $resourceName")
        return stream.use {
            CertificateFactory.getInstance("X.509").generateCertificate(it) as X509Certificate
        }
    }

    /**
     * SHA-256 of the certificate's SubjectPublicKeyInfo (DER-encoded), base64
     * encoded — exactly the value Android `<pin-set>` and OkHttp
     * [okhttp3.CertificatePinner] pin against (the "sha256/" prefix is a
     * CertificatePinner convention, stripped/added by callers as needed).
     */
    private fun spkiSha256Base64(cert: X509Certificate): String =
        Base64.getEncoder().encodeToString(
            MessageDigest.getInstance("SHA-256").digest(cert.publicKey.encoded)
        )

    @Test
    fun `ApiService X1 and X2 pins match digests derived from the real ISRG root certificates`() {
        val derivedX1 = spkiSha256Base64(loadCertificate("certs/isrg-root-x1.pem"))
        val derivedX2 = spkiSha256Base64(loadCertificate("certs/isrg-root-x2.pem"))

        assertEquals(
            "sha256/$derivedX1",
            ApiService.ISRG_ROOT_X1_HASH,
            "ISRG_ROOT_X1_HASH must equal the SPKI SHA-256 digest derived from the real " +
                "ISRG Root X1 certificate, not a hand-typed literal",
        )
        assertEquals(
            "sha256/$derivedX2",
            ApiService.ISRG_ROOT_X2_HASH,
            "ISRG_ROOT_X2_HASH must equal the SPKI SHA-256 digest derived from the real " +
                "ISRG Root X2 certificate (this is the #1593 regression: a hand-transcribed " +
                "digest sharing a 29-character prefix with the real value)",
        )
    }

    @Test
    fun `network_security_config pin-set matches digests derived from the real ISRG root certificates`() {
        val xml = javaClass.classLoader!!.getResourceAsStream("fixtures/network_security_config.xml")
            ?: error(
                "Missing fixtures/network_security_config.xml on classpath — did the " +
                    "copyProductionNetworkSecurityConfig Gradle task run?"
            )
        val doc = xml.use { DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(it) }
        val pinNodes = doc.getElementsByTagName("pin")
        val pins = (0 until pinNodes.length).map { pinNodes.item(it).textContent.trim() }

        assertTrue(
            pins.size >= 2,
            "Expected at least 2 <pin> entries in network_security_config.xml, found ${pins.size}",
        )

        val derivedX1 = spkiSha256Base64(loadCertificate("certs/isrg-root-x1.pem"))
        val derivedX2 = spkiSha256Base64(loadCertificate("certs/isrg-root-x2.pem"))

        assertEquals(
            derivedX1,
            pins[0],
            "First <pin> in network_security_config.xml must be the real ISRG Root X1 SPKI digest",
        )
        assertEquals(
            derivedX2,
            pins[1],
            "Second <pin> in network_security_config.xml must be the real ISRG Root X2 SPKI " +
                "digest (this is the #1593 regression)",
        )
    }
}
