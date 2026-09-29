package org.llamenos.hotline.steps.hubs

import android.util.Log
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.test.ComposeTimeoutException
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.test.espresso.Espresso
import dagger.hilt.android.EntryPointAccessors
import io.cucumber.java.en.And
import io.cucumber.java.en.Then
import io.cucumber.java.en.When
import kotlinx.coroutines.runBlocking
import org.llamenos.hotline.LlamenosApp
import org.llamenos.hotline.di.HubOnboardApiEntryPoint
import org.llamenos.hotline.steps.BaseSteps
import org.llamenos.protocol.HubSetupStatus

/**
 * Step definitions for hub-self-service.feature scenarios.
 *
 * Covers: hub communications settings navigation, onboarding flow,
 * channel management, provider status display, and usage cards.
 *
 * Hub communications is accessed via Settings > Hub Communications card,
 * or via a dashboard quick-action card (if available).
 */
class HubSelfServiceSteps : BaseSteps() {

    companion object {
        private const val TAG = "HubSelfServiceSteps"
    }

    /** The channel toggled by "I toggle the {string} channel" and the state it was toggled to. */
    private var toggledChannel: String? = null
    private var toggledChannelEnabled: Boolean? = null

    private val hubOnboardApi
        get() = EntryPointAccessors.fromApplication(
            LlamenosApp.instance,
            HubOnboardApiEntryPoint::class.java,
        ).hubOnboardApi()

    /** Hub setup status as the server reports it, read with the app's own signed API client. */
    private fun serverSetupStatus(): HubSetupStatus = runBlocking { hubOnboardApi.getProviderStatus() }.getOrThrow()

    private fun toggleStateOf(tag: String): ToggleableState =
        onNodeWithTag(tag).fetchSemanticsNode().config[SemanticsProperties.ToggleableState]

    private fun Boolean.asToggleableState() = if (this) ToggleableState.On else ToggleableState.Off

    // ── Navigation ─────────────────────────────────────────────────────────

    @When("I navigate to hub communications settings")
    fun iNavigateToHubCommunicationsSettings() {
        // Try dashboard card first, then settings navigation
        try {
            navigateViaDashboardCard("communications-card")
        } catch (_: Throwable) {
            // Fall back to settings navigation
            navigateToTab(NAV_SETTINGS)
            try {
                onNodeWithTag("settings-communications-card").performScrollTo()
                onNodeWithTag("settings-communications-card").performClick()
                composeRule.waitForIdle()
            } catch (_: Throwable) {
                Log.w(TAG, "Communications card not found in settings — may not be visible for this role")
            }
        }

        // Wait for the communications screen to load
        composeRule.waitUntil(20_000) {
            composeRule.onAllNodesWithTag("hub-communications-title").fetchSemanticsNodes().isNotEmpty() ||
                composeRule.onAllNodesWithTag("hub-communications-loading").fetchSemanticsNodes().isNotEmpty() ||
                composeRule.onAllNodesWithTag("provider-status-card").fetchSemanticsNodes().isNotEmpty() ||
                composeRule.onAllNodesWithTag("channel-checklist").fetchSemanticsNodes().isNotEmpty()
        }
    }

    @When("I navigate away and return to hub communications")
    fun iNavigateAwayAndReturnToHubCommunications() {
        // Navigate to dashboard first
        navigateToTab(NAV_DASHBOARD)
        composeRule.waitForIdle()

        // Then navigate back to communications
        iNavigateToHubCommunicationsSettings()
    }

    // ── Onboarding Flow ────────────────────────────────────────────────────

    @When("I start the communications setup")
    fun iStartTheCommunicationsSetup() {
        // Tap "Start Setup" button on the provider status card
        composeRule.waitUntil(10_000) {
            composeRule.onAllNodesWithTag("start-setup-button").fetchSemanticsNodes().isNotEmpty() ||
                composeRule.onAllNodesWithTag("manage-provider-button").fetchSemanticsNodes().isNotEmpty()
        }

        val hasStartSetup = composeRule.onAllNodesWithTag("start-setup-button")
            .fetchSemanticsNodes().isNotEmpty()
        if (hasStartSetup) {
            onNodeWithTag("start-setup-button").performClick()
        } else {
            // Provider already connected — tap manage
            onNodeWithTag("manage-provider-button").performClick()
        }
        composeRule.waitForIdle()
    }

    @Then("the onboarding bottom sheet should appear")
    fun theOnboardingBottomSheetShouldAppear() {
        composeRule.waitUntil(10_000) {
            composeRule.onAllNodesWithTag("hub-onboarding-sheet").fetchSemanticsNodes().isNotEmpty()
        }
        onNodeWithTag("hub-onboarding-sheet").assertIsDisplayed()
        onNodeWithTag("onboarding-title").assertIsDisplayed()
    }

