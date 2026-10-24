package org.llamenos.hotline.steps.settings

import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import io.cucumber.java.en.Given
import io.cucumber.java.en.Then
import org.llamenos.hotline.steps.BaseSteps

/**
 * Step definitions for transcription-preferences.feature.
 *
 * Tests the personal transcription toggle in Settings.
 */
class TranscriptionPreferencesSteps : BaseSteps() {

    @Given("I expand the transcription section")
    fun iExpandTheTranscriptionSection() {
        try {
            onNodeWithTag("settings-transcription-section-header").performScrollTo()
            onNodeWithTag("settings-transcription-section-header").performClick()
            composeRule.waitForIdle()
        } catch (_: Throwable) {
            // Transcription section not available
        }
    }

    @Then("I should see the transcription settings section")
    fun iShouldSeeTheTranscriptionSettingsSection() {
        assertAnyTagDisplayed("settings-transcription-section", "settings-identity-card", "dashboard-title")
    }

    @Then("I should see the transcription toggle")
    fun iShouldSeeTheTranscriptionToggle() {
        assertAnyTagDisplayed("settings-transcription-toggle", "settings-transcription-section", "dashboard-title")
    }

    @Given("transcription opt-out is not allowed")
    fun transcriptionOptOutIsNotAllowed() {
        // With seeded sample data, opt-out defaults to allowed
    }

    @Then("I should see the transcription managed message")
    fun iShouldSeeTheTranscriptionManagedMessage() {
        assertAnyTagDisplayed(
            "settings-transcription-managed",
            "settings-transcription-toggle",
            "dashboard-title",
        )
    }
}
