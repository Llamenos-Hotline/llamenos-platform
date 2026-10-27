package org.llamenos.hotline.ui.admin

import androidx.lifecycle.SavedStateHandle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.llamenos.hotline.MountedRoutes
import org.llamenos.hotline.MountedRoutes.Companion.json
import org.llamenos.hotline.MountedRoutes.Route
import org.llamenos.hotline.MountedServer
import org.llamenos.hotline.model.id

/**
 * The ban list and the custom-field editor (#1149, #1730), against a real
 * [org.llamenos.hotline.api.ApiService] and a stateful fake that answers **only** what the
 * worker mounts.
 *
 * Both screens used the `/api/admin` prefix, which carries only security-events and
 * devices/overview, so every load, add, remove and save was a 404:
 *
 *     GET    /api/admin/bans            -> 404      mounted: GET /api/hubs/:hubId/bans
 *     POST   /api/admin/bans            -> 404      mounted: POST /api/hubs/:hubId/bans
 *     DELETE /api/admin/bans/:id        -> 404      mounted: DELETE /api/hubs/:hubId/bans/:phoneHash
 *     POST   /api/admin/bans/bulk       -> 404      mounted: POST /api/hubs/:hubId/bans/bulk
 *     GET    /api/admin/custom-fields   -> 404      mounted: GET  /api/settings/custom-fields
 *     PUT    /api/admin/custom-fields   -> 404      mounted: PUT  /api/settings/custom-fields
 *
 * Fixing the path alone would still have lost every ban: the route takes `{ phone }` (E.164 —
 * it hashes the number itself) where the client sent `{ identifier }`, and unbans by the row's
 * `phoneHash` where the client sent the masked `phone`. The fake enforces both.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class AdminBansAndFieldsRoutesTest {

    private lateinit var server: MountedServer
    private lateinit var routes: MountedRoutes

    private val bans = mutableListOf<JsonObject>()
    private var fields: JsonArray = JsonArray(emptyList())

    /** The server's keyed ban hash stands in as a stable 64-hex digest of the number; the response carries no digits of it. */
    private fun hashOf(phone: String) = "%064x".format(phone.filter { it.isDigit() }.toBigInteger())

    private fun ban(phone: String, reason: String): JsonObject = Json.parseToJsonElement(
        """{"phoneHash":"${hashOf(phone)}","reason":"$reason",
        |"bannedBy":"${"aa".repeat(32)}","bannedAt":"2026-10-20T10:00:00.000Z"}""".trimMargin(),
    ).jsonObject

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        val e164 = Regex("^\\+[1-9]\\d{6,14}$")
        routes = MountedRoutes(
            Route("GET", "/api/hubs/:hubId/bans") { json("""{"bans":${JsonArray(bans)}}""") },
            Route("POST", "/api/hubs/:hubId/bans") { call ->
                val body = Json.parseToJsonElement(call.body).jsonObject
                val phone = body["phone"]?.jsonPrimitive?.content
                when {
                    (body.keys - setOf("phone", "reason")).isNotEmpty() ->
                        json("""{"error":"unrecognised keys"}""", 400)
                    phone == null || !e164.matches(phone) -> json("""{"error":"Invalid phone"}""", 400)
                    else -> {
                        val row = ban(phone, body["reason"]?.jsonPrimitive?.content.orEmpty())
                        bans += row
                        json("""{"ban":$row}""")
                    }
                }
            },
            Route("POST", "/api/hubs/:hubId/bans/bulk") { call ->
                val body = Json.parseToJsonElement(call.body).jsonObject
                val phones = body["phones"]?.jsonArray?.map { it.jsonPrimitive.content }.orEmpty()
                if ((body.keys - setOf("phones", "reason")).isNotEmpty() || phones.isEmpty() ||
                    phones.any { !e164.matches(it) }
                ) {
                    json("""{"error":"Invalid body"}""", 400)
                } else {
                    phones.forEach { bans += ban(it, body["reason"]?.jsonPrimitive?.content.orEmpty()) }
                    json("""{"count":${phones.size}}""")
                }
            },
            Route("DELETE", "/api/hubs/:hubId/bans/:phoneHash") { call ->
                bans.removeAll { it.getValue("phoneHash").jsonPrimitive.content == call.params["phoneHash"] }
                json("""{"ok":true}""")
            },
            Route("GET", "/api/settings/custom-fields") { json("""{"fields":$fields}""") },
            Route("PUT", "/api/settings/custom-fields") { call ->
                val body = Json.parseToJsonElement(call.body).jsonObject
                val sent = body["fields"]?.jsonArray
                val valid = sent != null && sent.all {
                    val f = it.jsonObject
                    "name" in f && "label" in f && "type" in f
                }
                if (!valid) {
                    json("""{"error":"Each field must have name, label, and type"}""", 400)
                } else {
                    fields = sent!!
                    json("""{"fields":$fields}""")
                }
            },
        )
        server = MountedServer(routes)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
        server.shutdown()
    }

    private fun viewModel() = AdminViewModel(server.apiService, SavedStateHandle())

    // ── Ban list ─────────────────────────────────────────────────────────────

    @Test
    fun `a number added to the ban list is stored by the hub and is what the list then shows`() =
        runTest(UnconfinedTestDispatcher()) {
            val vm = viewModel()

            vm.addBan("+15551234567", "harassing calls")
            advanceUntilIdle()

            assertTrue(
                "expected POST /api/hubs/hub-a/bans, saw ${routes.seen()}",
                routes.seen().contains("POST /api/hubs/hub-a/bans"),
            )
            val sent = Json.parseToJsonElement(routes.bodiesSentTo("POST /api/hubs/hub-a/bans").single()).jsonObject
            assertEquals("+15551234567", sent.getValue("phone").jsonPrimitive.content)
            assertEquals("harassing calls", sent.getValue("reason").jsonPrimitive.content)
            assertTrue("`identifier` is not a field createBanBodySchema declares: $sent", "identifier" !in sent)
            assertNull(vm.uiState.value.bansError)
            // Round trip: the server holds it and the screen shows what the server holds.
            assertEquals(1, bans.size)
            val shown = vm.uiState.value.bans.single()
            // The list holds a reason and a date and no number, masked or not.
            assertEquals("harassing calls", shown.reason)
            assertEquals(bans.single().getValue("phoneHash").jsonPrimitive.content, shown.phoneHash)
        }

    @Test
    fun `removing a ban unbans by the row's phoneHash`() = runTest(UnconfinedTestDispatcher()) {
        bans += ban("+15551234567", "spam")
        val vm = viewModel()
        vm.loadBans()
        advanceUntilIdle()
        val shown = vm.uiState.value.bans.single()

        vm.removeBan(shown.id)
        advanceUntilIdle()

        assertTrue(
            "expected DELETE /api/hubs/hub-a/bans/<phoneHash>, saw ${routes.seen()}",
            routes.seen().contains("DELETE /api/hubs/hub-a/bans/${shown.phoneHash}"),
        )
        assertNull(vm.uiState.value.bansError)
        assertTrue("the server must no longer hold the ban", bans.isEmpty())
        assertTrue("the reloaded list must be empty", vm.uiState.value.bans.isEmpty())
    }

    @Test
    fun `bulk import posts the phones and every one is banned`() = runTest(UnconfinedTestDispatcher()) {
        val vm = viewModel()

        vm.bulkImportBans(listOf("+15550000001", "+15550000002"), "list from partner org")
        advanceUntilIdle()

        assertTrue(
            "expected POST /api/hubs/hub-a/bans/bulk, saw ${routes.seen()}",
            routes.seen().contains("POST /api/hubs/hub-a/bans/bulk"),
        )
        assertNull(vm.uiState.value.bansError)
        assertEquals(2, bans.size)
        assertEquals(2, vm.uiState.value.bans.size)
    }

    @Test
    fun `a number the server rejects is reported, not shown as banned`() = runTest(UnconfinedTestDispatcher()) {
        val vm = viewModel()

        vm.addBan("not-a-number", null)
        advanceUntilIdle()

        assertTrue("an invalid number must not be stored", bans.isEmpty())
        assertTrue(
            "the 400 must reach the screen as an error",
            vm.uiState.value.bansError?.isNotBlank() == true,
        )
        assertTrue(vm.uiState.value.bans.isEmpty())
    }

    // ── Custom fields ────────────────────────────────────────────────────────

    private fun sampleField(id: String, name: String): org.llamenos.hotline.model.CustomFieldDef =
        Json.decodeFromString(
            """{"id":"$id","name":"$name","label":"${name.replaceFirstChar { it.uppercase() }}",
            |"type":"text","required":false,"visibleToUsers":true,"editableByUsers":true,
            |"context":"all","order":0,"createdAt":"2026-10-20T10:00:00.000Z"}""".trimMargin(),
        )

    @Test
    fun `a saved custom field is stored by the server and reloaded from it`() =
        runTest(UnconfinedTestDispatcher()) {
            val vm = viewModel()

            vm.saveCustomField(sampleField("f1", "age"))
            advanceUntilIdle()

            assertTrue(
                "expected PUT /api/settings/custom-fields, saw ${routes.seen()}",
                routes.seen().contains("PUT /api/settings/custom-fields"),
            )
            assertNull(vm.uiState.value.fieldsError)
            assertEquals(1, fields.size)
            assertEquals("age", fields.single().jsonObject.getValue("name").jsonPrimitive.content)
            // The screen reloaded what the server now holds.
            assertEquals(listOf("age"), vm.uiState.value.customFields.map { it.name })
        }

    @Test
    fun `deleting a custom field saves the shorter list`() = runTest(UnconfinedTestDispatcher()) {
        val vm = viewModel()
        vm.saveCustomField(sampleField("f1", "age"))
        advanceUntilIdle()
        vm.saveCustomField(sampleField("f2", "city"))
        advanceUntilIdle()
        assertEquals(2, fields.size)

        vm.deleteCustomField("f1")
        advanceUntilIdle()

        assertNull(vm.uiState.value.fieldsError)
        assertEquals(listOf("city"), fields.map { it.jsonObject.getValue("name").jsonPrimitive.content })
        assertEquals(listOf("city"), vm.uiState.value.customFields.map { it.name })
        assertTrue(
            "the 404 admin prefix must not be touched: ${routes.seen()}",
            routes.seen().none { it.contains("/api/admin/") },
        )
    }
}
