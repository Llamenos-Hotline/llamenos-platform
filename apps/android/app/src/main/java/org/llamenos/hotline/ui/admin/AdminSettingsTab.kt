package org.llamenos.hotline.ui.admin

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Language
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material.icons.filled.Topic
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import org.llamenos.hotline.R
import org.llamenos.hotline.model.TelephonyProviderType
import org.llamenos.hotline.ui.settings.SUPPORTED_LANGUAGES
import kotlin.math.roundToInt

/**
 * Admin settings tab with transcription, report categories, telephony,
 * call settings, IVR languages, and spam mitigation configuration.
 *
 * Each section is a Material 3 Card. Settings are persisted server-side
 * via the admin API. Sections with multiple fields have explicit Save buttons.
 */
@Composable
fun AdminSettingsTab(
    viewModel: AdminViewModel,
    modifier: Modifier = Modifier,
) {
    val uiState by viewModel.uiState.collectAsState()

    // Add Category Dialog
    if (uiState.showAddCategoryDialog) {
        AddCategoryDialog(
            onDismiss = { viewModel.dismissAddCategoryDialog() },
            onConfirm = { name -> viewModel.addReportCategory(name) },
        )
    }

    when {
        uiState.isLoadingSettings -> {
            Box(
                modifier = modifier
                    .fillMaxSize()
                    .testTag("admin-settings-loading"),
                contentAlignment = Alignment.Center,
            ) {
                CircularProgressIndicator()
            }
        }

        else -> {
            Column(
                modifier = modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                // --- Transcription Section ---
                TranscriptionSection(
                    transcriptionEnabled = uiState.transcriptionEnabled,
                    transcriptionOptOut = uiState.transcriptionOptOut,
                    onToggleTranscription = { viewModel.toggleTranscription(it) },
                    onToggleOptOut = { viewModel.toggleTranscriptionOptOut(it) },
                )

                // --- Report Categories Section ---
                ReportCategoriesSection(
                    categories = uiState.reportCategories,
                    isLoading = uiState.isLoadingCategories,
                    error = uiState.categoriesError,
                    onAddCategory = { viewModel.showAddCategoryDialog() },
                    onDeleteCategory = { viewModel.deleteReportCategory(it) },
                )

                // --- Telephony Section ---
                TelephonySection(
                    provider = uiState.telephonyProvider,
                    accountSid = uiState.telephonyAccountSid,
                    authToken = uiState.telephonyAuthToken,
                    phoneNumber = uiState.telephonyPhoneNumber,
                    isLoading = uiState.isLoadingTelephony,
                    error = uiState.telephonyError,
                    onProviderChange = { viewModel.updateTelephonyProvider(it) },
                    onAccountSidChange = { viewModel.updateTelephonyAccountSid(it) },
                    onAuthTokenChange = { viewModel.updateTelephonyAuthToken(it) },
                    onPhoneNumberChange = { viewModel.updateTelephonyPhoneNumber(it) },
                    onSave = { viewModel.saveTelephonySettings() },
                )

                // --- Call Settings Section ---
                CallSettingsSection(
                    queueTimeoutSeconds = uiState.queueTimeoutSeconds,
                    voicemailMaxSeconds = uiState.voicemailMaxSeconds,
                    isLoading = uiState.isLoadingCallSettings,
                    error = uiState.callSettingsError,
                    onQueueTimeoutChange = { viewModel.updateQueueTimeout(it) },
                    onVoicemailMaxChange = { viewModel.updateVoicemailMax(it) },
                    onSave = { viewModel.saveCallSettings() },
                )

                // --- IVR Languages Section ---
                IvrLanguagesSection(
                    enabledLanguages = uiState.ivrEnabledLanguages,
                    isLoading = uiState.isLoadingIvrLanguages,
                    error = uiState.ivrLanguagesError,
                    onToggleLanguage = { code, enabled -> viewModel.toggleIvrLanguage(code, enabled) },
                    onSave = { viewModel.saveIvrLanguages() },
                )

                // --- Spam Settings Section ---
                SpamSettingsSection(
                    maxCallsPerMinute = uiState.maxCallsPerMinute,
                    blockDurationMinutes = uiState.blockDurationMinutes,
                    rateLimitEnabled = uiState.rateLimitEnabled,
                    voiceCaptchaEnabled = uiState.voiceCaptchaEnabled,
                    isLoading = uiState.isLoadingSpamSettings,
                    error = uiState.spamSettingsError,
                    onMaxCallsPerMinuteChange = { viewModel.updateMaxCallsPerMinute(it) },
                    onBlockDurationChange = { viewModel.updateBlockDuration(it) },
                    onToggleRateLimit = { viewModel.toggleRateLimit(it) },
                    onToggleVoiceCaptcha = { viewModel.toggleVoiceCaptcha(it) },
                    onSave = { viewModel.saveSpamSettings() },
                )

                // Global error
                if (uiState.settingsError != null) {
                    Card(
                        modifier = Modifier
                            .fillMaxWidth()
                            .testTag("admin-settings-error"),
                        colors = CardDefaults.cardColors(
                            containerColor = MaterialTheme.colorScheme.errorContainer,
                        ),
                    ) {
                        Text(
                            text = uiState.settingsError ?: "",
                            modifier = Modifier.padding(16.dp),
                            color = MaterialTheme.colorScheme.onErrorContainer,
                        )
                    }
                }
            }
        }
    }
}

