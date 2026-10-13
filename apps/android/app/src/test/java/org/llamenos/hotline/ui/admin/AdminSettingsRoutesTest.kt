package org.llamenos.hotline.ui.admin

import androidx.lifecycle.SavedStateHandle
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.llamenos.hotline.InMemoryKeyValueStore
import org.llamenos.hotline.api.ApiException
import org.llamenos.hotline.api.ApiService
import org.llamenos.hotline.crypto.KeystoreService
import org.llamenos.hotline.hub.ActiveHubState
import org.llamenos.hotline.model.TelephonyProviderType
import java.util.Collections

/**
 * The five admin settings screens — telephony, call, IVR languages,
 * transcription and spam — against a real [ApiService] and a [MockWebServer]
 * that answers **only** the method/path pairs the worker mounts, and 404s
 * everything else exactly as the real server does.
 *
 * Every one of these screens used to send `PUT` to a path the server either
 * does not mount at all (`/api/settings/telephony`, `/api/admin/settings`) or
 * mounts only under `PATCH`, carrying a body naming fields no schema declares.
 * Measured against a live backend, signed as the test admin (#1724):
 *
 *     GET    /api/settings/telephony          -> 404 Not Found
 *     PUT    /api/settings/telephony          -> 404 Not Found
 *     GET    /api/admin/settings              -> 404 Not Found
 *     PUT    /api/admin/settings/transcription -> 404 Not Found
 *     PUT    /api/settings/call               -> 404 Not Found
 *     PUT    /api/settings/ivr-languages      -> 404 Not Found
 *     PUT    /api/settings/spam               -> 404 Not Found
 *
 * so no admin setting entered on Android has ever been stored, and the screens
 * reported nothing wrong.
 *
 * The route table below is a **mirror** of the server's, not a source of truth,
 * and the mock is a server rather than an echo: a dispatcher that answered
 * whatever the client asked would confirm any bug the client has — which is
 * exactly how a first version of `AdminViewModelShiftsTest` came to pin
 * `PUT .../shifts/:id` as if it were the contract.
 * `apps/worker/__tests__/unit/mobile-client-routes.test.ts` is what holds this
 * mirror to the worker's real route table (#1728).
 */
@OptIn(ExperimentalCoroutinesApi::class)
class AdminSettingsRoutesTest {

    private lateinit var server: MockWebServer
    private val requests: MutableList<RecordedRequest> = Collections.synchronizedList(mutableListOf())
    private val bodies: MutableMap<String, String> = Collections.synchronizedMap(mutableMapOf())

    /** What the fake server currently holds, so a write is observable by a read. */
    private var storedCall = """{"queueTimeoutSeconds":90,"voicemailMaxSeconds":120}"""
    private var storedTranscription = """{"globalEnabled":false,"allowUserOptOut":false}"""
    private var storedSpam =
        """{"voiceCaptchaEnabled":false,"rateLimitEnabled":true,"maxCallsPerMinute":3,"blockDurationMinutes":30}"""
    private var storedIvr = """{"enabledLanguages":["es","en","zh"]}"""
    private var storedProvider = "null"

    /**
     * Every method/path pair the worker mounts for these five screens, from
     * `apps/worker/routes/settings.ts` and `provider-setup.ts`. Note that
     * telephony reads from `/settings/telephony-provider` but writes through
     * `POST /provider-setup/configure`: `PATCH /settings/telephony-provider` is
     * mounted but answers 400 "updateTelephonyProvider is deprecated", so it is
     * not an alternative, and it is deliberately absent here.
     */
    private fun routeFor(request: RecordedRequest): (() -> String)? {
        val path = request.path.orEmpty().substringBefore('?')
        val body = request.body.readUtf8()
        if (body.isNotEmpty()) bodies["${request.method} $path"] = body
        return when ("${request.method} $path") {
            "GET /api/settings/call" -> ({ storedCall })
            "PATCH /api/settings/call" -> ({ merge(::storedCall.get(), body).also { storedCall = it } })
            "GET /api/settings/transcription" -> ({ storedTranscription })
            "PATCH /api/settings/transcription" ->
                ({ merge(storedTranscription, body).also { storedTranscription = it } })
            "GET /api/settings/spam" -> ({ storedSpam })
            "PATCH /api/settings/spam" -> ({ merge(storedSpam, body).also { storedSpam = it } })
            "GET /api/settings/ivr-languages" -> ({ storedIvr })
            "PATCH /api/settings/ivr-languages" -> ({ body.also { storedIvr = it } })
            "GET /api/settings/telephony-provider" -> ({ storedProvider })
            "POST /api/provider-setup/configure" -> ({ configure(body) })
            else -> null
        }
    }

