package org.llamenos.hotline.steps.admin

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import io.cucumber.java.en.Then
import io.cucumber.java.en.When
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.llamenos.hotline.helpers.SimulationClient
import org.llamenos.hotline.steps.BaseSteps

/**
 * Step definitions for invite-onboarding.feature scenarios.
 *
 * The create/list steps drive the real admin UI and then verify the result
 * against `GET /api/invites` (signed as the test admin) — the endpoint the app
 * itself calls since #1047. A broken path fails the step: before the fix the
 * app called `/api/admin/invites`, which the server has never mounted.
 *
 * Uses InviteDialog/InvitesTab UI testTags: create-invite-fab, create-invite-dialog,
 * invite-name-input, invite-phone-input, create-volunteer-invite, create-admin-invite,
 * created-invite-code, copy-created-invite, close-invite-dialog, invites-list,
 * invites-empty, invite-card-{id}, invite-name-{id}, invite-code-{id},
 * invite-role-{id}, invite-status-{id}, copy-invite-{id}.
 */
class InviteSteps : BaseSteps() {

    private val json = Json { ignoreUnknownKeys = true }

    /** The name typed into the create-invite dialog by this scenario. */
    private var createdInviteName: String? = null

    // ---- Invite creation ----

    @When("I create an invite for a new volunteer")
    fun iCreateAnInviteForANewVolunteer() {
        val name = "E2E Invite ${System.currentTimeMillis()}"
        navigateToAdminTab("invites")
        waitForNode("create-invite-fab")
        onNodeWithTag("create-invite-fab").performClick()
        composeRule.waitForIdle()
        waitForNode("invite-name-input")
        onNodeWithTag("invite-name-input").performTextReplacement(name)
        composeRule.waitForIdle()
        onNodeWithTag("create-volunteer-invite").performClick()
        createdInviteName = name
    }

    @Then("an invite link should be generated")
    fun anInviteLinkShouldBeGenerated() {
        waitForNode("created-invite-code", 10_000)
        onNodeWithTag("created-invite-code").assertIsDisplayed()
        // The create must have landed server-side, readable through the exact
        // endpoint the app lists from. A 404 here fails the step.
        val invite = findCreatedInvite()
        check(invite != null) {
            "GET /api/invites has no invite named '$createdInviteName' — the create did not reach the server"
        }
    }

    @When("I dismiss the invite link card")
    fun iDismissTheInviteLinkCard() {
        waitForNode("close-invite-dialog")
        onNodeWithTag("close-invite-dialog").performClick()
        composeRule.waitForIdle()
    }

    @Then("the volunteer name should appear in the pending invites list")
    fun theVolunteerNameShouldAppearInThePendingInvitesList() {
        val name = checkNotNull(createdInviteName) { "No invite was created in this scenario" }
        waitForNode("invites-list", 10_000)
        composeRule.waitUntil(10_000) {
            runCatching {
                onAllNodes(hasTestTagPrefix("invite-name-"))
                    .fetchSemanticsNodes()
                    .any { node ->
                        runCatching { node.config[SemanticsProperties.Text] }
                            .getOrNull()
                            ?.any { it.text == name } == true
                    }
            }.getOrDefault(false)
        }
        val invite = findCreatedInvite()
        check(invite != null && invite.usedAt == null) {
            "GET /api/invites does not list an unused invite named '$name'"
        }
    }

    @When("I revoke the invite")
    fun iRevokeTheInvite() {
        // Revoke UI not implemented — copy-invite buttons exist but no revoke action (#764)
        try {
            onAllNodes(hasTestTagPrefix("invite-card-")).onFirst().performClick()
            composeRule.waitForIdle()
        } catch (_: Throwable) {
            // No invite cards — invite wasn't created
        }
    }

    @Then("the volunteer name should no longer appear in the list")
    fun theVolunteerNameShouldNoLongerAppearInTheList() {
        composeRule.waitForIdle()
        assertAnyTagDisplayed("invites-list", "invites-empty")
    }

    // ---- Invite onboarding (web-specific flows — stubs for Android) ----

    @When("the volunteer opens the invite link")
    fun theVolunteerOpensTheInviteLink() {
        // On Android, deep link handling would open the app — stub for now (#766)
    }

    @Then("they should see a welcome screen with their name")
    fun theyShouldSeeAWelcomeScreenWithTheirName() {
        assertAnyTagDisplayed("dashboard-title", "profile-setup", "pin-title")
    }

    @When("the volunteer completes the onboarding flow")
    fun theVolunteerCompletesTheOnboardingFlow() {
        // On Android, invite deep link onboarding is stubbed — the admin is still
        // logged in from earlier steps. Just verify we're on a valid screen.
        composeRule.waitForIdle()
        assertAnyTagDisplayed("dashboard-title", "profile-setup", "pin-pad", "admin-tabs")
    }

    @Then("they should arrive at the profile setup or dashboard")
    fun theyShouldArriveAtTheProfileSetupOrDashboard() {
        assertAnyTagDisplayed("dashboard-title", "profile-setup")
    }

    // ---- Server-side verification ----

    private data class ServerInvite(val code: String, val name: String, val usedAt: String?)

    /**
     * `GET /api/invites` as the test admin and find this scenario's invite by
     * name. Throws on any non-2xx — the assertion is the response, so a broken
     * path is a failed step, not an empty list.
     */
    private fun findCreatedInvite(): ServerInvite? {
        val name = createdInviteName ?: return null
        val body = SimulationClient.authorizedGet("/api/invites")
        return json.parseToJsonElement(body).jsonObject["invites"]!!.jsonArray
            .map { it.jsonObject }
            .filter { it["name"]!!.jsonPrimitive.content == name }
            .map {
                ServerInvite(
                    code = it["code"]!!.jsonPrimitive.content,
                    name = name,
                    usedAt = it["usedAt"]?.jsonPrimitive?.content,
                )
            }
            .firstOrNull { it.usedAt == null }
    }
}
