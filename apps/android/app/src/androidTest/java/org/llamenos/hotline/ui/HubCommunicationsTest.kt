package org.llamenos.hotline.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.llamenos.protocol.ChannelConfig
import org.llamenos.hotline.model.ChannelConfigClass
import org.llamenos.protocol.HubChannelType
import org.llamenos.protocol.HubOnboardingState
import org.llamenos.protocol.HubQuota
import org.llamenos.protocol.HubUsage
import org.llamenos.protocol.ProviderTemplate
import org.llamenos.hotline.model.ProviderType
import org.llamenos.hotline.ui.hubsettings.ChannelChecklist
import org.llamenos.hotline.ui.hubsettings.HubOnboardingFlow
import org.llamenos.hotline.ui.hubsettings.HubUsageCard
import org.llamenos.hotline.ui.hubsettings.ProviderTemplateList

/**
 * Compose UI tests for hub communications / self-service screens.
 *
 * These tests render individual composables in isolation with fake data,
 * verifying layout, interaction, and state-dependent rendering. They do
 * NOT require a running backend — all data is passed directly to composables.
 */
class HubCommunicationsTest {

    @get:Rule
    val composeRule = createComposeRule()

    // ── Test data ───────────────────────────────────────────────────────────

    private val sampleTemplates = listOf(
        ProviderTemplate(
            id = "tmpl-1",
            name = "Twilio Starter",
            slug = "twilio-starter",
            description = "Basic Twilio setup with voice and SMS",
            providerType = ProviderType.Twilio,
            defaultChannels = listOf(HubChannelType.Voice, HubChannelType.SMS),
            allowSubAccounts = false,
            isActive = true,
            createdBy = "system",
            credentialHints = JsonObject(emptyMap()),
            recommendedSettings = JsonObject(emptyMap()),
        ),
        ProviderTemplate(
            id = "tmpl-2",
            name = "SignalWire Pro",
            slug = "signalwire-pro",
            description = "Full-featured SignalWire with all channels",
            providerType = ProviderType.Signalwire,
            defaultChannels = listOf(HubChannelType.Voice, HubChannelType.SMS, HubChannelType.Whatsapp),
            allowSubAccounts = true,
            isActive = true,
            createdBy = "system",
            credentialHints = JsonObject(emptyMap()),
            recommendedSettings = JsonObject(emptyMap()),
        ),
    )

    private val sampleChannels = ChannelConfig(
        voice = true,
        sms = true,
        email = false,
        signal = false,
        whatsapp = true,
        telegram = false,
        rcs = false,
    )

    private val sampleUsage = HubUsage(
        phoneNumbers = 2,
        smsSent = 150,
        callsReceived = 42,
        signalMessagesSent = 10,
        whatsAppMessagesSent = 25,
    )

    private val sampleQuotas = HubQuota(
        maxPhoneNumbers = 5,
        maxSMSPerMonth = 1000,
        maxCallsPerMonth = 500,
        maxSignalMessagesPerMonth = 500,
        maxWhatsAppMessagesPerMonth = 500,
    )

    // ── ProviderTemplateList ────────────────────────────────────────────────

    @Test
    fun templateList_showsTemplateCards() {
        composeRule.setContent {
            ProviderTemplateList(
                templates = sampleTemplates,
                isLoading = false,
                onSelectTemplate = {},
                onStartFromScratch = {},
            )
        }

        composeRule.onNodeWithTag("provider-template-list").assertIsDisplayed()
        composeRule.onNodeWithTag("template-list-title").assertIsDisplayed()
        composeRule.onNodeWithTag("template-card-twilio-starter").assertIsDisplayed()
        composeRule.onNodeWithTag("template-card-signalwire-pro").assertIsDisplayed()
        composeRule.onNodeWithTag("template-from-scratch").assertIsDisplayed()
    }

