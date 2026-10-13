package org.llamenos.hotline

import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.llamenos.hotline.api.RetryInterceptor

/**
 * Unit tests for RetryInterceptor retry logic.
 *
 * Uses a [FakeChain] that returns configurable HTTP status codes
 * to verify retry behavior without actual network calls.
 */
class RetryInterceptorTest {

    private val interceptor = RetryInterceptor()

    @Test
    fun `200 response is returned immediately without retry`() {
        val chain = FakeChain(listOf(200))
        val response = interceptor.intercept(chain)

        assertEquals(200, response.code)
        assertEquals(1, chain.callCount)
    }

    @Test
    fun `404 client error is not retried`() {
        val chain = FakeChain(listOf(404))
        val response = interceptor.intercept(chain)

        assertEquals(404, response.code)
        assertEquals(1, chain.callCount)
    }

    @Test
    fun `401 unauthorized is not retried`() {
        val chain = FakeChain(listOf(401))
        val response = interceptor.intercept(chain)

        assertEquals(401, response.code)
        assertEquals(1, chain.callCount)
    }

    @Test
    fun `500 server error retries and succeeds on second attempt`() {
        val chain = FakeChain(listOf(500, 200))
        val response = interceptor.intercept(chain)

        assertEquals(200, response.code)
        assertEquals(2, chain.callCount)
    }

    @Test
    fun `502 bad gateway retries and succeeds on third attempt`() {
        val chain = FakeChain(listOf(502, 503, 200))
        val response = interceptor.intercept(chain)

        assertEquals(200, response.code)
        assertEquals(3, chain.callCount)
    }

    @Test
    fun `exhausts retries and returns last error response`() {
        val chain = FakeChain(listOf(500, 502, 503))
        val response = interceptor.intercept(chain)

        assertEquals(503, response.code)
        assertEquals(3, chain.callCount)
    }

    @Test
    fun `429 too many requests is retried`() {
        val chain = FakeChain(listOf(429, 200))
        val response = interceptor.intercept(chain)

        assertEquals(200, response.code)
        assertEquals(2, chain.callCount)
    }

    @Test
    fun `408 request timeout is retried`() {
        val chain = FakeChain(listOf(408, 200))
        val response = interceptor.intercept(chain)

        assertEquals(200, response.code)
        assertEquals(2, chain.callCount)
    }

    // ─── Retry-After, and the wait budget ───────────────────────────────────
    //
    // The server's own rate limiters answer 429 with `Retry-After: 60`
    // (apps/worker/routes/invites.ts and middleware/rate-limit.ts). Honouring that
    // literally is what froze the app: two sleeps capped at 30s each, on the OkHttp
    // call thread, with no `callTimeout` on the client to abort them. The onboarding
    // screen has no way to show anything during those ~60s — it just spins.
    //
    // These tests record the requested waits instead of serving them, so they assert
    // the budget rather than the wall clock. The eight tests above assert only call
    // counts and status codes, which is why a minute of blocking was invisible to them.

    @Test
    fun `a 429 asking for a 60s wait is returned to the caller, not slept on`() {
        val chain = FakeChain(listOf(429, 429, 429), mapOf("Retry-After" to "60"))
        val waits = recordWaits()

        val response = interceptor.intercept(chain)

        assertEquals(429, response.code)
        assertEquals(
            "a Retry-After longer than the budget must not be waited out; waits=$waits",
            emptyList<Long>(),
            waits,
        )
        assertEquals("the 429 must be surfaced on the first attempt", 1, chain.callCount)
    }

    @Test
    fun `total wait across retries never exceeds the budget`() {
        for (retryAfter in listOf("1", "2", "5", "30", "60", "3600")) {
            val chain = FakeChain(listOf(429, 429, 429), mapOf("Retry-After" to retryAfter))
            val waits = recordWaits()

            interceptor.intercept(chain)

            assertTrue(
                "Retry-After: $retryAfter slept ${waits.sum()}ms, over the " +
                    "${RetryInterceptor.MAX_TOTAL_WAIT_MS}ms budget; waits=$waits",
                waits.sum() <= RetryInterceptor.MAX_TOTAL_WAIT_MS,
            )
        }
    }

    @Test
    fun `a Retry-After inside the budget is still honoured`() {
        val chain = FakeChain(listOf(429, 200), mapOf("Retry-After" to "2"))
        val waits = recordWaits()

        val response = interceptor.intercept(chain)

        assertEquals(200, response.code)
        assertEquals("the server's own 2s backoff must be used", listOf(2_000L), waits)
    }

    @Test
    fun `plain exponential backoff stays within the budget`() {
        val chain = FakeChain(listOf(503, 503, 503))
        val waits = recordWaits()

        interceptor.intercept(chain)

        assertTrue(
            "unheadered backoff slept ${waits.sum()}ms, over the budget; waits=$waits",
            waits.sum() <= RetryInterceptor.MAX_TOTAL_WAIT_MS,
        )
    }

    /** Swap the interceptor's sleep for a recorder: assert the budget, do not serve it. */
    private fun recordWaits(): List<Long> {
        val waits = mutableListOf<Long>()
        interceptor.sleep = { waits += it }
        return waits
    }

    /**
     * Fake OkHttp chain that returns responses with preconfigured status codes.
     * Each call to [proceed] returns the next status code in the list.
     */
    private class FakeChain(
        private val statusCodes: List<Int>,
        private val responseHeaders: Map<String, String> = emptyMap(),
    ) : Interceptor.Chain {
        var callCount = 0
            private set

        private val request = Request.Builder()
            .url("https://hub.example.com/api/test")
            .build()

        override fun request(): Request = request

        override fun proceed(request: Request): Response {
            val code = statusCodes.getOrElse(callCount) { statusCodes.last() }
            callCount++
            return Response.Builder()
                .request(request)
                .protocol(Protocol.HTTP_2)
                .code(code)
                .message("Status $code")
                .apply { responseHeaders.forEach { (name, value) -> header(name, value) } }
                .body("{}".toResponseBody("application/json".toMediaType()))
                .build()
        }

        // Required overrides with no-op implementations
        override fun connection() = null
        override fun call() = throw UnsupportedOperationException()
        override fun connectTimeoutMillis() = 30000
        override fun readTimeoutMillis() = 30000
        override fun writeTimeoutMillis() = 30000
        override fun withConnectTimeout(timeout: Int, unit: java.util.concurrent.TimeUnit) = this
        override fun withReadTimeout(timeout: Int, unit: java.util.concurrent.TimeUnit) = this
        override fun withWriteTimeout(timeout: Int, unit: java.util.concurrent.TimeUnit) = this
    }
}
