package org.llamenos.hotline.steps.calls

import android.util.Log
import androidx.compose.ui.test.ComposeTimeoutException
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import dagger.hilt.android.EntryPointAccessors
import io.cucumber.java.en.And
import io.cucumber.java.en.Given
import io.cucumber.java.en.Then
import io.cucumber.java.en.When
import kotlinx.coroutines.runBlocking
import org.llamenos.hotline.LlamenosApp
import org.llamenos.hotline.di.ActiveHubEntryPoint
import org.llamenos.hotline.di.CryptoEntryPoint
import org.llamenos.hotline.helpers.SimulationClient
import org.llamenos.hotline.steps.BaseSteps
import org.llamenos.hotline.steps.ScenarioHooks

/**
 * Step definitions for active-call.feature scenarios.
 *
 * Covers: active call card visibility, hangup, ban dialog with reason,
 * report spam button, and quick note button on the dashboard.
 *
 * Active call state is set up via [SimulationClient] which simulates
 * incoming calls and answers them on the test backend.
 */
class ActiveCallSteps : BaseSteps() {

    private var activeCallId: String = ""

    // ---- Given ----

    @Given("an active call exists")
    fun anActiveCallExists() {
        // Ensure we're on the dashboard (readNpubFromSettings might have navigated away)
        navigateToTab(NAV_DASHBOARD)

        // Get the actual signing pubkey for answering the call.
        // Using "admin" as pubkey works for the GET /active query (which returns all calls)
        // but fails for hangup/ban which check answeredBy === pubkey.
        val signingPubkey = getSigningPubkey() ?: "admin"
        Log.d("ActiveCallSteps", "Using pubkey for answer: ${signingPubkey.take(16)}...")

        // Create a shift with this volunteer so call routing works
        val hubId = ScenarioHooks.currentHubId
        try {
            SimulationClient.createShift(signingPubkey, hubId.ifEmpty { null })
            Log.d("ActiveCallSteps", "Created test shift for ${signingPubkey.take(16)}... in hub $hubId")
        } catch (e: Throwable) {
            Log.w("ActiveCallSteps", "Shift creation failed: ${e.message}")
        }

        // Simulate an incoming call and answer it via the test backend.
        // The call will then appear on the dashboard as an active call card.
        try {
            Log.d("ActiveCallSteps", "Simulating call in hub: $hubId")
            val callResult = SimulationClient.simulateIncomingCall(
                callerNumber = "+15559${System.currentTimeMillis().toString().takeLast(6)}",
                hubId = hubId.ifEmpty { null },
            )
            activeCallId = callResult.callId
            Log.d("ActiveCallSteps", "Simulated call: id=$activeCallId, status=${callResult.status}, error=${callResult.error}")

            if (activeCallId.isNotEmpty()) {
                val answerResult = SimulationClient.simulateAnswerCall(
                    callId = activeCallId,
                    pubkey = signingPubkey,
                )
                Log.d("ActiveCallSteps", "Answered call: status=${answerResult.status}, error=${answerResult.error}")
            }
        } catch (e: Throwable) {
            Log.w("ActiveCallSteps", "Call simulation failed: ${e.message}", e)
        }

        // Force DashboardViewModel to re-fetch active calls.
        // DashboardViewModel subscribes to refreshTrigger and calls refresh().
        triggerHubRefresh()

        // Wait for the active call card to appear
        try {
            composeRule.waitUntil(15_000) {
                composeRule.onAllNodesWithTag("active-call-card").fetchSemanticsNodes().isNotEmpty()
            }
        } catch (_: Throwable) {
            // Retry: trigger another hub refresh cycle
            Log.d("ActiveCallSteps", "active-call-card not found, retrying with hub refresh")
            triggerHubRefresh()
            try {
                composeRule.waitUntil(15_000) {
                    composeRule.onAllNodesWithTag("active-call-card").fetchSemanticsNodes().isNotEmpty()
                }
            } catch (_: Throwable) {
                Log.w("ActiveCallSteps", "active-call-card did not appear after retry")
            }
        }
    }

    // ---- Then ----

    @Then("I should see the active call card")
    fun iShouldSeeTheActiveCallCard() {
        // Wait for the active call card to appear on the dashboard.
        // The card renders when DashboardViewModel.currentCall is non-null after fetchActiveCall().
        composeRule.waitUntil(15_000) {
            composeRule.onAllNodesWithTag("active-call-card").fetchSemanticsNodes().isNotEmpty()
        }
        onNodeWithTag("active-call-card").assertIsDisplayed()
    }

    // ---- When ----

    @When("I tap the hangup button")
    fun iTapTheHangupButton() {
        composeRule.waitUntil(10_000) {
            composeRule.onAllNodesWithTag("hangup-button").fetchSemanticsNodes().isNotEmpty()
        }
        try {
            onNodeWithTag("hangup-button").performClick()
            composeRule.waitForIdle()
        } catch (_: Throwable) {
            Log.w("ActiveCallSteps", "Hangup button not available")
        }
    }

