package org.llamenos.hotline.ui.messaging

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.llamenos.hotline.MountedRoutes
import org.llamenos.hotline.MountedRoutes.Companion.json
import org.llamenos.hotline.MountedRoutes.Route
import org.llamenos.hotline.MountedServer

/**
 * The Blasts screen (#1997, #1149), against a real [org.llamenos.hotline.api.ApiService] and
 * a fake server that answers **only** what `apps/worker/routes/blasts.ts` mounts under
 * `/api/hubs/:hubId/blasts` and 404s everything else.
 *
 * What was wrong: the screen called `GET`/`POST /api/admin/blasts`, which is not mounted,
 * and posted `{ message, recipientIds, scheduled }` — a blast to hub members. The server's
 * blasts go to opted-in subscribers and take `createBlastBodySchema`
 * (`{ name, content: { body }, channels }`), then are sent with `POST /:id/send`. The list
 * decoded `message` and `recipientCount`, neither of which the server sends.
 *
 * The fake is stateful, so each test asserts what the user sees after the round trip — the
 * created blast is listed with the status the server gave it — not merely that a request
 * was made.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class BlastsRoutesTest {

    private lateinit var server: MountedServer
    private lateinit var routes: MountedRoutes

    /** What the fake server holds, shaped exactly as `blastResponseSchema`. */
    private val stored = mutableListOf<JsonObject>()

    private fun blastRow(id: String, name: String, body: JsonObject, channels: String, status: String): JsonObject =
        Json.parseToJsonElement(
            """{"id":"$id","name":"$name","content":$body,"status":"$status","targetChannels":$channels,""" +
                """"createdAt":"2026-10-22T10:00:00.000Z","updatedAt":"2026-10-22T10:00:00.000Z"}""",
        ).jsonObject

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        routes = MountedRoutes(
            Route("GET", "/api/hubs/:hubId/blasts") {
                json("""{"blasts":${stored.joinToString(",", "[", "]")},"total":${stored.size},"page":1,"limit":20}""")
            },
            Route("POST", "/api/hubs/:hubId/blasts") { call ->
                val req = Json.parseToJsonElement(call.body).jsonObject
                val row = blastRow(
                    id = "blast-${stored.size + 1}",
                    name = req.getValue("name").jsonPrimitive.content,
                    body = req.getValue("content").jsonObject,
                    channels = req.getValue("channels").toString(),
                    status = "draft",
                )
                stored += row
                json("""{"blast":$row}""", code = 201)
            },
            Route("POST", "/api/hubs/:hubId/blasts/:id/send") { call ->
                val index = stored.indexOfFirst { it.getValue("id").jsonPrimitive.content == call.params.getValue("id") }
                if (index < 0) return@Route json("""{"error":"Blast not found"}""", code = 404)
                val sent = JsonObject(stored[index] + ("status" to Json.parseToJsonElement("\"sending\"")))
                stored[index] = sent
                json("""{"blast":$sent}""")
            },
        )
        server = MountedServer(routes)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
        server.shutdown()
    }

    private fun newViewModel() = BlastsViewModel(server.apiService, server.activeHubState)

    @Test
    fun `the list loads from the hub-scoped blasts route and reads the server's shape`() = runTest {
        stored += blastRow(
            id = "blast-multi",
            name = "Multi-language",
            body = Json.parseToJsonElement("""{"es":{"body":"Hola"},"en":{"body":"Hello"}}""").jsonObject,
            channels = """["sms"]""",
            status = "sent",
        )

        val vm = newViewModel()
        advanceUntilIdle()

        val state = vm.uiState.value
        assertNull(state.error)
        val blast = state.blasts.single()
        assertEquals("Multi-language", blast.name)
        assertEquals("Hola", blast.messagePreview)
        assertEquals("sent", blast.status)
        assertTrue(routes.seen().contains("GET /api/hubs/hub-a/blasts"))
    }

    @Test
    fun `send now creates the blast with the create schema and then sends it`() = runTest {
        val vm = newViewModel()
        advanceUntilIdle()

        vm.createBlast("Shift update", "Evening shift starts at 6", listOf("sms", "signal"), sendNow = true)
        advanceUntilIdle()

        val created = Json.parseToJsonElement(routes.bodiesSentTo("POST /api/hubs/hub-a/blasts").single()).jsonObject
        assertEquals("Shift update", created.getValue("name").jsonPrimitive.content)
        assertEquals("Evening shift starts at 6", created.getValue("content").jsonObject.getValue("body").jsonPrimitive.content)
        assertEquals(listOf("sms", "signal"), created.getValue("channels").jsonArray.map { it.jsonPrimitive.content })
        assertTrue(routes.seen().contains("POST /api/hubs/hub-a/blasts/blast-1/send"))

        val state = vm.uiState.value
        assertNull(state.error)
        val listed = state.blasts.single()
        assertEquals("Shift update", listed.name)
        assertEquals("Evening shift starts at 6", listed.messagePreview)
        assertEquals("sending", listed.status)
    }

    @Test
    fun `save draft stores a draft and a draft can be sent later from the list`() = runTest {
        val vm = newViewModel()
        advanceUntilIdle()

        vm.createBlast("Draft", "Not yet", listOf("whatsapp"), sendNow = false)
        advanceUntilIdle()

        assertTrue(routes.seen().none { it.endsWith("/send") })
        assertEquals("draft", vm.uiState.value.blasts.single().status)

        vm.sendBlast("blast-1")
        advanceUntilIdle()

        assertEquals("sending", vm.uiState.value.blasts.single().status)
    }

    @Test
    fun `a failed send surfaces the error instead of an empty screen`() = runTest {
        val vm = newViewModel()
        advanceUntilIdle()

        vm.sendBlast("does-not-exist")
        advanceUntilIdle()

        assertNotNull(vm.uiState.value.error)
    }
}
