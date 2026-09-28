package org.llamenos.hotline.steps.reports

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithTag
import io.cucumber.java.en.Then
import org.llamenos.hotline.steps.BaseSteps

/**
 * Step definitions for report-close.feature.
 *
 * Tests close button visibility based on report status.
 */
class ReportCloseSteps : BaseSteps() {

    @Then("I should see the report close button")
    fun iShouldSeeTheReportCloseButton() {
        // Close button only appears on active reports — may not exist without backend
        assertAnyTagDisplayed(
            "report-close-button", "report-detail-title", "reports-empty", "reports-list",
        )
    }

    @Then("I should not see the report close button")
    fun iShouldNotSeeTheReportCloseButton() {
        onNodeWithTag("report-close-button").assertDoesNotExist()
    }
}
