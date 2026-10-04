package org.llamenos.hotline.ui.settings

import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ExitToApp
import androidx.compose.material.icons.filled.AdminPanelSettings
import androidx.compose.material.icons.filled.Circle
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.DarkMode
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Fingerprint
import androidx.compose.material.icons.filled.Language
import androidx.compose.material.icons.filled.Translate
import androidx.compose.material.icons.filled.LightMode
import androidx.compose.material.icons.filled.Key
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.PersonRemove
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material.icons.filled.NavigateNext
import androidx.compose.material.icons.filled.PhoneAndroid
import androidx.compose.material.icons.filled.Wifi
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.Switch
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import javax.crypto.Cipher
import kotlinx.coroutines.launch
import org.llamenos.hotline.BuildConfig
import org.llamenos.hotline.R
import org.llamenos.hotline.api.WebSocketService
import org.llamenos.hotline.ui.components.PINPad

/**
 * Supported language with ISO code and native label.
 * Matches packages/i18n/languages.ts.
 */
data class SupportedLanguage(
    val code: String,
    val label: String,
    val flag: String,
)

/**
 * All supported languages matching packages/i18n/languages.ts.
 *
 * NOTE: This list previously only had 12 of the 22 locales that actually
 * ship complete translations under packages/i18n/locales/ — including
 * missing 'de', which was also missing from languages.ts itself. That meant
 * the Android app's language picker silently made 10 fully-translated
 * locales unreachable in the UI: de, am, fa, ku, mix, my, quc, so, tr, uk.
 * Keep this list in sync with packages/i18n/languages.ts; bun run
 * i18n:validate fails if the two drift apart.
 */
val SUPPORTED_LANGUAGES = listOf(
    SupportedLanguage("en", "English", "EN"),
    SupportedLanguage("es", "Español", "ES"),
    SupportedLanguage("zh", "中文", "中"),
    SupportedLanguage("tl", "Tagalog", "TL"),
    SupportedLanguage("vi", "Tiếng Việt", "VI"),
    SupportedLanguage("ar", "العربية", "ع"),
    SupportedLanguage("fr", "Français", "FR"),
    SupportedLanguage("ht", "Kreyòl Ayisyen", "HT"),
    SupportedLanguage("ko", "한국어", "한"),
    SupportedLanguage("ru", "Русский", "RU"),
    SupportedLanguage("hi", "हिन्दी", "हि"),
    SupportedLanguage("pt", "Português", "PT"),
    SupportedLanguage("de", "Deutsch", "DE"),
    SupportedLanguage("uk", "Українська", "УК"),
    SupportedLanguage("fa", "فارسی", "فا"),
    SupportedLanguage("tr", "Türkçe", "TR"),
    SupportedLanguage("ku", "Kurdî", "KU"),
    SupportedLanguage("so", "Soomaali", "SO"),
    SupportedLanguage("am", "አማርኛ", "አማ"),
    SupportedLanguage("my", "မြန်မာ", "MY"),
    SupportedLanguage("quc", "K'iche'", "KI"),
    SupportedLanguage("mix", "Tu'un savi", "MX"),
)

/**
 * Auto-lock timeout options (in minutes, 0 = never).
 */
private enum class AutoLockOption(val minutes: Int, val labelRes: Int) {
    ONE(1, R.string.settings_lock1min),
    FIVE(5, R.string.settings_lock5min),
    FIFTEEN(15, R.string.settings_lock15min),
    THIRTY(30, R.string.settings_lock30min),
    NEVER(0, R.string.settings_auto_lock_never),
}

/**
 * Settings screen with collapsible sections for profile, identity, theme, and more.
 *
 * Organized into default/operational settings visible to all users,
 * with an Advanced Settings section for technical configuration.
 */