// ---- Transcription Section ----

@Composable
internal fun TranscriptionSection(
    transcriptionEnabled: Boolean,
    transcriptionOptOut: Boolean,
    onToggleTranscription: (Boolean) -> Unit,
    onToggleOptOut: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
    Card(
        modifier = modifier
            .fillMaxWidth()
            .testTag("admin-transcription-card"),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant,
        ),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
        ) {
            SectionHeader(
                icon = Icons.Filled.Mic,
                title = stringResource(R.string.settings_transcription),
            )

            Spacer(Modifier.height(16.dp))

            SettingsToggleRow(
                title = stringResource(R.string.admin_transcription_enabled),
                description = stringResource(R.string.admin_transcription_enabled_desc),
                checked = transcriptionEnabled,
                onCheckedChange = onToggleTranscription,
                testTag = "transcription-enabled-toggle",
            )

            Spacer(Modifier.height(12.dp))

            SettingsToggleRow(
                title = stringResource(R.string.admin_transcription_optout),
                description = stringResource(R.string.admin_transcription_optout_desc),
                checked = transcriptionOptOut,
                onCheckedChange = onToggleOptOut,
                testTag = "transcription-optout-toggle",
            )
        }
    }
}

// ---- Report Categories Section ----

@Composable
internal fun ReportCategoriesSection(
    categories: List<org.llamenos.hotline.model.ReportCategory>,
    isLoading: Boolean,
    error: String?,
    onAddCategory: () -> Unit,
    onDeleteCategory: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    Card(
        modifier = modifier
            .fillMaxWidth()
            .testTag("admin-report-categories-card"),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant,
        ),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                SectionHeader(
                    icon = Icons.Filled.Topic,
                    title = stringResource(R.string.admin_report_categories),
                )
                IconButton(
                    onClick = onAddCategory,
                    modifier = Modifier.testTag("add-category-button"),
                ) {
                    Icon(
                        imageVector = Icons.Filled.Add,
                        contentDescription = stringResource(R.string.admin_report_category_add),
                        tint = MaterialTheme.colorScheme.primary,
                    )
                }
            }

            if (isLoading) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 16.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator(modifier = Modifier.size(24.dp))
                }
            } else if (categories.isEmpty()) {
                Text(
                    text = stringResource(R.string.admin_report_category_empty),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(vertical = 8.dp),
                )
            } else {
                categories.forEach { category ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .testTag("category-item-${category.id}"),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween,
                    ) {
                        Text(
                            text = category.name,
                            style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.weight(1f),
                        )
                        IconButton(
                            onClick = { onDeleteCategory(category.id) },
                            modifier = Modifier.testTag("delete-category-${category.id}"),
                        ) {
                            Icon(
                                imageVector = Icons.Filled.Delete,
                                contentDescription = stringResource(R.string.admin_report_category_delete_confirm),
                                tint = MaterialTheme.colorScheme.error,
                            )
                        }
                    }
                    HorizontalDivider()
                }
            }

            if (error != null) {
                Spacer(Modifier.height(8.dp))
                Text(
                    text = error,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
        }
    }
}

