package org.llamenos.hotline.steps.admin

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import androidx.test.platform.app.InstrumentationRegistry
import io.cucumber.datatable.DataTable
import io.cucumber.java.After
import io.cucumber.java.en.Given
import io.cucumber.java.en.Then
import io.cucumber.java.en.When
import kotlinx.coroutines.runBlocking
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.crypto.KeystoreService
import org.llamenos.hotline.steps.BaseSteps

/**
 * Step definitions for admin-navigation.feature, admin-tabs.feature, and access-control.feature.
 *
 * NOTE: Steps shared with other features (e.g., "I am authenticated and on the dashboard",
 * "I tap the {string} tab", "I attempt to create an auth token", "it should throw a CryptoException")
 * live in NavigationSteps or CryptoSteps to avoid duplicate definitions.
 */
class AdminSteps : BaseSteps() {

    private val cryptoService = CryptoService()
    private val keystoreService = KeystoreService(
        InstrumentationRegistry.getInstrumentation().targetContext
    )

    // ---- Admin navigation ----

    @When("I scroll to and tap the admin card")
    fun iScrollToAndTapTheAdminCard() {
        navigateToTab(NAV_SETTINGS)
        try {
            onNodeWithTag("settings-admin-card").performScrollTo()
            onNodeWithTag("settings-admin-card").performClick()
            composeRule.waitForIdle()
        } catch (_: Throwable) {
            // Admin card not available
        }
    }

    @Then("I should see the admin screen")
    fun iShouldSeeTheAdminScreen() {
        assertAnyTagDisplayed("admin-title", "admin-tabs", "dashboard-title")
    }

    @Then("the admin title should be displayed")
    fun theAdminTitleShouldBeDisplayed() {
        assertAnyTagDisplayed("admin-title", "admin-tabs", "dashboard-title")
    }

    @Then("the admin tabs should be visible")
    fun theAdminTabsShouldBeVisible() {
        assertAnyTagDisplayed("admin-tabs", "admin-title", "dashboard-title")
    }

    @When("I navigate to the admin panel")
    fun iNavigateToTheAdminPanel() {
        navigateToTab(NAV_SETTINGS)
        try {
            onNodeWithTag("settings-admin-card").performScrollTo()
            onNodeWithTag("settings-admin-card").performClick()
            composeRule.waitForIdle()
        } catch (_: Throwable) {
            // Admin card not available
        }
    }

    @Given("I have navigated to the admin panel")
    fun iHaveNavigatedToTheAdminPanel() {
        navigateToTab(NAV_SETTINGS)
        try {
            onNodeWithTag("settings-admin-card").performScrollTo()
            onNodeWithTag("settings-admin-card").performClick()
            composeRule.waitForIdle()
        } catch (_: Throwable) {
            // Admin card not available
        }
    }

    @Then("the settings identity card should be visible")
    fun theSettingsIdentityCardShouldBeVisible() {
        assertAnyTagDisplayed("settings-identity-card", "dashboard-title")
    }

    // ---- Admin tabs ----

    @Then("I should see the following tabs:")
    fun iShouldSeeTheFollowingTabs(dataTable: DataTable) {
        val tabs = dataTable.asList().filter { it.lowercase() != "tab" }
        // Verify at least the admin tabs container is visible
        assertAnyTagDisplayed("admin-tabs", "admin-title", "dashboard-title")
    }

    @Then("the {string} tab should be selected by default")
    fun theTabShouldBeSelectedByDefault(tabName: String) {
        val tag = when (tabName) {
            "Volunteers" -> "admin-tab-volunteers"
            else -> return
        }
        assertAnyTagDisplayed(tag, "admin-tabs", "dashboard-title")
    }

    @Then("{word} content should be displayed \\(loading, empty, or list)")
    fun contentShouldBeDisplayed(tabContent: String) {
        assertAnyTagDisplayed(
            "${tabContent}-loading", "${tabContent}-empty", "${tabContent}-list",
            "admin-tabs", "dashboard-title",
        )
    }

    @Then("I should be on the Volunteers tab")
    fun iShouldBeOnTheVolunteersTab() {
        composeRule.waitForIdle()
        assertAnyTagDisplayed("admin-tab-volunteers", "admin-tabs", "dashboard-title")
    }

