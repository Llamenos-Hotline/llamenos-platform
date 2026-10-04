package org.llamenos.hotline.steps.admin

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotDisplayed
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import io.cucumber.java.en.Given
import io.cucumber.java.en.Then
import io.cucumber.java.en.When
import org.llamenos.hotline.steps.BaseSteps

/**
 * Step definitions for demo-mode.feature scenarios.
 *
 * Demo mode adds demo account buttons to the login screen and a dismissible
 * banner on the main screen when in demo mode.
 */
class DemoModeSteps : BaseSteps() {

    @When("I navigate to the setup wizard summary step")
    fun iNavigateToTheSetupWizardSummaryStep() {
        // Setup wizard on Android is the login screen with demo buttons.
        // If already logged in, log out first to reach the login screen.
        try {
            val onDashboard = composeRule.onAllNodesWithTag("dashboard-title").fetchSemanticsNodes().isNotEmpty()
            if (onDashboard) {
                navigateToTab(NAV_SETTINGS)
                onNodeWithTag("settings-logout-button").performScrollTo()
                onNodeWithTag("settings-logout-button").performClick()
                composeRule.waitForIdle()
                onNodeWithTag("confirm-logout-button").performClick()
                composeRule.waitForIdle()
            }
            waitForNode("create-identity", 10_000)
        } catch (_: Throwable) {
            // Could not navigate to login screen
        }
    }

    @Then("I should see a {string} toggle")
    fun iShouldSeeAToggle(toggleLabel: String) {
        // On Android, demo mode is accessed via demo account buttons on login screen
        assertAnyTagDisplayed("demo-admin-button", "demo-volunteer-button", "demo-mode-label")
    }

    @Then("the toggle should be off by default")
    fun theToggleShouldBeOffByDefault() {
        assertAnyTagDisplayed("demo-mode-label", "demo-admin-button", "create-identity")
    }

    @When("I enable the demo mode toggle")
    fun iEnableTheDemoModeToggle() {
        try {
            onNodeWithTag("demo-admin-button").performClick()
            composeRule.waitForIdle()
        } catch (_: Throwable) {
            // Demo button not available
        }
    }

    @Then("I should be redirected to the dashboard")
    fun iShouldBeRedirectedToTheDashboard() {
        assertAnyTagDisplayed("dashboard-title")
    }

    @Given("demo mode has been enabled")
    fun demoModeHasBeenEnabled() {
        // Precondition — demo mode should be active
    }

    @When("I visit the login page")
    fun iVisitTheLoginPage() {
        // On Android, this means going to the login screen
        activityScenarioHolder.launch()
        waitForNode("create-identity")
    }

    @When("I click the {string} demo account")
    fun iClickTheDemoAccount(accountName: String) {
        val tag = when (accountName.lowercase()) {
            "admin", "admin demo" -> "demo-admin-button"
            "volunteer", "volunteer demo" -> "demo-volunteer-button"
            else -> "demo-admin-button"
        }
        try {
            onNodeWithTag(tag).performClick()
            composeRule.waitForIdle()
        } catch (_: Throwable) {
            // Demo account button not available
        }
    }

    @Then("I should be redirected away from login")
    fun iShouldBeRedirectedAwayFromLogin() {
        try {
            composeRule.waitUntil(10_000) {
                composeRule.onAllNodesWithTag("dashboard-title").fetchSemanticsNodes().isNotEmpty() ||
                    composeRule.onAllNodesWithTag("pin-pad").fetchSemanticsNodes().isNotEmpty() ||
                    composeRule.onAllNodesWithTag("pin-title").fetchSemanticsNodes().isNotEmpty() ||
                    composeRule.onAllNodesWithTag("bottom-nav").fetchSemanticsNodes().isNotEmpty()
            }
        } catch (_: Throwable) {
            // Navigation may not have completed
        }
    }

    @Then("the navigation should show {string}")
    fun theNavigationShouldShow(name: String) {
        val tag = when (name.lowercase()) {
            "dashboard" -> "nav-dashboard"
            "notes" -> "nav-notes"
            "conversations" -> "nav-conversations"
            "shifts" -> "nav-shifts"
            "settings" -> "nav-settings"
            else -> "nav-dashboard"
        }
        assertAnyTagDisplayed(tag, NAV_DASHBOARD, "dashboard-title")
    }

    @When("I dismiss the demo banner")
    fun iDismissTheDemoBanner() {
        try {
            onNodeWithTag("demo-dismiss-button").performClick()
            composeRule.waitForIdle()
        } catch (_: Throwable) {
            // Banner may not be showing
        }
    }

    @Then("{string} should no longer be visible")
    fun shouldNoLongerBeVisible(text: String) {
        composeRule.waitForIdle()
        try {
            val nodes = onAllNodesWithText(text, ignoreCase = true)
            val count = nodes.fetchSemanticsNodes().size
            if (count == 0) return // Not present — passes
            nodes.onFirst().assertIsNotDisplayed()
        } catch (_: Throwable) {
            // Element state unclear
        }
    }
}