    /** A `PATCH` on an all-optional settings schema merges, as the service does. */
    private fun merge(stored: String, patch: String): String {
        val current = Json.parseToJsonElement(stored).jsonObject.toMutableMap()
        if (patch.isNotEmpty()) current += Json.parseToJsonElement(patch).jsonObject
        return Json.encodeToString(
            kotlinx.serialization.json.JsonObject.serializer(),
            kotlinx.serialization.json.JsonObject(current),
        )
    }

    /** `POST /provider-setup/configure` answers `{ok:true}` and stores the config. */
    private fun configure(body: String): String {
        val sent = Json.parseToJsonElement(body).jsonObject
        val provider = sent["provider"]?.jsonPrimitive?.content ?: "twilio"
        val phone = sent["phoneNumber"]?.jsonPrimitive?.content
        val credentials = sent["credentials"]?.jsonObject.orEmpty()
        val accountSid = credentials["accountSid"]?.jsonPrimitive?.content
        storedProvider = buildString {
            append("""{"type":"$provider"""")
            if (phone != null) append(""","phoneNumber":"$phone"""")
            if (accountSid != null) append(""","accountSid":"$accountSid"""")
            append("}")
        }
        return """{"ok":true}"""
    }

    private fun Map<String, kotlinx.serialization.json.JsonElement>?.orEmpty() =
        this ?: emptyMap()

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                val handler = routeFor(request)
                    ?: return MockResponse().setResponseCode(404).setBody("""{"error":"Not Found"}""")
                return MockResponse().setBody(handler())
            }
        }
        server.start()
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
        server.shutdown()
    }

    private fun apiService(): ApiService {
        val store = InMemoryKeyValueStore()
        store.store(KeystoreService.KEY_HUB_URL, server.url("/").toString().trimEnd('/'))
        val activeHubState = mockk<ActiveHubState>(relaxed = true)
        every { activeHubState.activeHubId } returns MutableStateFlow(null)
        return ApiService(
            authInterceptor = mockk(relaxed = true),
            retryInterceptor = mockk(relaxed = true),
            keystoreService = store,
            activeHubState = activeHubState,
        ).also {
            it.client = OkHttpClient()
            it.ioDispatcher = UnconfinedTestDispatcher()
        }
    }

    private fun newViewModel() = AdminViewModel(apiService(), SavedStateHandle())

    private fun seen() = requests.map { "${it.method} ${it.path?.substringBefore('?')}" }

    private fun sentBody(key: String) = bodies.getValue(key)

    // ── Call settings ────────────────────────────────────────────────

    @Test
    fun `call settings load the two values the server has, over PATCH not PUT`() =
        runTest(UnconfinedTestDispatcher()) {
            val vm = newViewModel()
            vm.loadCallSettings()
            advanceUntilIdle()

            assertEquals(90, vm.uiState.value.queueTimeoutSeconds)
            assertEquals(120, vm.uiState.value.voicemailMaxSeconds)
            assertNull(vm.uiState.value.callSettingsError)

            vm.updateQueueTimeout(240)
            vm.saveCallSettings()
            advanceUntilIdle()

            assertTrue(
                "expected PATCH /api/settings/call, saw ${seen()}",
                seen().contains("PATCH /api/settings/call"),
            )
            assertTrue(
                "PUT /api/settings/call is not mounted — the server answers 404",
                seen().none { it == "PUT /api/settings/call" },
            )
            val body = Json.parseToJsonElement(sentBody("PATCH /api/settings/call")).jsonObject
            assertEquals("240", body.getValue("queueTimeoutSeconds").jsonPrimitive.content)
            // The three settings this screen used to offer do not exist.
            for (invented in listOf("ringTimeout", "maxCallDuration", "parallelRingCount")) {
                assertTrue("$invented is not a field callSettingsSchema declares", invented !in body)
            }
            // Read back: the server now holds it, and the screen shows what it stored.
            assertEquals(240, vm.uiState.value.queueTimeoutSeconds)
            assertNull(vm.uiState.value.callSettingsError)
        }