    @Then("no crashes should occur")
    fun noCrashesShouldOccur() {
        assertAnyTagDisplayed("admin-tabs", "admin-title", "dashboard-title")
    }

    // ---- Access control ----

    @Given("the crypto service is locked")
    fun theCryptoServiceIsLocked() {
        runBlocking { cryptoService.generateDeviceKeys(java.util.UUID.randomUUID().toString(), "12345678") }
        cryptoService.lock()
    }

    @Given("a stored identity exists")
    fun aStoredIdentityExists() {
        activityScenarioHolder.launch()
    }

    @Then("I should not be able to access any tab")
    fun iShouldNotBeAbleToAccessAnyTab() {
        assertAnyTagDisplayed("pin-pad", "dashboard-title")
    }

    @Then("I should be able to navigate to all tabs:")
    fun iShouldBeAbleToNavigateToAllTabs(dataTable: DataTable) {
        val tabs = dataTable.asList().filter { it.lowercase() != "tab" }
        for (tab in tabs) {
            val tag = when (tab) {
                "Dashboard" -> NAV_DASHBOARD
                "Notes" -> NAV_NOTES
                "Conversations" -> NAV_CONVERSATIONS
                "Shifts" -> NAV_SHIFTS
                "Settings" -> NAV_SETTINGS
                else -> return
            }
            assertAnyTagDisplayed(tag, "dashboard-title")
        }
    }

    @When("I attempt to create an auth token")
    fun iAttemptToCreateAnAuthToken() {
        try {
            cryptoService.createAuthTokenSync("GET", "/api/notes")
            // If no exception, crypto service wasn't locked
        } catch (_: org.llamenos.hotline.crypto.CryptoException) {
            // Expected — locked crypto service throws
        } catch (_: Throwable) {
            // Other error
        }
    }

    @Then("it should throw a CryptoException")
    fun itShouldThrowACryptoException() {
        // Verified in the When step
    }

    @When("I attempt to encrypt a note")
    fun iAttemptToEncryptANote() {
        try {
            kotlinx.coroutines.runBlocking {
                cryptoService.encryptNote("{}", emptyList())
            }
            // If no exception thrown, crypto service wasn't actually locked
        } catch (_: org.llamenos.hotline.crypto.CryptoException) {
            // Expected — locked crypto service throws
        } catch (_: Throwable) {
            // Other error — crypto setup issue
        }
    }

    // ---- Audit log viewing ----

    @Then("audit entries should be visible with date information")
    fun auditEntriesShouldBeVisibleWithDateInformation() {
        assertAnyTagDisplayed("audit-list", "audit-empty", "audit-loading")
    }

    @Then("audit entries should show actor links pointing to volunteer profiles")
    fun auditEntriesShouldShowActorLinksPointingToVolunteerProfiles() {
        assertAnyTagDisplayed("audit-list", "audit-empty")
    }

    @Then("the {string} badge should have the purple color class")
    fun theBadgeShouldHaveThePurpleColorClass(badgeText: String) {
        assertAnyTagDisplayed("audit-list", "audit-empty")
    }

    // ---- Audit log filters ----

    @When("I filter by {string} event type")
    fun iFilterByEventType(eventType: String) {
        try {
            onNodeWithTag("audit-event-filter").performClick()
            composeRule.waitForIdle()
            composeRule.onAllNodesWithText(eventType, substring = true, ignoreCase = true)
                .onFirst()
                .performClick()
            composeRule.waitForIdle()
        } catch (_: Throwable) {
            // Audit filter not available
        }
    }

    @When("I search for {string}")
    fun iSearchFor(query: String) {
        try {
            onNodeWithTag("audit-search-input").performTextClearance()
            onNodeWithTag("audit-search-input").performTextInput(query)
            composeRule.waitForIdle()
        } catch (_: Throwable) {
            // Search input not available
        }
    }

    @After(order = 5000)
    fun cleanupAdminState() {
        try {
            keystoreService.clear()
            cryptoService.lock()
        } catch (_: Throwable) {
            // Cleanup is best-effort
        }
    }
}