// ---- Telephony Section ----

/**
 * Picker order: the cloud providers first, then the self-hosted PBXes.
 *
 * `TelephonyProviderType` is the generated `SharedProviderType`, so this is
 * exactly the eight providers `telephonyProviderTypeSchema` accepts. The list
 * here used to be five hardcoded strings, which left an operator on Telnyx,
 * Bandwidth or FreeSWITCH unable to select their own provider (#1724).
 */
internal val TELEPHONY_PROVIDER_PICKER_ORDER = listOf(
    TelephonyProviderType.Twilio,
    TelephonyProviderType.Signalwire,
    TelephonyProviderType.Vonage,
    TelephonyProviderType.Plivo,
    TelephonyProviderType.Telnyx,
    TelephonyProviderType.Bandwidth,
    TelephonyProviderType.Asterisk,
    TelephonyProviderType.Freeswitch,
)

/** The provider's own brand name. Trademarks are not localized. */
internal val TelephonyProviderType.displayName: String
    get() = when (this) {
        TelephonyProviderType.Twilio -> "Twilio"
        TelephonyProviderType.Signalwire -> "SignalWire"
        TelephonyProviderType.Vonage -> "Vonage"
        TelephonyProviderType.Plivo -> "Plivo"
        TelephonyProviderType.Telnyx -> "Telnyx"
        TelephonyProviderType.Bandwidth -> "Bandwidth"
        TelephonyProviderType.Asterisk -> "Asterisk"
        TelephonyProviderType.Freeswitch -> "FreeSWITCH"
    }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun TelephonySection(
    provider: TelephonyProviderType,
    accountSid: String,
    authToken: String,
    phoneNumber: String,
    isLoading: Boolean,
    error: String?,
    onProviderChange: (TelephonyProviderType) -> Unit,
    onAccountSidChange: (String) -> Unit,
    onAuthTokenChange: (String) -> Unit,
    onPhoneNumberChange: (String) -> Unit,
    onSave: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var expanded by remember { mutableStateOf(false) }

    Card(
        modifier = modifier
            .fillMaxWidth()
            .testTag("admin-telephony-card"),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant,
        ),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
        ) {
            SectionHeader(
                icon = Icons.Filled.Phone,
                title = stringResource(R.string.admin_telephony_settings),
            )

            Spacer(Modifier.height(12.dp))

            if (isLoading) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 16.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator(modifier = Modifier.size(24.dp))
                }
            } else {
                // Provider dropdown
                ExposedDropdownMenuBox(
                    expanded = expanded,
                    onExpandedChange = { expanded = it },
                ) {
                    OutlinedTextField(
                        value = provider.displayName,
                        onValueChange = {},
                        readOnly = true,
                        label = { Text(stringResource(R.string.admin_telephony_provider)) },
                        trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
                        modifier = Modifier
                            .fillMaxWidth()
                            .menuAnchor(MenuAnchorType.PrimaryNotEditable)
                            .testTag("telephony-provider-select"),
                    )
                    ExposedDropdownMenu(
                        expanded = expanded,
                        onDismissRequest = { expanded = false },
                    ) {
                        TELEPHONY_PROVIDER_PICKER_ORDER.forEach { p ->
                            DropdownMenuItem(
                                text = { Text(p.displayName) },
                                onClick = {
                                    onProviderChange(p)
                                    expanded = false
                                },
                            )
                        }
                    }
                }

                Spacer(Modifier.height(8.dp))

                OutlinedTextField(
                    value = accountSid,
                    onValueChange = onAccountSidChange,
                    label = { Text(stringResource(R.string.admin_telephony_account_sid)) },
                    singleLine = true,
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("telephony-account-sid"),
                )

                Spacer(Modifier.height(8.dp))

                OutlinedTextField(
                    value = authToken,
                    onValueChange = onAuthTokenChange,
                    label = { Text(stringResource(R.string.admin_telephony_auth_token)) },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("telephony-auth-token"),
                )

                Spacer(Modifier.height(8.dp))

                OutlinedTextField(
                    value = phoneNumber,
                    onValueChange = onPhoneNumberChange,
                    label = { Text(stringResource(R.string.admin_telephony_phone_number)) },
                    singleLine = true,
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("telephony-phone-number"),
                )

                Spacer(Modifier.height(12.dp))

                Button(
                    onClick = onSave,
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("telephony-save-button"),
                ) {
                    Text(stringResource(R.string.action_save))
                }
            }

            if (error != null) {
                Spacer(Modifier.height(8.dp))
                Text(
                    text = error,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
        }
    }
}

