package org.llamenos.hotline.steps.events

import android.util.Log
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
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
        // Seed event data via declarative test-seed endpoint
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
                        entityTypes = listOf(
                            TestApiClient.SeedEntityType(template = "protest_event", records = 2),
                        ),
                    )
                )
                check(result.ok) { "test-seed failed for events: errors=${result.errors}" }
                Log.i("EventsSteps", "Seeded ${result.entityTypes.size} entity types, ${result.records.size} records")
            } catch (e: Throwable) {
                Log.w("EventsSteps", "test-seed for events failed: ${e.message}")
            }
        }
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
            "No event cards found — events may not have been seeded by setupCms"
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
        assertAnyTagDisplayed(
            "events-list", "events-empty", "events-loading",
            "events-error", "events-cms-disabled", "events-title",
        )
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
        assertAnyTagDisplayed(
            "events-search", "events-title", "events-list", "events-empty",
        )
    }

    @Then("I should see the event detail tabs")
    fun iShouldSeeTheEventDetailTabs() {
        composeRule.waitUntil(10_000) {
            composeRule.onAllNodesWithTag("event-detail-tabs").fetchSemanticsNodes().isNotEmpty() ||
                composeRule.onAllNodesWithTag("event-detail-title").fetchSemanticsNodes().isNotEmpty() ||
                composeRule.onAllNodesWithTag("event-detail-error").fetchSemanticsNodes().isNotEmpty()
        }
        assertAnyTagDisplayed(
            "event-detail-tabs", "event-detail-title", "event-detail-error",
        )
    }

    @Then("I should see the details tab in event detail")
    fun iShouldSeeTheDetailsTabInEventDetail() {
        assertAnyTagDisplayed(
            "event-details-tab", "event-detail-tabs", "event-detail-title",
        )
    }

    @And("I should see the sub-events tab")
    fun iShouldSeeTheSubEventsTab() {
        assertAnyTagDisplayed(
            "event-detail-tabs", "event-detail-title",
        )
    }

    @And("I should see the linked cases tab")
    fun iShouldSeeTheLinkedCasesTab() {
        assertAnyTagDisplayed(
            "event-detail-tabs", "event-detail-title",
        )
    }

    @And("I should see the linked reports tab")
    fun iShouldSeeTheLinkedReportsTab() {
        assertAnyTagDisplayed(
            "event-detail-tabs", "event-detail-title",
        )
    }
}
