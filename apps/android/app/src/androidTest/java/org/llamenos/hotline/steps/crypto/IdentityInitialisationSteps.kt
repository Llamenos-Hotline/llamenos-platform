package org.llamenos.hotline.steps.crypto

import dagger.hilt.android.EntryPointAccessors
import io.cucumber.java.en.Given
import io.cucumber.java.en.Then
import io.cucumber.java.en.When
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.llamenos.hotline.LlamenosApp
import org.llamenos.hotline.crypto.UserIdentityService
import org.llamenos.hotline.di.CryptoEntryPoint
import org.llamenos.hotline.di.UserIdentityEntryPoint
import org.llamenos.hotline.helpers.SimulationClient
import org.llamenos.hotline.steps.BaseSteps
import org.llamenos.protocol.PukEnvelopeResponse
import org.llamenos.protocol.SigchainGenesisPayload
import org.llamenos.protocol.SigchainPukEpochPayload
import org.llamenos.protocol.SigchainResponse
import org.llamenos.protocol.SigchainResponseLink

/**
 * Step definitions for identity-initialisation.feature.
 *
 * The identity is created through the real onboarding UI, and initialisation runs
 * through the app's own [UserIdentityService] singleton — the same instance the
 * key-generation and unlock paths call. Every assertion reads the server's stored
 * state back as this device and checks it with packages/crypto (verify_sigchain,
 * PUK envelope open + subkey derivation), so a pass means the chain verifies, not
 * that a function was called.
 */
class IdentityInitialisationSteps : BaseSteps() {

    private val json = Json { ignoreUnknownKeys = true }

    private val cryptoService
        get() = EntryPointAccessors.fromApplication(LlamenosApp.instance, CryptoEntryPoint::class.java)
            .cryptoService()

    private val identityEntryPoint
        get() = EntryPointAccessors.fromApplication(LlamenosApp.instance, UserIdentityEntryPoint::class.java)

    private val signingPubkey: String
        get() = checkNotNull(cryptoService.signingPubkeyHex) { "No identity on this device" }

    private fun storedChain(): List<SigchainResponseLink> = runBlocking {
        identityEntryPoint.apiService()
            .request<SigchainResponse>("GET", "/api/users/$signingPubkey/sigchain")
            .links
    }

    @Given("I have created a new identity on this device")
    fun iHaveCreatedANewIdentityOnThisDevice() {
        navigateToMainScreen()
        waitForNode("dashboard-title", timeoutMillis = 30_000)
        assertTrue("Device keys must be unlocked after onboarding", cryptoService.isUnlocked)
    }

    @Then("identity initialisation waits until the server knows this user")
    fun identityInitialisationWaitsUntilTheServerKnowsThisUser() {
        val outcome = runBlocking { identityEntryPoint.userIdentityService().ensureInitialized() }
        assertEquals(UserIdentityService.Outcome.NotRegistered, outcome)
    }

    @When("the hub registers this device's user")
    fun theHubRegistersThisDevicesUser() {
        val result = SimulationClient.promoteToAdmin(signingPubkey)
        assertTrue("Registering $signingPubkey failed: ${result.error}", result.ok)
    }

    @When("the app initialises this user's identity")
    fun theAppInitialisesThisUsersIdentity() {
        val outcome = runBlocking { identityEntryPoint.userIdentityService().ensureInitialized() }
        assertTrue(
            "Identity initialisation must verify the chain, got $outcome",
            outcome is UserIdentityService.Outcome.Verified,
        )
    }

    @Then("this user's sigchain is a genesis link followed by a PUK epoch")
    fun thisUsersSigchainIsAGenesisLinkFollowedByAPukEpoch() {
        val shape = storedChain().map { "${it.seqNo}:${it.linkType}" }
        assertEquals(listOf("1:genesis", "2:puk_epoch"), shape)
    }

    @Then("the stored sigchain verifies and authorises only this device")
    fun theStoredSigchainVerifiesAndAuthorisesOnlyThisDevice() {
        val links = storedChain()
        val linksJson = identityEntryPoint.userIdentityService().toCryptoLinksJson(links)
        val verified = runBlocking { cryptoService.verifySigchain(linksJson) }
        assertEquals(links.size.toULong(), verified.verifiedCount)
        assertEquals(links.last().hash, verified.headHash)
        assertEquals(listOf(signingPubkey), verified.activeDevicePubkeys)
    }

    @Then("the genesis link names this device's keys")
    fun theGenesisLinkNamesThisDevicesKeys() {
        val genesis = storedChain().first()
        val payload = json.decodeFromJsonElement(
            SigchainGenesisPayload.serializer(),
            checkNotNull(genesis.payload) { "Genesis link has no payload" },
        )
        assertEquals(cryptoService.deviceId, payload.deviceID)
        assertEquals(signingPubkey, payload.devicePubkey)
        assertEquals(cryptoService.encryptionPubkeyHex, payload.deviceEncryptionPubkey)
        assertEquals(signingPubkey, genesis.signerPubkey)
        assertEquals(cryptoService.deviceId, genesis.signerDeviceID)
    }

    @Then("this device opens its PUK envelope to the keys the chain names")
    fun thisDeviceOpensItsPukEnvelopeToTheKeysTheChainNames() {
        val epochLink = storedChain().single { it.linkType == "puk_epoch" }
        val epoch = json.decodeFromJsonElement(
            SigchainPukEpochPayload.serializer(),
            checkNotNull(epochLink.payload) { "puk_epoch link has no payload" },
        )
        val deviceId = checkNotNull(cryptoService.deviceId)
        val stored = runBlocking {
            identityEntryPoint.apiService()
                .request<PukEnvelopeResponse>("GET", "/api/puk/envelopes/$deviceId")
        }
        assertEquals(epoch.generation, stored.generation)
        val seedHex = runBlocking { cryptoService.unwrapPukSeed(stored.envelope) }
        assertNotNull(seedHex)
        val derived = runBlocking { cryptoService.derivePukState(seedHex, stored.generation) }
        assertEquals(epoch.signPubkey, derived.signPubkeyHex)
        assertEquals(epoch.dhPubkey, derived.dhPubkeyHex)
    }
}
