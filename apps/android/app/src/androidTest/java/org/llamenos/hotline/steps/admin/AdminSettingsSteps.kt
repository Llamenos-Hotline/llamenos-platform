package org.llamenos.hotline.steps.admin

import io.cucumber.java.en.Given
import io.cucumber.java.en.Then
import io.cucumber.java.en.When
import org.llamenos.hotline.helpers.SimulationClient
import org.llamenos.hotline.steps.BaseSteps

/**
 * Step definitions for admin-settings.feature.
 *
 * Transcription steps assert BEHAVIOUR (#1743): the switches must show what
 * the server holds (load works), and flipping one must change what the server
 * holds (save works). "Transcription should be enabled" used to pass whenever
 * any admin chrome rendered — the toggle was never even clickable through its
 * tagged row, the throw was swallowed, and the Then asserted display only.
 */
class AdminSettingsSteps : BaseSteps() {

    private var transcriptionBefore: SimulationClient.TranscriptionSettingsResponse? = null

    @Given("I navigate to the admin settings tab")
    fun iNavigateToTheAdminSettingsTab() {
        navigateToAdminTab("settings")
    }

    @Then("I should see the transcription settings card")
    fun iShouldSeeTheTranscriptionSettingsCard() {
        // The card is "shown" when its controls reflect the server's settings —
        // a card frozen at defaults after a failed GET does not count.
        val server = SimulationClient.getTranscriptionSettings()
        awaitSwitchState("transcription-enabled-toggle", server.globalEnabled)
    }

    @Then("I should see the transcription enabled toggle")
    fun iShouldSeeTheTranscriptionEnabledToggle() {
        val server = SimulationClient.getTranscriptionSettings()
        awaitSwitchState("transcription-enabled-toggle", server.globalEnabled)
    }

    @Then("I should see the transcription opt-out toggle")
    fun iShouldSeeTheTranscriptionOptOutToggle() {
        val server = SimulationClient.getTranscriptionSettings()
        awaitSwitchState("transcription-optout-toggle", server.allowUserOptOut)
    }

    @When("I toggle transcription on")
    fun iToggleTranscriptionOn() {
        // Drive the setting to ON through the switch, whatever it started at:
        // if the server already has it on, flip it off first (verified) so the
        // second flip is a real state change the Then step can observe.
        val before = SimulationClient.getTranscriptionSettings()
        transcriptionBefore = before
        awaitSwitchState("transcription-enabled-toggle", before.globalEnabled)
        if (before.globalEnabled) {
            clickSwitchInRow("transcription-enabled-toggle")
            SimulationClient.awaitServerState(
                what = "transcription toggled off in preparation",
                fetch = { SimulationClient.getTranscriptionSettings() },
            ) { !it.globalEnabled }
            awaitSwitchState("transcription-enabled-toggle", false)
        }
        clickSwitchInRow("transcription-enabled-toggle")
    }

    @Then("transcription should be enabled")
    fun transcriptionShouldBeEnabled() {
        val before = checkNotNull(transcriptionBefore) {
            "'I toggle transcription on' must run before this step"
        }
        transcriptionBefore = null
        try {
            SimulationClient.awaitServerState(
                what = "globalEnabled=true after toggling transcription on",
                fetch = { SimulationClient.getTranscriptionSettings() },
            ) { it.globalEnabled }
        } finally {
            SimulationClient.authorizedPatch(
                "/api/settings/transcription",
                """{"globalEnabled":${before.globalEnabled},"allowUserOptOut":${before.allowUserOptOut}}""",
            )
        }
    }
}
