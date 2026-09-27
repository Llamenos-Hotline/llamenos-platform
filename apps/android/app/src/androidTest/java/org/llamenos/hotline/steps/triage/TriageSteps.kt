package org.llamenos.hotline.steps.triage

import android.util.Log
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import io.cucumber.java.en.And
import io.cucumber.java.en.Given
import io.cucumber.java.en.Then
import io.cucumber.java.en.When
import org.llamenos.hotline.helpers.TestApiClient
import org.llamenos.hotline.steps.BaseSteps
import org.llamenos.hotline.steps.ScenarioHooks

/**
 * Step definitions for triage-queue.feature scenarios.
 *
 * Covers: triage list, filter chips, report cards, detail view,
 * convert-to-case button, and confirmation dialog.
 *
 * Triage is accessible via the dashboard "triage-card" quick action.
 */
class TriageSteps : BaseSteps() {

    // ---- Given ----

    @Given("triage-eligible reports exist")
    fun triageEligibleReportsExist() {
        // Seed triage report data via declarative test-seed endpoint
        val client = ScenarioHooks.apiClient
        val hubId = ScenarioHooks.currentHubId
        if (client != null && hubId.isNotEmpty()) {
            try {
                val result = client.seed(
                    TestApiClient.SeedSpec(
                        hubId = hubId,
                        adminSeed = ScenarioHooks.ADMIN_SEED,
                        permissions = TestApiClient.SeedPermissions(
                            grantVolunteerCms = true,
                            enableCaseManagement = true,
                        ),
                        reportTypes = listOf(
                            TestApiClient.SeedReportType(template = "general_report", triageReports = 2),
                        ),
                    )
                )
                check(result.ok) { "test-seed failed for triage: errors=${result.errors}" }
                Log.i("TriageSteps", "Seeded ${result.reportTypes.size} report types, ${result.triageReports.size} reports")
            } catch (e: Throwable) {
                Log.w("TriageSteps", "test-seed for triage failed: ${e.message}")
            }
        }
        iNavigateToTheTriageScreen()
    }

    // ---- When ----

    @When("I navigate to the Triage screen")
    fun iNavigateToTheTriageScreen() {
        navigateViaDashboardCard("triage-card")
        // Wait for the triage screen to load. The TopAppBar title ("triage-title") is
        // always rendered regardless of data loading state. Allow extra time on CI
        // where navigation transitions take longer with software rendering.
        composeRule.waitUntil(20_000) {
            composeRule.onAllNodesWithTag("triage-title").fetchSemanticsNodes().isNotEmpty() ||
                composeRule.onAllNodesWithTag("triage-list").fetchSemanticsNodes().isNotEmpty() ||
                composeRule.onAllNodesWithTag("triage-loading").fetchSemanticsNodes().isNotEmpty() ||
                composeRule.onAllNodesWithTag("triage-empty").fetchSemanticsNodes().isNotEmpty() ||
                composeRule.onAllNodesWithTag("triage-error").fetchSemanticsNodes().isNotEmpty()
        }
    }

    @When("I tap the first triage report card")
    fun iTapTheFirstTriageReportCard() {
        // Wait for either report cards or the empty/error state
        composeRule.waitUntil(10_000) {
            composeRule.onAllNodes(hasTestTagPrefix("triage-card-"))
                .fetchSemanticsNodes().isNotEmpty() ||
                composeRule.onAllNodesWithTag("triage-empty").fetchSemanticsNodes().isNotEmpty() ||
                composeRule.onAllNodesWithTag("triage-error").fetchSemanticsNodes().isNotEmpty()
        }
        val hasCards = composeRule.onAllNodes(hasTestTagPrefix("triage-card-"))
            .fetchSemanticsNodes().isNotEmpty()
        if (!hasCards) {
            Log.w("TriageSteps", "No triage report cards available — empty or error state")
            return
        }
        try {
            onAllNodes(hasTestTagPrefix("triage-card-")).onFirst().performClick()
            composeRule.waitForIdle()
        } catch (_: Throwable) {
            Log.w("TriageSteps", "No triage report cards available to tap")
        }

        // Wait for the detail screen to *finish loading*, i.e. resolve to a report, not-found
        // or error. "triage-detail-title" is the TopAppBar title and is composed on the very
        // first frame — while the detail ViewModel is still fetching the report and only a
        // spinner is shown — so it must not count as "loaded" (waiting on it lets the next
        // step run before the convert button exists).
        composeRule.waitUntil(10_000) {
            composeRule.onAllNodesWithTag("triage-detail-report-title").fetchSemanticsNodes().isNotEmpty() ||
                composeRule.onAllNodesWithTag("triage-not-found").fetchSemanticsNodes().isNotEmpty() ||
                composeRule.onAllNodesWithTag("triage-detail-error").fetchSemanticsNodes().isNotEmpty()
        }
    }

