package org.llamenos.hotline.ui.calls

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import android.app.Application
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.llamenos.hotline.telephony.RingingCallInfo
import org.llamenos.hotline.ui.theme.LlamenosTheme
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * JVM-side UI test for the incoming-call screen (Robolectric + Compose test rule, no
 * emulator). Selectors are test-tag only, following the PIN-pad pattern.
 */
/** Stub application: the real LlamenosApp initializes liblinphone, which needs native
 * libraries that don't exist on the JVM. */
private class IncomingCallScreenTestApp : Application()

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = IncomingCallScreenTestApp::class)
class IncomingCallScreenTest {

    @get:Rule
    val composeRule = createComposeRule()

    private val info = RingingCallInfo(
        callId = "call-1",
        remoteAddress = "sip:+15551234567@example.org",
        remoteDisplayName = "+1 555 123 4567",
        hubId = "hub-1",
    )

    private fun render(info: RingingCallInfo, isUnlocked: Boolean, onAccept: () -> Unit = {}, onDecline: () -> Unit = {}) {
        composeRule.setContent {
            LlamenosTheme {
                IncomingCallScreen(
                    info = info,
                    isUnlocked = isUnlocked,
                    onAccept = onAccept,
                    onDecline = onDecline,
                )
            }
        }
    }

    @Test
    fun `shows the caller identity and both actions when unlocked`() {
        render(info, isUnlocked = true)

        composeRule.onNodeWithTag("incoming-caller-label")
            .assertIsDisplayed()
            .assertTextEquals("+1 555 123 4567")
        composeRule.onNodeWithTag("incoming-accept").assertIsDisplayed()
        composeRule.onNodeWithTag("incoming-decline").assertIsDisplayed()
    }

    @Test
    fun `falls back to the address when the caller has no display name`() {
        render(info.copy(remoteDisplayName = null), isUnlocked = true)

        composeRule.onNodeWithTag("incoming-caller-label")
            .assertTextEquals("sip:+15551234567@example.org")
    }

    @Test
    fun `hides the caller identity while the app is locked`() {
        render(info, isUnlocked = false)

        // Generic label, not the caller's number — same PII posture as the notification.
        composeRule.onNodeWithTag("incoming-caller-label")
            .assertTextEquals("Someone is calling the hotline")
    }

    @Test
    fun `tapping answer invokes the accept action`() {
        var accepted = false
        var declined = false
        render(info, isUnlocked = true, onAccept = { accepted = true }, onDecline = { declined = true })

        composeRule.onNodeWithTag("incoming-accept").performClick()

        assert(accepted) { "accept callback must fire" }
        assert(!declined) { "decline callback must not fire" }
    }

    @Test
    fun `tapping decline invokes the decline action`() {
        var accepted = false
        var declined = false
        render(info, isUnlocked = true, onAccept = { accepted = true }, onDecline = { declined = true })

        composeRule.onNodeWithTag("incoming-decline").performClick()

        assert(declined) { "decline callback must fire" }
        assert(!accepted) { "accept callback must not fire" }
    }
}
