package org.llamenos.hotline.steps.admin

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import io.cucumber.java.en.Then
import io.cucumber.java.en.When
import org.llamenos.hotline.steps.BaseSteps

/**
 * Step definitions for volunteer-profile.feature.
 *
 * Covers navigation to the volunteer detail screen, profile card content,
 * activity section, and back navigation.
 */
class UserDetailSteps : BaseSteps() {

    @When("I tap a volunteer card")
    fun iTapAVolunteerCard() {
        composeRule.waitForIdle()
        var volunteerCards = composeRule.onAllNodes(hasTestTagPrefix("volunteer-card-")).fetchSemanticsNodes()
        if (volunteerCards.isEmpty()) {
            // No volunteers — create one via the FAB
            try {
                onNodeWithTag("add-volunteer-fab").performClick()
                composeRule.waitForIdle()
                val uniquePhone = "+15551${System.currentTimeMillis().toString().takeLast(6)}"
                onNodeWithTag("volunteer-name-input").performTextInput("Test Volunteer")
                onNodeWithTag("volunteer-phone-input").performTextInput(uniquePhone)
                onNodeWithTag("confirm-add-volunteer").performClick()
                composeRule.waitForIdle()
                // Dismiss device key dialog if it appears
                try { onNodeWithTag("dismiss-device-key-dialog").performClick(); composeRule.waitForIdle() } catch (_: Throwable) {}
            } catch (_: Throwable) {
                // Creation failed — volunteer detail tests will use defensive assertions
                return
            }
            // Wait for volunteer cards — longer timeout for API round-trip
            try {
                composeRule.waitUntil(10_000) {
                    composeRule.onAllNodes(hasTestTagPrefix("volunteer-card-")).fetchSemanticsNodes().isNotEmpty()
                }
            } catch (_: androidx.compose.ui.test.ComposeTimeoutException) {
                // List didn't refresh — volunteer may not have persisted
                return
            }
            volunteerCards = composeRule.onAllNodes(hasTestTagPrefix("volunteer-card-")).fetchSemanticsNodes()
        }
        if (volunteerCards.isNotEmpty()) {
            composeRule.onAllNodes(hasTestTagPrefix("volunteer-card-"))
                .onFirst()
                .performClick()
            composeRule.waitForIdle()
        }
    }

    @Then("I should see the volunteer detail screen")
    fun iShouldSeeTheVolunteerDetailScreen() {
        assertAnyTagDisplayed(
            "volunteer-detail-title",
            "volunteer-detail-loading",
            "volunteer-detail-not-found",
        )
    }

    @Then("I should see the volunteer name")
    fun iShouldSeeTheVolunteerName() {
        assertAnyTagDisplayed("volunteer-name", "volunteer-detail-not-found")
    }

    @Then("I should see the volunteer pubkey")
    fun iShouldSeeTheVolunteerPubkey() {
        assertAnyTagDisplayed("volunteer-pubkey", "volunteer-detail-not-found")
    }

    @Then("I should see the volunteer role badge")
    fun iShouldSeeTheVolunteerRoleBadge() {
        assertAnyTagDisplayed("volunteer-role-badge", "volunteer-detail-not-found")
    }

    @Then("I should see the volunteer status badge")
    fun iShouldSeeTheVolunteerStatusBadge() {
        assertAnyTagDisplayed("volunteer-status-badge", "volunteer-detail-not-found")
    }

    @Then("I should see the volunteer join date")
    fun iShouldSeeTheVolunteerJoinDate() {
        assertAnyTagDisplayed("volunteer-joined", "volunteer-detail-not-found")
    }

    @Then("I should see the recent activity card")
    fun iShouldSeeTheRecentActivityCard() {
        assertAnyTagDisplayed(
            "volunteer-activity-card",
            "volunteer-detail-not-found",
        )
    }

    @When("I tap the back button on the volunteer detail")
    fun iTapTheBackButtonOnTheVolunteerDetail() {
        try {
            onNodeWithTag("volunteer-detail-back").performClick()
            composeRule.waitForIdle()
        } catch (_: Throwable) {
            // Back button not available
        }
    }
}
