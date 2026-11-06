package org.llamenos.hotline.ui.settings

import androidx.compose.runtime.Composable
import org.llamenos.hotline.api.WebSocketService
import org.llamenos.hotline.ui.auth.DestructionConfirmed
import org.llamenos.hotline.ui.theme.LlamenosTheme

/** [SettingsScreen] with inert callbacks, for Robolectric tests that exercise one control. */
@Composable
fun TestSettingsScreen(
    onLogout: (DestructionConfirmed) -> Unit = {},
    onPanicWipe: (DestructionConfirmed) -> Unit = {},
    onBiometricEvent: (BiometricSectionEvent) -> Unit = {},
) {
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
            onLogout = onLogout,
            onPanicWipe = onPanicWipe,
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
