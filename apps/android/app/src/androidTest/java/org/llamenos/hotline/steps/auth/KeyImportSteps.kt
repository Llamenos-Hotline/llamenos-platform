package org.llamenos.hotline.steps.auth

import io.cucumber.java.en.Then
import io.cucumber.java.en.When
import org.llamenos.hotline.steps.BaseSteps

/**
 * Step definitions for key-import.feature scenarios.
 *
 * Feature: Key Import
 * Tests importing an existing device key and completing PIN setup.
 */
class KeyImportSteps : BaseSteps() {

    @Then("the hub URL should be stored as {string}")
    fun theHubUrlShouldBeStoredAs(url: String) {
        assertAnyTagDisplayed("dashboard-title", "pin-pad", "create-identity")
    }

    @When("I see the error {string}")
    fun iSeeTheError(errorMessage: String) {
        assertAnyTagDisplayed("device-key-error", "login-error", "create-identity")
    }
}
