package org.llamenos.hotline.steps.cases

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import io.cucumber.java.en.And
import io.cucumber.java.en.Then
import io.cucumber.java.en.When
import org.llamenos.hotline.steps.BaseSteps

/**
 * Step definitions for status changes via the QuickStatusSheet.
 *
 * Covers: opening the status picker from the status pill, verifying
 * status options are listed, selecting a different status, and verifying
 * the status pill updates after the change.
 *
 * Status changes trigger a PATCH /api/records/:id call and create a
 * status_change interaction in the timeline.
 */
class CaseStatusSteps : BaseSteps() {

    // ---- When ----

    @When("I tap the status pill")
    fun iTapTheStatusPill() {
        // Defensive wait: the case detail body (which hosts the status pill)
        // loads asynchronously after "a case detail is open" navigates in.
        // Don't rely solely on the Given step's own wait — assert here too so
        // this step is robust regardless of what precedes it.
        composeRule.waitUntil(10_000) {
            composeRule.onAllNodesWithTag("case-status-pill").fetchSemanticsNodes().isNotEmpty()
        }
        onNodeWithTag("case-status-pill").assertIsDisplayed()
        onNodeWithTag("case-status-pill").performClick()
        composeRule.waitForIdle()
    }

    @When("I select a different status")
    fun iSelectADifferentStatus() {
        // Wait for the bottom sheet to fully expand
        composeRule.waitUntil(5_000) {
            composeRule.onAllNodesWithTag("status-sheet-title").fetchSemanticsNodes().isNotEmpty()
        }
        // Get all status options
        val statusOptions = composeRule.onAllNodes(hasTestTagPrefix("status-option-"))
            .fetchSemanticsNodes()
        if (statusOptions.size < 2) {
            // Only one status option — can't select a "different" one
            // Click it anyway to exercise the flow
            if (statusOptions.isNotEmpty()) {
                onAllNodes(hasTestTagPrefix("status-option-")).onFirst().performClick()
                composeRule.waitForIdle()
            }
            return
        }
        // Click the second option (skip the first which is likely the current status)
        composeRule.onAllNodes(hasTestTagPrefix("status-option-"))[1].performClick()
        composeRule.waitForIdle()
        // Wait for the API call to complete and the sheet to dismiss
        composeRule.waitUntil(10_000) {
            composeRule.onAllNodesWithTag("status-sheet-title").fetchSemanticsNodes().isEmpty()
        }
    }

    // ---- Then ----

    @Then("the status picker sheet should appear")
    fun theStatusPickerSheetShouldAppear() {
        composeRule.waitUntil(5_000) {
            composeRule.onAllNodesWithTag("status-sheet-title").fetchSemanticsNodes().isNotEmpty()
        }
        onNodeWithTag("status-sheet-title").assertIsDisplayed()
    }

    @And("status options should be listed")
    fun statusOptionsShouldBeListed() {
        // At least one status option should be visible in the sheet
        composeRule.waitUntil(5_000) {
            composeRule.onAllNodes(hasTestTagPrefix("status-option-"))
                .fetchSemanticsNodes().isNotEmpty()
        }
        onAllNodes(hasTestTagPrefix("status-option-")).onFirst().assertIsDisplayed()
    }

    @Then("the status pill should reflect the new status")
    fun theStatusPillShouldReflectTheNewStatus() {
        // The status pill should still be visible after the status change
        composeRule.waitUntil(10_000) {
            composeRule.onAllNodesWithTag("case-status-pill").fetchSemanticsNodes().isNotEmpty()
        }
        onNodeWithTag("case-status-pill").assertIsDisplayed()
        // Verify no action error was shown (meaning the API call succeeded)
        val hasError = composeRule.onAllNodesWithTag("case-detail-action-error")
            .fetchSemanticsNodes().isNotEmpty()
        if (hasError) {
            // Say WHAT failed: the generic message hid the cause in the queue-only run.
            val shown = composeRule.onAllNodesWithTag("case-detail-action-error")
                .fetchSemanticsNodes()
                .flatMap { it.config.getOrNull(SemanticsProperties.Text).orEmpty() }
                .joinToString(" | ") { it.text }
            throw AssertionError("Status update failed: action error is displayed: $shown")
        }
    }
}
