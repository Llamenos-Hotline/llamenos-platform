package org.llamenos.hotline.api.relay

/**
 * The crypto operations the WebSocket relay needs. Production implementation is
 * [org.llamenos.hotline.crypto.CryptoService], which delegates every call to the Rust
 * core. Device secrets and server event keys never leave Rust memory.
 *
 * It is an interface so the relay protocol can be unit-tested on the JVM, where the
 * native library is not loaded.
 */
interface RelayCrypto {
    /** Ed25519 device signing pubkey (hex), or null if no identity is loaded. */
    val relayDevicePubkeyHex: String?

    /**
     * Sign [messageHex] (hex-encoded bytes) with the device Ed25519 key.
     * @return hex signature
     * @throws IllegalStateException if the key store is locked or the native library is missing
     */
    fun signRelayChallenge(messageHex: String): String

    /** Verify a server Ed25519 signature over [messageHex]. Returns false on any failure. */
    fun verifyServerEventSignature(messageHex: String, signatureHex: String, serverPubkeyHex: String): Boolean

    /**
     * Decrypt a relay event payload that the server encrypted for [epoch], using the
     * server event keys stored in Rust (current + previous epoch). Returns null on failure.
     */
    fun decryptServerEventForEpoch(payloadHex: String, epoch: Long): String?
}
