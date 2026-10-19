package org.llamenos.hotline.api

import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.spec.X509EncodedKeySpec

/**
 * A real Ed25519 server key for wipe tests, from the JDK provider — the native
 * library is unavailable on the JVM, so [verify] stands in for
 * `mobileEd25519Verify` with the same (messageHex, signatureHex, pubkeyHex) contract.
 */
class WipeSigner {
    private val keyPair = KeyPairGenerator.getInstance("Ed25519").generateKeyPair()

    /** Raw 32-byte public key, hex — the form `/api/config` advertises. */
    val pubkeyHex: String = keyPair.public.encoded.takeLast(32).toByteArray().toHex()

    /** Sign exactly what `ws-manager.ts` `sendSignedWipeToUser` signs. */
    fun signWipe(target: String, ts: Long): String = sign("1:device:wipe:$target:$ts")

    fun sign(message: String): String =
        Signature.getInstance("Ed25519").run {
            initSign(keyPair.private)
            update(message.toByteArray(Charsets.UTF_8))
            sign().toHex()
        }

    /** A complete wipe frame as the server sends it. */
    fun wipeFrame(target: String, ts: Long, reason: String = "admin-erasure", targetField: String = "targetUserId") =
        """{"type":"device:wipe","$targetField":"$target","reason":"$reason","timestamp":"2026-10-19T00:00:00Z","sig":"${signWipe(target, ts)}","ts":$ts}"""

    companion object {
        private val X509_ED25519_PREFIX = "302a300506032b6570032100".hexToBytes()

        fun verify(messageHex: String, signatureHex: String, pubkeyHex: String): Boolean = runCatching {
            val key = KeyFactory.getInstance("Ed25519")
                .generatePublic(X509EncodedKeySpec(X509_ED25519_PREFIX + pubkeyHex.hexToBytes()))
            Signature.getInstance("Ed25519").run {
                initVerify(key)
                update(messageHex.hexToBytes())
                verify(signatureHex.hexToBytes())
            }
        }.getOrDefault(false)

        private fun ByteArray.toHex() = joinToString("") { "%02x".format(it) }
        private fun String.hexToBytes() = chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    }
}