    @Test
    fun `a saved call setting is what a fresh load reads back`() =
        runTest(UnconfinedTestDispatcher()) {
            val vm = newViewModel()
            vm.loadCallSettings()
            advanceUntilIdle()
            vm.updateVoicemailMax(300)
            vm.saveCallSettings()
            advanceUntilIdle()

            val second = newViewModel()
            second.loadCallSettings()
            advanceUntilIdle()

            assertEquals(
                "the save must reach the server, not just the first screen's state",
                300, second.uiState.value.voicemailMaxSeconds,
            )
        }

    // ── Transcription ────────────────────────────────────────────────

    @Test
    fun `transcription reads and writes the route the server mounts`() =
        runTest(UnconfinedTestDispatcher()) {
            val vm = newViewModel()
            vm.toggleTranscription(true)
            advanceUntilIdle()

            assertTrue(
                "expected PATCH /api/settings/transcription, saw ${seen()}",
                seen().contains("PATCH /api/settings/transcription"),
            )
            assertTrue(
                "/api/admin/settings has no route at all — only /admin/security-events, /admin/devices and /admin/events exist",
                seen().none { it.contains("/api/admin/settings") },
            )
            val body = Json.parseToJsonElement(
                sentBody("PATCH /api/settings/transcription"),
            ).jsonObject
            assertEquals("true", body.getValue("globalEnabled").jsonPrimitive.content)
            assertTrue("`enabled` is not a field the schema declares", "enabled" !in body)
            assertTrue(
                "`allowVolunteerOptOut` is not a field the schema declares",
                "allowVolunteerOptOut" !in body,
            )
            assertTrue(vm.uiState.value.transcriptionEnabled)
            assertNull(vm.uiState.value.settingsError)

            val second = newViewModel()
            second.loadCallSettings() // any load; the point is the second read below
            advanceUntilIdle()
            assertEquals(
                """{"globalEnabled":true,"allowUserOptOut":false}""",
                storedTranscription,
            )
        }

    // ── Spam ─────────────────────────────────────────────────────────

    @Test
    fun `spam settings carry the per-minute limit and the block duration, and no bypass`() =
        runTest(UnconfinedTestDispatcher()) {
            val vm = newViewModel()
            vm.loadSpamSettings()
            advanceUntilIdle()

            assertEquals(3, vm.uiState.value.maxCallsPerMinute)
            assertEquals(30, vm.uiState.value.blockDurationMinutes)
            assertTrue(vm.uiState.value.rateLimitEnabled)

            vm.updateMaxCallsPerMinute(7)
            vm.updateBlockDuration(45)
            vm.saveSpamSettings()
            advanceUntilIdle()

            assertTrue(
                "expected PATCH /api/settings/spam, saw ${seen()}",
                seen().contains("PATCH /api/settings/spam"),
            )
            assertTrue(seen().none { it == "PUT /api/settings/spam" })
            val body = Json.parseToJsonElement(sentBody("PATCH /api/settings/spam")).jsonObject
            assertEquals("7", body.getValue("maxCallsPerMinute").jsonPrimitive.content)
            assertEquals("45", body.getValue("blockDurationMinutes").jsonPrimitive.content)
            assertTrue(
                "the rate limit is per minute; maxCallsPerHour is not a field the schema declares",
                "maxCallsPerHour" !in body,
            )
            assertTrue(
                "the server has no known-number bypass at all",
                "knownNumberBypass" !in body,
            )
            assertEquals(7, vm.uiState.value.maxCallsPerMinute)
            assertNull(vm.uiState.value.spamSettingsError)
        }

    // ── IVR languages ────────────────────────────────────────────────

    @Test
    fun `IVR languages are the ordered array the server stores, not a code-to-bool map`() =
        runTest(UnconfinedTestDispatcher()) {
            val vm = newViewModel()
            vm.loadIvrLanguages()
            advanceUntilIdle()

            assertEquals(listOf("es", "en", "zh"), vm.uiState.value.ivrEnabledLanguages)

            // Enabling appends, so the digits callers already know do not move.
            vm.toggleIvrLanguage("de", true)
            vm.saveIvrLanguages()
            advanceUntilIdle()

            assertTrue(
                "expected PATCH /api/settings/ivr-languages, saw ${seen()}",
                seen().contains("PATCH /api/settings/ivr-languages"),
            )
            assertTrue(seen().none { it == "PUT /api/settings/ivr-languages" })
            val body = Json.parseToJsonElement(
                sentBody("PATCH /api/settings/ivr-languages"),
            ).jsonObject
            assertTrue(
                "the server rejects a {languages: {code: bool}} map with 400 at enabledLanguages",
                "languages" !in body,
            )
            assertEquals(
                listOf("es", "en", "zh", "de"),
                body.getValue("enabledLanguages").jsonArray.map { it.jsonPrimitive.content },
            )
            assertEquals(listOf("es", "en", "zh", "de"), vm.uiState.value.ivrEnabledLanguages)
            assertNull(vm.uiState.value.ivrLanguagesError)
        }

