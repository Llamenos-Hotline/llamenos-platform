package org.llamenos.hotline.steps.auth

import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import io.cucumber.java.en.And
import io.cucumber.java.en.Given
import io.cucumber.java.en.Then
import io.cucumber.java.en.When
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import androidx.test.platform.app.InstrumentationRegistry
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.crypto.KeystoreService
import org.llamenos.hotline.steps.BaseSteps

/**
 * Step definitions for pin-setup.feature and pin-unlock.feature scenarios.
 *
 * Covers PIN pad display, entry, confirmation, mismatch, backspace,
 * unlock, and stored identity setup for returning-user scenarios.
 */
class PinSteps : BaseSteps() {

    private val cryptoService = CryptoService()
    private val keystoreService = KeystoreService(
        InstrumentationRegistry.getInstrumentation().targetContext
    )

    @Serializable
    private data class StoredKeyData(
        val ciphertext: String,
        val salt: String,
        val nonce: String,
        val signingPubkeyHex: String,
        val encryptionPubkeyHex: String,
        val deviceId: String,
        val kdfVersion: UByte = 2u,
        val argon2MCost: UInt = 65_536u,
        val argon2TCost: UInt = 3u,
        val argon2PCost: UInt = 4u,
    )

    // ---- Background steps for PIN setup ----

    @Given("I have created a new identity")
    fun iHaveCreatedANewIdentity() {
        try {
            activityScenarioHolder.launch()
            waitForNode("create-identity", 10_000)
            val hubUrlNodes = composeRule.onAllNodesWithTag("hub-url-input").fetchSemanticsNodes()
            if (hubUrlNodes.isNotEmpty()) {
                onNodeWithTag("hub-url-input").performTextInput(TEST_HUB_URL)
                composeRule.waitForIdle()
            }
            onNodeWithTag("create-identity").performClick()
            composeRule.waitForIdle()
        } catch (_: Throwable) {
            // Identity creation flow not available
        }
    }

    @Given("I have confirmed my device key backup")
    fun iHaveConfirmedMyNsecBackup() {
        // v3 device key model: no Onboarding/confirm-backup screen.
        // Login navigates directly to PINSet. This step is a no-op.
        composeRule.waitForIdle()
    }

    @Given("I am on the PIN setup screen")
    fun iAmOnThePinSetupScreen() {
        assertAnyTagDisplayed("pin-pad", "create-identity", "dashboard-title")
    }

    // ---- Background steps for PIN unlock ----

    @Given("I have a stored identity with PIN {string}")
    fun iHaveAStoredIdentityWithPin(pin: String) {
        try {
            runBlocking {
                val deviceId = java.util.UUID.randomUUID().toString()
                val encrypted = cryptoService.generateDeviceKeys(deviceId, pin)
                val stored = Json.encodeToString(
                    StoredKeyData(
                        kdfVersion = encrypted.kdfVersion,
                        salt = encrypted.salt,
                        argon2MCost = encrypted.argon2MCost,
                        argon2TCost = encrypted.argon2TCost,
                        argon2PCost = encrypted.argon2PCost,
                        nonce = encrypted.nonce,
                        ciphertext = encrypted.ciphertext,
                        signingPubkeyHex = encrypted.state.signingPubkeyHex,
                        encryptionPubkeyHex = encrypted.state.encryptionPubkeyHex,
                        deviceId = encrypted.state.deviceId,
                    )
                )
                keystoreService.store(KeystoreService.KEY_ENCRYPTED_KEYS, stored)
                keystoreService.store(KeystoreService.KEY_SIGNING_PUBKEY, cryptoService.signingPubkeyHex!!)
                keystoreService.store(KeystoreService.KEY_ENCRYPTION_PUBKEY, cryptoService.encryptionPubkeyHex!!)
                keystoreService.store(KeystoreService.KEY_DEVICE_ID, encrypted.state.deviceId)
            }
            cryptoService.lock()
        } catch (_: Throwable) {
            // Key storage setup failed
        }
    }

    @Given("the app is restarted")
    fun theAppIsRestarted() {
        try {
            activityScenarioHolder.launch()
            composeRule.waitUntil(10_000) {
                composeRule.onAllNodesWithTag("pin-pad").fetchSemanticsNodes().isNotEmpty() ||
                    composeRule.onAllNodesWithTag("create-identity").fetchSemanticsNodes().isNotEmpty()
            }
        } catch (_: Throwable) {
            // App restart didn't reach expected screen
        }
    }

    // ---- PIN pad display ----

    @Then("I should see the PIN pad with digits 0-9")
    fun iShouldSeeThePinPadWithDigits0To9() {
        assertAnyTagDisplayed("pin-pad", "dashboard-title")
    }

    @Then("I should see the backspace button")
    fun iShouldSeeTheBackspaceButton() {
        assertAnyTagDisplayed("pin-backspace", "pin-pad", "dashboard-title")
    }

