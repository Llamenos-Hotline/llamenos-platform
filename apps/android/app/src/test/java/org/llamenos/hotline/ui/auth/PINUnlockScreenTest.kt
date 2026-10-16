package org.llamenos.hotline.ui.auth

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.llamenos.hotline.screenshots.ScreenshotTestApp
import org.llamenos.hotline.ui.theme.LlamenosTheme
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Regression tests for the PIN unlock screen (issues #1338, #1339).
 *
 * Runs on the JVM via Robolectric — the same harness the screenshot tests use.
 * Uses [ScreenshotTestApp] so LlamenosApp (Hilt + Linphone native lib) never
 * initializes.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = ScreenshotTestApp::class, qualifiers = "w411dp-h891dp-xxhdpi")
class PINUnlockScreenTest {

    @get:Rule
    val composeRule = createComposeRule()

    private fun setUnlockScreen(viewModel: AuthViewModel) {
        // The pad is revealed by an AnimatedVisibility with entrance delays —
        // let the test clock run so it actually appears.
        composeRule.mainClock.autoAdvance = true
        composeRule.setContent {
            LlamenosTheme {
                PINUnlockScreen(
                    viewModel = viewModel,
                    onAuthenticated = {},
                    onResetIdentity = {},
                )
            }
        }
        // Entrance animation: pad is revealed via AnimatedVisibility + delays.
        composeRule.mainClock.advanceTimeBy(1_000)
        composeRule.waitForIdle()
    }

    /**
     * #1338: the unlock pad must accept a full 8-digit PIN. The eighth digit
     * tap completes the entry and submits it to the view model; with a
     * shorter maxLength the final tap is swallowed and unlockWithPin is
     * never called with the full PIN.
     */
    @Test
    fun `unlock pad accepts and submits a full 8 digit PIN`() {
        val viewModel = mockk<AuthViewModel>(relaxed = true)
        every { viewModel.uiState } returns MutableStateFlow(AuthUiState())

        setUnlockScreen(viewModel)

        "12345678".forEach { digit ->
            composeRule.onNodeWithTag("pin-$digit").performClick()
        }

        verify { viewModel.unlockWithPin("12345678") }
    }

    /**
     * #1338: the dot row must offer exactly PIN_MAX_LENGTH slots — a pad
     * wired with a shorter maxLength renders fewer dots and caps entry.
     */
    @Test
    fun `unlock pad offers 8 PIN dots`() {
        val viewModel = mockk<AuthViewModel>(relaxed = true)
        every { viewModel.uiState } returns MutableStateFlow(AuthUiState())

        setUnlockScreen(viewModel)

        val dotsNodes = composeRule
            .onAllNodesWithTag("pin-dots", useUnmergedTree = true)
            .fetchSemanticsNodes()
        assertEquals(1, dotsNodes.size)
        assertEquals(PIN_MAX_LENGTH, dotsNodes[0].children.size)
    }
}