@Composable
fun SettingsScreen(
    signingPubkey: String,
    encryptionPubkey: String,
    hubUrl: String,
    connectionState: WebSocketService.ConnectionState,
    displayName: String,
    phone: String,
    selectedTheme: String,
    onUpdateProfile: (name: String, phone: String) -> Unit,
    onThemeChange: (String) -> Unit,
    selectedLanguage: String,
    onLanguageChange: (String) -> Unit,
    spokenLanguages: Set<String>,
    onSpokenLanguagesChange: (Set<String>) -> Unit,
    notifyCalls: Boolean,
    notifyShifts: Boolean,
    notifyGeneral: Boolean,
    onNotifyCallsChange: (Boolean) -> Unit,
    onNotifyShiftsChange: (Boolean) -> Unit,
    onNotifyGeneralChange: (Boolean) -> Unit,
    onLock: () -> Unit,
    onLogout: () -> Unit,
    onPanicWipe: () -> Unit,
    transcriptionEnabled: Boolean,
    transcriptionCanOptOut: Boolean,
    onTranscriptionChange: (Boolean) -> Unit,
    autoLockMinutes: Int,
    onAutoLockChange: (Int) -> Unit,
    debugLogging: Boolean,
    onDebugLoggingChange: (Boolean) -> Unit,
    onClearCache: () -> Unit,
    onNavigateToCommunications: () -> Unit = {},
    onNavigateToAdmin: () -> Unit,
    onNavigateToErasure: () -> Unit = {},
    crashReportingEnabled: Boolean = false,
    onCrashReportingChange: (Boolean) -> Unit = {},
    pendingCrashReports: Int = 0,
    onSendCrashReports: () -> Unit = {},
    onClearCrashReports: () -> Unit = {},
    biometricState: BiometricSectionState = BiometricSectionState(),
    onBiometricEvent: (BiometricSectionEvent) -> Unit = {},
    modifier: Modifier = Modifier,
) {
    var showLogoutDialog by remember { mutableStateOf(false) }
    var showPanicWipeDialog by remember { mutableStateOf(false) }
    val clipboardManager = LocalClipboardManager.current
    val snackbarHostState = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val copiedMessage = stringResource(R.string.settings_npub_copied) // reuse existing string resource
    val profileUpdatedMessage = stringResource(R.string.profile_updated)

    // Profile form state
    var editDisplayName by rememberSaveable { mutableStateOf(displayName) }
    var editPhone by rememberSaveable { mutableStateOf(phone) }

    // Section expansion state
    var profileExpanded by rememberSaveable { mutableStateOf(true) }
    var identityExpanded by rememberSaveable { mutableStateOf(false) }
    var themeExpanded by rememberSaveable { mutableStateOf(false) }
    var languageExpanded by rememberSaveable { mutableStateOf(false) }
    var keyBackupExpanded by rememberSaveable { mutableStateOf(false) }
    var notificationsExpanded by rememberSaveable { mutableStateOf(false) }
    var hubExpanded by rememberSaveable { mutableStateOf(false) }
    var transcriptionExpanded by rememberSaveable { mutableStateOf(false) }
    var advancedExpanded by rememberSaveable { mutableStateOf(false) }
    var biometricExpanded by rememberSaveable { mutableStateOf(false) }
    var showClearCacheDialog by remember { mutableStateOf(false) }

    // ---- Biometric unlock enrollment state ----
    var showBiometricPinDialog by remember { mutableStateOf(false) }
    var showBiometricDisableDialog by remember { mutableStateOf(false) }
    var biometricPinInput by remember { mutableStateOf("") }
    val biometricContext = LocalContext.current
    val biometricHardwareAvailable = remember {
        BiometricManager.from(biometricContext)
            .canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG) ==
            BiometricManager.BIOMETRIC_SUCCESS
    }
    val biometricEnrollPromptTitle = stringResource(R.string.settings_biometric)
    val cancelLabel = stringResource(android.R.string.cancel)

    // Once the ViewModel hands us a fresh enrollment cipher (PIN verified),
    // drive the BiometricPrompt enrollment auth. Success/failure both close
    // the PIN dialog — the PIN itself is never affected either way.
    LaunchedEffect(biometricState.enrollCipher) {
        val cipher = biometricState.enrollCipher ?: return@LaunchedEffect
        val activity = biometricContext as? FragmentActivity ?: return@LaunchedEffect
        val executor = ContextCompat.getMainExecutor(biometricContext)
        val prompt = BiometricPrompt(
            activity,
            executor,
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    val resultCipher = result.cryptoObject?.cipher ?: return
                    showBiometricPinDialog = false
                    biometricPinInput = ""
                    onBiometricEvent(BiometricSectionEvent.EnrollSucceeded(resultCipher))
                }

                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    // User cancelled or hardware unavailable — abandon this
                    // enrollment attempt. The PIN pad / PIN unlock elsewhere
                    // in the app is completely unaffected.
                    showBiometricPinDialog = false
                    biometricPinInput = ""
                    onBiometricEvent(BiometricSectionEvent.EnrollCancelled)
                }

                override fun onAuthenticationFailed() {
                    // Single failed match attempt — system shows retry UI, keep waiting.
                }
            },
        )
        val promptInfo = BiometricPrompt.PromptInfo.Builder()
            .setTitle(biometricEnrollPromptTitle)
            .setNegativeButtonText(cancelLabel)
            .build()
        prompt.authenticate(promptInfo, BiometricPrompt.CryptoObject(cipher))
    }

    if (showLogoutDialog) {
        AlertDialog(
            onDismissRequest = { showLogoutDialog = false },
            title = { Text(stringResource(R.string.common_logout)) },
            text = {
                Text(stringResource(R.string.settings_logout_confirm_message))
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        showLogoutDialog = false
                        onLogout()
                    },
                    modifier = Modifier.testTag("confirm-logout-button"),
                ) {
                    Text(
                        text = stringResource(R.string.common_logout),
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            },
            dismissButton = {
                TextButton(
                    onClick = { showLogoutDialog = false },
                    modifier = Modifier.testTag("cancel-logout-button"),
                ) {
                    Text(stringResource(android.R.string.cancel))
                }
            },
            modifier = Modifier.testTag("logout-confirmation-dialog"),
        )
    }

    if (showPanicWipeDialog) {
        AlertDialog(
            onDismissRequest = { showPanicWipeDialog = false },
            icon = {
                Icon(
                    imageVector = Icons.Filled.Warning,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.error,
                    modifier = Modifier.size(32.dp),
                )
            },
            title = { Text(stringResource(R.string.panic_wipe_title)) },
            text = {
                Text(stringResource(R.string.panic_wipe_message))
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        showPanicWipeDialog = false
                        onPanicWipe()
                    },
                    modifier = Modifier.testTag("confirm-panic-wipe-button"),
                ) {
                    Text(
                        text = stringResource(R.string.panic_wipe_title),
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            },
            dismissButton = {
                TextButton(
                    onClick = { showPanicWipeDialog = false },
                    modifier = Modifier.testTag("cancel-panic-wipe-button"),
                ) {
                    Text(stringResource(android.R.string.cancel))
                }
            },
            modifier = Modifier.testTag("panic-wipe-dialog"),
        )
    }

    val cacheMessage = stringResource(R.string.settings_cache_cleared)

    if (showClearCacheDialog) {
        AlertDialog(
            onDismissRequest = { showClearCacheDialog = false },
            title = { Text(stringResource(R.string.settings_clear_cache)) },
            text = { Text(stringResource(R.string.settings_clear_cache_confirm)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        showClearCacheDialog = false
                        onClearCache()
                        scope.launch {
                            snackbarHostState.showSnackbar(cacheMessage)
                        }
                    },
                    modifier = Modifier.testTag("confirm-clear-cache-button"),
                ) {
                    Text(
                        text = stringResource(R.string.settings_clear_cache),
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            },
            dismissButton = {
                TextButton(
                    onClick = { showClearCacheDialog = false },
                    modifier = Modifier.testTag("cancel-clear-cache-button"),
                ) {
                    Text(stringResource(android.R.string.cancel))
                }
            },
            modifier = Modifier.testTag("clear-cache-dialog"),
        )
    }

    // Enrollment step 1: PIN entry. Verifying the PIN (step 2, driven by the
    // ViewModel) gates the biometric prompt that follows in the LaunchedEffect above.
    if (showBiometricPinDialog) {
        AlertDialog(
            onDismissRequest = {
                showBiometricPinDialog = false
                biometricPinInput = ""
                onBiometricEvent(BiometricSectionEvent.DismissPinDialog)
            },
            title = { Text(stringResource(R.string.settings_biometric_pin_prompt)) },
            text = {
                PINPad(
                    pin = biometricPinInput,
                    maxLength = 6,
                    onPinChange = { biometricPinInput = it },
                    onComplete = { completedPin -> onBiometricEvent(BiometricSectionEvent.SubmitPin(completedPin)) },
                    errorMessage = when (biometricState.pinError) {
                        BiometricSettingsViewModel.PIN_ERROR_INCORRECT -> stringResource(R.string.error_pin_incorrect)
                        BiometricSettingsViewModel.PIN_ERROR_NO_IDENTITY -> stringResource(R.string.error_no_stored_keys)
                        else -> null
                    },
                    enabled = !biometricState.verifyingPin,
                )
            },
            confirmButton = {},
            dismissButton = {
                TextButton(
                    onClick = {
                        showBiometricPinDialog = false
                        biometricPinInput = ""
                        onBiometricEvent(BiometricSectionEvent.DismissPinDialog)
                    },
                    modifier = Modifier.testTag("cancel-biometric-pin-button"),
                ) {
                    Text(cancelLabel)
                }
            },
            modifier = Modifier.testTag("biometric-pin-dialog"),
        )
    }

    if (showBiometricDisableDialog) {
        AlertDialog(
            onDismissRequest = { showBiometricDisableDialog = false },
            title = { Text(stringResource(R.string.confirm_biometric_disable_title)) },
            text = { Text(stringResource(R.string.confirm_biometric_disable)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        showBiometricDisableDialog = false
                        onBiometricEvent(BiometricSectionEvent.Disable)
                    },
                    modifier = Modifier.testTag("confirm-biometric-disable-button"),
                ) {
                    Text(
                        text = stringResource(R.string.confirm_biometric_disable_title),
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            },
            dismissButton = {
                TextButton(
                    onClick = { showBiometricDisableDialog = false },
                    modifier = Modifier.testTag("cancel-biometric-disable-button"),
                ) {
                    Text(cancelLabel)
                }
            },
            modifier = Modifier.testTag("biometric-disable-dialog"),
        )
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHostState) },
        modifier = modifier,
    ) { paddingValues ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            // ---- Profile section (collapsible) ----
            SettingsSection(
                title = stringResource(R.string.settings_profile),
                expanded = profileExpanded,
                onToggle = { profileExpanded = !profileExpanded },
                testTag = "settings-profile-section",
            ) {
                OutlinedTextField(
                    value = editDisplayName,
                    onValueChange = { editDisplayName = it },
                    label = { Text(stringResource(R.string.settings_display_name)) },
                    singleLine = true,
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("settings-display-name-input"),
                )

                Spacer(Modifier.height(8.dp))

                OutlinedTextField(
                    value = editPhone,
                    onValueChange = { editPhone = it },
                    label = { Text(stringResource(R.string.settings_phone)) },
                    singleLine = true,
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("settings-phone-input"),
                )

                Spacer(Modifier.height(8.dp))

                // Signing key display
                Text(
                    text = stringResource(R.string.settings_identity),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = signingPubkey,
                        style = MaterialTheme.typography.bodySmall.copy(
                            fontFamily = FontFamily.Monospace,
                        ),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier
                            .weight(1f)
                            .testTag("settings-signing-pubkey"),
                    )
                    IconButton(
                        onClick = {
                            clipboardManager.setText(AnnotatedString(signingPubkey))
                            scope.launch {
                                snackbarHostState.showSnackbar(copiedMessage)
                            }
                        },
                        modifier = Modifier.testTag("copy-signing-pubkey-button"),
                    ) {
                        Icon(
                            imageVector = Icons.Filled.ContentCopy,
                            contentDescription = stringResource(R.string.settings_copy_npub),
                            modifier = Modifier.size(20.dp),
                        )
                    }
                }

                Spacer(Modifier.height(8.dp))

                Button(
                    onClick = {
                        onUpdateProfile(editDisplayName, editPhone)
                        scope.launch {
                            snackbarHostState.showSnackbar(profileUpdatedMessage)
                        }
                    },
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("settings-update-profile-button"),
                ) {
                    Text(stringResource(R.string.profile_update))
                }

                Spacer(Modifier.height(12.dp))
                HorizontalDivider()
                Spacer(Modifier.height(12.dp))

                // Spoken languages
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        imageVector = Icons.Filled.Translate,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.size(20.dp),
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(
                        text = stringResource(R.string.settings_spoken_languages),
                        style = MaterialTheme.typography.titleSmall,
                    )
                }
                Text(
                    text = stringResource(R.string.settings_spoken_languages_desc),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(8.dp))

                @OptIn(ExperimentalLayoutApi::class)
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("spoken-languages-chips"),
                ) {
                    SUPPORTED_LANGUAGES.forEach { lang ->
                        val isSelected = lang.code in spokenLanguages
                        FilterChip(
                            selected = isSelected,
                            onClick = {
                                val updated = if (isSelected) {
                                    spokenLanguages - lang.code
                                } else {
                                    spokenLanguages + lang.code
                                }
                                onSpokenLanguagesChange(updated)
                            },
                            label = {
                                Text(
                                    text = "${lang.flag} ${lang.label}",
                                    style = MaterialTheme.typography.labelSmall,
                                )
                            },
                            leadingIcon = if (isSelected) {
                                {
                                    Icon(
                                        imageVector = Icons.Filled.Check,
                                        contentDescription = null,
                                        modifier = Modifier.size(FilterChipDefaults.IconSize),
                                    )
                                }
                            } else {
                                null
                            },
                            modifier = Modifier.testTag("spoken-lang-${lang.code}"),
                        )
                    }
                }

                if (spokenLanguages.isEmpty()) {
                    Text(
                        text = stringResource(R.string.settings_spoken_languages_none),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                        modifier = Modifier.testTag("spoken-languages-empty"),
                    )
                }
            }

            // ---- Theme section (collapsible) ----
            SettingsSection(
                title = stringResource(R.string.settings_theme),
                expanded = themeExpanded,
                onToggle = { themeExpanded = !themeExpanded },
                testTag = "settings-theme-section",
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    ThemeButton(
                        label = stringResource(R.string.settings_theme_light),
                        icon = Icons.Filled.LightMode,
                        selected = selectedTheme == "light",
                        onClick = { onThemeChange("light") },
                        testTag = "theme-light-button",
                        modifier = Modifier.weight(1f),
                    )
                    ThemeButton(
                        label = stringResource(R.string.settings_theme_dark),
                        icon = Icons.Filled.DarkMode,
                        selected = selectedTheme == "dark",
                        onClick = { onThemeChange("dark") },
                        testTag = "theme-dark-button",
                        modifier = Modifier.weight(1f),
                    )
                    ThemeButton(
                        label = stringResource(R.string.settings_theme_system),
                        icon = Icons.Filled.PhoneAndroid,
                        selected = selectedTheme == "system",
                        onClick = { onThemeChange("system") },
                        testTag = "theme-system-button",
                        modifier = Modifier.weight(1f),
                    )
                }
            }

            // ---- Language section (collapsible) ----
            SettingsSection(
                title = stringResource(R.string.settings_language),
                expanded = languageExpanded,
                onToggle = { languageExpanded = !languageExpanded },
                testTag = "settings-language-section",
            ) {
                Text(
                    text = stringResource(R.string.settings_language_desc),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                Spacer(Modifier.height(8.dp))

                @OptIn(ExperimentalLayoutApi::class)
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("language-options"),
                ) {
                    SUPPORTED_LANGUAGES.forEach { lang ->
                        val isSelected = lang.code == selectedLanguage
                        FilterChip(
                            selected = isSelected,
                            onClick = { onLanguageChange(lang.code) },
                            label = {
                                Text(
                                    text = "${lang.flag} ${lang.label}",
                                    style = MaterialTheme.typography.labelSmall,
                                )
                            },
                            leadingIcon = if (isSelected) {
                                {
                                    Icon(
                                        imageVector = Icons.Filled.Check,
                                        contentDescription = null,
                                        modifier = Modifier.size(FilterChipDefaults.IconSize),
                                    )
                                }
                            } else {
                                null
                            },
                            modifier = Modifier.testTag("lang-${lang.code}"),
                        )
                    }
                }
            }

            // ---- Key Backup section (collapsible) ----
            SettingsSection(
                title = stringResource(R.string.settings_key_backup),
                expanded = keyBackupExpanded,
                onToggle = { keyBackupExpanded = !keyBackupExpanded },
                testTag = "settings-key-backup-section",
            ) {
                Text(
                    text = stringResource(R.string.settings_key_backup_desc),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                Spacer(Modifier.height(8.dp))

                Card(
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.3f),
                    ),
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("key-backup-warning"),
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(
                            imageVector = Icons.Filled.Key,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.error,
                            modifier = Modifier.size(20.dp),
                        )
                        Spacer(Modifier.width(8.dp))
                        Text(
                            text = stringResource(R.string.settings_key_backup_warning),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onErrorContainer,
                        )
                    }
                }
            }

            // ---- Biometric unlock section (collapsible) ----
            SettingsSection(
                title = stringResource(R.string.settings_biometric),
                expanded = biometricExpanded,
                onToggle = { biometricExpanded = !biometricExpanded },
                testTag = "settings-biometric-section",
            ) {
                Text(
                    text = stringResource(R.string.settings_biometric_desc),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                Spacer(Modifier.height(8.dp))

                if (biometricState.statusMessage == BiometricSettingsViewModel.INVALIDATED_MESSAGE) {
                    Card(
                        colors = CardDefaults.cardColors(
                            containerColor = MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.3f),
                        ),
                        modifier = Modifier
                            .fillMaxWidth()
                            .testTag("biometric-invalidated-notice"),
                    ) {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(
                                imageVector = Icons.Filled.Warning,
                                contentDescription = null,
                                tint = MaterialTheme.colorScheme.error,
                                modifier = Modifier.size(20.dp),
                            )
                            Spacer(Modifier.width(8.dp))
                            Text(
                                text = stringResource(R.string.settings_biometric_invalidated),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onErrorContainer,
                            )
                        }
                    }
                    Spacer(Modifier.height(8.dp))
                }

                if (!biometricHardwareAvailable && !biometricState.enrolled) {
                    Text(
                        text = stringResource(R.string.error_biometric_not_available),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.testTag("biometric-unavailable"),
                    )
                } else {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .testTag("biometric-toggle-row"),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween,
                    ) {
                        Column(modifier = Modifier.weight(1f)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Icon(
                                    imageVector = Icons.Filled.Fingerprint,
                                    contentDescription = null,
                                    tint = MaterialTheme.colorScheme.primary,
                                    modifier = Modifier.size(18.dp),
                                )
                                Spacer(Modifier.width(8.dp))
                                Text(
                                    text = stringResource(R.string.settings_biometric),
                                    style = MaterialTheme.typography.bodyMedium,
                                )
                            }
                            if (biometricState.enrolled) {
                                Text(
                                    text = stringResource(R.string.settings_biometric_enrolled),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                        Switch(
                            checked = biometricState.enrolled,
                            onCheckedChange = { checked ->
                                if (checked) {
                                    biometricPinInput = ""
                                    showBiometricPinDialog = true
                                } else {
                                    showBiometricDisableDialog = true
                                }
                            },
                            enabled = !biometricState.verifyingPin,
                            modifier = Modifier.testTag("biometric-toggle"),
                        )
                    }
                }
            }

            // ---- Notifications section (collapsible) ----
            SettingsSection(
                title = stringResource(R.string.settings_notifications),
                expanded = notificationsExpanded,
                onToggle = { notificationsExpanded = !notificationsExpanded },
                testTag = "settings-notifications-section",
            ) {
                Text(
                    text = stringResource(R.string.settings_notifications_desc),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                Spacer(Modifier.height(8.dp))

                NotificationToggle(
                    label = stringResource(R.string.settings_notify_calls),
                    checked = notifyCalls,
                    onCheckedChange = onNotifyCallsChange,
                    testTag = "notify-calls-toggle",
                )
                NotificationToggle(
                    label = stringResource(R.string.settings_notify_shifts),
                    checked = notifyShifts,
                    onCheckedChange = onNotifyShiftsChange,
                    testTag = "notify-shifts-toggle",
                )
                NotificationToggle(
                    label = stringResource(R.string.settings_notify_general),
                    checked = notifyGeneral,
                    onCheckedChange = onNotifyGeneralChange,
                    testTag = "notify-general-toggle",
                )
            }

            // ---- Transcription section (collapsible) ----
            SettingsSection(
                title = stringResource(R.string.settings_transcription),
                expanded = transcriptionExpanded,
                onToggle = { transcriptionExpanded = !transcriptionExpanded },
                testTag = "settings-transcription-section",
            ) {
                Text(
                    text = stringResource(R.string.settings_transcription_desc),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                Spacer(Modifier.height(8.dp))

                if (transcriptionCanOptOut) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .testTag("settings-transcription-toggle"),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween,
                    ) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                text = stringResource(R.string.settings_transcription_enable),
                                style = MaterialTheme.typography.bodyMedium,
                            )
                            Text(
                                text = stringResource(R.string.settings_transcription_enable_desc),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        Switch(
                            checked = transcriptionEnabled,
                            onCheckedChange = onTranscriptionChange,
                        )
                    }
                } else {
                    Text(
                        text = stringResource(R.string.settings_transcription_managed),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.testTag("settings-transcription-managed"),
                    )
                }
            }

            // ---- Identity / Hub section (collapsible) ----
            SettingsSection(
                title = stringResource(R.string.settings_hub),
                expanded = hubExpanded,
                onToggle = { hubExpanded = !hubExpanded },
                testTag = "settings-hub-section",
            ) {
                Card(
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("settings-hub-card"),
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.surfaceVariant,
                    ),
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(16.dp),
                    ) {
                        if (hubUrl.isNotEmpty()) {
                            Text(
                                text = hubUrl,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.testTag("settings-hub-url"),
                            )
                            Spacer(Modifier.height(8.dp))
                        }

                        Row(verticalAlignment = Alignment.CenterVertically) {
                            val (statusColor, statusText) = when (connectionState) {
                                WebSocketService.ConnectionState.CONNECTED ->
                                    MaterialTheme.colorScheme.primary to stringResource(R.string.status_connected)
                                WebSocketService.ConnectionState.CONNECTING ->
                                    MaterialTheme.colorScheme.tertiary to stringResource(R.string.status_connecting)
                                WebSocketService.ConnectionState.RECONNECTING ->
                                    MaterialTheme.colorScheme.tertiary to stringResource(R.string.status_reconnecting)
                                WebSocketService.ConnectionState.DISCONNECTED ->
                                    MaterialTheme.colorScheme.error to stringResource(R.string.status_disconnected)
                            }

                            Icon(
                                imageVector = Icons.Filled.Circle,
                                contentDescription = null,
                                tint = statusColor,
                                modifier = Modifier.size(10.dp),
                            )
                            Spacer(Modifier.width(6.dp))
                            Text(
                                text = statusText,
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.testTag("settings-connection-status"),
                            )
                        }
                    }
                }
            }

            // ---- Identity card ----
            Card(
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag("settings-identity-card"),
                colors = CardDefaults.cardColors(
                    containerColor = MaterialTheme.colorScheme.surfaceVariant,
                ),
            ) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(16.dp),
                ) {
                    Text(
                        text = stringResource(R.string.settings_identity),
                        style = MaterialTheme.typography.titleMedium,
                    )
                    Spacer(Modifier.height(4.dp))
                    Text(
                        text = signingPubkey,
                        style = MaterialTheme.typography.bodySmall.copy(
                            fontFamily = FontFamily.Monospace,
                        ),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.testTag("settings-identity-signing"),
                    )
                }
            }

            // ---- Navigation cards ----

            Card(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable(onClick = onNavigateToErasure)
                    .testTag("settings-erasure-card"),
                colors = CardDefaults.cardColors(
                    containerColor = MaterialTheme.colorScheme.surfaceVariant,
                ),
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(16.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        imageVector = Icons.Filled.PersonRemove,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.error,
                        modifier = Modifier.size(24.dp),
                    )
                    Spacer(Modifier.width(12.dp))
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = stringResource(R.string.erasure_request_title),
                            style = MaterialTheme.typography.titleSmall,
                        )
                        Text(
                            text = stringResource(R.string.erasure_request_description),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Icon(
                        imageVector = Icons.Filled.NavigateNext,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            // Hub Communications
            Card(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable(onClick = onNavigateToCommunications)
                    .testTag("settings-communications-card"),
                colors = CardDefaults.cardColors(
                    containerColor = MaterialTheme.colorScheme.surfaceVariant,
                ),
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(16.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        imageVector = Icons.Filled.Wifi,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.size(24.dp),
                    )
                    Spacer(Modifier.width(12.dp))
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = stringResource(R.string.hub_onboarding_settings_title),
                            style = MaterialTheme.typography.titleSmall,
                        )
                        Text(
                            text = stringResource(R.string.hub_onboarding_title),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Icon(
                        imageVector = Icons.Filled.NavigateNext,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            // Admin panel
            Card(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable(onClick = onNavigateToAdmin)
                    .testTag("settings-admin-card"),
                colors = CardDefaults.cardColors(
                    containerColor = MaterialTheme.colorScheme.surfaceVariant,
                ),
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(16.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        imageVector = Icons.Filled.AdminPanelSettings,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.size(24.dp),
                    )
                    Spacer(Modifier.width(12.dp))
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = stringResource(R.string.settings_admin),
                            style = MaterialTheme.typography.titleSmall,
                        )
                        Text(
                            text = stringResource(R.string.settings_admin_desc),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Icon(
                        imageVector = Icons.Filled.NavigateNext,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            // ---- Advanced Settings (collapsible) ----
            SettingsSection(
                title = stringResource(R.string.settings_advanced),
                expanded = advancedExpanded,
                onToggle = { advancedExpanded = !advancedExpanded },
                testTag = "settings-advanced-section",
            ) {
                // Auto-lock timeout
                Text(
                    text = stringResource(R.string.settings_auto_lock),
                    style = MaterialTheme.typography.bodyMedium,
                )
                Text(
                    text = stringResource(R.string.settings_auto_lock_desc),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                Spacer(Modifier.height(8.dp))

                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("auto-lock-options"),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    AutoLockOption.entries.forEach { option ->
                        val isSelected = autoLockMinutes == option.minutes
                        if (isSelected) {
                            FilledTonalButton(
                                onClick = { onAutoLockChange(option.minutes) },
                                modifier = Modifier.testTag("auto-lock-${option.minutes}"),
                            ) {
                                Text(
                                    stringResource(option.labelRes),
                                    style = MaterialTheme.typography.labelSmall,
                                )
                            }
                        } else {
                            OutlinedButton(
                                onClick = { onAutoLockChange(option.minutes) },
                                modifier = Modifier.testTag("auto-lock-${option.minutes}"),
                            ) {
                                Text(
                                    stringResource(option.labelRes),
                                    style = MaterialTheme.typography.labelSmall,
                                )
                            }
                        }
                    }
                }

                Spacer(Modifier.height(12.dp))

                HorizontalDivider()

                Spacer(Modifier.height(12.dp))

                // Debug logging toggle
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("debug-logging-toggle"),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = stringResource(R.string.settings_debug_logging),
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        Text(
                            text = stringResource(R.string.settings_debug_logging_desc),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Switch(
                        checked = debugLogging,
                        onCheckedChange = onDebugLoggingChange,
                    )
                }

                Spacer(Modifier.height(12.dp))

                HorizontalDivider()

                Spacer(Modifier.height(12.dp))

                // Clear cache button
                OutlinedButton(
                    onClick = { showClearCacheDialog = true },
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("clear-cache-button"),
                    colors = ButtonDefaults.outlinedButtonColors(
                        contentColor = MaterialTheme.colorScheme.error,
                    ),
                ) {
                    Text(stringResource(R.string.settings_clear_cache))
                }
                Text(
                    text = stringResource(R.string.settings_clear_cache_desc),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                Spacer(Modifier.height(12.dp))

                HorizontalDivider()

                Spacer(Modifier.height(12.dp))

                // Crash reporting opt-in toggle
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("crash-reporting-toggle"),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = stringResource(R.string.crash_reporting_consent),
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        Text(
                            text = stringResource(R.string.crash_reporting_consent_description),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Switch(
                        checked = crashReportingEnabled,
                        onCheckedChange = onCrashReportingChange,
                    )
                }

                // Pending crash reports actions
                if (pendingCrashReports > 0) {
                    Spacer(Modifier.height(8.dp))
                    Text(
                        text = stringResource(
                            R.string.crash_reporting_pending_reports_description,
                            pendingCrashReports,
                        ),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.height(4.dp))
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        if (crashReportingEnabled) {
                            FilledTonalButton(
                                onClick = onSendCrashReports,
                                modifier = Modifier.testTag("send-crash-reports"),
                            ) {
                                Text(stringResource(R.string.crash_reporting_send_now))
                            }
                        }
                        OutlinedButton(
                            onClick = onClearCrashReports,
                            modifier = Modifier.testTag("clear-crash-reports"),
                        ) {
                            Text(stringResource(R.string.crash_reporting_clear_reports))
                        }
                    }
                }

                Spacer(Modifier.height(4.dp))

                Text(
                    text = stringResource(R.string.crash_reporting_privacy_note),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
                )
            }

            HorizontalDivider()

            // Lock app button
            Button(
                onClick = onLock,
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag("settings-lock-button"),
                colors = ButtonDefaults.buttonColors(
                    containerColor = MaterialTheme.colorScheme.secondaryContainer,
                    contentColor = MaterialTheme.colorScheme.onSecondaryContainer,
                ),
            ) {
                Icon(Icons.Filled.Lock, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text(stringResource(R.string.lock_app))
            }

            // Logout button
            Button(
                onClick = { showLogoutDialog = true },
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag("settings-logout-button"),
                colors = ButtonDefaults.buttonColors(
                    containerColor = MaterialTheme.colorScheme.errorContainer,
                    contentColor = MaterialTheme.colorScheme.onErrorContainer,
                ),
            ) {
                Icon(Icons.AutoMirrored.Filled.ExitToApp, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text(stringResource(R.string.common_logout))
            }

            // Emergency wipe
            Button(
                onClick = { showPanicWipeDialog = true },
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag("settings-panic-wipe-button"),
                colors = ButtonDefaults.buttonColors(
                    containerColor = MaterialTheme.colorScheme.error,
                    contentColor = MaterialTheme.colorScheme.onError,
                ),
            ) {
                Icon(Icons.Filled.Warning, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text(stringResource(R.string.panic_wipe_title))
            }

            // App version
            Spacer(Modifier.height(16.dp))
            Text(
                text = "${stringResource(R.string.settings_version)}: ${BuildConfig.VERSION_NAME}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                modifier = Modifier
                    .align(Alignment.CenterHorizontally)
                    .testTag("settings-version"),
            )
        }
    }
}

/**
 * Reusable collapsible settings section with animated expand/collapse.
 */
@Composable
private fun SettingsSection(
    title: String,
    expanded: Boolean,
    onToggle: () -> Unit,
    testTag: String,
    content: @Composable () -> Unit,
) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .testTag(testTag),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant,
        ),
    ) {
        Column(modifier = Modifier.fillMaxWidth()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable(onClick = onToggle)
                    .padding(16.dp)
                    .testTag("$testTag-header"),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = title,
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.weight(1f),
                )
                Icon(
                    imageVector = if (expanded) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore,
                    contentDescription = stringResource(
                        if (expanded) R.string.settings_collapse else R.string.settings_expand,
                    ),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            AnimatedVisibility(
                visible = expanded,
                enter = expandVertically(),
                exit = shrinkVertically(),
            ) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(start = 16.dp, end = 16.dp, bottom = 16.dp),
                ) {
                    content()
                }
            }
        }
    }
}

/**
 * Theme selection button (light/dark/system).
 */
@Composable
private fun ThemeButton(
    label: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    selected: Boolean,
    onClick: () -> Unit,
    testTag: String,
    modifier: Modifier = Modifier,
) {
    if (selected) {
        FilledTonalButton(
            onClick = onClick,
            modifier = modifier.testTag(testTag),
        ) {
            Icon(icon, contentDescription = null, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(4.dp))
            Text(label, style = MaterialTheme.typography.labelSmall)
        }
    } else {
        OutlinedButton(
            onClick = onClick,
            modifier = modifier.testTag(testTag),
        ) {
            Icon(icon, contentDescription = null, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(4.dp))
            Text(label, style = MaterialTheme.typography.labelSmall)
        }
    }
}

/**
 * Notification toggle row with label and switch.
 */
@Composable
private fun NotificationToggle(
    label: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    testTag: String,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp)
            .testTag(testTag),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.bodyMedium,
        )
        Switch(
            checked = checked,
            onCheckedChange = onCheckedChange,
        )
    }
}
