package org.llamenos.hotline.api

import io.mockk.coEvery
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.llamenos.hotline.InMemoryKeyValueStore
import org.llamenos.hotline.crypto.AuthToken
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.crypto.KeystoreService
import org.llamenos.hotline.hub.ActiveHubState
import java.io.IOException

/**
 * Wire behaviour of [InviteRepository] against a real [ApiService] and
 * [MockWebServer] replaying apps/worker/routes/invites.ts.
 *
 * Covers the redemption contract that matters for #1345:
 *  - POST goes to the NON-hub-scoped /api/invites/redeem (the server resolves
 *    the invite's hub itself)
 *  - the body is { code, pubkey, timestamp, token } with a NORMALIZED
 *    (lowercase) code and NO nonce field — the token is signed over the
 *    nonce-less device-auth message
 *  - HTTP error statuses surface as [ApiException] with the status in
 *    [ApiException.code] for the ViewModel to classify
 */
@OptIn(ExperimentalCoroutinesApi::class)
class InviteRepositoryTest {

    private val code = "3f6f8f2c-9f3e-4a2b-b1c1-2d4e6f8091a2"
    private val signingPubkey = "ab".repeat(32)

    private lateinit var server: MockWebServer
    private lateinit var cryptoService: CryptoService
    private lateinit var repository: InviteRepository

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        val store = InMemoryKeyValueStore()
        store.store(KeystoreService.KEY_HUB_URL, server.url("/").toString().trimEnd('/'))
        // An active hub must NOT leak into the redeem path.
        val activeHubState = mockk<ActiveHubState>(relaxed = true)
        every { activeHubState.activeHubId } returns MutableStateFlow("hub-a")
        val apiService = ApiService(
            authInterceptor = mockk(relaxed = true),
            retryInterceptor = mockk(relaxed = true),
            keystoreService = store,
            activeHubState = activeHubState,
        ).also {
            it.client = OkHttpClient()
            it.ioDispatcher = UnconfinedTestDispatcher()
        }
        cryptoService = mockk()
        coEvery {
            cryptoService.createAuthTokenWithoutNonce("POST", "/api/invites/redeem")
        } returns AuthToken(
            pubkey = signingPubkey,
            timestamp = 1_700_000_000_000L,
            token = "cd".repeat(64),
            nonce = null,
        )
        repository = InviteRepository(apiService, cryptoService)
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun ok(body: String = """{"ok":true}""") =
        MockResponse().setResponseCode(200).setBody(body)

    @Test
    fun `redeem posts the nonce-less signed body to the non-hub-scoped route`() = runTest {
        server.enqueue(ok())

        val result = repository.redeemInvite(code)

        assertTrue(result.isSuccess)
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/invites/redeem", request.path)

        val body = Json.parseToJsonElement(request.body.readUtf8()).jsonObject
        assertEquals(code, body.getValue("code").jsonPrimitive.content)
        assertEquals(signingPubkey, body.getValue("pubkey").jsonPrimitive.content)
        assertEquals(1_700_000_000_000L, body.getValue("timestamp").jsonPrimitive.long)
        assertEquals("cd".repeat(64), body.getValue("token").jsonPrimitive.content)
        // The redeem schema has no nonce field — its absence is what makes the
        // token unusable against every nonce-bearing endpoint.
        assertFalse("nonce" in body)
    }

    @Test
    fun `redeem extracts the code from a pasted invite link and normalizes case`() = runTest {
        server.enqueue(ok())
        val link = "https://hub.example.org/onboarding?code=${code.uppercase()}"

        val result = repository.redeemInvite(link)

        assertTrue(result.isSuccess)
        val body = Json.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject
        assertEquals(code, body.getValue("code").jsonPrimitive.content)
    }

    @Test
    fun `redeem with no code anywhere fails before any request`() = runTest {
        val result = repository.redeemInvite("not-a-code")

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull() is IllegalArgumentException)
        assertEquals(0, server.requestCount)
    }

    @Test
    fun `invalid code surfaces as ApiException 400`() = runTest {
        server.enqueue(MockResponse().setResponseCode(400).setBody("""{"error":"Invalid invite code"}"""))

        val result = repository.redeemInvite(code)

        val error = result.exceptionOrNull()
        assertTrue(error is ApiException)
        assertEquals(400, (error as ApiException).code)
    }

    @Test
    fun `unknown code surfaces as ApiException 404`() = runTest {
        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"Invite not found"}"""))

        val result = repository.redeemInvite(code)

        assertEquals(404, (result.exceptionOrNull() as ApiException).code)
    }

    @Test
    fun `expired or used invite surfaces as ApiException 410`() = runTest {
        server.enqueue(MockResponse().setResponseCode(410).setBody("""{"error":"Invite expired"}"""))

        val result = repository.redeemInvite(code)

        assertEquals(410, (result.exceptionOrNull() as ApiException).code)
    }

    @Test
    fun `rate limit surfaces as ApiException 429`() = runTest {
        server.enqueue(MockResponse().setResponseCode(429).setBody("""{"error":"Too many requests"}"""))

        val result = repository.redeemInvite(code)

        assertEquals(429, (result.exceptionOrNull() as ApiException).code)
    }

    @Test
    fun `wrong hub invite rejection still surfaces as ApiException`() = runTest {
        // Invites are hub-bound server-side; a code issued for another hub is
        // rejected with the same public shape (status varies, never a success).
        server.enqueue(MockResponse().setResponseCode(400).setBody("""{"error":"Invite not valid for this hub"}"""))

        val result = repository.redeemInvite(code)

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull() is ApiException)
    }

    @Test
    fun `unreachable hub surfaces as IOException`() = runTest {
        server.shutdown()

        val result = repository.redeemInvite(code)

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull() is IOException)
    }

    @Test
    fun `ok response body does not confuse success`() = runTest {
        server.enqueue(ok("""{"ok":true}"""))

        val result = repository.redeemInvite(code)

        assertTrue(result.isSuccess)
    }
}
