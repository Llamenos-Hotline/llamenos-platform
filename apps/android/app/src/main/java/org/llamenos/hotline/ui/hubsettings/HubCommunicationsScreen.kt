package org.llamenos.hotline.ui.hubsettings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import org.llamenos.hotline.R
import org.llamenos.hotline.viewmodel.HubCommunicationsViewModel
import org.llamenos.protocol.HubQuota
import org.llamenos.hotline.model.ProviderType

/**
 * Hub communications settings screen.
 *
 * Displays:
 * - Provider connection status card
 * - Channel enable/disable switches
 * - Usage statistics with quota progress bars
 * - "Start Setup" / "Resume Setup" button when no provider is configured
 * - Onboarding BottomSheet wizard for first-time setup
 *
 * Accessible from hub settings navigation. Permission-gated to admin users.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HubCommunicationsScreen(
    onNavigateBack: () -> Unit,
    onNavigateToProviderSetup: () -> Unit,
    onNavigateToPhoneNumbers: (String) -> Unit,
    modifier: Modifier = Modifier,
    viewModel: HubCommunicationsViewModel = hiltViewModel(),
) {
    val uiState by viewModel.uiState.collectAsState()
    val snackbarHostState = remember { SnackbarHostState() }

    // Show snackbar for save errors
    LaunchedEffect(uiState.saveError) {
        uiState.saveError?.let { error ->
            snackbarHostState.showSnackbar(error)
            viewModel.clearError()
        }
    }

    // Show snackbar for channels saved
    LaunchedEffect(uiState.channelsSaved) {
        if (uiState.channelsSaved) {
            snackbarHostState.showSnackbar("Channel settings saved")
            viewModel.clearChannelsSaved()
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        text = stringResource(R.string.hub_onboarding_settings_title),
                        modifier = Modifier.testTag("hub-communications-title"),
                    )
                },
                navigationIcon = {
                    IconButton(
                        onClick = onNavigateBack,
                        modifier = Modifier.testTag("hub-communications-back"),
                    ) {
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.nav_dashboard),
                        )
                    }
                },
                actions = {
                    IconButton(
                        onClick = { viewModel.refresh() },
                        modifier = Modifier.testTag("hub-communications-refresh"),
                    ) {
                        Icon(
                            imageVector = Icons.Filled.Refresh,
                            contentDescription = stringResource(R.string.action_refresh),
                        )
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.secondaryContainer,
                    titleContentColor = MaterialTheme.colorScheme.onSecondaryContainer,
                ),
            )
        },
        snackbarHost = { SnackbarHost(snackbarHostState) },
        modifier = modifier,
    ) { paddingValues ->
        // Always render the content (including channel checklist) even during first load.
        // This prevents the channel switches from being hidden behind a full-screen spinner
        // on slow CI emulators where the API fetch takes longer than the test assertion timeout.
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues)
                .testTag("hub-communications-list"),
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            // Inline loading indicator (not full-screen blocking)
            if (uiState.isLoading) {
                item {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(vertical = 8.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        CircularProgressIndicator(
                            modifier = Modifier.testTag("hub-communications-loading"),
                        )
                    }
                }
            }

            // Description
            item {
                Text(
                    text = stringResource(R.string.hub_onboarding_settings_description),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.testTag("hub-communications-description"),
                )
            }

            // Error message
            uiState.error?.let { error ->
                item {
                    Card(
                        modifier = Modifier.fillMaxWidth(),
                        colors = CardDefaults.cardColors(
                            containerColor = MaterialTheme.colorScheme.errorContainer,
                        ),
                    ) {
                        Row(
                            modifier = Modifier.padding(16.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(
                                imageVector = Icons.Filled.Error,
                                contentDescription = null,
                                tint = MaterialTheme.colorScheme.onErrorContainer,
                            )
                            Spacer(modifier = Modifier.width(8.dp))
                            Text(
                                text = error,
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onErrorContainer,
                            )
                        }
                    }
                }
            }

            // Provider status card
            item {
                ProviderStatusCard(
                    providerConnected = uiState.providerConnected,
                    providerType = uiState.setupStatus?.providerType,
                    numbersProvisioned = uiState.setupStatus?.numbersProvisioned ?: 0,
                    onStartSetup = { viewModel.showOnboarding() },
                    onNavigateToProviderSetup = onNavigateToProviderSetup,
                )
            }

            // Channel settings — always visible on the main screen.
            // The onboarding flow uses a separate ChannelChecklist instance
            // inside the BottomSheet, scoped to the CHANNELS step only.
            item {
                ChannelChecklist(
                    channels = uiState.channels,
                    onToggle = { channel, enabled ->
                        viewModel.toggleChannel(channel, enabled)
                    },
                    enabled = !uiState.isSavingChannels,
                )
            }

            // Usage card
            item {
                HubUsageCard(
                    usage = uiState.currentUsage,
                    quotas = uiState.quotas,
                )
            }

            // Quota limits card
            uiState.quotas?.let { quotas ->
                item {
                    QuotaCard(quotas = quotas)
                }
            }

            // Bottom spacing
            item {
                Spacer(modifier = Modifier.height(16.dp))
            }
        }

        // Onboarding BottomSheet
        if (uiState.showOnboarding) {
            HubOnboardingFlow(
                onboardingState = uiState.onboardingState,
                templates = uiState.templates,
                isLoadingTemplates = uiState.isLoadingTemplates,
                isCompletingStep = uiState.isCompletingStep,
                channels = uiState.channels,
                onSelectTemplate = { templateId ->
                    viewModel.startOnboarding(templateId = templateId)
                },
                onToggleChannel = { channel, enabled ->
                    viewModel.toggleChannel(channel, enabled)
                },
                onCompleteStep = { step, channelConfig ->
                    viewModel.completeStep(step, channelConfig)
                },
                onNavigateToProviderSetup = {
                    viewModel.dismissOnboarding()
                    onNavigateToProviderSetup()
                },
                onNavigateToPhoneNumbers = {
                    val provider = uiState.setupStatus?.providerType?.value ?: "twilio"
                    viewModel.dismissOnboarding()
                    onNavigateToPhoneNumbers(provider)
                },
                onDismiss = { viewModel.dismissOnboarding() },
            )
        }
    }
}

/**
 * Card showing provider connection status with action buttons.
 */