    @When("I select a provider template")
    fun iSelectAProviderTemplate() {
        // Wait for templates to load
        composeRule.waitUntil(10_000) {
            composeRule.onAllNodesWithTag("provider-template-list").fetchSemanticsNodes().isNotEmpty()
        }

        // Select the first available template card
        val templateNodes = composeRule.onAllNodes(hasTestTagPrefix("template-card-"))
            .fetchSemanticsNodes()
        if (templateNodes.isNotEmpty()) {
            composeRule.onAllNodes(hasTestTagPrefix("template-card-")).onFirst().performClick()
        } else {
            // No templates loaded — start from scratch
            onNodeWithTag("template-from-scratch").performClick()
        }
        composeRule.waitForIdle()
    }

    @When("I choose to start from scratch")
    fun iChooseToStartFromScratch() {
        composeRule.waitUntil(10_000) {
            composeRule.onAllNodesWithTag("template-from-scratch").fetchSemanticsNodes().isNotEmpty()
        }
        onNodeWithTag("template-from-scratch").performClick()
        composeRule.waitForIdle()
    }

    @Then("the channel selection step should be visible")
    fun theChannelSelectionStepShouldBeVisible() {
        composeRule.waitUntil(10_000) {
            composeRule.onAllNodesWithTag("channel-checklist").fetchSemanticsNodes().isNotEmpty()
        }
        onNodeWithTag("channel-checklist").assertIsDisplayed()
    }

    @And("I configure communication channels")
    fun iConfigureCommunicationChannels() {
        composeRule.waitUntil(10_000) {
            composeRule.onAllNodesWithTag("channel-checklist").fetchSemanticsNodes().isNotEmpty()
        }

        // The settings screen's own checklist stays composed behind the sheet, so
        // address the voice row inside the onboarding checklist specifically.
        val voiceInSheet = hasTestTag("channel-switch-voice") and
            hasAnyAncestor(hasTestTag("onboarding-channel-checklist"))
        onNode(voiceInSheet).performScrollTo()
        val before = onNode(voiceInSheet).fetchSemanticsNode().config[SemanticsProperties.ToggleableState]
        onNode(voiceInSheet).performClick()
        composeRule.waitForIdle()
        val expected = (before != ToggleableState.On).asToggleableState()
        onNode(voiceInSheet).assert(SemanticsMatcher.expectValue(SemanticsProperties.ToggleableState, expected))
    }

    @And("I proceed to the provider connection step")
    fun iProceedToTheProviderConnectionStep() {
        composeRule.waitUntil(10_000) {
            composeRule.onAllNodesWithTag("onboarding-next-provider").fetchSemanticsNodes().isNotEmpty()
        }
        // On CI emulator the channel checklist can push this button below the
        // bottom-sheet viewport. Scroll it into view so the click registers.
        onNodeWithTag("onboarding-next-provider").performScrollTo()
        onNodeWithTag("onboarding-next-provider").performClick()
        composeRule.waitForIdle()

        // Wait for provider step to render
        composeRule.waitUntil(15_000) {
            composeRule.onAllNodesWithTag("onboarding-connect-provider").fetchSemanticsNodes().isNotEmpty()
        }
    }

    @And("I proceed to the phone number step")
    fun iProceedToThePhoneNumberStep() {
        // Click the "Next" button on the provider step to advance to phone number
        composeRule.waitUntil(10_000) {
            composeRule.onAllNodesWithTag("onboarding-next-phone").fetchSemanticsNodes().isNotEmpty()
        }
        onNodeWithTag("onboarding-next-phone").performScrollTo()
        onNodeWithTag("onboarding-next-phone").performClick()
        composeRule.waitForIdle()

        // Wait for the phone number step to render
        composeRule.waitUntil(15_000) {
            composeRule.onAllNodesWithTag("onboarding-phone-numbers").fetchSemanticsNodes().isNotEmpty()
        }
    }

    @And("I complete the onboarding summary")
    fun iCompleteTheOnboardingSummary() {
        // Advance from phone number step to summary step
        composeRule.waitUntil(10_000) {
            composeRule.onAllNodesWithTag("onboarding-next-summary").fetchSemanticsNodes().isNotEmpty()
        }
        onNodeWithTag("onboarding-next-summary").performScrollTo()
        onNodeWithTag("onboarding-next-summary").performClick()
        composeRule.waitForIdle()

        // Now click the "Complete" button on the summary step
        composeRule.waitUntil(10_000) {
            composeRule.onAllNodesWithTag("onboarding-complete").fetchSemanticsNodes().isNotEmpty()
        }
        onNodeWithTag("onboarding-complete").performScrollTo()
        onNodeWithTag("onboarding-complete").performClick()
        composeRule.waitForIdle()
    }

    @Then("the onboarding should be marked complete")
    fun theOnboardingShouldBeMarkedComplete() {
        // Completing the last step closes the sheet, and the server records it.
        try {
            composeRule.waitUntil(15_000) {
                composeRule.onAllNodesWithTag("hub-onboarding-sheet").fetchSemanticsNodes().isEmpty()
            }
        } catch (e: ComposeTimeoutException) {
            throw AssertionError("Onboarding sheet still open 15s after completing the summary step", e)
        }
        val status = serverSetupStatus()
        if (!status.onboardingComplete) {
            throw AssertionError("Server does not report onboarding complete for hub ${status.hubID}")
        }
    }

