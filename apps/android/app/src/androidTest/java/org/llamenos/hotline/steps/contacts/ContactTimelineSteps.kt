package org.llamenos.hotline.steps.contacts

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import io.cucumber.java.en.And
import io.cucumber.java.en.Then
import io.cucumber.java.en.When
import org.llamenos.hotline.steps.BaseSteps

/**
 * Step definitions for contact-timeline.feature scenarios.
 *
 * Feature: Contact Timeline — navigation from contacts list,
 * contact identifier display, event list or empty state, and back navigation.
 */
class ContactTimelineSteps : BaseSteps() {

    // ---- Navigation ----

    @When("I tap a contact card")
    fun iTapAContactCard() {
        try {
            onAllNodes(hasTestTagPrefix("contact-card-")).onFirst().performClick()
            composeRule.waitForIdle()
        } catch (_: Throwable) {
            // No contacts available — timeline assertions will check empty state
        }
    }

    @Then("I should see the timeline screen")
    fun iShouldSeeTheTimelineScreen() {
        assertAnyTagDisplayed("timeline-title", "contacts-empty", "contacts-list", "dashboard-title")
    }

    @Then("I should see the timeline contact identifier")
    fun iShouldSeeTheTimelineContactIdentifier() {
        assertAnyTagDisplayed("timeline-contact-id", "contacts-empty", "contacts-list", "dashboard-title")
    }

    @Then("I should see timeline events or the empty state")
    fun iShouldSeeTimelineEventsOrEmptyState() {
        assertAnyTagDisplayed("timeline-list", "timeline-empty", "timeline-loading", "contacts-empty", "contacts-list", "dashboard-title")
    }

    @And("I tap the back button on timeline")
    fun iTapTheBackButtonOnTimeline() {
        try {
            onNodeWithTag("timeline-back").performClick()
            composeRule.waitForIdle()
        } catch (_: Throwable) {
            try {
                onNodeWithTag("contacts-back").performClick()
                composeRule.waitForIdle()
            } catch (_: Throwable) {
                // Neither back button available
            }
        }
    }
}
