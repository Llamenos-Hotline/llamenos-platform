package org.llamenos.hotline.steps.dashboard

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotDisplayed
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import io.cucumber.java.en.Given
import io.cucumber.java.en.Then
import io.cucumber.java.en.When
import org.llamenos.hotline.steps.BaseSteps

/**
 * Step definitions for dashboard-errors.feature.
 *
 * Tests the dismissible error card on the dashboard.
 */
class DashboardErrorSteps : BaseSteps() {

    @Then("the dashboard error card should not be visible")
    fun theDashboardErrorCardShouldNotBeVisible() {
        onNodeWithTag("dashboard-error-card").assertDoesNotExist()
    }

    @Given("a dashboard error is displayed")
    fun aDashboardErrorIsDisplayed() {
        // Trigger a refresh that will fail without a reachable API
        // The error card visibility is what we test
        onNodeWithTag("dashboard-clock-button").performClick()
        composeRule.waitForIdle()
    }

    @When("I dismiss the dashboard error")
    fun iDismissTheDashboardError() {
        onNodeWithTag("dashboard-error-dismiss").performClick()
        composeRule.waitForIdle()
    }
}
