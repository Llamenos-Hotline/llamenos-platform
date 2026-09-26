package org.llamenos.hotline.api.relay

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.llamenos.hotline.model.LlamenosEvent
import org.llamenos.hotline.service.AttributedHubEvent
import org.llamenos.protocol.CryptoLabels
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.spec.X509EncodedKeySpec

/**
 * Wire-protocol tests for [RelaySession] against the server protocol in
 * `apps/worker/routes/ws.ts` + `apps/worker/lib/ws-manager.ts`.
 *
 * Signatures are real Ed25519 (JDK provider), built exactly the way the server builds
 * them, so a formatting drift in the signed strings fails these tests.
 */
class RelaySessionTest {

    private val deviceKey: KeyPair = KeyPairGenerator.getInstance("Ed25519").generateKeyPair()
    private val serverKey: KeyPair = KeyPairGenerator.getInstance("Ed25519").generateKeyPair()
    private val serverPubkeyHex = serverKey.rawPubkeyHex()
    private val now = 1_758_000_000_123L
    private val epoch = 20_350L

    /**
     * JVM stand-in for [org.llamenos.hotline.crypto.CryptoService]: real Ed25519, and a
     * "decrypt" that only accepts the epoch the payload was produced for.
     */
    private inner class FakeRelayCrypto : RelayCrypto {
        override val relayDevicePubkeyHex: String? = deviceKey.rawPubkeyHex()
        val decryptedEpochs = mutableListOf<Long>()

        override fun signRelayChallenge(messageHex: String): String =
            Signature.getInstance("Ed25519").run {
                initSign(deviceKey.private)
                update(messageHex.hexToBytes())
                sign().toHex()
            }

        override fun verifyServerEventSignature(messageHex: String, signatureHex: String, serverPubkeyHex: String): Boolean =
            try {
                Signature.getInstance("Ed25519").run {
                    initVerify(publicKeyFromRaw(serverPubkeyHex))
                    update(messageHex.hexToBytes())
                    verify(signatureHex.hexToBytes())
                }
            } catch (_: Exception) {
                false
            }

        override fun decryptServerEventForEpoch(payloadHex: String, epoch: Long): String? {
            decryptedEpochs += epoch
            val (payloadEpoch, content) = String(payloadHex.hexToBytes()).split("|", limit = 2)
            return content.takeIf { payloadEpoch.toLong() == epoch }
        }
    }

    private val crypto = FakeRelayCrypto()

    private fun session(
        replaySinceMs: Long? = null,
        deduplicator: RelayEventDeduplicator = RelayEventDeduplicator(clock = { now }),
        ensureEventKeys: suspend (Long) -> Unit = {},
    ) = RelaySession(
        crypto = crypto,
        serverPubkeyHex = serverPubkeyHex,
        deduplicator = deduplicator,
        replaySinceMs = replaySinceMs,
        ensureEventKeys = ensureEventKeys,
        clock = { now },
    )

    /** Build an event frame exactly as `ConnectionManager.publishToHub` does. */
    private fun serverEvent(
        hubId: String,
        content: String,
        kind: Long = RelayEventKinds.CALL_RING,
        ts: Long = now,
        signedHubId: String = hubId,
    ): String {
        val payload = "$epoch|$content".toByteArray().toHex()
        val sigMessage = "1:$signedHubId:$kind:$epoch:$payload:$ts"
        val sig = Signature.getInstance("Ed25519").run {
            initSign(serverKey.private)
            update(sigMessage.toByteArray(Charsets.UTF_8))
            sign().toHex()
        }
        return """{"type":"event","v":1,"hubId":"$hubId","kind":$kind,"payload":"$payload","epoch":$epoch,"ts":$ts,"sig":"$sig"}"""
    }

    private suspend fun RelaySession.authenticate(vararg hubs: String): List<RelaySession.Action> {
        onFrame("""{"type":"challenge","nonce":"nonce-1"}""")
        val hubList = hubs.joinToString(",") { "\"$it\"" }
        return onFrame("""{"type":"authenticated","hubs":[$hubList]}""")
    }

    private fun List<RelaySession.Action>.sentFrames(): List<JsonObject> =
        filterIsInstance<RelaySession.Action.Send>().map { Json.parseToJsonElement(it.frame).jsonObject }

    private fun List<RelaySession.Action>.delivered(): List<AttributedHubEvent<LlamenosEvent>> =
        filterIsInstance<RelaySession.Action.Deliver>().map { it.event }

