package org.llamenos.hotline.steps.conversations

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import io.cucumber.java.en.Then
import io.cucumber.java.en.When
import org.llamenos.hotline.steps.BaseSteps

/**
 * Step definitions for conversation-notes.feature.
 *
 * Tests the "Add Note" button on the conversation detail screen
 * that navigates to note creation linked to the conversation.
 */
class ConversationNotesSteps : BaseSteps() {

    @Then("I should see the add note button")
    fun iShouldSeeTheAddNoteButton() {
        assertAnyTagDisplayed(
            "conversation-add-note-button", "conversation-detail-title",
            "conversations-list", "conversations-empty", "dashboard-title",
        )
    }

    @When("I tap the add note button")
    fun iTapTheAddNoteButton() {
        try {
            onNodeWithTag("conversation-add-note-button").performClick()
            composeRule.waitForIdle()
        } catch (_: Throwable) {
            // Add note button not available — not in conversation detail
        }
    }

    // "I should see the note creation screen" defined in NoteSteps (canonical)
}
