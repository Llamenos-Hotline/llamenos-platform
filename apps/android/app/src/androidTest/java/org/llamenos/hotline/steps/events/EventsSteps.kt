package org.llamenos.hotline.steps.events

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
 * Step definitions for event-management.feature scenarios.
 *
 * Covers: events list, event cards, search field, event detail
 * tabs (details, sub-events, linked cases, linked reports).
 *
 * Events are accessible via the dashboard "events-card" quick action.
 */
class EventsSteps : BaseSteps() {

    // ---- Given ----

    @Given("events exist in the system")
    fun eventsExistInTheSystem() {
        // Seed event data via declarative test-seed endpoint. A seeding failure fails
        // the step here, not three steps later as an unexplained empty list.
        val client = checkNotNull(ScenarioHooks.apiClient) { "No test API client — cannot seed events" }
        val hubId = ScenarioHooks.currentHubId
        check(hubId.isNotEmpty()) { "No scenario hub — cannot seed events" }
        val result = client.seed(
            TestApiClient.SeedSpec(
                hubId = hubId,
                adminSeed = ScenarioHooks.ADMIN_SEED,
                permissions = TestApiClient.SeedPermissions(
                    grantVolunteerCms = true,
                    enableCaseManagement = true,
                ),
                entityTypes = listOf(
                    TestApiClient.SeedEntityType(template = "protest_event", records = 2),
                ),
            )
        )
        check(result.ok) { "test-seed failed for events: errors=${result.errors}" }
        Log.i("EventsSteps", "Seeded ${result.entityTypes.size} entity types, ${result.records.size} records")
        iNavigateToTheEventsScreen()
    }

    // ---- When ----

    @When("I navigate to the Events screen")
    fun iNavigateToTheEventsScreen() {
        navigateViaDashboardCard("events-card")
        // Wait for the events screen to load
        composeRule.waitUntil(10_000) {
            composeRule.onAllNodesWithTag("events-title").fetchSemanticsNodes().isNotEmpty() ||
                composeRule.onAllNodesWithTag("events-list").fetchSemanticsNodes().isNotEmpty() ||
                composeRule.onAllNodesWithTag("events-loading").fetchSemanticsNodes().isNotEmpty() ||
                composeRule.onAllNodesWithTag("events-empty").fetchSemanticsNodes().isNotEmpty() ||
                composeRule.onAllNodesWithTag("events-error").fetchSemanticsNodes().isNotEmpty() ||
                composeRule.onAllNodesWithTag("events-cms-disabled").fetchSemanticsNodes().isNotEmpty()
        }
    }

    @When("I tap the first event card")
    fun iTapTheFirstEventCard() {
        // Wait for either event cards or empty/error state
        composeRule.waitUntil(15_000) {
            composeRule.onAllNodes(hasTestTagPrefix("event-card-"))
                .fetchSemanticsNodes().isNotEmpty() ||
                composeRule.onAllNodesWithTag("events-empty").fetchSemanticsNodes().isNotEmpty() ||
                composeRule.onAllNodesWithTag("events-error").fetchSemanticsNodes().isNotEmpty() ||
                composeRule.onAllNodesWithTag("events-cms-disabled").fetchSemanticsNodes().isNotEmpty()
        }

        val hasCards = composeRule.onAllNodes(hasTestTagPrefix("event-card-"))
            .fetchSemanticsNodes().isNotEmpty()
        check(hasCards) {
            val shown = listOf("events-empty", "events-error", "events-cms-disabled")
                .filter { composeRule.onAllNodesWithTag(it).fetchSemanticsNodes().isNotEmpty() }
            "No event cards found; the events screen settled on $shown"
        }

        onAllNodes(hasTestTagPrefix("event-card-")).onFirst().performClick()
        composeRule.waitForIdle()

        // Wait for event detail to load
        composeRule.waitUntil(10_000) {
            composeRule.onAllNodesWithTag("event-detail-title").fetchSemanticsNodes().isNotEmpty() ||
                composeRule.onAllNodesWithTag("event-detail-tabs").fetchSemanticsNodes().isNotEmpty() ||
                composeRule.onAllNodesWithTag("event-detail-loading").fetchSemanticsNodes().isNotEmpty() ||
                composeRule.onAllNodesWithTag("event-detail-error").fetchSemanticsNodes().isNotEmpty()
        }
    }

    // ---- Then ----

    @Then("I should see the events list or empty state")
    fun iShouldSeeTheEventsListOrEmptyState() {
        assertAnyTagDisplayed("events-list", "events-empty", timeoutMillis = 10_000)
    }

    @Then("I should see event cards or the empty state")
    fun iShouldSeeEventCardsOrTheEmptyState() {
        composeRule.waitUntil(10_000) {
            composeRule.onAllNodesWithTag("events-list").fetchSemanticsNodes().isNotEmpty() ||
                composeRule.onAllNodesWithTag("events-empty").fetchSemanticsNodes().isNotEmpty() ||
                composeRule.onAllNodesWithTag("events-loading").fetchSemanticsNodes().isNotEmpty() ||
                composeRule.onAllNodesWithTag("events-cms-disabled").fetchSemanticsNodes().isNotEmpty()
        }

        val hasList = composeRule.onAllNodesWithTag("events-list")
            .fetchSemanticsNodes().isNotEmpty()
        if (hasList) {
            val eventCards = composeRule.onAllNodes(hasTestTagPrefix("event-card-"))
                .fetchSemanticsNodes()
            if (eventCards.isNotEmpty()) {
                onAllNodes(hasTestTagPrefix("event-card-")).onFirst().assertIsDisplayed()
            }
        }
        // Empty or CMS disabled is valid
    }

    @Then("the events search field should be visible")
    fun theEventsSearchFieldShouldBeVisible() {
        assertAnyTagDisplayed("events-search")
    }

    @Then("I should see the event detail tabs")
    fun iShouldSeeTheEventDetailTabs() {
        assertAnyTagDisplayed("event-detail-tabs", timeoutMillis = 10_000)
    }

    @Then("I should see the details tab in event detail")
    fun iShouldSeeTheDetailsTabInEventDetail() {
        assertEventTabReachable("details", timeoutMillis = 10_000)
    }

    @And("I should see the sub-events tab")
    fun iShouldSeeTheSubEventsTab() {
        assertEventTabReachable("sub_events")
    }

    @And("I should see the linked cases tab")
    fun iShouldSeeTheLinkedCasesTab() {
        assertEventTabReachable("linked_cases")
    }

    @And("I should see the linked reports tab")
    fun iShouldSeeTheLinkedReportsTab() {
        assertEventTabReachable("linked_reports")
    }

    /**
     * The event detail tabs sit in a horizontally scrolling tab row that is wider
     * than a phone screen, so later tabs start off-screen. Scroll the tab into
     * view the way a user swipes the row, then require it to be displayed.
     */
    private fun assertEventTabReachable(slug: String, timeoutMillis: Long = 5_000) {
        val tag = "event-tab-$slug"
        waitForNode(tag, timeoutMillis)
        onNodeWithTag(tag).performScrollTo()
        onNodeWithTag(tag).assertIsDisplayed()
    }
}