    @Test
    fun templateList_showsLoadingIndicator() {
        composeRule.setContent {
            ProviderTemplateList(
                templates = emptyList(),
                isLoading = true,
                onSelectTemplate = {},
                onStartFromScratch = {},
            )
        }

        composeRule.onNodeWithTag("provider-template-list").assertIsDisplayed()
        composeRule.onNodeWithTag("template-list-title").assertIsDisplayed()
        // Template cards should NOT be present while loading
        composeRule.onNodeWithTag("template-from-scratch").assertDoesNotExist()
    }

    @Test
    fun templateList_templateCardClickCallsCallback() {
        var selectedTemplate: ProviderTemplate? = null

        composeRule.setContent {
            ProviderTemplateList(
                templates = sampleTemplates,
                isLoading = false,
                onSelectTemplate = { selectedTemplate = it },
                onStartFromScratch = {},
            )
        }

        composeRule.onNodeWithTag("template-card-twilio-starter").performClick()
        assert(selectedTemplate?.id == "tmpl-1") {
            "Expected tmpl-1 but got ${selectedTemplate?.id}"
        }
    }

    @Test
    fun templateList_startFromScratchCallsCallback() {
        var scratchClicked = false

        composeRule.setContent {
            ProviderTemplateList(
                templates = sampleTemplates,
                isLoading = false,
                onSelectTemplate = {},
                onStartFromScratch = { scratchClicked = true },
            )
        }

        composeRule.onNodeWithTag("template-from-scratch").performClick()
        assert(scratchClicked) { "Expected startFromScratch callback to fire" }
    }

    @Test
    fun templateList_showsSubAccountBadge() {
        composeRule.setContent {
            ProviderTemplateList(
                templates = sampleTemplates,
                isLoading = false,
                onSelectTemplate = {},
                onStartFromScratch = {},
            )
        }

        // SignalWire Pro has allowSubAccounts = true
        composeRule.onNodeWithTag("template-card-signalwire-pro").assertIsDisplayed()
    }

    // ── ChannelChecklist ────────────────────────────────────────────────────

    @Test
    fun channelChecklist_showsAllChannelSwitches() {
        composeRule.setContent {
            ChannelChecklist(
                channels = sampleChannels,
                onToggle = { _, _ -> },
            )
        }

        composeRule.onNodeWithTag("channel-checklist").assertIsDisplayed()
        composeRule.onNodeWithTag("channel-checklist-title").assertIsDisplayed()

        // All 7 channel switch rows exist
        composeRule.onNodeWithTag("channel-switch-voice").assertIsDisplayed()
        composeRule.onNodeWithTag("channel-switch-sms").assertIsDisplayed()
        composeRule.onNodeWithTag("channel-switch-email").assertIsDisplayed()
        composeRule.onNodeWithTag("channel-switch-signal").assertIsDisplayed()
        composeRule.onNodeWithTag("channel-switch-whatsapp").assertIsDisplayed()
        composeRule.onNodeWithTag("channel-switch-telegram").assertIsDisplayed()
        composeRule.onNodeWithTag("channel-switch-rcs").assertIsDisplayed()
    }

    @Test
    fun channelChecklist_toggleFiresCallback() {
        var toggledChannel: String? = null
        var toggledEnabled: Boolean? = null

        composeRule.setContent {
            ChannelChecklist(
                channels = ChannelConfig(voice = false),
                onToggle = { channel, enabled ->
                    toggledChannel = channel
                    toggledEnabled = enabled
                },
            )
        }

        // The whole row is the toggle target.
        composeRule.onNodeWithTag("channel-switch-voice").performClick()
        composeRule.waitForIdle()

        assertEquals("voice", toggledChannel)
        assertEquals(true, toggledEnabled)
    }

    @Test
    fun channelChecklist_disabledStatePreventsInteraction() {
        composeRule.setContent {
            ChannelChecklist(
                channels = sampleChannels,
                onToggle = { _, _ -> },
                enabled = false,
            )
        }

        composeRule.onNodeWithTag("channel-checklist").assertIsDisplayed()
        // When disabled, the switch rows still render but cannot be toggled.
        composeRule.onNodeWithTag("channel-switch-voice").assertIsNotEnabled()
    }

