package org.llamenos.hotline.steps.admin

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.ComposeTimeoutException
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import io.cucumber.datatable.DataTable
import io.cucumber.java.en.Given
import io.cucumber.java.en.Then
import io.cucumber.java.en.When
import kotlin.math.abs
import org.llamenos.hotline.helpers.SimulationClient
import org.llamenos.hotline.steps.BaseSteps

/**
 * Step definitions for admin-sidebar.feature.
 *
 * The drawer opens from the admin panel's top bar and from every admin section
 * screen; picking an item opens that section.
 *
 * Section-content steps assert BEHAVIOUR, not rendering: they drive a control,
 * save, and read the setting back through the API (#1743). A failure names the
 * setting that did not persist; a slow emulator cannot produce one, because the
 * server state either changed or it did not.
 */
class AdminSidebarSteps : BaseSteps() {

    private companion object {
        val AdminDrawerItemTags = arrayOf(
            "admin-sidebar-item-call-settings",
            "admin-sidebar-item-custom-fields",
            "admin-sidebar-item-bans",
        )

        // Call settings sliders span 30..300s with 17 steps, i.e. a 15-second
        // grid; both probe values sit on it so SetProgress lands exactly.
        const val CALL_GRID_SECONDS = 15
        const val CALL_PROBE_A = 120
        const val CALL_PROBE_B = 135

        // Spam rate-limit slider spans 1..100/min with 98 steps — every integer.
        const val SPAM_PROBE_A = 20
        const val SPAM_PROBE_B = 25
    }

    // ---- Given ----

    @Given("I navigate to admin settings with sidebar")
    fun iNavigateToAdminSettingsWithSidebar() {
        navigateToTab(NAV_SETTINGS)
        waitForNode("settings-admin-card", timeoutMillis = 10_000)
        onNodeWithTag("settings-admin-card").performScrollTo()
        onNodeWithTag("settings-admin-card").performClick()
        composeRule.waitForIdle()
        // Reaching the admin panel is the precondition; whether it offers the
        // sidebar is what the Then steps assert.
        assertAnyTagDisplayed("admin-title", timeoutMillis = 10_000)
    }

    // ---- Then (visibility assertions) ----

    @Then("I should see the sidebar toggle button")
    fun iShouldSeeTheSidebarToggleButton() {
        assertAnyTagDisplayed("admin-sidebar-toggle")
    }

    @Then("I should see the admin sidebar drawer")
    fun iShouldSeeTheAdminSidebarDrawer() {
        // The ModalNavigationDrawer itself doesn't have a testTag, so verify
        // the drawer is open by checking for nav items inside it
        assertAnyTagDisplayed(*AdminDrawerItemTags)
    }

    @Then("I should see {string} scope header")
    fun iShouldSeeScopeHeader(scopeName: String) {
        val tag = when (scopeName) {
            "This Hub" -> "admin-sidebar-scope-hub"
            "Platform" -> "admin-sidebar-scope-platform"
            else -> "admin-sidebar-scope-${scopeName.lowercase().replace(" ", "-")}"
        }
        // The drawer scrolls (the Platform scope sits below every hub item);
        // bring the header into view before asserting it.
        waitForNode(tag)
        onNodeWithTag(tag).performScrollTo()
        assertAnyTagDisplayed(tag)
    }

    @Then("I should see hub-level nav items")
    fun iShouldSeeHubLevelNavItems() {
        // Verify at least one hub-level sidebar item is visible
        assertAnyTagDisplayed(
            "admin-sidebar-item-call-settings",
            "admin-sidebar-item-custom-fields",
            "admin-sidebar-item-bans",
            "admin-sidebar-item-audit",
        )
    }

    @Then("I should see sidebar items for:")
    fun iShouldSeeSidebarItemsFor(dataTable: DataTable) {
        val items = dataTable.asList().filter { it.lowercase() != "item" }
        check(items.isNotEmpty()) { "Sidebar item table is empty" }
        for (item in items) {
            val tag = "admin-sidebar-item-$item"
            // The drawer scrolls; bring each item into view before asserting it.
            waitForNode(tag)
            onNodeWithTag(tag).performScrollTo()
            assertAnyTagDisplayed(tag)
        }
    }

    // ---- When (interactions) ----

    @When("I tap the sidebar toggle button")
    fun iTapTheSidebarToggleButton() {
        waitForNode("admin-sidebar-toggle")
        onNodeWithTag("admin-sidebar-toggle").performClick()
        composeRule.waitForIdle()
    }

    @When("I tap the {string} sidebar item")
    fun iTapTheSidebarItem(itemSlug: String) {
        val tag = "admin-sidebar-item-$itemSlug"
        waitForNode(tag)
        onNodeWithTag(tag).performScrollTo()
        onNodeWithTag(tag).performClick()
        composeRule.waitForIdle()
    }

    // ---- Then (navigation assertions) ----

    @Then("the sidebar drawer should close")
    fun theSidebarDrawerShouldClose() {
        // After tapping a sidebar item the drawer closes: its items leave the screen
        // and the toggle that reopens it is back in view.
        val drawerItems = AdminDrawerItemTags
        try {
            composeRule.waitUntil(5_000) { !isAnyTagDisplayed(*drawerItems) }
        } catch (e: ComposeTimeoutException) {
            throw AssertionError("Admin sidebar drawer still open: one of ${drawerItems.joinToString()} is displayed", e)
        }
        assertAnyTagDisplayed("admin-sidebar-toggle")
    }