// ---- Call Settings Section ----

/** 30...300 in 15-second steps, so the slider has 18 interior stops. */
private const val CALL_SECONDS_STEPS = 17

@Composable
internal fun CallSettingsSection(
    queueTimeoutSeconds: Int,
    voicemailMaxSeconds: Int,
    isLoading: Boolean,
    error: String?,
    onQueueTimeoutChange: (Int) -> Unit,
    onVoicemailMaxChange: (Int) -> Unit,
    onSave: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Card(
        modifier = modifier
            .fillMaxWidth()
            .testTag("admin-call-settings-card"),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant,
        ),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
        ) {
            SectionHeader(
                icon = Icons.Filled.Call,
                title = stringResource(R.string.admin_call_settings),
            )

            Spacer(Modifier.height(12.dp))

            if (isLoading) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 16.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator(modifier = Modifier.size(24.dp))
                }
            } else {
                // The two call settings the server has, both in seconds over its
                // own 30...300 clamp. The three that used to be here — a ring
                // timeout, a maximum call duration and a parallel ring count —
                // have no server field, no storage and no effect (#1724).
                SliderSetting(
                    label = stringResource(R.string.call_settings_queue_timeout),
                    value = queueTimeoutSeconds.toFloat(),
                    valueRange = CALL_SECONDS_RANGE.first.toFloat()..CALL_SECONDS_RANGE.last.toFloat(),
                    steps = CALL_SECONDS_STEPS,
                    valueLabel = stringResource(R.string.admin_seconds_unit, queueTimeoutSeconds),
                    onValueChange = { onQueueTimeoutChange(it.roundToInt()) },
                    testTag = "queue-timeout-slider",
                )

                Spacer(Modifier.height(12.dp))

                SliderSetting(
                    label = stringResource(R.string.call_settings_voicemail_max),
                    value = voicemailMaxSeconds.toFloat(),
                    valueRange = CALL_SECONDS_RANGE.first.toFloat()..CALL_SECONDS_RANGE.last.toFloat(),
                    steps = CALL_SECONDS_STEPS,
                    valueLabel = stringResource(R.string.admin_seconds_unit, voicemailMaxSeconds),
                    onValueChange = { onVoicemailMaxChange(it.roundToInt()) },
                    testTag = "voicemail-max-slider",
                )

                Spacer(Modifier.height(12.dp))

                Button(
                    onClick = onSave,
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("call-settings-save-button"),
                ) {
                    Text(stringResource(R.string.action_save))
                }
            }

            if (error != null) {
                Spacer(Modifier.height(8.dp))
                Text(
                    text = error,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
        }
    }
}

// ---- IVR Languages Section ----

/**
 * Every locale a caller can be offered, with the language's own name.
 *
 * The same set as `SUPPORTED_LANGUAGES` in `ui/settings/SettingsScreen.kt`,
 * which mirrors `LANGUAGES` in `packages/i18n/languages.ts` — the source of
 * truth for which locales exist. This list held 13 of them, so nine shipped
 * locales were unreachable from this screen; the server still rejects a code
 * outside `LANGUAGE_CODES`, so a drift here cannot store a language that does
 * not exist.
 */
internal val IVR_LANGUAGE_LIST = SUPPORTED_LANGUAGES.map { it.code to it.label }

/**
 * Positions from this index on are reached through the "more languages" digit —
 * `ivrIndexToDigit` in `packages/i18n/languages.ts`, which the server's IVR
 * menu builder uses.
 */
private const val IVR_SUB_MENU_THRESHOLD = 8

/** The keypad digit that selects the language at [index]. */
private fun ivrDigitLabel(index: Int): String =
    if (index < IVR_SUB_MENU_THRESHOLD) "${index + 1}" else "9\u00b7${index - IVR_SUB_MENU_THRESHOLD + 1}"