    @Test
    fun `disabling an IVR language removes only that one and keeps the rest in order`() =
        runTest(UnconfinedTestDispatcher()) {
            val vm = newViewModel()
            vm.loadIvrLanguages()
            advanceUntilIdle()

            vm.toggleIvrLanguage("en", false)
            vm.saveIvrLanguages()
            advanceUntilIdle()

            assertEquals(listOf("es", "zh"), vm.uiState.value.ivrEnabledLanguages)
            assertEquals("""{"enabledLanguages":["es","zh"]}""", storedIvr)
        }

    // ── Telephony ────────────────────────────────────────────────────

    @Test
    fun `telephony reads the provider route and writes through provider-setup`() =
        runTest(UnconfinedTestDispatcher()) {
            val vm = newViewModel()
            vm.loadTelephonySettings()
            advanceUntilIdle()

            // Unconfigured: the route answers a bare `null`, which is the empty
            // form and not an error.
            assertNull(vm.uiState.value.telephonyError)
            assertEquals("", vm.uiState.value.telephonyAccountSid)

            vm.updateTelephonyProvider(TelephonyProviderType.Signalwire)
            vm.updateTelephonyAccountSid("AC" + "a".repeat(32))
            vm.updateTelephonyPhoneNumber("+15550001111")
            vm.saveTelephonySettings()
            advanceUntilIdle()

            assertTrue(
                "expected GET /api/settings/telephony-provider, saw ${seen()}",
                seen().contains("GET /api/settings/telephony-provider"),
            )
            assertTrue(
                "expected POST /api/provider-setup/configure, saw ${seen()}",
                seen().contains("POST /api/provider-setup/configure"),
            )
            assertTrue(
                "/api/settings/telephony has never existed — 404 on every verb",
                seen().none { it.endsWith("/api/settings/telephony") },
            )
            assertTrue(
                "PATCH /api/settings/telephony-provider answers 400 'deprecated' and must not be used",
                seen().none { it == "PATCH /api/settings/telephony-provider" },
            )

            val body = Json.parseToJsonElement(
                sentBody("POST /api/provider-setup/configure"),
            ).jsonObject
            assertEquals("signalwire", body.getValue("provider").jsonPrimitive.content)
            assertEquals("+15550001111", body.getValue("phoneNumber").jsonPrimitive.content)
            assertEquals(
                "AC" + "a".repeat(32),
                body.getValue("credentials").jsonObject.getValue("accountSid").jsonPrimitive.content,
            )

            // The write is read back, so the screen shows what the server stored.
            assertEquals(TelephonyProviderType.Signalwire, vm.uiState.value.telephonyProvider)
            assertEquals("+15550001111", vm.uiState.value.telephonyPhoneNumber)
            assertNull(vm.uiState.value.telephonyError)
        }

    @Test
    fun `the provider picker offers every provider the server accepts`() {
        assertEquals(
            "the picker listed five of the eight providers, so Telnyx, Bandwidth and " +
                "FreeSWITCH operators could not select their own",
            TelephonyProviderType.entries.toSet(),
            TELEPHONY_PROVIDER_PICKER_ORDER.toSet(),
        )
    }

    // ── The mock is a server, not an echo ────────────────────────────

    @Test
    fun `the mock refuses the verbs and paths these screens used to send`() =
        runTest(UnconfinedTestDispatcher()) {
            val api = apiService()
            val refused = listOf(
                "PUT" to "/api/settings/call",
                "PUT" to "/api/settings/spam",
                "PUT" to "/api/settings/ivr-languages",
                "PUT" to "/api/settings/transcription",
                "GET" to "/api/settings/telephony",
                "PUT" to "/api/settings/telephony",
                "GET" to "/api/admin/settings",
                "PUT" to "/api/admin/settings/transcription",
            )
            for ((method, path) in refused) {
                val error = runCatching {
                    api.requestNoContent(method, path)
                }.exceptionOrNull()
                assertTrue(
                    "$method $path must 404, or this suite proves nothing about routes; got $error",
                    error is ApiException && error.code == 404,
                )
            }
        }
}
