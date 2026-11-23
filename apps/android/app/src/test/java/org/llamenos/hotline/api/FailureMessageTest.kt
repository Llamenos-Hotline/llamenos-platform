package org.llamenos.hotline.api

import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.IOException

/** What a user is told when a request fails (#2121): status and reason, never a class name. */
class FailureMessageTest {

    @Test
    fun `an API error carries the status and the server's reason`() {
        assertEquals(
            "HTTP 403: Missing permission: calls:read-history",
            ApiException(403, """{"error":"Missing permission: calls:read-history"}""").failureMessage("x"),
        )
    }

    @Test
    fun `a message field is used when there is no error field`() {
        assertEquals("HTTP 502: Provider hang-up failed", ApiException(502, """{"message":"Provider hang-up failed"}""").failureMessage("x"))
    }

    @Test
    fun `a non-JSON body is the reason as sent`() {
        assertEquals("HTTP 500: Internal Server Error", ApiException(500, "Internal Server Error").failureMessage("x"))
    }

    @Test
    fun `an empty body still says the status`() {
        assertEquals("HTTP 403", ApiException(403, "").failureMessage("x"))
    }

    @Test
    fun `a transport failure keeps its own message and the fallback is last`() {
        assertEquals("Unable to resolve host", IOException("Unable to resolve host").failureMessage("x"))
        assertEquals("fallback", IllegalStateException().failureMessage("fallback"))
    }
}