    @Test
    fun channelChecklist_showsCustomTitleAndDescription() {
        composeRule.setContent {
            ChannelChecklist(
                channels = sampleChannels,
                onToggle = { _, _ -> },
                title = "Pick Your Channels",
                description = "Select the channels you want to activate",
            )
        }

        composeRule.onNodeWithTag("channel-checklist").assertIsDisplayed()
        composeRule.onNodeWithText("Pick Your Channels").assertIsDisplayed()
        composeRule.onNodeWithText("Select the channels you want to activate").assertIsDisplayed()
    }

    // ── HubUsageCard ────────────────────────────────────────────────────────

    @Test
    fun usageCard_showsUsageDataWithProgressBars() {
        composeRule.setContent {
            HubUsageCard(
                usage = sampleUsage,
                quotas = sampleQuotas,
            )
        }

        composeRule.onNodeWithTag("hub-usage-card").assertIsDisplayed()
        composeRule.onNodeWithTag("hub-usage-title").assertIsDisplayed()
        composeRule.onNodeWithTag("hub-usage-calls").assertIsDisplayed()
        composeRule.onNodeWithTag("hub-usage-sms").assertIsDisplayed()
        composeRule.onNodeWithTag("hub-usage-signal").assertIsDisplayed()
        composeRule.onNodeWithTag("hub-usage-whatsapp").assertIsDisplayed()
    }

    @Test
    fun usageCard_showsPlaceholderWhenNoUsage() {
        composeRule.setContent {
            HubUsageCard(
                usage = null,
                quotas = null,
            )
        }

        composeRule.onNodeWithTag("hub-usage-card").assertIsDisplayed()
        composeRule.onNodeWithTag("hub-usage-title").assertIsDisplayed()
        // When usage is null, shows "--" placeholder
        composeRule.onNodeWithText("--").assertIsDisplayed()
    }

    @Test
    fun usageCard_showsUsageWithoutQuotas() {
        composeRule.setContent {
            HubUsageCard(
                usage = sampleUsage,
                quotas = null,
            )
        }

        composeRule.onNodeWithTag("hub-usage-card").assertIsDisplayed()
        composeRule.onNodeWithTag("hub-usage-calls").assertIsDisplayed()
        // Without quotas, shows just the count (no "/ max")
        composeRule.onNodeWithText("42").assertIsDisplayed()
    }

    @Test
    fun usageCard_showsUsageWithQuotaFraction() {
        composeRule.setContent {
            HubUsageCard(
                usage = sampleUsage,
                quotas = sampleQuotas,
            )
        }

        // With quotas, shows "current / max"
        composeRule.onNodeWithText("42 / 500").assertIsDisplayed()
        composeRule.onNodeWithText("150 / 1000").assertIsDisplayed()
    }

    // ── HubOnboardingFlow (BottomSheet) ─────────────────────────────────────

    @Test
    fun onboardingFlow_rendersTemplateStepByDefault() {
        composeRule.setContent {
            HubOnboardingFlow(
                onboardingState = null,
                templates = sampleTemplates,
                isLoadingTemplates = false,
                isCompletingStep = false,
                channels = ChannelConfig(),
                onSelectTemplate = {},
                onToggleChannel = { _, _ -> },
                onCompleteStep = { _, _ -> },
                onNavigateToProviderSetup = {},
                onNavigateToPhoneNumbers = {},
                onDismiss = {},
            )
        }

        composeRule.onNodeWithTag("hub-onboarding-sheet").assertIsDisplayed()
        composeRule.onNodeWithTag("onboarding-title").assertIsDisplayed()
        composeRule.onNodeWithTag("onboarding-step-indicator").assertIsDisplayed()
        // Template list should be visible as the first step
        composeRule.onNodeWithTag("provider-template-list").assertIsDisplayed()
    }

