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
        val client = checkNotNull(ScenarioHooks.apiClient) { "No API client — scenario hub was not provisioned" }
        val hubId = ScenarioHooks.currentHubId
        check(hubId.isNotEmpty()) { "No current hub — triage reports would be seeded nowhere" }
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
        // Every scenario using this step seeds triage reports first, so a card must exist.
        composeRule.waitUntil(10_000) {
            composeRule.onAllNodes(hasTestTagPrefix("triage-card-")).fetchSemanticsNodes().isNotEmpty()
        }
        onAllNodes(hasTestTagPrefix("triage-card-")).onFirst().performClick()
        composeRule.waitForIdle()

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
        assertAnyTagDisplayed("triage-list", "triage-empty", timeoutMillis = 10_000)
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
        assertAnyTagDisplayed("triage-filters")
    }

    @Then("I should see the triage detail view")
    fun iShouldSeeTheTriageDetailView() {
        // The loaded report, not just the TopAppBar title (composed before the fetch
        // resolves) or the not-found state.
        assertAnyTagDisplayed("triage-detail-report-title", timeoutMillis = 10_000)
    }

    @And("the triage report title should be visible")
    fun theTriageReportTitleShouldBeVisible() {
        assertAnyTagDisplayed("triage-detail-report-title")
    }

    @And("the triage report status should be visible")
    fun theTriageReportStatusShouldBeVisible() {
        assertAnyTagDisplayed("triage-detail-status")
    }

    @Then("the convert to case button should be visible")
    fun theConvertToCaseButtonShouldBeVisible() {
        // The scenario seeds open triage reports; the button shows for any non-closed
        // report and sits below the metadata card, so scroll to it first.
        waitForNode("triage-convert-button", timeoutMillis = 10_000)
        onNodeWithTag("triage-convert-button").performScrollTo()
        assertAnyTagDisplayed("triage-convert-button")
    }

    @Then("the convert confirmation dialog should appear")
    fun theConvertConfirmationDialogShouldAppear() {
        composeRule.waitUntil(10_000) {
            composeRule.onAllNodesWithTag("triage-convert-dialog").fetchSemanticsNodes().isNotEmpty()
        }
        onNodeWithTag("triage-convert-dialog").assertIsDisplayed()
    }
}
