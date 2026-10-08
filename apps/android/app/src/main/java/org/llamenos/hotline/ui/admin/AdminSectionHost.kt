package org.llamenos.hotline.ui.admin

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import org.llamenos.hotline.R
import org.llamenos.hotline.ui.analytics.AnalyticsScreen

@Composable
fun AdminSectionHost(
    viewModel: AdminViewModel = hiltViewModel(),
) {
    val uiState by viewModel.uiState.collectAsState()
    val section = uiState.selectedAdminSection

    // Show add-category dialog when report-types section triggers it
    if (uiState.showAddCategoryDialog) {
        AddCategoryDialog(
            onDismiss = { viewModel.dismissAddCategoryDialog() },
            onConfirm = { name -> viewModel.addReportCategory(name) },
        )
    }

    Box(
        modifier = Modifier.fillMaxSize(),
        contentAlignment = Alignment.Center,
    ) {
        when (section) {
            "location-lookup" -> Text(stringResource(R.string.admin_nav_items_location_lookup))
            "passkey-policy" -> Text(stringResource(R.string.admin_nav_items_passkey_policy))
            "recovery-group" -> Text(stringResource(R.string.admin_nav_items_recovery_group))
            "devices" -> Text(stringResource(R.string.admin_nav_items_devices))
            "hub-roles" -> Text(stringResource(R.string.admin_nav_items_hub_roles))
            "teams" -> Text(stringResource(R.string.admin_nav_items_teams))
            "tags" -> Text(stringResource(R.string.admin_nav_items_tags))
            "custom-fields" -> CustomFieldsTab(viewModel = viewModel)
            "report-types" -> ReportCategoriesSection(
                categories = uiState.reportCategories,
                isLoading = uiState.isLoadingCategories,
                error = uiState.categoriesError,
                onAddCategory = { viewModel.showAddCategoryDialog() },
                onDeleteCategory = { viewModel.deleteReportCategory(it) },
                modifier = Modifier.padding(16.dp),
            )
            "firehose" -> Text(stringResource(R.string.admin_nav_items_firehose))
            "call-settings" -> CallSettingsSection(
                queueTimeoutSeconds = uiState.queueTimeoutSeconds,
                voicemailMaxSeconds = uiState.voicemailMaxSeconds,
                isLoading = uiState.isLoadingCallSettings,
                error = uiState.callSettingsError,
                onQueueTimeoutChange = { viewModel.updateQueueTimeout(it) },
                onVoicemailMaxChange = { viewModel.updateVoicemailMax(it) },
                onSave = { viewModel.saveCallSettings() },
                modifier = Modifier.padding(16.dp),
            )
            "voice-prompts" -> Text(stringResource(R.string.admin_nav_items_voice_prompts))
            "phone-menu-languages" -> IvrLanguagesSection(
                enabledLanguages = uiState.ivrEnabledLanguages,
                isLoading = uiState.isLoadingIvrLanguages,
                error = uiState.ivrLanguagesError,
                onToggleLanguage = { code, enabled -> viewModel.toggleIvrLanguage(code, enabled) },
                onSave = { viewModel.saveIvrLanguages() },
                modifier = Modifier.padding(16.dp),
            )
            "transcription" -> TranscriptionSection(
                transcriptionEnabled = uiState.transcriptionEnabled,
                transcriptionOptOut = uiState.transcriptionOptOut,
                onToggleTranscription = { viewModel.toggleTranscription(it) },
                onToggleOptOut = { viewModel.toggleTranscriptionOptOut(it) },
                modifier = Modifier.padding(16.dp),
            )
            "spam-protection" -> SpamSettingsSection(
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
                modifier = Modifier.padding(16.dp),
            )
            "phone-provider" -> TelephonySection(
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
                modifier = Modifier.padding(16.dp),
            )
            "messaging-sms" -> Text(stringResource(R.string.admin_nav_items_messaging_sms))
            "rcs" -> Text(stringResource(R.string.admin_nav_items_rcs))
            "signal" -> Text(stringResource(R.string.admin_nav_items_signal))
            "bans" -> BanListTab(viewModel = viewModel)
            "audit" -> AuditLogTab(viewModel = viewModel)
            "analytics" -> AnalyticsScreen()
            "health" -> SystemHealthTab(viewModel = viewModel)
            "hubs" -> Text(stringResource(R.string.admin_nav_items_hubs))
            "platform-roles" -> Text(stringResource(R.string.admin_nav_items_platform_roles))
            "platform-bans" -> BanListTab(viewModel = viewModel)
            "platform-audit" -> AuditLogTab(viewModel = viewModel)
            "platform-analytics" -> AnalyticsScreen()
            "platform-health" -> SystemHealthTab(viewModel = viewModel)
            "platform-settings" -> Text(stringResource(R.string.admin_nav_items_platform_settings))
            "gdpr-erasure" -> ErasureQueueTab(viewModel = viewModel)
            "erasure-queue" -> ErasureQueueTab(viewModel = viewModel)
            "retention" -> RetentionSettingsTab(viewModel = viewModel)
            "platform-bans-manage" -> PlatformBansTab(viewModel = viewModel)
            else -> Text(stringResource(R.string.common_loading))
        }
    }
}