@Composable
private fun ProviderStatusCard(
    providerConnected: Boolean,
    providerType: ProviderType?,
    numbersProvisioned: Int,
    onStartSetup: () -> Unit,
    onNavigateToProviderSetup: () -> Unit,
) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .testTag("provider-status-card"),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceContainerLow,
        ),
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(
                text = stringResource(R.string.hub_onboarding_provider_status),
                style = MaterialTheme.typography.titleMedium,
            )

            Spacer(modifier = Modifier.height(8.dp))

            Row(
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    imageVector = if (providerConnected) {
                        Icons.Filled.CheckCircle
                    } else {
                        Icons.Filled.Error
                    },
                    contentDescription = null,
                    tint = if (providerConnected) {
                        MaterialTheme.colorScheme.primary
                    } else {
                        MaterialTheme.colorScheme.error
                    },
                    modifier = Modifier.size(20.dp),
                )
                Spacer(modifier = Modifier.width(8.dp))
                Text(
                    text = if (providerConnected) {
                        stringResource(R.string.hub_onboarding_provider_connected)
                    } else {
                        stringResource(R.string.hub_onboarding_provider_disconnected)
                    },
                    style = MaterialTheme.typography.bodyMedium,
                    color = if (providerConnected) {
                        MaterialTheme.colorScheme.primary
                    } else {
                        MaterialTheme.colorScheme.error
                    },
                )
            }

            if (providerConnected && providerType != null) {
                Text(
                    text = stringResource(
                        R.string.hub_onboarding_template_provider,
                        providerType.value.replaceFirstChar { it.uppercase() },
                    ),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 4.dp),
                )

                Text(
                    text = stringResource(
                        R.string.hub_onboarding_phone_numbers,
                    ) + ": $numbersProvisioned",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 2.dp),
                )

                Spacer(modifier = Modifier.height(8.dp))

                Button(
                    onClick = onNavigateToProviderSetup,
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("manage-provider-button"),
                ) {
                    Text(stringResource(R.string.hub_onboarding_provider_status))
                }
            } else {
                Spacer(modifier = Modifier.height(8.dp))

                Text(
                    text = stringResource(R.string.hub_onboarding_no_provider_description),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                Spacer(modifier = Modifier.height(8.dp))

                Button(
                    onClick = onStartSetup,
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("start-setup-button"),
                ) {
                    Text(stringResource(R.string.hub_onboarding_start_setup))
                }
            }
        }
    }
}

/**
 * Card showing quota limits.
 */
@Composable
private fun QuotaCard(
    quotas: HubQuota,
) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .testTag("hub-quota-card"),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceContainerLow,
        ),
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(
                text = stringResource(R.string.hub_onboarding_quota_title),
                style = MaterialTheme.typography.titleMedium,
            )

            Spacer(modifier = Modifier.height(8.dp))

            QuotaRow(
                label = stringResource(R.string.hub_onboarding_quota_phone_numbers),
                value = quotas.maxPhoneNumbers.toString(),
            )
            QuotaRow(
                label = stringResource(R.string.hub_onboarding_quota_sms),
                value = quotas.maxSMSPerMonth.toString(),
            )
            QuotaRow(
                label = stringResource(R.string.hub_onboarding_quota_calls),
                value = quotas.maxCallsPerMonth.toString(),
            )
        }
    }
}

@Composable
private fun QuotaRow(
    label: String,
    value: String,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 2.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.bodyMedium,
        )
        Text(
            text = value,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