    // ---- Then (settings persistence — behaviour assertions, #1743) ----

    @Then("a call setting saved through that section is persisted by the server")
    fun callSettingSavedThroughSectionPersists() {
        val before = SimulationClient.getCallSettings()
        val target = if (before.queueTimeoutSeconds != CALL_PROBE_A) CALL_PROBE_A else CALL_PROBE_B
        try {
            setSliderSeconds("queue-timeout-slider", target)
            clickSave("call-settings-save-button")
            SimulationClient.awaitServerState(
                what = "queueTimeoutSeconds=$target saved through the call settings section",
                fetch = { SimulationClient.getCallSettings() },
            ) { it.queueTimeoutSeconds == target }
        } finally {
            // Platform-wide setting: put back what the scenario found, or the
            // next scenario's starting state is whatever this one probed.
            SimulationClient.authorizedPatch(
                "/api/settings/call",
                """{"queueTimeoutSeconds":${before.queueTimeoutSeconds},"voicemailMaxSeconds":${before.voicemailMaxSeconds}}""",
            )
        }
    }

    @Then("a spam setting saved through that section is persisted by the server")
    fun spamSettingSavedThroughSectionPersists() {
        val before = SimulationClient.getSpamSettings()
        val target = if (before.maxCallsPerMinute != SPAM_PROBE_A) SPAM_PROBE_A else SPAM_PROBE_B
        try {
            setSliderValue(
                tag = "max-calls-per-minute-slider",
                fraction = (target - 1).toFloat() / 99f,
                expectedValue = target.toFloat(),
            )
            clickSave("spam-settings-save-button")
            SimulationClient.awaitServerState(
                what = "maxCallsPerMinute=$target saved through the spam protection section",
                fetch = { SimulationClient.getSpamSettings() },
            ) { it.maxCallsPerMinute == target }
        } finally {
            SimulationClient.authorizedPatch(
                "/api/settings/spam",
                """{"voiceCaptchaEnabled":${before.voiceCaptchaEnabled},"rateLimitEnabled":${before.rateLimitEnabled},"maxCallsPerMinute":${before.maxCallsPerMinute},"blockDurationMinutes":${before.blockDurationMinutes}}""",
            )
        }
    }

    @Then("a transcription setting saved through that section is persisted by the server")
    fun transcriptionSettingSavedThroughSectionPersists() {
        // Transcription toggles PATCH on flip — there is no save button.
        val before = SimulationClient.getTranscriptionSettings()
        try {
            flipSwitch("transcription-enabled-toggle", expectCheckedBefore = before.globalEnabled)
            SimulationClient.awaitServerState(
                what = "globalEnabled=${!before.globalEnabled} toggled through the transcription section",
                fetch = { SimulationClient.getTranscriptionSettings() },
            ) { it.globalEnabled == !before.globalEnabled }
        } finally {
            SimulationClient.authorizedPatch(
                "/api/settings/transcription",
                """{"globalEnabled":${before.globalEnabled},"allowUserOptOut":${before.allowUserOptOut}}""",
            )
        }
    }

    // ---- Settings control drivers ----

    /**
     * Drive a seconds-grid slider (30..300, 15s steps) to [seconds] and prove
     * the slider's own value followed — so a section that never loaded its
     * settings fails here ("slider at X after setting Y") rather than at a
     * tag-existence timeout.
     */
    private fun setSliderSeconds(tag: String, seconds: Int) {
        require((seconds - 30) % CALL_GRID_SECONDS == 0) { "$seconds is off the 15s grid" }
        setSliderValue(tag, (seconds - 30).toFloat() / 270f, seconds.toFloat())
    }

    private fun setSliderValue(tag: String, fraction: Float, expectedValue: Float) {
        waitForNode(tag, timeoutMillis = 10_000)
        onNodeWithTag(tag).performScrollTo()
        onNodeWithTag(tag).performSemanticsAction(SemanticsActions.SetProgress) { it(fraction) }
        composeRule.waitForIdle()
        val info = onNodeWithTag(tag).fetchSemanticsNode().config[SemanticsProperties.ProgressBarRangeInfo]
        check(abs(info.current - expectedValue) < 0.5f) {
            "'$tag' sits at ${info.current} after being driven to $expectedValue — " +
                "the section's controls are not taking input"
        }
    }

    private fun clickSave(tag: String) {
        waitForNode(tag, timeoutMillis = 10_000)
        onNodeWithTag(tag).performScrollTo()
        onNodeWithTag(tag).performClick()
        composeRule.waitForIdle()
    }

    /**
     * Flip the Switch inside a tagged SettingsToggleRow, first waiting until
     * it shows the value the server reported — so a section whose GET failed
     * (the #1732 defect: toggles frozen at defaults) fails saying the control
     * never showed the server's state, not with a flipped-the-wrong-way timeout.
     */
    private fun flipSwitch(rowTag: String, expectCheckedBefore: Boolean) {
        awaitSwitchState(rowTag, expectCheckedBefore)
        clickSwitchInRow(rowTag)
    }
}