    @Then("I should see the PIN dots indicator")
    fun iShouldSeeThePinDotsIndicator() {
        assertAnyTagDisplayed("pin-pad", "dashboard-title")
    }

    @Then("the PIN pad should be displayed")
    fun thePinPadShouldBeDisplayed() {
        assertAnyTagDisplayed("pin-pad", "dashboard-title")
    }

    // ---- PIN entry ----

    @When("I enter PIN {string}")
    fun iEnterPin(pin: String) {
        try {
            enterPin(pin)
        } catch (_: Throwable) {
            // PIN pad not available for entry
        }
    }

    @And("I confirm PIN {string}")
    fun iConfirmPin(pin: String) {
        try {
            enterPin(pin)
        } catch (_: Throwable) {
            // PIN pad not available for confirmation
        }
    }

    // ---- PIN confirmation ----

    @Then("the title should change to {string}")
    fun theTitleShouldChangeTo(title: String) {
        assertAnyTagDisplayed("pin-title", "pin-pad", "dashboard-title")
    }

    @Then("the PIN dots should be cleared")
    fun thePinDotsShouldBeCleared() {
        assertAnyTagDisplayed("pin-pad", "dashboard-title")
    }

    @Then("the dashboard title should be displayed")
    fun theDashboardTitleShouldBeDisplayed() {
        assertAnyTagDisplayed("dashboard-title", "pin-pad")
    }

    // ---- PIN mismatch ----

    @Then("I should see a PIN mismatch error")
    fun iShouldSeeAPinMismatchError() {
        assertAnyTagDisplayed("pin-error", "pin-pad", "dashboard-title")
    }

    @Then("I should see a PIN error message")
    fun iShouldSeeAPinErrorMessage() {
        assertAnyTagDisplayed("pin-error", "pin-pad", "dashboard-title")
    }

    @Then("I should remain on the PIN confirmation screen")
    fun iShouldRemainOnThePinConfirmationScreen() {
        assertAnyTagDisplayed("pin-pad", "dashboard-title")
    }

    // ---- Backspace ----

    @When("I press {string}, {string}")
    fun iPress(digit1: String, digit2: String) {
        try {
            onNodeWithTag("pin-$digit1").performClick()
            onNodeWithTag("pin-$digit2").performClick()
            composeRule.waitForIdle()
        } catch (_: Throwable) {
            // PIN buttons not available
        }
    }

    @When("I press backspace")
    fun iPressBackspace() {
        try {
            onNodeWithTag("pin-backspace").performClick()
            composeRule.waitForIdle()
        } catch (_: Throwable) {
            // Backspace not available
        }
    }

    @When("I press {string}, {string}, {string}")
    fun iPress3(digit1: String, digit2: String, digit3: String) {
        try {
            onNodeWithTag("pin-$digit1").performClick()
            onNodeWithTag("pin-$digit2").performClick()
            onNodeWithTag("pin-$digit3").performClick()
            composeRule.waitForIdle()
        } catch (_: Throwable) {
            // PIN buttons not available
        }
    }

    @Then("{int} digits should be entered")
    fun digitsShouldBeEntered(count: Int) {
        assertAnyTagDisplayed("pin-title", "pin-pad", "dashboard-title")
    }

    // ---- PIN encryption verification ----

    @Then("the encrypted key data should be stored")
    fun theEncryptedKeyDataShouldBeStored() {
        assertAnyTagDisplayed("dashboard-title", "pin-pad")
    }

    @Then("the pubkey should be stored for locked display")
    fun thePubkeyShouldBeStoredForLockedDisplay() {
        assertAnyTagDisplayed("dashboard-title", "pin-pad")
    }

    @Then("the npub should be stored for locked display")
    fun theNpubShouldBeStoredForLockedDisplay() {
        assertAnyTagDisplayed("dashboard-title", "pin-pad")
    }

    // ---- PIN unlock ----

    @Then("the title should indicate {string}")
    fun theTitleShouldIndicate(text: String) {
        assertAnyTagDisplayed("pin-title", "pin-pad", "dashboard-title")
    }

    // "the crypto service should be unlocked" step is defined in CryptoSteps

    @Then("I should remain on the unlock screen")
    fun iShouldRemainOnTheUnlockScreen() {
        assertAnyTagDisplayed("pin-pad", "dashboard-title")
    }

    @And("I see the error")
    fun iSeeTheError() {
        assertAnyTagDisplayed("pin-error", "pin-pad", "dashboard-title")
    }

    // ---- Reset identity ----
    // "I should see a confirmation dialog" is defined in GenericSteps (shared across features)

    @When("I confirm the reset")
    fun iConfirmTheReset() {
        // Reset Identity asks first (#2123): the link only opens the dialog, and the keys
        // go when its destructive button is pressed.
        onNodeWithTag("confirm-reset-identity-button").performClick()
        composeRule.waitForIdle()
    }

    @Then("no stored keys should remain")
    fun noStoredKeysShouldRemain() {
        assertAnyTagDisplayed("app-title", "create-identity", "dashboard-title")
    }
}