/** The language's own name, or the bare code for one this build does not list. */
private fun ivrLanguageLabel(code: String): String =
    IVR_LANGUAGE_LIST.firstOrNull { it.first == code }?.second ?: code.uppercase()

@Composable
internal fun IvrLanguagesSection(
    enabledLanguages: List<String>,
    isLoading: Boolean,
    error: String?,
    onToggleLanguage: (String, Boolean) -> Unit,
    onSave: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Card(
        modifier = modifier
            .fillMaxWidth()
            .testTag("admin-ivr-languages-card"),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant,
        ),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
        ) {
            SectionHeader(
                icon = Icons.Filled.Language,
                title = stringResource(R.string.admin_ivr_settings),
            )

            Spacer(Modifier.height(12.dp))

            if (isLoading) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 16.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator(modifier = Modifier.size(24.dp))
                }
            } else {
                // The enabled languages in the order callers hear them, each with
                // the digit that selects it: position is a setting in its own
                // right, which the `Map<String, Boolean>` this screen used to
                // hold could not express at all.
                Text(
                    text = stringResource(R.string.ivr_enabled_languages),
                    style = MaterialTheme.typography.labelMedium,
                )
                if (enabledLanguages.isEmpty()) {
                    Text(
                        text = stringResource(R.string.ivr_at_least_one),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
                enabledLanguages.forEachIndexed { index, code ->
                    Text(
                        text = "${ivrDigitLabel(index)}  ${ivrLanguageLabel(code)}",
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.testTag("ivr-enabled-$code"),
                    )
                }
                Text(
                    // One string a test can compare against the server's array,
                    // because the order is what a per-row assertion cannot see.
                    text = enabledLanguages.joinToString(","),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.testTag("ivr-enabled-order"),
                )
                Text(
                    text = stringResource(R.string.ivr_sub_menu_note),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                Spacer(Modifier.height(12.dp))

                Text(
                    text = stringResource(R.string.ivr_available_languages),
                    style = MaterialTheme.typography.labelMedium,
                )
                IVR_LANGUAGE_LIST.forEach { (code, label) ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .testTag("ivr-language-$code"),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween,
                    ) {
                        Text(
                            text = "$label ($code)",
                            style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.weight(1f),
                        )
                        Switch(
                            checked = code in enabledLanguages,
                            onCheckedChange = { onToggleLanguage(code, it) },
                        )
                    }
                }

                Spacer(Modifier.height(12.dp))

                Button(
                    onClick = onSave,
                    enabled = enabledLanguages.isNotEmpty(),
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("ivr-languages-save-button"),
                ) {
                    Text(stringResource(R.string.action_save))
                }
            }

            if (error != null) {
                Spacer(Modifier.height(8.dp))
                Text(
                    text = error,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
        }
    }
}

// ---- Spam Settings Section ----

@Composable
internal fun SpamSettingsSection(
    maxCallsPerMinute: Int,
    blockDurationMinutes: Int,
    rateLimitEnabled: Boolean,
    voiceCaptchaEnabled: Boolean,
    isLoading: Boolean,
    error: String?,
    onMaxCallsPerMinuteChange: (Int) -> Unit,
    onBlockDurationChange: (Int) -> Unit,
    onToggleRateLimit: (Boolean) -> Unit,
    onToggleVoiceCaptcha: (Boolean) -> Unit,
    onSave: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Card(
        modifier = modifier
            .fillMaxWidth()
            .testTag("admin-spam-settings-card"),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant,
        ),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
        ) {
            SectionHeader(
                icon = Icons.Filled.Shield,
                title = stringResource(R.string.admin_spam_settings),
            )

            Spacer(Modifier.height(12.dp))

            if (isLoading) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 16.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator(modifier = Modifier.size(24.dp))
                }
            } else {
                // The server's rate limit is per MINUTE, with a block duration
                // alongside it. This screen offered a per-HOUR limit and a
                // "known number bypass" the server does not have at all — a
                // switch that promised to exempt repeat callers from the
                // CAPTCHA and controlled nothing in either position (#1724).
                SettingsToggleRow(
                    title = stringResource(R.string.spam_rate_limiting),
                    description = stringResource(R.string.spam_rate_limiting_description),
                    checked = rateLimitEnabled,
                    onCheckedChange = onToggleRateLimit,
                    testTag = "rate-limit-toggle",
                )

                Spacer(Modifier.height(12.dp))

                SliderSetting(
                    label = stringResource(R.string.spam_max_calls_per_minute),
                    value = maxCallsPerMinute.toFloat(),
                    valueRange = MAX_CALLS_PER_MINUTE_RANGE.first.toFloat()..MAX_CALLS_PER_MINUTE_RANGE.last.toFloat(),
                    steps = MAX_CALLS_PER_MINUTE_RANGE.last - MAX_CALLS_PER_MINUTE_RANGE.first - 1,
                    valueLabel = maxCallsPerMinute.toString(),
                    onValueChange = { onMaxCallsPerMinuteChange(it.roundToInt()) },
                    testTag = "max-calls-per-minute-slider",
                )

                Spacer(Modifier.height(12.dp))

                SliderSetting(
                    label = stringResource(R.string.spam_block_duration),
                    value = blockDurationMinutes.toFloat(),
                    valueRange = BLOCK_DURATION_MINUTES_RANGE.first.toFloat()..BLOCK_DURATION_MINUTES_RANGE.last.toFloat(),
                    steps = 0,
                    valueLabel = blockDurationMinutes.toString(),
                    onValueChange = { onBlockDurationChange(it.roundToInt()) },
                    testTag = "block-duration-slider",
                )

                Spacer(Modifier.height(12.dp))

                SettingsToggleRow(
                    title = stringResource(R.string.spam_voice_captcha),
                    description = stringResource(R.string.spam_voice_captcha_description),
                    checked = voiceCaptchaEnabled,
                    onCheckedChange = onToggleVoiceCaptcha,
                    testTag = "voice-captcha-toggle",
                )

                Spacer(Modifier.height(12.dp))

                Button(
                    onClick = onSave,
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("spam-settings-save-button"),
                ) {
                    Text(stringResource(R.string.action_save))
                }
            }

            if (error != null) {
                Spacer(Modifier.height(8.dp))
                Text(
                    text = error,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
        }
    }
}