    // ---- challenge → auth ----

    @Test
    fun `challenge is answered with an Ed25519 auth the server accepts`() = runTest {
        val frames = session().onFrame("""{"type":"challenge","nonce":"abc123"}""").sentFrames()

        assertEquals(1, frames.size)
        val auth = frames.single()
        assertEquals("auth", auth["type"]!!.jsonPrimitive.content)
        assertEquals("abc123", auth["nonce"]!!.jsonPrimitive.content)
        assertEquals(deviceKey.rawPubkeyHex(), auth["pubkey"]!!.jsonPrimitive.content)
        assertEquals(now.toDouble(), auth["ts"]!!.jsonPrimitive.double, 0.0)

        // Server side (routes/ws.ts): `${LABEL_WS_CHALLENGE}:${pubkey}:${nonce}:${ts}`
        // with ts formatted as a JavaScript number.
        val serverSigned = "${CryptoLabels.LABEL_WS_CHALLENGE}:${deviceKey.rawPubkeyHex()}:abc123:$now"
        val valid = Signature.getInstance("Ed25519").run {
            initVerify(deviceKey.public)
            update(serverSigned.toByteArray(Charsets.UTF_8))
            verify(auth["sig"]!!.jsonPrimitive.content.hexToBytes())
        }
        assertTrue("auth signature must verify over the server's signed string", valid)
    }

    @Test
    fun `challenge without a device identity fails authentication`() = runTest {
        val noIdentity = object : RelayCrypto by crypto {
            override val relayDevicePubkeyHex: String? = null
        }
        val actions = RelaySession(noIdentity, serverPubkeyHex, RelayEventDeduplicator())
            .onFrame("""{"type":"challenge","nonce":"n"}""")
        assertTrue(actions.single() is RelaySession.Action.AuthFailed)
    }

    @Test
    fun `auth_failed error surfaces as AuthFailed`() = runTest {
        val s = session()
        s.authenticate("hub-a")
        val actions = s.onFrame("""{"type":"error","code":"auth_failed","message":"Invalid signature"}""")
        assertTrue(actions.single() is RelaySession.Action.AuthFailed)
        assertFalse(s.isAuthenticated)
    }

    // ---- authenticated → subscribe for every hub ----

    @Test
    fun `authenticated subscribes to every member hub`() = runTest {
        val s = session()
        val actions = s.authenticate("hub-a", "hub-b")

        assertTrue(s.isAuthenticated)
        assertEquals(listOf("hub-a", "hub-b"), actions.filterIsInstance<RelaySession.Action.Authenticated>().single().hubs)
        val subscribes = actions.sentFrames()
        assertEquals(listOf("hub-a", "hub-b"), subscribes.map { it["hubId"]!!.jsonPrimitive.content })
        for (frame in subscribes) {
            assertEquals("subscribe", frame["type"]!!.jsonPrimitive.content)
            val kinds = frame["kinds"]!!.jsonArray.map { it.jsonPrimitive.double.toLong() }
            assertEquals(RelayEventKinds.SUBSCRIBED, kinds)
        }
    }

    @Test
    fun `reconnect requests a replay per hub`() = runTest {
        val since = now - 60_000L
        val frames = session(replaySinceMs = since).authenticate("hub-a", "hub-b").sentFrames()
        val replays = frames.filter { it["type"]!!.jsonPrimitive.content == "replay" }
        assertEquals(listOf("hub-a", "hub-b"), replays.map { it["hubId"]!!.jsonPrimitive.content })
        replays.forEach { assertEquals(since.toDouble(), it["since"]!!.jsonPrimitive.double, 0.0) }
    }

    // ---- event delivery + hub attribution ----

    @Test
    fun `event for a non-active hub is delivered attributed to that hub`() = runTest {
        // The session never consults the active hub: whichever hub the UI shows ("hub-a"),
        // a call ringing on "hub-b" must arrive labelled "hub-b".
        val s = session()
        s.authenticate("hub-a", "hub-b")

        val delivered = s.onFrame(serverEvent("hub-b", """{"type":"call:ring","callId":"call-9"}""")).delivered()

        assertEquals(listOf(AttributedHubEvent<LlamenosEvent>("hub-b", LlamenosEvent.CallRing("call-9"))), delivered)
        assertEquals(listOf(epoch), crypto.decryptedEpochs)
    }