    @Then("the active call card should disappear")
    fun theActiveCallCardShouldDisappear() {
        // Hangup ends the call server-side; the dashboard drops the card once the
        // end-call event (or the next active-call fetch) lands.
        try {
            composeRule.waitUntil(15_000) {
                composeRule.onAllNodesWithTag("active-call-card").fetchSemanticsNodes().isEmpty()
            }
        } catch (e: ComposeTimeoutException) {
            throw AssertionError("active-call-card still shown 15s after hangup (call $activeCallId)", e)
        }
        assertAnyTagDisplayed("dashboard-title")
    }

    @When("I tap the ban and hangup button")
    fun iTapTheBanAndHangupButton() {
        composeRule.waitUntil(10_000) {
            composeRule.onAllNodesWithTag("ban-hangup-button").fetchSemanticsNodes().isNotEmpty()
        }
        try {
            onNodeWithTag("ban-hangup-button").performClick()
            composeRule.waitForIdle()
        } catch (_: Throwable) {
            Log.w("ActiveCallSteps", "Ban+Hangup button not available")
        }
    }

    @Then("the ban dialog should appear")
    fun theBanDialogShouldAppear() {
        composeRule.waitUntil(5_000) {
            composeRule.onAllNodesWithTag("ban-dialog").fetchSemanticsNodes().isNotEmpty()
        }
        onNodeWithTag("ban-dialog").assertIsDisplayed()
    }

    @And("the ban reason input should be visible")
    fun theBanReasonInputShouldBeVisible() {
        onNodeWithTag("ban-reason-input").assertIsDisplayed()
    }

    @And("the ban confirm button should be visible")
    fun theBanConfirmButtonShouldBeVisible() {
        onNodeWithTag("ban-confirm-button").assertIsDisplayed()
    }

    @Then("the report spam button should be visible on the call card")
    fun theReportSpamButtonShouldBeVisibleOnTheCallCard() {
        composeRule.waitUntil(15_000) {
            composeRule.onAllNodesWithTag("active-call-card").fetchSemanticsNodes().isNotEmpty()
        }
        onNodeWithTag("report-spam-button").assertIsDisplayed()
    }

    @Then("the quick note button should be visible on the call card")
    fun theQuickNoteButtonShouldBeVisibleOnTheCallCard() {
        composeRule.waitUntil(15_000) {
            composeRule.onAllNodesWithTag("active-call-card").fetchSemanticsNodes().isNotEmpty()
        }
        onNodeWithTag("quick-note-button").assertIsDisplayed()
    }

    // ---- Helpers ----

    /**
     * Get the app's Ed25519 signing pubkey from the CryptoService singleton.
     * Returns the hex pubkey or null if unavailable.
     */
    private fun getSigningPubkey(): String? {
        return try {
            val entryPoint = EntryPointAccessors.fromApplication(
                LlamenosApp.instance,
                CryptoEntryPoint::class.java,
            )
            entryPoint.cryptoService().signingPubkeyHex
        } catch (e: Throwable) {
            Log.w("ActiveCallSteps", "getSigningPubkey failed: ${e.message}")
            null
        }
    }

    /**
     * Force DashboardViewModel.refresh() via [ActiveHubState.triggerRefresh].
     *
     * The previous approach of toggling the hub ID ("__refresh__" → real hub) was
     * unreliable due to StateFlow conflation: if the collector already saw the real
     * hub ID and the intermediate value was conflated away, no emission occurred.
     *
     * [ActiveHubState.refreshTrigger] is a SharedFlow that bypasses this problem —
     * every emit is delivered to all active collectors regardless of value equality.
     */
    private fun triggerHubRefresh() {
        val hubId = ScenarioHooks.currentHubId
        if (hubId.isEmpty()) {
            Log.w("ActiveCallSteps", "triggerHubRefresh: hubId is empty, skipping")
            return
        }
        try {
            val entryPoint = EntryPointAccessors.fromApplication(
                LlamenosApp.instance,
                ActiveHubEntryPoint::class.java,
            )
            val hubState = entryPoint.activeHubState()
            val currentHubValue = hubState.activeHubId.value
            Log.d("ActiveCallSteps", "triggerHubRefresh: activeHubId.value=$currentHubValue, scenarioHub=$hubId")

            // Ensure the active hub is set (might have been cleared during identity wipe)
            if (currentHubValue != hubId) {
                Log.d("ActiveCallSteps", "triggerHubRefresh: re-setting activeHub to $hubId")
                runBlocking { hubState.setActiveHub(hubId) }
                composeRule.waitForIdle()
                Thread.sleep(500)
            }

            runBlocking {
                hubState.triggerRefresh()
            }
            Log.d("ActiveCallSteps", "triggerHubRefresh: emitted refreshTrigger")
            composeRule.waitForIdle()
            // Give the ViewModel time to process the refresh and make the API call.
            // Emulator with swiftshader_indirect GPU may need 3-5s for network I/O.
            Thread.sleep(3000)
            composeRule.waitForIdle()
        } catch (e: Throwable) {
            Log.w("ActiveCallSteps", "triggerHubRefresh failed: ${e.message}", e)
        }
    }
}
