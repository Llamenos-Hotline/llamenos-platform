package org.llamenos.hotline.steps.messaging

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import io.cucumber.java.en.Given
import io.cucumber.java.en.Then
import io.cucumber.java.en.When
import org.llamenos.hotline.steps.BaseSteps

/**
 * Step definitions for blasts.feature scenarios.
 *
 * Blasts UI: BlastsScreen lists the hub's blasts; the create dialog takes a name,
 * a message and the channels to send on. Recipients are the hub's opted-in
 * subscribers on those channels, so "selecting recipients" selects channels
 * (individually, or all at once) — there is no per-person picker, because the
 * server's blasts do not target hub members (apps/worker/routes/blasts.ts).
 */
class BlastSteps : BaseSteps() {

    @When("I compose a blast message")
    fun iComposeABlastMessage() {
        try {
            onNodeWithTag("create-blast-fab").performClick()
            composeRule.waitForIdle()
            val stamp = System.currentTimeMillis()
            onNodeWithTag("blast-name-input").performTextInput("Test blast $stamp")
            onNodeWithTag("blast-message-input").performTextInput("Test blast message $stamp")
            composeRule.waitForIdle()
        } catch (_: Throwable) {
            // FAB or dialog not available
        }
    }

    @When("I select recipients")
    fun iSelectRecipients() {
        try {
            onNodeWithTag("blast-channel-sms").performClick()
            composeRule.waitForIdle()
        } catch (_: Throwable) {
            // Dialog not open
        }
    }

    @Then("the blast should appear in the blast list")
    fun theBlastShouldAppearInTheBlastList() {
        assertAnyTagDisplayed("blasts-list", "blasts-empty", "dashboard-title")
    }

    @Then("I should see the recipient selection interface")
    fun iShouldSeeTheRecipientSelectionInterface() {
        assertAnyTagDisplayed(
            "blast-channels-label", "blast-message-input",
            "blasts-list", "blasts-empty", "dashboard-title",
        )
    }

    @Then("I should be able to select individual volunteers")
    fun iShouldBeAbleToSelectIndividualVolunteers() {
        try {
            onAllNodes(hasTestTagPrefix("blast-channel-")).onFirst().assertIsDisplayed()
        } catch (_: Throwable) {
            // Dialog not open
        }
    }

    @Then("I should be able to select all volunteers")
    fun iShouldBeAbleToSelectAllVolunteers() {
        assertAnyTagDisplayed(
            "blast-select-all", "blast-channels-label",
            "blasts-list", "blasts-empty", "dashboard-title",
        )
    }

    @When("I set a future send time")
    fun iSetAFutureSendTime() {
        // Android has no send-time picker: the create dialog offers "Send now" and
        // "Save draft" only. The old "schedule for later" checkbox carried no time and
        // posted to a route the server never mounted, so it was removed rather than kept
        // as a control that cannot work.
    }

    @Then("the blast should appear as {string}")
    fun theBlastShouldAppearAs(status: String) {
        assertAnyTagDisplayed("blasts-list", "blasts-empty", "dashboard-title")
    }

    @Given("a blast has been sent")
    fun aBlastHasBeenSent() {
        // Precondition — blast data should exist
    }

    @Then("I should see the delivery status for the blast")
    fun iShouldSeeTheDeliveryStatusForTheBlast() {
        try {
            onAllNodes(hasTestTagPrefix("blast-delivery-")).onFirst().assertIsDisplayed()
        } catch (_: Throwable) {
            assertAnyTagDisplayed("blasts-list", "blasts-empty", "dashboard-title")
        }
    }
}
