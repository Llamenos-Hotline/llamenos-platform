package org.llamenos.hotline.ui.settings

import androidx.biometric.BiometricManager
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.llamenos.hotline.api.WebSocketService
import org.llamenos.hotline.screenshots.ScreenshotTestApp
import org.llamenos.hotline.ui.auth.PIN_MAX_LENGTH
import org.llamenos.hotline.ui.theme.LlamenosTheme
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements

/**
 * BiometricManager stub: reports STRONG biometrics available so the
 * SettingsScreen biometric toggle (and its PIN-entry dialog) renders.
 * Shadows the androidx.biometric class (what the app actually calls).
 */
@Implements(androidx.biometric.BiometricManager::class)
class BiometricAvailableShadow : org.robolectric.shadow.api.Shadow() {
    @Implementation
    fun canAuthenticate(authenticators: Int): Int = BiometricManager.BIOMETRIC_SUCCESS
}

/**
 * Regression test for the biometric-enrollment PIN dialog (issue #1338,
 * third PINPad surface): the dialog must accept a full 8-digit PIN.
 *
 * Runs on the JVM via Robolectric — same harness as the screenshot tests.
 */
@RunWith(RobolectricTestRunner::class)
@Config(
    sdk = [34],
    application = ScreenshotTestApp::class,
    qualifiers = "w411dp-h891dp-xxhdpi",
    shadows = [BiometricAvailableShadow::class],
)
class SettingsBiometricPinDialogTest {

    @get:Rule
    val composeRule = createComposeRule()

    private fun setSettingsScreen(onBiometricEvent: (BiometricSectionEvent) -> Unit) {
        composeRule.setContent {
            LlamenosTheme {
                SettingsScreen(
                    signingPubkey = "npub1abc",
                    encryptionPubkey = "npub1def",
                    hubUrl = "https://llamenos.example.org",
                    connectionState = WebSocketService.ConnectionState.CONNECTED,
                    displayName = "Test Volunteer",
                    phone = "+1 555 000 0000",
                    selectedTheme = "dark",
                    onUpdateProfile = { _, _ -> },
                    onThemeChange = {},
                    selectedLanguage = "en",
                    onLanguageChange = {},
                    spokenLanguages = setOf("en"),
                    onSpokenLanguagesChange = {},
                    notifyCalls = true,
                    notifyShifts = true,
                    notifyGeneral = false,
                    onNotifyCallsChange = {},
                    onNotifyShiftsChange = {},
                    onNotifyGeneralChange = {},
                    onLock = {},
                    onLogout = {},
                    onPanicWipe = {},
                    transcriptionEnabled = true,
                    transcriptionCanOptOut = true,
                    onTranscriptionChange = {},
                    autoLockMinutes = 5,
                    onAutoLockChange = {},
                    debugLogging = false,
                    onDebugLoggingChange = {},
                    onClearCache = {},
                    onNavigateToAdmin = {},
                    onBiometricEvent = onBiometricEvent,
                )
            }
        }
    }

    @Test
    fun `biometric enrollment dialog accepts and submits a full 8 digit PIN`() {
        val events = mutableListOf<BiometricSectionEvent>()
        setSettingsScreen { events.add(it) }

        // Expand the Biometric Unlock section, then flip the enrollment toggle
        // on — that opens the "Enter your PIN" dialog.
        composeRule.onNodeWithTag("settings-biometric-section-header").performClick()
        // The toggle row renders below the viewport; invoke the switch's
        // OnClick semantics action directly instead of a coordinate click.
        composeRule.onNodeWithTag("biometric-toggle").performSemanticsAction(SemanticsActions.OnClick)

        composeRule.onNodeWithTag("biometric-pin-dialog").assertExists()

        // The dialog's PINPad must offer exactly PIN_MAX_LENGTH dots.
        val dotsNodes = composeRule
            .onAllNodesWithTag("pin-dots", useUnmergedTree = true)
            .fetchSemanticsNodes()
        assertEquals(1, dotsNodes.size)
        assertEquals(PIN_MAX_LENGTH, dotsNodes[0].children.size)

        // Enter a full 8-digit PIN — the eighth tap submits it.
        "12345678".forEach { digit ->
            composeRule.onNodeWithTag("pin-$digit").performClick()
        }

        assertEquals(
            listOf(BiometricSectionEvent.SubmitPin("12345678")),
            events.filterIsInstance<BiometricSectionEvent.SubmitPin>(),
        )
    }
}
