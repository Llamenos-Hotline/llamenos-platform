package org.llamenos.hotline.ui.hubsettings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.RadioButtonUnchecked
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import org.llamenos.hotline.R
import org.llamenos.protocol.ChannelConfig
import org.llamenos.protocol.HubOnboardingState
import org.llamenos.protocol.ProviderTemplate

/**
 * Steps in the onboarding wizard. [key] is the server step each screen completes
 * (ONBOARDING_STEPS in apps/worker/services/provider-setup/hub-onboard.ts); the
 * summary screen completes `channel_setup`, after which the server marks the
 * onboarding complete.
 */
private enum class OnboardingStep(val key: String, val labelResId: Int) {
    TEMPLATE("template_selection", R.string.hub_onboarding_step_template),
    CHANNELS("channel_selection", R.string.hub_onboarding_step_channels),
    PROVIDER("provider_connection", R.string.hub_onboarding_step_provider),
    PHONE_NUMBER("phone_number", R.string.hub_onboarding_step_phone_number),
    SUMMARY("channel_setup", R.string.hub_onboarding_step_summary),
}

/**
 * BottomSheet onboarding flow for new hub communications setup.
 *
 * Guides the admin through:
 * 1. Choose a provider template (or start from scratch)
 * 2. Select communication channels
 * 3. Connect provider (OAuth or API key)
 * 4. Provision phone number
 * 5. Review and complete
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HubOnboardingFlow(
    onboardingState: HubOnboardingState?,
    templates: List<ProviderTemplate>,
    isLoadingTemplates: Boolean,
    isCompletingStep: Boolean,
    channels: ChannelConfig,
    onSelectTemplate: (String?) -> Unit,
    onToggleChannel: (String, Boolean) -> Unit,
    onCompleteStep: (step: String, channelConfig: ChannelConfig?) -> Unit,
    onNavigateToProviderSetup: () -> Unit,
    onNavigateToPhoneNumbers: () -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    // Do NOT key on onboardingState — when the server responds to completeStep(),
    // we advance the step locally before the response arrives. Re-keying on
    // onboardingState would reset currentStep to the server's value, causing the
    // UI to flicker back and the next step's content to disappear (timeout on CI).
    var currentStep by remember {
        mutableStateOf(
            OnboardingStep.entries.find { it.key == onboardingState?.currentStep }
                ?: OnboardingStep.TEMPLATE
        )
    }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        modifier = modifier.testTag("hub-onboarding-sheet"),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp)
                .padding(bottom = 32.dp)
                .verticalScroll(rememberScrollState()),
        ) {
            // Title
            Text(
                text = stringResource(R.string.hub_onboarding_title),
                style = MaterialTheme.typography.headlineSmall,
                modifier = Modifier
                    .padding(bottom = 4.dp)
                    .testTag("onboarding-title"),
            )

            // Step indicator
            StepIndicator(
                currentStep = currentStep,
                completedSteps = onboardingState?.completedSteps ?: emptyList(),
            )

            HorizontalDivider(modifier = Modifier.padding(vertical = 12.dp))

            // Step content
            when (currentStep) {
                OnboardingStep.TEMPLATE -> {
                    ProviderTemplateList(
                        templates = templates,
                        isLoading = isLoadingTemplates,
                        onSelectTemplate = { template ->
                            onSelectTemplate(template.id)
                            currentStep = OnboardingStep.CHANNELS
                        },
                        onStartFromScratch = {
                            onSelectTemplate(null)
                            currentStep = OnboardingStep.CHANNELS
                        },
                    )
                }

                OnboardingStep.CHANNELS -> {
                    ChannelChecklist(
                        channels = channels,
                        onToggle = onToggleChannel,
                        title = stringResource(R.string.hub_onboarding_channel_checklist_title),
                        description = stringResource(R.string.hub_onboarding_channel_checklist_description),
                        testTag = "onboarding-channel-checklist",
                    )

                    Spacer(modifier = Modifier.height(16.dp))

                    Row(modifier = Modifier.fillMaxWidth()) {
                        OutlinedButton(
                            onClick = { currentStep = OnboardingStep.TEMPLATE },
                            modifier = Modifier.weight(1f),
                        ) {
                            Text(stringResource(R.string.hub_onboarding_step_template))
                        }
                        Spacer(modifier = Modifier.width(8.dp))
                        Button(
                            onClick = {
                                onCompleteStep(OnboardingStep.CHANNELS.key, channels)
                                currentStep = OnboardingStep.PROVIDER
                            },
                            modifier = Modifier
                                .weight(1f)
                                .testTag("onboarding-next-provider"),
                            enabled = !isCompletingStep,
                        ) {
                            if (isCompletingStep) {
                                CircularProgressIndicator(
                                    modifier = Modifier.width(16.dp).height(16.dp),
                                )
                            } else {
                                Text(stringResource(R.string.hub_onboarding_step_provider))
                            }
                        }
                    }
                }

                OnboardingStep.PROVIDER -> {
                    Column {
                        Text(
                            text = stringResource(R.string.hub_onboarding_provider_connection_title),
                            style = MaterialTheme.typography.titleMedium,
                        )
                        Text(
                            text = stringResource(R.string.hub_onboarding_provider_connection_description),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(top = 4.dp),
                        )

                        Spacer(modifier = Modifier.height(16.dp))

                        Button(
                            onClick = onNavigateToProviderSetup,
                            modifier = Modifier
                                .fillMaxWidth()
                                .testTag("onboarding-connect-provider"),
                        ) {
                            Text(stringResource(R.string.hub_onboarding_provider_connection_title))
                        }

                        Spacer(modifier = Modifier.height(8.dp))

                        Row(modifier = Modifier.fillMaxWidth()) {
                            OutlinedButton(
                                onClick = { currentStep = OnboardingStep.CHANNELS },
                                modifier = Modifier.weight(1f),
                            ) {
                                Text(stringResource(R.string.hub_onboarding_step_channels))
                            }
                            Spacer(modifier = Modifier.width(8.dp))
                            Button(
                                onClick = {
                                    onCompleteStep(OnboardingStep.PROVIDER.key, null)
                                    currentStep = OnboardingStep.PHONE_NUMBER
                                },
                                modifier = Modifier
                                    .weight(1f)
                                    .testTag("onboarding-next-phone"),
                                enabled = !isCompletingStep,
                            ) {
                                Text(stringResource(R.string.hub_onboarding_step_phone_number))
                            }
                        }
                    }
                }

                OnboardingStep.PHONE_NUMBER -> {
                    Column {
                        Text(
                            text = stringResource(R.string.hub_onboarding_phone_number_title),
                            style = MaterialTheme.typography.titleMedium,
                        )
                        Text(
                            text = stringResource(R.string.hub_onboarding_phone_number_description),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(top = 4.dp),
                        )

                        Spacer(modifier = Modifier.height(16.dp))

                        Button(
                            onClick = onNavigateToPhoneNumbers,
                            modifier = Modifier
                                .fillMaxWidth()
                                .testTag("onboarding-phone-numbers"),
                        ) {
                            Text(stringResource(R.string.hub_onboarding_phone_number_title))
                        }

                        Spacer(modifier = Modifier.height(8.dp))

                        Row(modifier = Modifier.fillMaxWidth()) {
                            OutlinedButton(
                                onClick = { currentStep = OnboardingStep.PROVIDER },
                                modifier = Modifier.weight(1f),
                            ) {
                                Text(stringResource(R.string.hub_onboarding_step_provider))
                            }
                            Spacer(modifier = Modifier.width(8.dp))
                            Button(
                                onClick = {
                                    onCompleteStep(OnboardingStep.PHONE_NUMBER.key, null)
                                    currentStep = OnboardingStep.SUMMARY
                                },
                                modifier = Modifier
                                    .weight(1f)
                                    .testTag("onboarding-next-summary"),
                                enabled = !isCompletingStep,
                            ) {
                                Text(stringResource(R.string.hub_onboarding_step_summary))
                            }
                        }
                    }
                }

                OnboardingStep.SUMMARY -> {
                    Column {
                        Text(
                            text = stringResource(R.string.hub_onboarding_summary_title),
                            style = MaterialTheme.typography.titleMedium,
                        )
                        Text(
                            text = stringResource(R.string.hub_onboarding_summary_description),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(top = 4.dp),
                        )

                        Spacer(modifier = Modifier.height(16.dp))

                        // Summary items
                        SummaryItem(
                            label = stringResource(R.string.hub_onboarding_step_channels),
                            isComplete = onboardingState?.completedSteps?.contains("channel_selection") == true,
                        )
                        SummaryItem(
                            label = stringResource(R.string.hub_onboarding_step_provider),
                            isComplete = onboardingState?.completedSteps?.contains("provider_connection") == true,
                        )
                        SummaryItem(
                            label = stringResource(R.string.hub_onboarding_step_phone_number),
                            isComplete = onboardingState?.completedSteps?.contains("phone_number") == true,
                        )

                        Spacer(modifier = Modifier.height(16.dp))

                        Button(
                            onClick = { onCompleteStep(OnboardingStep.SUMMARY.key, null) },
                            modifier = Modifier
                                .fillMaxWidth()
                                .testTag("onboarding-complete"),
                            enabled = !isCompletingStep,
                        ) {
                            if (isCompletingStep) {
                                CircularProgressIndicator(
                                    modifier = Modifier.width(16.dp).height(16.dp),
                                )
                            } else {
                                Text(stringResource(R.string.hub_onboarding_complete_setup))
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun StepIndicator(
    currentStep: OnboardingStep,
    completedSteps: List<String>,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 8.dp)
            .testTag("onboarding-step-indicator"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        OnboardingStep.entries.forEachIndexed { index, step ->
            val isCompleted = step.key in completedSteps
            val isCurrent = step == currentStep

            Icon(
                imageVector = if (isCompleted) {
                    Icons.Filled.CheckCircle
                } else {
                    Icons.Filled.RadioButtonUnchecked
                },
                contentDescription = stringResource(step.labelResId),
                tint = when {
                    isCompleted -> MaterialTheme.colorScheme.primary
                    isCurrent -> MaterialTheme.colorScheme.secondary
                    else -> MaterialTheme.colorScheme.outlineVariant
                },
            )
            if (index < OnboardingStep.entries.size - 1) {
                Spacer(modifier = Modifier.width(4.dp))
            }
        }
    }
}

@Composable
private fun SummaryItem(
    label: String,
    isComplete: Boolean,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = if (isComplete) {
                Icons.Filled.CheckCircle
            } else {
                Icons.Filled.RadioButtonUnchecked
            },
            contentDescription = null,
            tint = if (isComplete) {
                MaterialTheme.colorScheme.primary
            } else {
                MaterialTheme.colorScheme.outlineVariant
            },
        )
        Spacer(modifier = Modifier.width(8.dp))
        Text(
            text = label,
            style = MaterialTheme.typography.bodyMedium,
        )
        Spacer(modifier = Modifier.weight(1f))
        Text(
            text = if (isComplete) {
                stringResource(R.string.hub_onboarding_summary_configured)
            } else {
                stringResource(R.string.hub_onboarding_summary_pending)
            },
            style = MaterialTheme.typography.labelSmall,
            color = if (isComplete) {
                MaterialTheme.colorScheme.primary
            } else {
                MaterialTheme.colorScheme.onSurfaceVariant
            },
        )
    }
}
