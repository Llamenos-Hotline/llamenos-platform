package org.llamenos.hotline.api

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.llamenos.hotline.MountedRoutes
import org.llamenos.hotline.MountedRoutes.Companion.json
import org.llamenos.hotline.MountedRoutes.Route
import org.llamenos.hotline.MountedServer
import org.llamenos.hotline.ui.admin.channels.ChannelConfigViewModel

/**
 * The messaging channel settings and A2P screens (#1997), against a real [ApiService] and
 * a fake server that answers **only** what `apps/worker/routes/settings.ts` and
 * `provider-setup.ts` mount and 404s everything else.
 *
 * What was wrong: every call in [MessagingConfigRepository] omitted the `/api` prefix
 * (`/settings/messaging`, `/provider-setup/a2p/…`), so each one 404'd — the channel
 * screens could neither load nor save. And `getA2pStatus` turned *every* failure into
 * "no registration", so the 404 rendered as an unregistered hub instead of an error.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class MessagingConfigRepositoryTest {

    private lateinit var server: MountedServer
    private lateinit var routes: MountedRoutes
    private lateinit var repository: MessagingConfigRepository

    /** What the fake server holds — the messaging config, as `messagingConfigSchema` shapes it. */
    private var stored: JsonObject = Json.parseToJsonElement(
        """{"enabledChannels":[],"autoAssign":true,"inactivityTimeout":60,"maxConcurrentPerUser":3}""",
    ).jsonObject

    /** The hub's A2P registration, or null for "never submitted" (the route answers 404). */
    private var a2p: String? = null
    private var a2pStatusCode = 200

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        routes = MountedRoutes(
            Route("GET", "/api/settings/messaging") { json(stored.toString()) },
            Route("PATCH", "/api/settings/messaging") { call ->
                stored = JsonObject(stored + Json.parseToJsonElement(call.body).jsonObject)
                json(stored.toString())
            },
            Route("POST", "/api/settings/messaging/test") { json("""{"connected":true}""") },
            Route("GET", "/api/provider-setup/a2p/status") {
                when {
                    a2pStatusCode != 200 -> json("""{"error":"boom"}""", code = a2pStatusCode)
                    a2p == null -> json("""{"error":"No A2P registration found for this hub"}""", code = 404)
                    else -> json(a2p!!)
                }
            },
            Route("POST", "/api/provider-setup/a2p/brand") { call ->
                val hubId = Json.parseToJsonElement(call.body).jsonObject.getValue("hubId").jsonPrimitive.content
                a2p = """{"id":"reg-1","hubId":"$hubId","providerType":"twilio","brandStatus":"pending","campaignStatus":"not_submitted"}"""
                json(a2p!!)
            },
            Route("POST", "/api/provider-setup/a2p/campaign") { json(a2p!!.replace("\"campaignStatus\":\"not_submitted\"", "\"campaignStatus\":\"pending\"")) },
            Route("POST", "/api/provider-setup/a2p/skip") { call ->
                val hubId = Json.parseToJsonElement(call.body).jsonObject.getValue("hubId").jsonPrimitive.content
                json("""{"id":"reg-1","hubId":"$hubId","providerType":"twilio","brandStatus":"skipped","campaignStatus":"skipped"}""")
            },
        )
        server = MountedServer(routes)
        repository = MessagingConfigRepository(server.apiService)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
        server.shutdown()
    }

    @Test
    fun `a saved channel setting is what the screen reads back`() = runTest {
        assertEquals(emptyList<String>(), repository.getConfig().enabledChannels)

        repository.updateConfig(mapOf("enabledChannels" to listOf("sms"), "autoAssign" to false))
        val reloaded = repository.getConfig()

        assertEquals(listOf("sms"), reloaded.enabledChannels)
        assertEquals(false, reloaded.autoAssign)
        val sent = Json.parseToJsonElement(routes.bodiesSentTo("PATCH /api/settings/messaging").single()).jsonObject
        assertEquals(false, sent.getValue("autoAssign").jsonPrimitive.boolean)
    }

    @Test
    fun `a connection test reaches the mounted route`() = runTest {
        assertTrue(repository.testChannel("sms"))
        assertTrue(routes.seen().contains("POST /api/settings/messaging/test"))
    }

    @Test
    fun `a hub that never registered reads as no registration, and a brand submission is then listed`() = runTest {
        assertNull(repository.getA2pStatus("hub-a"))

        repository.submitBrand("hub-a", mapOf("legalName" to "Example"))
        val status = repository.getA2pStatus("hub-a")

        assertEquals("pending", status?.brandStatus)
        assertEquals("hub-a", status?.hubId)
    }

    @Test
    fun `campaign and skip reach their mounted routes`() = runTest {
        repository.submitBrand("hub-a", mapOf("legalName" to "Example"))
        assertEquals("pending", repository.submitCampaign("reg-1", "hub-a", mapOf("useCase" to "MIXED")).campaignStatus)
        assertEquals("skipped", repository.skipA2p("hub-a").brandStatus)
    }

    @Test
    fun `an A2P status failure other than not-found is surfaced, not read as unregistered`() = runTest {
        a2pStatusCode = 403
        val error = assertThrows(ApiException::class.java) {
            runBlocking { repository.getA2pStatus("hub-a") }
        }
        assertEquals(403, error.code)
    }

    @Test
    fun `the SMS screen's A2P section loads and skips for the active hub`() = runTest {
        val vm = ChannelConfigViewModel(repository, server.activeHubState)
        vm.loadA2pStatus()
        advanceUntilIdle()
        assertNull(vm.state.value.a2pRegistration)
        assertNull(vm.state.value.error)

        vm.skipA2p()
        advanceUntilIdle()

        val sent = Json.parseToJsonElement(routes.bodiesSentTo("POST /api/provider-setup/a2p/skip").single()).jsonObject
        assertEquals("hub-a", sent.getValue("hubId").jsonPrimitive.content)
        assertEquals("skipped", vm.state.value.a2pRegistration?.brandStatus)
        assertTrue(routes.requests.any { it.path == "/api/provider-setup/a2p/status?hubId=hub-a" })
    }

    @Test
    fun `with no active hub the A2P section reports it instead of posting an empty hub id`() = runTest {
        server.hubFlow.value = null
        val vm = ChannelConfigViewModel(repository, server.activeHubState)

        vm.skipA2p()
        advanceUntilIdle()

        assertTrue(routes.seen().none { it.startsWith("POST /api/provider-setup/a2p") })
        assertEquals("No active hub", vm.state.value.error)
    }
}
