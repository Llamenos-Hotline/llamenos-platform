package org.llamenos.hotline.crypto

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.llamenos.hotline.hub.HubChainService

/**
 * `packages/crypto/tests/fixtures/v2/hub-chain.json` and `recovery.json` (#2963;
 * wire spec §6.2) through this app's production reader: [CryptoService.hubChainCall]
 * over JNI, the call [HubChainService] verifies every served chain with. Each
 * positive yields the crate's head and state hash; each negative — the forked pair,
 * the revoked-admin race, a server-substituted epoch pk, `migration: 1`, … — fails
 * with its closed rejection code ([HubChainService.rejectionCode]), never merely
 * an error.
 */
@RunWith(AndroidJUnit4::class)
class HubChainVectorTest {

    private fun load(name: String): JsonObject =
        InstrumentationRegistry.getInstrumentation().context.assets
            .open(name).bufferedReader()
            .use { Json.parseToJsonElement(it.readText()).jsonObject }

    private val hubChain = load("hub-chain.json")
    private val recovery = load("recovery.json")

    private fun verifyRequest(c: JsonObject): String {
        val chain = hubChain.getValue("chain").jsonArray
        val links = chain.take(c.getValue("prefix").jsonPrimitive.int) + c.getValue("append").jsonArray
        return buildJsonObject {
            put("op", "verify")
            put("links", JsonArray(links))
            put("userChains", hubChain.getValue("userChains"))
            c["anchor"]?.let { put("anchor", it) }
        }.toString()
    }

    private fun codeOf(request: String): String = runBlocking {
        try {
            CryptoService().hubChainCall(request)
            "no-error"
        } catch (e: CryptoException) {
            HubChainService.rejectionCode(e)
        }
    }

    @Test
    fun hubChainPositivesYieldTheCratesHeadAndState() = runBlocking {
        val positives = hubChain.getValue("positives").jsonArray
        assertEquals(14, positives.size)
        for (p in positives.map { it.jsonObject }) {
            val answer = Json.parseToJsonElement(CryptoService().hubChainCall(verifyRequest(p))).jsonObject
            val expect = p.getValue("expect").jsonObject
            assertEquals(p.getValue("name").toString(), expect.getValue("stateHash"), answer.getValue("stateHash"))
            assertEquals(p.getValue("name").toString(), expect.getValue("head"), answer.getValue("head"))
        }
    }

    @Test
    fun hubChainNegativesFailWithTheirCode() {
        val negatives = hubChain.getValue("negatives").jsonArray
        assertEquals(19, negatives.size)
        for (n in negatives.map { it.jsonObject }) {
            assertEquals(
                n.getValue("name").toString(),
                n.getValue("expect").jsonPrimitive.content,
                codeOf(verifyRequest(n)),
            )
        }
    }

    @Test
    fun recoveryVectorsOpenAndFailByCode() = runBlocking {
        fun request(c: JsonObject) = buildJsonObject {
            put("op", "verifySigchain")
            put("links", c.getValue("chain"))
            put("userChains", recovery.getValue("userChains"))
            put("hubChains", recovery.getValue("hubChains"))
            put("hubAnchors", c.getValue("hubAnchors"))
        }.toString()
        for (p in recovery.getValue("positives").jsonArray.map { it.jsonObject }) {
            val state = Json.parseToJsonElement(CryptoService().hubChainCall(request(p))).jsonObject
            assertEquals(p.getValue("expect").jsonObject.getValue("activeDevicePubkeys"), state.getValue("activeDevicePubkeys"))
        }
        val negatives = recovery.getValue("negatives").jsonArray
        assertEquals(8, negatives.size)
        for (n in negatives.map { it.jsonObject }) {
            val code = codeOf(request(n))
            if (code == "no-error") fail("${n.getValue("name")} was accepted")
            assertEquals(n.getValue("name").toString(), n.getValue("expect").jsonPrimitive.content, code)
        }
    }
}
