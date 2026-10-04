package org.llamenos.hotline.steps.hubs

import android.util.Log
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.filter
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onChildren
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import dagger.hilt.android.EntryPointAccessors
import io.cucumber.java.en.And
import io.cucumber.java.en.Given
import io.cucumber.java.en.Then
import io.cucumber.java.en.When
import org.llamenos.hotline.LlamenosApp
import org.llamenos.hotline.di.CryptoEntryPoint
import org.llamenos.hotline.helpers.SimulationClient
import org.llamenos.hotline.steps.BaseSteps

/**
 * Step definitions for hub-switch.feature scenarios.
 *
 * Covers: second hub creation, hub switching via tap, active indicator
 * updates, and hub-scoped data reload (notes screen).
 *
 * ScenarioHooks @Before(order = 1) already creates one hub and sets
 * [ScenarioHooks.currentHubId]. This class creates a second hub so the
 * hub list contains two entries to switch between.
 *
 * Hub identification: Super-admin users see ALL hubs (including leftovers
 * from prior test runs), so we identify hubs by name text via semantic
 * matching rather than positional index. The LazyColumn is scrolled to
 * the target hub using [performScrollToNode].
 */
class HubSwitchSteps : BaseSteps() {

    companion object {
        private const val TAG = "HubSwitchSteps"
    }

    private var secondHubName: String = ""

    // ---- Given ----

    @Given("the app is launched with two test hubs")
    fun launchWithTwoHubs() {
        // ScenarioHooks @Before(order = 1) already created the first hub.
        // Create a second hub so the list has two entries.
        secondHubName = "android-test-hub-2-${System.currentTimeMillis()}"
        val hub2 = SimulationClient.createTestHub(secondHubName)
        check(hub2.id.isNotEmpty()) {
            "Failed to create second test hub: ${hub2.error}"
        }
        Log.d(TAG, "Created second hub: ${hub2.id} (name=$secondHubName)")

        // Launch the app (creates identity and navigates to dashboard).
        navigateToMainScreen()

        // Promote the test user to super-admin so GET /api/hubs returns hubs.
        // POST /api/hubs grants membership to its CREATOR, which is the harness's
        // admin identity — not this device's identity, which the app generated at
        // launch a moment ago. Non-member users cannot see hubs they don't belong
        // to, so the device identity still needs a role to list them.
        val entryPoint = EntryPointAccessors.fromApplication(
            LlamenosApp.instance,
            CryptoEntryPoint::class.java,
        )
        val signingPubkey = entryPoint.cryptoService().signingPubkeyHex
        check(signingPubkey != null) {
            "No signing pubkey available — identity creation may have failed"
        }
        val result = SimulationClient.promoteToAdmin(signingPubkey)
        Log.d(TAG, "Promoted to admin: ok=${result.ok}, error=${result.error}")
        check(result.ok || result.error == null) {
            "Admin promotion failed: ${result.error}"
        }
    }

    @Given("I am on the hub management screen")
    fun navigateToHubManagement() {
        // Hub list is accessed via the "hubs-card" quick action on the Dashboard
        navigateViaDashboardCard("hubs-card")

        // Wait for the hub list screen to load.
        composeRule.waitUntil(20_000) {
            composeRule.onAllNodesWithTag("hubs-title").fetchSemanticsNodes().isNotEmpty() ||
                composeRule.onAllNodesWithTag("hubs-list").fetchSemanticsNodes().isNotEmpty() ||
                composeRule.onAllNodesWithTag("hubs-loading").fetchSemanticsNodes().isNotEmpty() ||
                composeRule.onAllNodesWithTag("hubs-empty").fetchSemanticsNodes().isNotEmpty() ||
                composeRule.onAllNodesWithTag("hubs-error").fetchSemanticsNodes().isNotEmpty()
        }
    }

    // ---- When ----

    @When("I tap the second hub in the list")
    fun tapSecondHub() {
        check(secondHubName.isNotEmpty()) {
            "secondHubName not set — launchWithTwoHubs() must run first"
        }

        // Wait for the hubs-list LazyColumn to be present
        composeRule.waitUntil(10_000) {
            composeRule.onAllNodesWithTag("hubs-list").fetchSemanticsNodes().isNotEmpty()
        }

        // Scroll the LazyColumn to the hub with our known name.
        // Super-admin sees ALL hubs (including leftovers from prior runs),
        // so positional indexing is unreliable. Use name-based matching.
        val targetMatcher = hasText(secondHubName)
        onNodeWithTag("hubs-list").performScrollToNode(targetMatcher)
        composeRule.waitForIdle()

        // Now find the hub-row card containing this name and click it.
        // Use unmerged tree to see through merged semantics boundaries.
        val hubCardMatcher = hasTestTag("hub-row") and hasAnyDescendant(hasText(secondHubName))
        var found = composeRule.onAllNodes(hubCardMatcher, useUnmergedTree = true)
            .fetchSemanticsNodes()
        if (found.isEmpty()) {
            // Fall back to merged tree
            found = composeRule.onAllNodes(hubCardMatcher).fetchSemanticsNodes()
        }
        if (found.isEmpty()) {
            // Debug: log what hub-rows are visible
            val visibleRows = composeRule.onAllNodesWithTag("hub-row")
                .fetchSemanticsNodes()
            Log.e(TAG, "No hub-row found for '$secondHubName'. Visible hub-rows: ${visibleRows.size}")
            for ((i, node) in visibleRows.withIndex()) {
                Log.e(TAG, "  hub-row[$i]: ${node.config}")
            }
            error("Could not find hub-row with name '$secondHubName' after scrolling. ${visibleRows.size} hub-rows visible.")
        }
        composeRule.onAllNodes(hubCardMatcher, useUnmergedTree = true)[0].performClick()
        composeRule.waitForIdle()
    }

