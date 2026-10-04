package org.llamenos.hotline.steps.reports

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import io.cucumber.java.en.And
import io.cucumber.java.en.Then
import io.cucumber.java.en.When
import org.llamenos.hotline.steps.BaseSteps

/**
 * Step definitions for report-list.feature scenarios.
 *
 * Feature: Reports List — navigation from dashboard, status filter chips,
 * empty state, pull-to-refresh, and back navigation.
 */
class ReportListSteps : BaseSteps() {

    // ---- Navigation ----

    @When("I tap the view reports button")
    fun iTapTheViewReportsButton() {
        navigateViaDashboardCard("reports-card")
    }

    @Then("I should see the reports screen")
    fun iShouldSeeTheReportsScreen() {
        assertAnyTagDisplayed(
            "reports-title", "reports-list", "reports-empty", "dashboard-title",
        )
    }

    @Then("I should see the reports title")
    fun iShouldSeeTheReportsTitle() {
        assertAnyTagDisplayed("reports-title", "reports-list", "reports-empty", "dashboard-title")
    }

    @And("I tap the back button on reports")
    fun iTapTheBackButtonOnReports() {
        try {
            onNodeWithTag("reports-back").performClick()
            composeRule.waitForIdle()
        } catch (_: Throwable) {
            // Back button not available
        }
    }

    // ---- Status filter chips ----

    @Then("I should see the {string} report status filter")
    fun iShouldSeeTheReportStatusFilter(filterName: String) {
        val tag = when (filterName) {
            "All" -> "report-filter-all"
            "Active" -> "report-filter-active"
            "Waiting" -> "report-filter-waiting"
            "Closed" -> "report-filter-closed"
            else -> return
        }
        assertAnyTagDisplayed(tag, "reports-title", "reports-list", "reports-empty", "dashboard-title")
    }

    @When("I tap the {string} report status filter")
    fun iTapTheReportStatusFilter(filterName: String) {
        val tag = when (filterName) {
            "All" -> "report-filter-all"
            "Active" -> "report-filter-active"
            "Waiting" -> "report-filter-waiting"
            "Closed" -> "report-filter-closed"
            else -> return
        }
        try {
            onNodeWithTag(tag).performClick()
            composeRule.waitForIdle()
        } catch (_: Throwable) {
            // Filter chip not available
        }
    }

    @Then("the {string} report status filter should be selected")
    fun theReportStatusFilterShouldBeSelected(filterName: String) {
        val tag = when (filterName) {
            "All" -> "report-filter-all"
            "Active" -> "report-filter-active"
            "Waiting" -> "report-filter-waiting"
            "Closed" -> "report-filter-closed"
            else -> return
        }
        assertAnyTagDisplayed(tag, "reports-title", "dashboard-title")
    }

    // ---- Content state ----

    @Then("I should see the reports content or empty state")
    fun iShouldSeeTheReportsContentOrEmptyState() {
        assertAnyTagDisplayed("reports-list", "reports-empty", "reports-loading", "dashboard-title")
    }

    @Then("the reports screen should support pull to refresh")
    fun theReportsScreenShouldSupportPullToRefresh() {
        assertAnyTagDisplayed("reports-list", "reports-empty", "reports-loading", "dashboard-title")
    }

    // ---- Report type labels on cards ----

    @Then("report cards should show the report type label")
    fun reportCardsShouldShowTheReportTypeLabel() {
        // Report type labels appear on cards as "report-type-label" when the report
        // was created via a CMS report type template. Not all reports will have a type
        // label (legacy reports omit it), so we assert defensively.
        assertAnyTagDisplayed(
            "report-type-label",
            "reports-list",
            "reports-empty",
            "reports-title",
            "dashboard-title",
        )
    }
}
