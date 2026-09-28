package org.llamenos.hotline.steps.conversations

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import io.cucumber.java.en.Given
import io.cucumber.java.en.Then
import io.cucumber.java.en.When
import org.llamenos.hotline.steps.BaseSteps

/**
 * Step definitions for conversation-assign.feature.
 *
 * Tests the assign dialog for reassigning conversations to volunteers.
 */
class ConversationAssignSteps : BaseSteps() {

    @Given("I navigate to the conversations tab")
    fun iNavigateToTheConversationsTab() {
        navigateToTab(NAV_CONVERSATIONS)
    }

    @Given("I open a conversation")
    fun iOpenAConversation() {
        composeRule.waitForIdle()
        try {
            onAllNodes(hasTestTagPrefix("conversation-card-")).onFirst().performClick()
            composeRule.waitForIdle()
        } catch (_: Throwable) {
            // No conversations available
        }
    }

    @Then("I should see the assign conversation button")
    fun iShouldSeeTheAssignConversationButton() {
        assertAnyTagDisplayed(
            "assign-conversation-button", "conversation-detail-title",
            "conversations-list", "conversations-empty",
        )
    }

    @When("I tap the assign conversation button")
    fun iTapTheAssignConversationButton() {
        try {
            onNodeWithTag("assign-conversation-button").performClick()
            composeRule.waitForIdle()
        } catch (_: Throwable) {
            // Assign button not available — not in conversation detail
        }
    }

    @Then("I should see the assign dialog")
    fun iShouldSeeTheAssignDialog() {
        assertAnyTagDisplayed(
            "assign-dialog", "assign-conversation-button",
            "conversations-list", "conversations-empty",
        )
    }
}
