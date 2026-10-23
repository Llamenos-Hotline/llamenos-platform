package org.llamenos.hotline.api

import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.Serializable
import okhttp3.Interceptor
import okhttp3.MediaType
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody
import okio.Buffer
import okio.BufferedSource
import okio.ForwardingSource
import okio.buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.llamenos.hotline.InMemoryKeyValueStore
import org.llamenos.hotline.crypto.KeystoreService
import org.llamenos.hotline.hub.ActiveHubState

/**
 * Every [ApiService] request helper closes the response it executed, on success and on error.
 *
 * An unclosed OkHttp response keeps its connection allocated: OkHttp cannot return it to the
 * pool, so every leaked call costs a fresh connection (and, on a pinned TLS hub, a fresh
 * handshake) until the GC finds the call and OkHttp logs "A connection … was leaked".
 * [ApiService.requestNoContent] and [ApiService.requestRawNoContent] leaked on every success,
 * because nothing reads a no-content body — and the clock-in/clock-out, push and VoIP
 * registration calls all go through them.
 *
 * The backend here is an interceptor that answers without calling `proceed()`, so no socket is
 * opened: what is asserted is the close itself, observed on the body's source.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ApiServiceResponseCloseTest {

    @Serializable
    private data class Ok(val ok: Boolean)

    private var answerCode = 200
    private var answerBody = """{"ok":true}"""
    private val issuedBodies = mutableListOf<TrackedBody>()

    private lateinit var apiService: ApiService

    /** A response body that records whether anything closed it. */
    private class TrackedBody(content: String) : ResponseBody() {
        var closed = false
            private set
        private val source = object : ForwardingSource(Buffer().writeUtf8(content)) {
            override fun close() {
                closed = true
                super.close()
            }
        }.buffer()
        private val length = content.encodeToByteArray().size.toLong()

        override fun contentType(): MediaType = "application/json".toMediaType()
        override fun contentLength(): Long = length
        override fun source(): BufferedSource = source
    }

    @Before
    fun setUp() {
        val store = InMemoryKeyValueStore()
        store.store(KeystoreService.KEY_HUB_URL, "http://hub.test")
        val activeHubState = mockk<ActiveHubState>(relaxed = true)
        every { activeHubState.activeHubId } returns MutableStateFlow(null)
        val backend = Interceptor { chain ->
            val body = TrackedBody(answerBody).also { issuedBodies += it }
            Response.Builder()
                .request(chain.request())
                .protocol(Protocol.HTTP_1_1)
                .code(answerCode)
                .message(if (answerCode in 200..299) "OK" else "Error")
                .body(body)
                .build()
        }
        apiService = ApiService(
            authInterceptor = mockk(relaxed = true),
            retryInterceptor = mockk(relaxed = true),
            keystoreService = store,
            activeHubState = activeHubState,
        ).also {
            it.client = OkHttpClient.Builder().addInterceptor(backend).build()
            it.ioDispatcher = UnconfinedTestDispatcher()
        }
    }

    private fun assertEveryResponseClosed() {
        assertEquals("exactly one request was made", 1, issuedBodies.size)
        assertTrue("the response was left open, holding its connection", issuedBodies.single().closed)
    }

    private suspend fun assertApiError(code: Int, call: suspend () -> Unit) {
        try {
            call()
            fail("expected ApiException($code)")
        } catch (e: ApiException) {
            assertEquals(code, e.code)
            assertEquals(answerBody, e.message)
        }
    }

    @Test
    fun `requestNoContent closes a successful response`() = runTest {
        apiService.requestNoContent("POST", "/api/hubs/hub-a/shifts/clock-in")
        assertEveryResponseClosed()
    }

    @Test
    fun `requestNoContent closes an error response`() = runTest {
        answerCode = 500
        answerBody = """{"error":"boom"}"""
        assertApiError(500) { apiService.requestNoContent("POST", "/api/hubs/hub-a/shifts/clock-in") }
        assertEveryResponseClosed()
    }

    @Test
    fun `requestRawNoContent closes a successful response`() = runTest {
        apiService.requestRawNoContent("POST", "/api/devices/register", """{"pushToken":"x"}""")
        assertEveryResponseClosed()
    }

    @Test
    fun `requestRawNoContent closes an error response`() = runTest {
        answerCode = 409
        answerBody = """{"error":"conflict"}"""
        assertApiError(409) { apiService.requestRawNoContent("POST", "/api/devices/register", null) }
        assertEveryResponseClosed()
    }

    @Test
    fun `request closes a successful response`() = runTest {
        val result: Ok = apiService.request("GET", "/api/anything")
        assertEquals(Ok(true), result)
        assertEveryResponseClosed()
    }

    @Test
    fun `request closes an error response`() = runTest {
        answerCode = 404
        answerBody = """{"error":"Not Found"}"""
        assertApiError(404) { apiService.request<Ok>("GET", "/api/anything") }
        assertEveryResponseClosed()
    }
}
