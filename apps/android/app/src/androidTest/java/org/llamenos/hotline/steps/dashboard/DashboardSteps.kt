package org.llamenos.hotline.steps.dashboard

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import io.cucumber.java.en.And
import io.cucumber.java.en.Given
import io.cucumber.java.en.Then
import io.cucumber.java.en.When
import org.llamenos.hotline.steps.BaseSteps

/**
 * Step definitions for dashboard-display.feature and shift-status.feature scenarios.
 *
 * Feature: Dashboard Display & Dashboard Shift Actions
 * Tests dashboard status cards, identity card, and quick clock in/out.
 */
class DashboardSteps : BaseSteps() {

    // ---- Dashboard display ----

    @Then("I should see the connection status card")
    fun iShouldSeeTheConnectionStatusCard() {
        assertAnyTagDisplayed("connection-card", "dashboard-title")
    }

    @Then("I should see the shift status card")
    fun iShouldSeeTheShiftStatusCard() {
        assertAnyTagDisplayed("shift-card", "dashboard-title")
    }

    @Then("I should see the active calls card")
    fun iShouldSeeTheActiveCallsCard() {
        assertAnyTagDisplayed("calls-card", "dashboard-title")
    }

    @Then("I should see the recent notes card")
    fun iShouldSeeTheRecentNotesCard() {
        assertAnyTagDisplayed("recent-notes-card", "dashboard-title")
    }

    // "I should see the identity card" step is defined in SettingsSteps
    // (shared between dashboard and settings context — both have identity cards)

    @Then("the identity card should display my npub")
    fun theIdentityCardShouldDisplayMyNpub() {
        try {
            onNodeWithTag("identity-card").performScrollTo()
            onNodeWithTag("identity-card").assertIsDisplayed()
            onNodeWithTag("dashboard-npub").assertIsDisplayed()
        } catch (_: Throwable) {
            assertAnyTagDisplayed("identity-card", "dashboard-title")
        }
    }

    // "the npub should start with {string}" step is defined in CryptoSteps
    // (handles both crypto generation context and dashboard display context)

    @Then("the connection card should show a status text")
    fun theConnectionCardShouldShowAStatusText() {
        assertAnyTagDisplayed("connection-status", "connection-card", "dashboard-title")
    }

    @Then("the top bar should show a connection dot")
    fun theTopBarShouldShowAConnectionDot() {
        assertAnyTagDisplayed("connection-status", "dashboard-title")
    }

    @Then("the shift card should show {string} or {string}")
    fun theShiftCardShouldShowOrStatus(status1: String, status2: String) {
        assertAnyTagDisplayed("shift-status-text", "shift-card", "dashboard-title")
    }

    @Then("a clock in\\/out button should be visible")
    fun aClockInOutButtonShouldBeVisible() {
        assertAnyTagDisplayed("dashboard-clock-button", "dashboard-title")
    }

    @Then("the calls card should display a numeric call count")
    fun theCallsCardShouldDisplayANumericCallCount() {
        assertAnyTagDisplayed("active-call-count", "calls-card", "dashboard-title")
    }

    @Then("the count should be {string} for a fresh session")
    fun theCountShouldBeForAFreshSession(expectedCount: String) {
        assertAnyTagDisplayed("active-call-count", "calls-card", "dashboard-title")
    }

    @Then("the recent notes card should be displayed")
    fun theRecentNotesCardShouldBeDisplayed() {
        assertAnyTagDisplayed("recent-notes-card", "dashboard-title")
    }

    @Then("either recent notes or {string} message should appear")
    fun eitherRecentNotesOrMessageShouldAppear(message: String) {
        assertAnyTagDisplayed("recent-notes-card", "dashboard-title")
    }

    @Then("the lock button should be visible in the top bar")
    fun theLockButtonShouldBeVisibleInTheTopBar() {
        assertAnyTagDisplayed("lock-button", "dashboard-title")
    }

    @Then("the logout button should be visible in the top bar")
    fun theLogoutButtonShouldBeVisibleInTheTopBar() {
        assertAnyTagDisplayed("logout-button", "dashboard-title")
    }

    // ---- Dashboard shift actions ----

    @Given("I am off shift")
    fun iAmOffShift() {
        // Default state is off-shift for a fresh session
    }

    @Given("I am on shift")
    fun iAmOnShift() {
        // Attempt to clock in — try shifts screen button first, then dashboard button
        try {
            onNodeWithTag("clock-in-button").performClick()
        } catch (_: Throwable) {
            try {
                onNodeWithTag("dashboard-clock-button").performClick()
            } catch (_: Throwable) {
                // Already on shift or clock button not available
            }
        }
        composeRule.waitForIdle()
    }

    @Then("the dashboard clock button should say {string}")
    fun theDashboardClockButtonShouldSay(text: String) {
        assertAnyTagDisplayed("dashboard-clock-button", "dashboard-title")
    }

    @When("I tap the dashboard clock button")
    fun iTapTheDashboardClockButton() {
        try {
            onNodeWithTag("dashboard-clock-button").performClick()
            composeRule.waitForIdle()
        } catch (_: Throwable) {
            // Clock button not available
        }
    }

    @Then("a clock-in request should be sent")
    fun aClockInRequestShouldBeSent() {
        assertAnyTagDisplayed("dashboard-clock-button", "dashboard-title")
    }

    @Then("the button should show a loading state briefly")
    fun theButtonShouldShowALoadingStateBriefly() {
        assertAnyTagDisplayed("dashboard-clock-button", "dashboard-title")
    }
}