    @And("I navigate to the notes screen")
    fun navigateToNotes() {
        navigateToTab(NAV_NOTES)
        composeRule.waitForIdle()
    }

    // ---- Then / And ----

    @Then("the second hub shows the active indicator")
    fun secondHubShowsActiveIndicator() {
        check(secondHubName.isNotEmpty()) {
            "secondHubName not set — launchWithTwoHubs() must run first"
        }

        // After clicking a hub, the active hub changes. The hub list may need
        // to be scrolled again to find our target hub (it may have moved
        // due to recomposition after the state change).
        //
        // IMPORTANT: Must use useUnmergedTree = true because the Card's .clickable
        // modifier sets mergeDescendants = true, which merges child testTags into
        // the parent in the default (merged) tree. Without unmerged tree,
        // onChildren().filter(hasTestTag("hub-active-indicator")) returns nothing.
        val hubCardMatcher = hasTestTag("hub-row") and hasAnyDescendant(hasText(secondHubName))

        composeRule.waitUntil(15_000) {
            // Ensure the hub is scrolled into view
            try {
                onNodeWithTag("hubs-list").performScrollToNode(hasText(secondHubName))
            } catch (_: Throwable) { /* May already be visible */ }

            val nodes = composeRule.onAllNodes(hubCardMatcher, useUnmergedTree = true)
                .fetchSemanticsNodes()
            if (nodes.isEmpty()) return@waitUntil false
            composeRule.onAllNodes(hubCardMatcher, useUnmergedTree = true)[0]
                .onChildren()
                .filter(hasTestTag("hub-active-indicator"))
                .fetchSemanticsNodes()
                .isNotEmpty()
        }
        composeRule.onAllNodes(hubCardMatcher, useUnmergedTree = true)[0]
            .onChildren()
            .filter(hasTestTag("hub-active-indicator"))
            .also { it[0].assertIsDisplayed() }
    }

    @And("the first hub no longer shows the active indicator")
    fun firstHubNoLongerShowsActiveIndicator() {
        // Verify exactly one hub-active-indicator exists in the entire tree.
        // That indicator should be on the second hub (verified by prior step).
        // Must use unmerged tree — merged tree hides child testTags inside clickable Cards.
        val allIndicators = composeRule.onAllNodesWithTag("hub-active-indicator", useUnmergedTree = true)
            .fetchSemanticsNodes()
        check(allIndicators.size == 1) {
            "Expected exactly 1 hub-active-indicator (on second hub), found ${allIndicators.size}"
        }
    }

    @Then("the notes screen loads without error")
    fun notesScreenLoadsWithoutError() {
        // Give the hub state time to propagate to all subscribers
        Thread.sleep(1_000)
        composeRule.waitUntil(15_000) {
            composeRule.onAllNodesWithTag("notes-list").fetchSemanticsNodes().isNotEmpty() ||
                composeRule.onAllNodesWithTag("notes-empty").fetchSemanticsNodes().isNotEmpty() ||
                composeRule.onAllNodesWithTag("empty-state").fetchSemanticsNodes().isNotEmpty()
        }
        // Assert no error banner is present
        val errorNodes = composeRule.onAllNodesWithTag("notes-error", useUnmergedTree = true)
            .fetchSemanticsNodes() +
            composeRule.onAllNodesWithTag("error-message", useUnmergedTree = true)
                .fetchSemanticsNodes()
        if (errorNodes.isNotEmpty()) {
            // Log the error text for diagnosis
            for ((i, node) in errorNodes.withIndex()) {
                Log.e(TAG, "Error node[$i]: ${node.config}")
            }
            // Also dump any text nodes in the error region
            val allTexts = composeRule.onAllNodesWithTag("notes-error", useUnmergedTree = true)
            try {
                val children = allTexts[0].onChildren().fetchSemanticsNodes()
                for ((i, child) in children.withIndex()) {
                    Log.e(TAG, "Error child[$i]: ${child.config}")
                }
            } catch (_: Throwable) {}
        }
        check(errorNodes.isEmpty()) {
            "Notes screen showed an error after hub switch (${errorNodes.size} error node(s) found)"
        }
    }
}
