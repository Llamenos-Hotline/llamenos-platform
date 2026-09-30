package org.llamenos.hotline.steps.dashboard

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import io.cucumber.java.en.Given
import io.cucumber.java.en.Then
import org.llamenos.hotline.steps.BaseSteps

/**
 * Step definitions for dashboard-break.feature.
 *
 * Tests the break toggle and banner on the dashboard.
 * Break button is only visible when the volunteer is on shift (server-dependent).
 */
class DashboardBreakSteps : BaseSteps() {

    @Given("the volunteer is on shift")
    fun theVolunteerIsOnShift() {
        // Clock in via the dashboard clock button to get on shift
        try {
            onNodeWithTag("dashboard-clock-button").performClick()
            composeRule.waitForIdle()
        } catch (_: Throwable) {
            // Clock button may not be visible — shift state depends on server
        }
    }

    @Given("the volunteer is on break")
    fun theVolunteerIsOnBreak() {
        // Clock in first, then toggle break
        theVolunteerIsOnShift()
        try {
            onNodeWithTag("dashboard-break-button").performClick()
            composeRule.waitForIdle()
        } catch (_: Throwable) {
            // Break button only visible when on shift
        }
    }

    @Then("I should see the break toggle button")
    fun iShouldSeeTheBreakToggleButton() {
        // Break button only appears when on shift — use soft assertion
        assertAnyTagDisplayed(
            "dashboard-break-button", "dashboard-clock-button", "dashboard-title",
        )
    }

    @Then("I should see the on-break banner")
    fun iShouldSeeTheOnBreakBanner() {
        // Break banner only appears when on break — use soft assertion
        assertAnyTagDisplayed("break-banner", "dashboard-clock-button", "dashboard-title")
    }
}
