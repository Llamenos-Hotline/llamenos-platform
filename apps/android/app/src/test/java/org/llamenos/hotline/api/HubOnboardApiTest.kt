package org.llamenos.hotline.api

import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.llamenos.hotline.InMemoryKeyValueStore
import org.llamenos.hotline.crypto.KeystoreService
import org.llamenos.hotline.hub.ActiveHubState
import org.llamenos.protocol.ChannelConfig
import org.llamenos.protocol.HubChannelType

/**
 * Wire behaviour of [HubOnboardApi] against a real [ApiService] and
 * [MockWebServer] replaying the backend's responses from
 * apps/worker/routes/hub-onboard.ts, which is mounted at /api/hubs/:hubId/onboard
 * and wraps every payload in a one-field envelope.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class HubOnboardApiTest {

    private lateinit var server: MockWebServer
    private lateinit var api: HubOnboardApi

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        val store = InMemoryKeyValueStore()
        store.store(KeystoreService.KEY_HUB_URL, server.url("/").toString().trimEnd('/'))
        val activeHubState = mockk<ActiveHubState>(relaxed = true)
        every { activeHubState.activeHubId } returns MutableStateFlow("hub-a")
        val apiService = ApiService(
            authInterceptor = mockk(relaxed = true),
            retryInterceptor = mockk(relaxed = true),
            keystoreService = store,
            activeHubState = activeHubState,
        ).also {
            it.client = OkHttpClient()
            it.ioDispatcher = UnconfinedTestDispatcher()
        }
        api = HubOnboardApi(apiService, activeHubState)
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun json(body: String) = MockResponse().setResponseCode(200).setBody(body)

    private fun requestJson(body: String): JsonObject = Json.parseToJsonElement(body).jsonObject

    private val onboardingBody = """
        {"onboarding":{"hubId":"hub-a","templateId":null,"currentStep":"channel_selection",
         "completedSteps":["template_selection"],"isComplete":false,
         "channelConfig":{"voice":true,"sms":false,"email":false,"signal":false,
                          "whatsapp":false,"telegram":false,"rcs":false}}}
    """.trimIndent()

    @Test
    fun `provider status is read from the onboard router and unwrapped`() = runTest {
        server.enqueue(
            json(
                """{"status":{"hubId":"hub-a","providerConnected":false,"numbersProvisioned":0,
                   "channelsConfigured":["sms"],"channelsPending":["voice"],"onboardingComplete":true}}""",
            ),
        )

        val status = api.getProviderStatus().getOrThrow()

        assertEquals("/api/hubs/hub-a/onboard/provider-status", server.takeRequest().path)
        assertEquals(listOf(HubChannelType.SMS), status.channelsConfigured)
        assertTrue(status.onboardingComplete)
    }

    @Test
    fun `usage is a single period object, not a list`() = runTest {
        server.enqueue(json("""{"usage":{"phoneNumbers":1,"smsSent":12,"callsReceived":3}}"""))

        val usage = api.getUsage().getOrThrow()

        assertEquals("/api/hubs/hub-a/onboard/usage", server.takeRequest().path)
        assertEquals(12, usage.smsSent)
        assertEquals(3, usage.callsReceived)
    }

    @Test
    fun `toggling a channel sends one channel and its state, and returns the saved config`() = runTest {
        server.enqueue(
            json(
                """{"channels":{"voice":false,"sms":true,"email":false,"signal":false,
                   "whatsapp":false,"telegram":false,"rcs":false}}""",
            ),
        )

        val saved = api.updateChannel(channel = "sms", enabled = true).getOrThrow()

        val request = server.takeRequest()
        assertEquals("PUT", request.method)
        assertEquals("/api/hubs/hub-a/onboard/channels", request.path)
        val body = requestJson(request.body.readUtf8())
        assertEquals("sms", body.getValue("channel").jsonPrimitive.content)
        assertTrue(body.getValue("enabled").jsonPrimitive.boolean)
        assertTrue(saved.sms)
        assertFalse(saved.voice)
    }

    @Test
    fun `start onboarding posts to the onboard root and unwraps the state`() = runTest {
        server.enqueue(json(onboardingBody))

        val state = api.startOnboarding(templateId = "tpl-1").getOrThrow()

        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/hubs/hub-a/onboard", request.path)
        assertEquals("tpl-1", requestJson(request.body.readUtf8()).getValue("templateId").jsonPrimitive.content)
        assertEquals("channel_selection", state.currentStep)
    }

    @Test
    fun `completing the channel step carries the selected channels`() = runTest {
        server.enqueue(json(onboardingBody))

        api.completeStep(step = "channel_selection", channelConfig = ChannelConfig(voice = true)).getOrThrow()

        val request = server.takeRequest()
        assertEquals("PUT", request.method)
        assertEquals("/api/hubs/hub-a/onboard/step", request.path)
        val body = requestJson(request.body.readUtf8())
        assertEquals("channel_selection", body.getValue("step").jsonPrimitive.content)
        val channelConfig = body.getValue("data").jsonObject.getValue("channelConfig").jsonObject
        assertTrue(channelConfig.getValue("voice").jsonPrimitive.boolean)
        assertFalse(channelConfig.getValue("sms").jsonPrimitive.boolean)
    }

    @Test
    fun `completing a step without data omits the data object`() = runTest {
        server.enqueue(json(onboardingBody))

        api.completeStep(step = "provider_connection").getOrThrow()

        val body = requestJson(server.takeRequest().body.readUtf8())
        assertEquals("provider_connection", body.getValue("step").jsonPrimitive.content)
        assertFalse("data" in body)
    }
}