    @Test
    fun `event keys are ensured for the event epoch before decrypting`() = runTest {
        val ensured = mutableListOf<Long>()
        val s = session(ensureEventKeys = { ensured += it })
        s.authenticate("hub-a")
        s.onFrame(serverEvent("hub-a", """{"type":"call:update","callId":"c","status":"completed"}"""))
        assertEquals(listOf(epoch), ensured)
    }

    @Test
    fun `event whose hubId was not the one signed is dropped`() = runTest {
        val s = session()
        s.authenticate("hub-a", "hub-b")
        val relabelled = serverEvent("hub-b", """{"type":"call:ring","callId":"c"}""", signedHubId = "hub-a")
        assertTrue(s.onFrame(relabelled).isEmpty())
    }

    @Test
    fun `event signed by another key is dropped`() = runTest {
        val other = KeyPairGenerator.getInstance("Ed25519").generateKeyPair()
        val s = RelaySession(crypto, other.rawPubkeyHex(), RelayEventDeduplicator(clock = { now }), clock = { now })
        s.authenticate("hub-a")
        assertTrue(s.onFrame(serverEvent("hub-a", """{"type":"call:ring","callId":"c"}""")).isEmpty())
    }

    @Test
    fun `event before authentication is dropped`() = runTest {
        assertTrue(session().onFrame(serverEvent("hub-a", """{"type":"call:ring","callId":"c"}""")).isEmpty())
    }

    @Test
    fun `replayed duplicate is delivered once, across sessions`() = runTest {
        val dedup = RelayEventDeduplicator(clock = { now })
        val frame = serverEvent("hub-a", """{"type":"call:ring","callId":"c"}""")

        val first = session(deduplicator = dedup)
        first.authenticate("hub-a")
        assertEquals(1, first.onFrame(frame).delivered().size)
        assertTrue(first.onFrame(frame).isEmpty())

        val reconnected = session(deduplicator = dedup, replaySinceMs = now - 1_000L)
        reconnected.authenticate("hub-a")
        assertTrue(reconnected.onFrame(frame).isEmpty())
    }

    @Test
    fun `stale event is dropped`() = runTest {
        val s = session()
        s.authenticate("hub-a")
        val stale = serverEvent("hub-a", """{"type":"call:ring","callId":"c"}""", ts = now - 10 * 60 * 1000L)
        assertTrue(s.onFrame(stale).isEmpty())
    }

    @Test
    fun `non-protocol frames are ignored`() = runTest {
        val s = session()
        assertTrue(s.onFrame("""["EVENT","sub",{}]""").isEmpty())
        assertTrue(s.onFrame("not json").isEmpty())
        assertTrue(s.onFrame("""{"type":"pong"}""").isEmpty())
        assertTrue(s.onFrame("""{"type":"challenge"}""").isEmpty())
    }

    // ---- content parsing ----

    @Test
    fun `parser maps server event content types`() {
        assertEquals(LlamenosEvent.CallRing("c"), RelayEventParser.parse("""{"type":"call:ring","callId":"c"}"""))
        assertEquals(LlamenosEvent.CallEnded("c"), RelayEventParser.parse("""{"type":"call:update","callId":"c","status":"completed"}"""))
        assertEquals(LlamenosEvent.CallUpdate("c", "in-progress"), RelayEventParser.parse("""{"type":"call:update","callId":"c","status":"in-progress"}"""))
        assertEquals(LlamenosEvent.MessageNew("v"), RelayEventParser.parse("""{"type":"message:new","conversationId":"v"}"""))
        assertEquals(LlamenosEvent.Unknown("future:thing"), RelayEventParser.parse("""{"type":"future:thing"}"""))
        assertEquals(null, RelayEventParser.parse("""{"type":"call:ring"}"""))
    }

    private companion object {
        /** DER prefix of an X.509 SubjectPublicKeyInfo for a raw Ed25519 key. */
        const val ED25519_SPKI_PREFIX = "302a300506032b6570032100"

        fun KeyPair.rawPubkeyHex(): String = public.encoded.takeLast(32).toByteArray().toHex()

        fun publicKeyFromRaw(rawHex: String) =
            KeyFactory.getInstance("Ed25519").generatePublic(X509EncodedKeySpec((ED25519_SPKI_PREFIX + rawHex).hexToBytes()))

        fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }

        fun String.hexToBytes(): ByteArray = chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    }
}
