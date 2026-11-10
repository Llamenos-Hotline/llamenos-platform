package org.llamenos.hotline.ui.auth

import android.app.Application
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * #2120: `parseInvite` runs on every keystroke of the invite field, so it must never
 * throw. A half-typed link (`http:`, `abc:`, `tel:123`) is an *opaque* URI, and
 * `Uri.getQueryParameter` throws `UnsupportedOperationException` on one — that crash
 * killed the app mid-typing on the login screen.
 *
 * Uses Robolectric for the real [android.net.Uri] implementation.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class)
class InviteViewModelParseTest {

    private val code = "3f6f8f2c-9f3e-4a2b-b1c1-2d4e6f8091a2"
    private val link = "https://hub.example.org/enroll?code=$code"

    @Test
    fun `every prefix of a valid invite link parses without throwing`() {
        for (i in 1..link.length) {
            InviteViewModel.parseInvite(link.substring(0, i))
        }
    }

    @Test
    fun `opaque URIs parse to null without throwing`() {
        for (input in listOf("abc:", "tel:123", "mailto:x", "http:", "https:")) {
            assertNull(InviteViewModel.parseInvite(input), "expected null for $input")
        }
    }

    @Test
    fun `bare invite code parses with no hub`() {
        assertEquals(
            InviteViewModel.ParsedInvite(code, hubUrl = null),
            InviteViewModel.parseInvite(code),
        )
    }

    @Test
    fun `full invite link parses with hub url`() {
        assertEquals(
            InviteViewModel.ParsedInvite(code, hubUrl = "https://hub.example.org"),
            InviteViewModel.parseInvite(link),
        )
    }

    @Test
    fun `hierarchical link without a code parses to null`() {
        assertNull(InviteViewModel.parseInvite("https://hub.example.org/enroll"))
    }

    @Test
    fun `blank input parses to null`() {
        assertNull(InviteViewModel.parseInvite(""))
        assertNull(InviteViewModel.parseInvite("   "))
    }
}
