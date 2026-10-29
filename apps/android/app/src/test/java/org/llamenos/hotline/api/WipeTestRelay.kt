package org.llamenos.hotline.api

import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.llamenos.hotline.InMemoryKeyValueStore
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.crypto.KeystoreService
import org.llamenos.hotline.hub.HubActivityService

/**
 * A [WebSocketService] driven through its real setup path: `/api/config` is served by
 * a [MockWebServer] (advertising [server]'s key), and the relay challenge is answered,
 * so the service holds a server key and an authenticated identity exactly as it would
 * on a live socket. Crypto is stubbed at the [CryptoService] boundary — the native
 * library is unavailable on the JVM — with Ed25519 verify backed by the JDK.
 */
class WipeTestRelay(
    val server: WipeSigner = WipeSigner(),
    val devicePubkey: String = "aa".repeat(32),
    advertiseServerKey: Boolean = true,
    /** What the stored server event key decrypts every `event` payload to. */
    decryptedEvent: String? = """{"type":"call:ring","callId":"call-1"}""",
) : AutoCloseable {
    private val http = MockWebServer().apply { start() }

    val crypto: CryptoService = mockk<CryptoService>(relaxed = true).also {
        every { it.signingPubkeyHex } returns devicePubkey
        every { it.ed25519Sign(any()) } returns "cd".repeat(64)
        every { it.ed25519Verify(any(), any(), any()) } answers {
            WipeSigner.verify(firstArg(), secondArg(), thirdArg())
        }
        every { it.decryptServerEventWithStoredKeys(any(), any()) } returns decryptedEvent
    }

    val service: WebSocketService

    init {
        val store = InMemoryKeyValueStore()
        store.store(KeystoreService.KEY_HUB_URL, http.url("/").toString().trimEnd('/'))
        val api = ApiService(AuthInterceptor(crypto), RetryInterceptor(), store, mockk(relaxed = true))
        api.client = OkHttpClient()
        val keyField = if (advertiseServerKey) ""","serverPubkey":"${server.pubkeyHex}"""" else ""
        http.enqueue(
            MockResponse().setResponseCode(200).setHeader("Content-Type", "application/json")
                .setBody("""{"hotlineName":"T","apiVersion":1,"minApiVersion":1,"wsRelayUrl":"/ws"$keyField}"""),
        )
        service = WebSocketService(crypto, store, HubActivityService(), api)
        runBlocking { service.resolveRelayUrl() }
        service.handleServerMessage("""{"type":"challenge","nonce":"n1"}""")
    }

    fun eventFrame(hubId: String = "hub-a") =
        """{"type":"event","v":1,"hubId":"$hubId","kind":1000,"payload":"deadbeef","epoch":1,"ts":1730000000000,"sig":"ab"}"""

    override fun close() = http.shutdown()
}
