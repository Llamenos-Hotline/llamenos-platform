package org.llamenos.hotline.steps.admin

import androidx.compose.ui.test.ComposeTimeoutException
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import io.cucumber.datatable.DataTable
import io.cucumber.java.en.Given
import io.cucumber.java.en.Then
import io.cucumber.java.en.When
import org.llamenos.hotline.steps.BaseSteps

/**
 * Step definitions for admin-sidebar.feature.
 *
 * Tests the admin sidebar drawer navigation on Android.
 */
class AdminSidebarSteps : BaseSteps() {

    private companion object {
        val AdminDrawerItemTags = arrayOf(
            "admin-sidebar-item-call-settings",
            "admin-sidebar-item-custom-fields",
            "admin-sidebar-item-bans",
        )
    }

    // ---- Given ----

    @Given("I navigate to admin settings with sidebar")
    fun iNavigateToAdminSettingsWithSidebar() {
        navigateToTab(NAV_SETTINGS)
        waitForNode("settings-admin-card", timeoutMillis = 10_000)
        onNodeWithTag("settings-admin-card").performScrollTo()
        onNodeWithTag("settings-admin-card").performClick()
        composeRule.waitForIdle()
        // Reaching the admin screen is the precondition; whether it offers the
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
        assertAnyTagDisplayed(
            "admin-sidebar-item-call-settings",
            "admin-sidebar-item-custom-fields",
            "admin-sidebar-item-bans",
        )
    }

    @Then("I should see {string} scope header")
    fun iShouldSeeScopeHeader(scopeName: String) {
        val tag = when (scopeName) {
            "This Hub" -> "admin-sidebar-scope-hub"
            "Platform" -> "admin-sidebar-scope-platform"
            else -> "admin-sidebar-scope-${scopeName.lowercase().replace(" ", "-")}"
        }
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

    @Then("I should see the call settings section content")
    fun iShouldSeeTheCallSettingsSectionContent() {
        assertAnyTagDisplayed(
            "call-settings-ring-timeout",
            "call-settings-max-duration",
        )
    }

    @Then("I should see spam protection section content")
    fun iShouldSeeSpamProtectionSectionContent() {
        assertAnyTagDisplayed(
            "spam-max-calls-slider",
            "spam-captcha-toggle",
        )
    }

    @Then("I should see transcription section content")
    fun iShouldSeeTranscriptionSectionContent() {
        assertAnyTagDisplayed(
            "transcription-enabled-toggle",
            "transcription-optout-toggle",
        )
    }
}
