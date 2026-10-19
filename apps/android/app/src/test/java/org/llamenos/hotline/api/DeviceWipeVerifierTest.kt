package org.llamenos.hotline.api

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * [DeviceWipeVerifier] decides whether a relay frame may destroy this device's keys.
 * Signatures here are real Ed25519 ([WipeSigner]) over the server's exact format.
 */
class DeviceWipeVerifierTest {

    private val server = WipeSigner()
    private val me = "aa".repeat(32)
    private val other = "bb".repeat(32)
    private val now = 1_800_000_000_000L

    private fun verify(
        frame: String,
        devicePubkey: String? = me,
        serverPubkey: String? = server.pubkeyHex,
        nowMs: Long = now,
    ) = DeviceWipeVerifier.verify(
        Json.parseToJsonElement(frame).jsonObject, devicePubkey, serverPubkey, nowMs, WipeSigner::verify,
    )

    @Test
    fun `a wipe signed by the server for this device is accepted`() {
        assertEquals(DeviceWipeCommand("admin-erasure"), verify(server.wipeFrame(me, now)))
    }

    @Test
    fun `a device-revocation wipe naming this device is accepted`() {
        val frame = server.wipeFrame(me, now, reason = "device-revocation", targetField = "targetDevicePubkey")
        assertEquals(DeviceWipeCommand("device-revocation"), verify(frame))
    }

    @Test
    fun `a wipe signed for another device is rejected`() {
        // Signed for `other`, but the frame does not name a target — the signature alone must refuse it.
        val frame = """{"type":"device:wipe","reason":"x","sig":"${server.signWipe(other, now)}","ts":$now}"""
        assertNull(verify(frame))
    }

    @Test
    fun `a frame naming another device is rejected even when signed for this one`() {
        val frame = """{"type":"device:wipe","targetDevicePubkey":"$other","reason":"x","sig":"${server.signWipe(me, now)}","ts":$now}"""
        assertNull(verify(frame))
    }

    @Test
    fun `a wipe signed by any key other than the server's is rejected`() {
        val attacker = WipeSigner()
        assertNull(verify(attacker.wipeFrame(me, now)))
    }

    @Test
    fun `a wipe whose timestamp was altered after signing is rejected`() {
        val frame = server.wipeFrame(me, now - 1_000).replace("\"ts\":${now - 1_000}", "\"ts\":$now")
        assertNull(verify(frame))
    }

    @Test
    fun `a stale wipe is rejected`() {
        val ts = now - DeviceWipeVerifier.MAX_AGE_MS - 1
        assertNull(verify(server.wipeFrame(me, ts)))
    }

    @Test
    fun `a wipe from the future beyond clock skew is rejected`() {
        val ts = now + DeviceWipeVerifier.CLOCK_SKEW_MS + 1
        assertNull(verify(server.wipeFrame(me, ts)))
    }

    @Test
    fun `without the server key no wipe is accepted`() {
        assertNull(verify(server.wipeFrame(me, now), serverPubkey = null))
    }

    @Test
    fun `without an authenticated identity no wipe is accepted`() {
        assertNull(verify(server.wipeFrame(me, now), devicePubkey = null))
    }

    @Test
    fun `a frame missing its signature or timestamp is rejected`() {
        assertNull(verify("""{"type":"device:wipe","targetUserId":"$me","reason":"x","ts":$now}"""))
        assertNull(verify("""{"type":"device:wipe","targetUserId":"$me","reason":"x","sig":"${server.signWipe(me, now)}"}"""))
    }
}