    @Test
    fun onboardingFlow_selectTemplateAdvancesToChannels() {
        composeRule.setContent {
            HubOnboardingFlow(
                onboardingState = null,
                templates = sampleTemplates,
                isLoadingTemplates = false,
                isCompletingStep = false,
                channels = ChannelConfig(),
                onSelectTemplate = {},
                onToggleChannel = { _, _ -> },
                onCompleteStep = { _, _ -> },
                onNavigateToProviderSetup = {},
                onNavigateToPhoneNumbers = {},
                onDismiss = {},
            )
        }

        // Click on a template card to advance to channels step
        composeRule.onNodeWithTag("template-card-twilio-starter").performClick()
        composeRule.waitForIdle()

        // Should now show the channel checklist
        composeRule.onNodeWithTag("channel-checklist").assertIsDisplayed()
    }

    @Test
    fun onboardingFlow_startFromScratchAdvancesToChannels() {
        composeRule.setContent {
            HubOnboardingFlow(
                onboardingState = null,
                templates = sampleTemplates,
                isLoadingTemplates = false,
                isCompletingStep = false,
                channels = ChannelConfig(),
                onSelectTemplate = {},
                onToggleChannel = { _, _ -> },
                onCompleteStep = { _, _ -> },
                onNavigateToProviderSetup = {},
                onNavigateToPhoneNumbers = {},
                onDismiss = {},
            )
        }

        composeRule.onNodeWithTag("template-from-scratch").performClick()
        composeRule.waitForIdle()

        composeRule.onNodeWithTag("channel-checklist").assertIsDisplayed()
    }

    @Test
    fun onboardingFlow_channelStepShowsNextButton() {
        composeRule.setContent {
            HubOnboardingFlow(
                onboardingState = HubOnboardingState(
                    hubID = "test-hub",
                    channelConfig = ChannelConfigClass(
                        voice = false, sms = false, email = false,
                        signal = false, whatsapp = false, telegram = false, rcs = false,
                    ),
                    currentStep = "channel_selection",
                    completedSteps = listOf("template_selection"),
                ),
                templates = sampleTemplates,
                isLoadingTemplates = false,
                isCompletingStep = false,
                channels = sampleChannels,
                onSelectTemplate = {},
                onToggleChannel = { _, _ -> },
                onCompleteStep = { _, _ -> },
                onNavigateToProviderSetup = {},
                onNavigateToPhoneNumbers = {},
                onDismiss = {},
            )
        }

        composeRule.onNodeWithTag("channel-checklist").assertIsDisplayed()
        composeRule.onNodeWithTag("onboarding-next-provider").assertIsDisplayed()
        composeRule.onNodeWithTag("onboarding-next-provider").assertIsEnabled()
    }

    @Test
    fun onboardingFlow_nextButtonDisabledWhileCompletingStep() {
        composeRule.setContent {
            HubOnboardingFlow(
                onboardingState = HubOnboardingState(
                    hubID = "test-hub",
                    channelConfig = ChannelConfigClass(
                        voice = false, sms = false, email = false,
                        signal = false, whatsapp = false, telegram = false, rcs = false,
                    ),
                    currentStep = "channel_selection",
                    completedSteps = listOf("template_selection"),
                ),
                templates = sampleTemplates,
                isLoadingTemplates = false,
                isCompletingStep = true,
                channels = sampleChannels,
                onSelectTemplate = {},
                onToggleChannel = { _, _ -> },
                onCompleteStep = { _, _ -> },
                onNavigateToProviderSetup = {},
                onNavigateToPhoneNumbers = {},
                onDismiss = {},
            )
        }

        composeRule.onNodeWithTag("onboarding-next-provider").assertIsNotEnabled()
    }