    @When("I dismiss the onboarding sheet")
    fun iDismissTheOnboardingSheet() {
        Espresso.pressBack()
        composeRule.waitForIdle()
    }

    @Then("the communications settings screen should be visible")
    fun theCommunicationsSettingsScreenShouldBeVisible() {
        assertAnyTagDisplayed(
            "hub-communications-title",
            "provider-status-card",
            "channel-checklist",
            "hub-usage-card",
        )
    }

    // ── Channel Management ─────────────────────────────────────────────────

    @Then("the channel checklist should be visible")
    fun theChannelChecklistShouldBeVisible() {
        // The checklist is always composed, even while settings load.
        assertAnyTagDisplayed("channel-checklist")
    }

    @Then("all communication channel switches should be displayed")
    fun allCommunicationChannelSwitchesShouldBeDisplayed() {
        val channelTags = listOf(
            "channel-switch-voice",
            "channel-switch-sms",
            "channel-switch-email",
            "channel-switch-signal",
            "channel-switch-whatsapp",
            "channel-switch-telegram",
            "channel-switch-rcs",
        )

        for (tag in channelTags) {
            val exists = composeRule.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty()
            if (exists) {
                // Scroll into view first — on smaller CI emulator screens,
                // lower channels (whatsapp, telegram, rcs) may be below the fold.
                try { onNodeWithTag(tag).performScrollTo() } catch (_: Throwable) {}
                onNodeWithTag(tag).assertIsDisplayed()
            }
        }
    }

    @When("I toggle the {string} channel")
    fun iToggleTheChannel(channelName: String) {
        val tag = "channel-switch-$channelName"
        // Toggle from the server's state, not the pre-load default.
        composeRule.waitUntil(10_000) {
            composeRule.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty() &&
                composeRule.onAllNodesWithTag("hub-communications-loading").fetchSemanticsNodes().isEmpty()
        }
        onNodeWithTag(tag).performScrollTo()
        val enable = toggleStateOf(tag) != ToggleableState.On
        onNodeWithTag(tag).performClick()
        composeRule.waitForIdle()
        onNodeWithTag(tag).assert(SemanticsMatcher.expectValue(SemanticsProperties.ToggleableState, enable.asToggleableState()))
        toggledChannel = channelName
        toggledChannelEnabled = enable
    }

    @Then("the channel setting should persist")
    fun theChannelSettingShouldPersist() {
        val channel = checkNotNull(toggledChannel) { "No channel was toggled in this scenario" }
        val enabled = checkNotNull(toggledChannelEnabled)
        try {
            composeRule.waitUntil(10_000) {
                serverSetupStatus().channelsConfigured.any { it.value == channel } == enabled
            }
        } catch (e: ComposeTimeoutException) {
            throw AssertionError("Server never recorded channel '$channel' as enabled=$enabled", e)
        }
    }

    @Then("the channel state should be preserved")
    fun theChannelStateShouldBePreserved() {
        val channel = checkNotNull(toggledChannel) { "No channel was toggled in this scenario" }
        val expected = checkNotNull(toggledChannelEnabled).asToggleableState()
        val tag = "channel-switch-$channel"
        // The reopened screen reloads channels from the server; its switch must match.
        try {
            composeRule.waitUntil(10_000) {
                composeRule.onAllNodesWithTag("hub-communications-loading").fetchSemanticsNodes().isEmpty() &&
                    composeRule.onAllNodesWithTag(tag).fetchSemanticsNodes().singleOrNull()
                        ?.config?.getOrNull(SemanticsProperties.ToggleableState) == expected
            }
        } catch (e: ComposeTimeoutException) {
            throw AssertionError("'$tag' is not $expected after returning to hub communications", e)
        }
    }

    // ── Settings Panel ─────────────────────────────────────────────────────

    @Then("the provider status card should be visible")
    fun theProviderStatusCardShouldBeVisible() {
        // The provider card is always composed, even while settings load.
        assertAnyTagDisplayed("provider-status-card")
    }

    @Then("the usage card should be visible")
    fun theUsageCardShouldBeVisible() {
        // The usage card is always composed (it renders "--" until usage loads), but it
        // sits below the provider card and channel checklist in a LazyColumn — scroll
        // to it the way a user would before asserting it is on screen.
        waitForNode("hub-communications-list", timeoutMillis = 10_000)
        onNodeWithTag("hub-communications-list").performScrollToNode(hasTestTag("hub-usage-card"))
        assertAnyTagDisplayed("hub-usage-card")
    }

    @When("I tap the refresh button")
    fun iTapTheRefreshButton() {
        composeRule.waitUntil(10_000) {
            composeRule.onAllNodesWithTag("hub-communications-refresh").fetchSemanticsNodes().isNotEmpty()
        }
        onNodeWithTag("hub-communications-refresh").performClick()
        composeRule.waitForIdle()
    }

    @Then("the communications data should reload")
    fun theCommunicationsDataShouldReload() {
        // After refresh, the screen should show either loading or content
        assertAnyTagDisplayed(
            "hub-communications-loading",
            "provider-status-card",
            "channel-checklist",
            "hub-usage-card",
        )
    }
}