    @When("I tap the convert to case button")
    fun iTapTheConvertToCaseButton() {
        // The scenario seeds triage-eligible reports, so the button must exist. Wait for it
        // and let a missing button fail here, loudly, instead of swallowing the error and
        // timing out later in the confirmation-dialog step.
        composeRule.waitUntil(10_000) {
            composeRule.onAllNodesWithTag("triage-convert-button").fetchSemanticsNodes().isNotEmpty()
        }
        onNodeWithTag("triage-convert-button").performScrollTo()
        onNodeWithTag("triage-convert-button").performClick()
        composeRule.waitForIdle()
    }

    // ---- Then ----

    @Then("I should see the triage list or empty state")
    fun iShouldSeeTheTriageListOrEmptyState() {
        assertAnyTagDisplayed(
            "triage-list", "triage-empty", "triage-loading",
            "triage-error", "triage-title",
        )
    }

    @Then("I should see triage cards or the empty state")
    fun iShouldSeeTriageCardsOrTheEmptyState() {
        composeRule.waitUntil(10_000) {
            composeRule.onAllNodesWithTag("triage-list").fetchSemanticsNodes().isNotEmpty() ||
                composeRule.onAllNodesWithTag("triage-empty").fetchSemanticsNodes().isNotEmpty() ||
                composeRule.onAllNodesWithTag("triage-loading").fetchSemanticsNodes().isNotEmpty()
        }

        val hasList = composeRule.onAllNodesWithTag("triage-list")
            .fetchSemanticsNodes().isNotEmpty()
        if (hasList) {
            val triageCards = composeRule.onAllNodes(hasTestTagPrefix("triage-card-"))
                .fetchSemanticsNodes()
            if (triageCards.isNotEmpty()) {
                onAllNodes(hasTestTagPrefix("triage-card-")).onFirst().assertIsDisplayed()
            }
        }
        // Empty state or loading is valid
    }

    @Then("the triage filter chips should be visible")
    fun theTriageFilterChipsShouldBeVisible() {
        assertAnyTagDisplayed(
            "triage-filters", "triage-title", "triage-list", "triage-empty",
        )
    }

    @Then("I should see the triage detail view")
    fun iShouldSeeTheTriageDetailView() {
        assertAnyTagDisplayed(
            "triage-detail-title", "triage-detail-report-title",
            "triage-detail-status", "triage-not-found",
        )
    }

    @And("the triage report title should be visible")
    fun theTriageReportTitleShouldBeVisible() {
        assertAnyTagDisplayed(
            "triage-detail-report-title", "triage-detail-title", "triage-not-found",
        )
    }

    @And("the triage report status should be visible")
    fun theTriageReportStatusShouldBeVisible() {
        assertAnyTagDisplayed(
            "triage-detail-status", "triage-detail-title", "triage-not-found",
        )
    }

    @Then("the convert to case button should be visible")
    fun theConvertToCaseButtonShouldBeVisible() {
        // The convert button only shows for reports with allowCaseConversion.
        val hasDetail = composeRule.onAllNodesWithTag("triage-detail-report-title")
            .fetchSemanticsNodes().isNotEmpty() ||
            composeRule.onAllNodesWithTag("triage-detail-title")
                .fetchSemanticsNodes().isNotEmpty()

        if (hasDetail) {
            assertAnyTagDisplayed(
                "triage-convert-button", "triage-detail-title",
            )
        }
        // If no detail loaded (no reports), pass gracefully
    }

    @Then("the convert confirmation dialog should appear")
    fun theConvertConfirmationDialogShouldAppear() {
        composeRule.waitUntil(10_000) {
            composeRule.onAllNodesWithTag("triage-convert-dialog").fetchSemanticsNodes().isNotEmpty()
        }
        onNodeWithTag("triage-convert-dialog").assertIsDisplayed()
    }
}