// ---- Shared Composables ----

@Composable
internal fun SectionHeader(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    title: String,
    modifier: Modifier = Modifier,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = modifier,
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.primary,
            modifier = Modifier.size(24.dp),
        )
        Spacer(Modifier.width(8.dp))
        Text(
            text = title,
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.Bold,
        )
    }
}

@Composable
internal fun SettingsToggleRow(
    title: String,
    description: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    testTag: String,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .testTag(testTag),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = title,
                style = MaterialTheme.typography.bodyMedium,
            )
            Text(
                text = description,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Switch(
            checked = checked,
            onCheckedChange = onCheckedChange,
        )
    }
}

@Composable
internal fun SliderSetting(
    label: String,
    value: Float,
    valueRange: ClosedFloatingPointRange<Float>,
    steps: Int,
    valueLabel: String,
    onValueChange: (Float) -> Unit,
    testTag: String,
    modifier: Modifier = Modifier,
) {
    Column(modifier = modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text(
                text = label,
                style = MaterialTheme.typography.bodyMedium,
            )
            Text(
                text = valueLabel,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.primary,
            )
        }
        Slider(
            value = value,
            onValueChange = onValueChange,
            valueRange = valueRange,
            steps = steps,
            modifier = Modifier.testTag(testTag),
        )
    }
}

// ---- Add Category Dialog ----

@Composable
internal fun AddCategoryDialog(
    onDismiss: () -> Unit,
    onConfirm: (String) -> Unit,
) {
    var name by remember { mutableStateOf("") }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.admin_report_category_add)) },
        text = {
            OutlinedTextField(
                value = name,
                onValueChange = { name = it },
                label = { Text(stringResource(R.string.admin_report_category_name)) },
                singleLine = true,
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag("category-name-input"),
            )
        },
        confirmButton = {
            TextButton(
                onClick = { onConfirm(name) },
                enabled = name.isNotBlank(),
                modifier = Modifier.testTag("confirm-add-category"),
            ) {
                Text(stringResource(R.string.action_save))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(stringResource(android.R.string.cancel))
            }
        },
    )
}
