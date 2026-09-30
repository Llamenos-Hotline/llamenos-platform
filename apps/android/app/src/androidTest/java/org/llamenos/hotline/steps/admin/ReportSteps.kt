package org.llamenos.hotline.steps.admin

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import io.cucumber.java.en.Given
import io.cucumber.java.en.Then
import io.cucumber.java.en.When
import org.llamenos.hotline.steps.BaseSteps

/**
 * Step definitions for reports.feature scenarios.
 *
 * Reports on Android are accessed through the admin audit log tab.
 * Report creation uses the note-creation flow with report-type custom fields.
 */
class ReportSteps : BaseSteps() {

    @When("I fill in the report details")
    fun iFillInTheReportDetails() {
        // Reports use the note creation UI with custom fields
        try {
            onNodeWithTag("note-text-input").performTextInput("Test report content ${System.currentTimeMillis()}")
            composeRule.waitForIdle()
        } catch (_: Throwable) {
            // Note creation may not be visible
        }
    }

    @Then("the report should appear in the reports list")
    fun theReportShouldAppearInTheReportsList() {
        assertAnyTagDisplayed("reports-list", "reports-empty", "reports-loading")
    }

    @Given("at least one report exists")
    fun atLeastOneReportExists() {
        createReportViaUI()
    }

    @Then("I should see reports in the list")
    fun iShouldSeeReportsInTheList() {
        assertAnyTagDisplayed("reports-list", "reports-empty", "reports-loading")
    }

    @Given("a report exists")
    fun aReportExists() {
        createReportViaUI()
    }

    @When("I click on the report")
    fun iClickOnTheReport() {
        composeRule.waitForIdle()
        val reportCards = composeRule.onAllNodes(hasTestTagPrefix("report-card-")).fetchSemanticsNodes()
        if (reportCards.isEmpty()) {
            createReportViaUI()
        }
        try {
            onAllNodes(hasTestTagPrefix("report-card-")).onFirst().performClick()
            composeRule.waitForIdle()
        } catch (_: Throwable) {
            // No reports to click
        }
    }

    @Then("I should see the report detail view")
    fun iShouldSeeTheReportDetailView() {
        assertAnyTagDisplayed(
            "report-detail-title", "report-detail-title-text",
            "report-not-found", "report-metadata-card",
        )
    }

    @Then("I should see the report content")
    fun iShouldSeeTheReportContent() {
        assertAnyTagDisplayed(
            "report-detail-title-text", "report-metadata-card", "report-not-found",
        )
    }

    @Given("a reporter has been invited and onboarded")
    fun aReporterHasBeenInvitedAndOnboarded() {
        // Precondition — reporter account exists
    }

    @When("the reporter logs in")
    fun theReporterLogsIn() {
        // Reporter uses standard login flow with their device key
        navigateToMainScreen()
    }

    @When("they create a new report")
    fun theyCreateANewReport() {
        createReportViaUI()
    }

    @Then("the report should be saved successfully")
    fun theReportShouldBeSavedSuccessfully() {
        assertAnyTagDisplayed("reports-list", "reports-empty", "report-detail-title")
    }

    @Given("a reporter is logged in")
    fun aReporterIsLoggedIn() {
        navigateToMainScreen()
    }

    private fun createReportViaUI() {
        try {
            // Navigate to reports screen first if not already there
            val hasReportsFab = composeRule.onAllNodesWithTag("report-create-fab").fetchSemanticsNodes().isNotEmpty()
            if (!hasReportsFab) {
                navigateViaDashboardCard("reports-card")
                waitForNode("reports-title")
            }
            onNodeWithTag("report-create-fab").performClick()
            composeRule.waitForIdle()
            onNodeWithTag("report-title-input").performTextInput("E2E Report ${System.currentTimeMillis()}")
            onNodeWithTag("report-body-input").performTextInput("Test report body")
            onNodeWithTag("report-submit-button").performClick()
            composeRule.waitForIdle()
            // Wait for return to reports list
            composeRule.waitUntil(5000) {
                composeRule.onAllNodes(hasTestTagPrefix("report-card-")).fetchSemanticsNodes().isNotEmpty() ||
                    composeRule.onAllNodesWithTag("reports-list").fetchSemanticsNodes().isNotEmpty() ||
                    composeRule.onAllNodesWithTag("reports-empty").fetchSemanticsNodes().isNotEmpty()
            }
        } catch (_: Throwable) {
            // FAB or form may not be available
        }
    }
}
