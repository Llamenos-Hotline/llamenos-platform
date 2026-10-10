package org.llamenos.hotline.api

import androidx.annotation.VisibleForTesting
import okhttp3.Interceptor
import okhttp3.Response
import java.io.IOException
import javax.inject.Inject
import javax.inject.Singleton

/**
 * OkHttp [Interceptor] that retries transient HTTP errors with exponential backoff,
 * within a total wait budget.
 *
 * The budget is the point. `intercept` blocks the calling coroutine for its whole
 * duration, and [org.llamenos.hotline.api.ApiService] sets no `callTimeout`, so time
 * spent here is time the UI has no answer and no error to show. The server's rate
 * limiters answer 429 with `Retry-After: 60` (`routes/invites.ts`,
 * `middleware/rate-limit.ts`); waiting that out twice, capped at
 * [MAX_RETRY_AFTER_MS] each, froze onboarding for ~60s on a spinner with no error
 * and no cancel — the server had answered in milliseconds, every time.
 *
 * So a delay that would take the call past [MAX_TOTAL_WAIT_MS] is not waited out:
 * the 429 is returned to the caller instead, which can say "too many attempts, try
 * again in a minute" far better than a frozen screen can. Retrying is for a blip,
 * not for a limit the server has told us lasts a minute.
 *
 * Retried status codes: 408 (Request Timeout), 429 (Too Many Requests),
 * 500, 502, 503, 504 (server errors).
 *
 * Backoff schedule: 1s → 2s → 4s (3 attempts max, then propagates the error).
 * Respects `Retry-After` header from 429 responses (capped at 30s).
 *
 * Non-retryable errors (4xx client errors, network IOException) are propagated immediately.
 */
@Singleton
class RetryInterceptor @Inject constructor() : Interceptor {

    /**
     * The wait, in milliseconds. A seam so tests can assert the retry budget without
     * serving it on the wall clock.
     */
    @VisibleForTesting
    internal var sleep: (Long) -> Unit = { Thread.sleep(it) }

    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        var lastResponse: Response? = null
        var waitedMs = 0L

        for (attempt in 0 until MAX_RETRIES) {
            // Close previous response body to avoid resource leaks
            lastResponse?.close()

            try {
                val response = chain.proceed(request)

                if (!isRetryable(response.code) || attempt == MAX_RETRIES - 1) {
                    return response
                }

                val delayMs = retryDelay(response, attempt)
                if (waitedMs + delayMs > MAX_TOTAL_WAIT_MS) return response

                lastResponse = response
                waitedMs += delayMs
                sleep(delayMs)
            } catch (e: IOException) {
                if (attempt == MAX_RETRIES - 1) throw e

                val delayMs = BASE_DELAY_MS * (1L shl attempt)
                if (waitedMs + delayMs > MAX_TOTAL_WAIT_MS) throw e
                waitedMs += delayMs
                sleep(delayMs)
            }
        }

        // Should not reach here, but satisfy compiler
        return lastResponse ?: throw IOException("Retry exhausted with no response")
    }

    private fun isRetryable(code: Int): Boolean = code in RETRYABLE_CODES

    private fun retryDelay(response: Response, attempt: Int): Long {
        // Respect Retry-After header for 429 responses
        if (response.code == 429) {
            val retryAfter = response.header("Retry-After")?.toLongOrNull()
            if (retryAfter != null) {
                return (retryAfter * 1000).coerceAtMost(MAX_RETRY_AFTER_MS)
            }
        }

        return BASE_DELAY_MS * (1L shl attempt)
    }

    companion object {
        /** The most time the client will spend waiting across all retries of one call. */
        internal const val MAX_TOTAL_WAIT_MS = 5_000L

        private const val MAX_RETRIES = 3
        private const val BASE_DELAY_MS = 1000L
        private const val MAX_RETRY_AFTER_MS = 30_000L

        private val RETRYABLE_CODES = setOf(408, 429, 500, 502, 503, 504)
    }
}