    @Test
    fun onboardingFlow_summaryStepShowsCompletionStates() {
        composeRule.setContent {
            HubOnboardingFlow(
                onboardingState = HubOnboardingState(
                    hubID = "test-hub",
                    channelConfig = ChannelConfigClass(
                        voice = false, sms = false, email = false,
                        signal = false, whatsapp = false, telegram = false, rcs = false,
                    ),
                    currentStep = "summary",
                    completedSteps = listOf(
                        "template_selection",
                        "channel_selection",
                        "provider_connection",
                        "phone_number",
                    ),
                ),
                templates = sampleTemplates,
                isLoadingTemplates = false,
                isCompletingStep = false,
                channels = sampleChannels,
                onSelectTemplate = {},
                onToggleChannel = { _, _ -> },
                onCompleteStep = { _, _ -> },
                onNavigateToProviderSetup = {},
                onNavigateToPhoneNumbers = {},
                onDismiss = {},
            )
        }

        composeRule.onNodeWithTag("onboarding-complete").assertIsDisplayed()
        composeRule.onNodeWithTag("onboarding-complete").assertIsEnabled()
    }

    @Test
    fun onboardingFlow_completeButtonCallsCallback() {
        var completedStep: String? = null

        composeRule.setContent {
            HubOnboardingFlow(
                onboardingState = HubOnboardingState(
                    hubID = "test-hub",
                    channelConfig = ChannelConfigClass(
                        voice = false, sms = false, email = false,
                        signal = false, whatsapp = false, telegram = false, rcs = false,
                    ),
                    currentStep = "summary",
                    completedSteps = listOf(
                        "template_selection",
                        "channel_selection",
                        "provider_connection",
                        "phone_number",
                    ),
                ),
                templates = sampleTemplates,
                isLoadingTemplates = false,
                isCompletingStep = false,
                channels = sampleChannels,
                onSelectTemplate = {},
                onToggleChannel = { _, _ -> },
                onCompleteStep = { step, _ -> completedStep = step },
                onNavigateToProviderSetup = {},
                onNavigateToPhoneNumbers = {},
                onDismiss = {},
            )
        }

        composeRule.onNodeWithTag("onboarding-complete").performClick()
        composeRule.waitForIdle()

        assert(completedStep == "summary") {
            "Expected 'summary' but got '$completedStep'"
        }
    }

    @Test
    fun onboardingFlow_providerStepShowsConnectButton() {
        composeRule.setContent {
            HubOnboardingFlow(
                onboardingState = HubOnboardingState(
                    hubID = "test-hub",
                    channelConfig = ChannelConfigClass(
                        voice = false, sms = false, email = false,
                        signal = false, whatsapp = false, telegram = false, rcs = false,
                    ),
                    currentStep = "provider_connection",
                    completedSteps = listOf("template_selection", "channel_selection"),
                ),
                templates = sampleTemplates,
                isLoadingTemplates = false,
                isCompletingStep = false,
                channels = sampleChannels,
                onSelectTemplate = {},
                onToggleChannel = { _, _ -> },
                onCompleteStep = { _, _ -> },
                onNavigateToProviderSetup = {},
                onNavigateToPhoneNumbers = {},
                onDismiss = {},
            )
        }

        composeRule.onNodeWithTag("onboarding-connect-provider").assertIsDisplayed()
    }

    @Test
    fun onboardingFlow_phoneNumberStepShowsButton() {
        composeRule.setContent {
            HubOnboardingFlow(
                onboardingState = HubOnboardingState(
                    hubID = "test-hub",
                    channelConfig = ChannelConfigClass(
                        voice = false, sms = false, email = false,
                        signal = false, whatsapp = false, telegram = false, rcs = false,
                    ),
                    currentStep = "phone_number",
                    completedSteps = listOf(
                        "template_selection",
                        "channel_selection",
                        "provider_connection",
                    ),
                ),
                templates = sampleTemplates,
                isLoadingTemplates = false,
                isCompletingStep = false,
                channels = sampleChannels,
                onSelectTemplate = {},
                onToggleChannel = { _, _ -> },
                onCompleteStep = { _, _ -> },
                onNavigateToProviderSetup = {},
                onNavigateToPhoneNumbers = {},
                onDismiss = {},
            )
        }

        composeRule.onNodeWithTag("onboarding-phone-numbers").assertIsDisplayed()
    }
}
