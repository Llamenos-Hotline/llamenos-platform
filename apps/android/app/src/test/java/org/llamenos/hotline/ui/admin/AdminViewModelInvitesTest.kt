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
import org.llamenos.hotline.api.ApiService
import org.llamenos.hotline.crypto.KeystoreService
import org.llamenos.hotline.hub.ActiveHubState
import java.util.Collections

/**
 * AdminViewModel's invite list/create calls, against a real [ApiService] and a
 * [MockWebServer] that answers **only** the method/path pairs the worker
 * actually mounts, and 404s everything else exactly as the real server does —
 * the same harness as [AdminViewModelShiftsTest].
 *
 * Regression coverage for #1047: the client called `/api/admin/invites`, which
 * the server has never mounted (`apps/worker/app.ts` mounts `routes/invites.ts`
 * at `/api/invites`), so Android admins could neither list nor create invites.
 * With the old path this test's dispatcher answers 404 and every assertion
 * below fails.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class AdminViewModelInvitesTest {

    private lateinit var server: MockWebServer
    private val hubFlow = MutableStateFlow<String?>("hub-a")
    private val requests: MutableList<RecordedRequest> = Collections.synchronizedList(mutableListOf())
    private val bodies: MutableMap<String, String> = Collections.synchronizedMap(mutableMapOf())

    private data class Route(val method: String, val path: String, val body: String = """{"ok":true}""") {
        private val regex = Regex(
            "^" + Regex.escape(path).replace("{id}", "\\E[^/]+\\Q") + "(\\?.*)?$",
        )

        fun matches(request: RecordedRequest): Boolean =
            request.method == method && regex.matches(request.path.orEmpty())
    }

    /**
     * The routes `apps/worker/routes/invites.ts` mounts at `/api/invites`.
     * List answers `{invites: [...]}`; create answers 201 with the invite
     * wrapped — `{"invite": {...}}` — which is what `identity.createInvite`
     * returns and what the desktop client reads (`res.invite`).
     */
    private val routes = listOf(
        Route("GET", "/api/invites", """{"invites":[]}"""),
        Route(
            "POST",
            "/api/invites",
            """{"invite":{"code":"11111111-2222-3333-4444-555555555555","name":"New Volunteer","phone":"+15551234567","roleIds":["role-volunteer"],"hubId":"hub-a","createdBy":"aa11","createdAt":"2026-10-10T00:00:00.000Z","expiresAt":"2026-10-17T00:00:00.000Z"}}""",
        ),
        Route("DELETE", "/api/invites/{id}"),
    )

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                val body = request.body.readUtf8()
                if (body.isNotEmpty()) bodies["${request.method} ${request.path}"] = body
                val route = routes.firstOrNull { it.matches(request) }
                    ?: return MockResponse().setResponseCode(404).setBody("""{"error":"Not Found"}""")
                return MockResponse().setBody(route.body)
            }
        }
        server.start()
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
        server.shutdown()
    }

    private fun newViewModel(): AdminViewModel {
        val store = InMemoryKeyValueStore()
        store.store(KeystoreService.KEY_HUB_URL, server.url("/").toString().trimEnd('/'))
        val activeHubState = mockk<ActiveHubState>(relaxed = true)
        every { activeHubState.activeHubId } returns hubFlow
        val apiService = ApiService(
            authInterceptor = mockk(relaxed = true),
            retryInterceptor = mockk(relaxed = true),
            keystoreService = store,
            activeHubState = activeHubState,
        ).also {
            it.client = OkHttpClient()
            it.ioDispatcher = UnconfinedTestDispatcher()
        }
        return AdminViewModel(apiService, SavedStateHandle())
    }

    private fun seen() = requests.map { "${it.method} ${it.path}" }

    @Test
    fun `invites are listed from the unscoped api-invites route, not the 404 admin prefix`() =
        runTest(UnconfinedTestDispatcher()) {
            val vm = newViewModel()
            advanceUntilIdle()
            requests.clear()

            vm.loadInvites()
            advanceUntilIdle()

            assertTrue(
                "expected GET /api/invites, saw ${seen()}",
                seen().contains("GET /api/invites"),
            )
            assertNull(vm.uiState.value.invitesError)
        }

    @Test
    fun `invite creation posts the codegen body shape to api-invites`() =
        runTest(UnconfinedTestDispatcher()) {
            val vm = newViewModel()
            advanceUntilIdle()
            requests.clear()

            vm.createInvite("New Volunteer", "+15551234567", listOf("role-volunteer"))
            advanceUntilIdle()

            assertTrue(
                "expected POST /api/invites, saw ${seen()}",
                seen().contains("POST /api/invites"),
            )
            val body = checkNotNull(bodies["POST /api/invites"]) { "no POST body recorded" }
            val json = Json.parseToJsonElement(body).jsonObject
            assertEquals("New Volunteer", json["name"]!!.jsonPrimitive.content)
            assertEquals("+15551234567", json["phone"]!!.jsonPrimitive.content)
            assertEquals("hub-a", json["hubId"]!!.jsonPrimitive.content)
            assertEquals(
                "role-volunteer",
                json["roleIds"]!!.jsonArray.single().jsonPrimitive.content,
            )
            // The response wraps the invite: {"invite": {...}}.
            assertEquals("11111111-2222-3333-4444-555555555555", vm.uiState.value.createdInviteCode)
            assertNull(vm.uiState.value.invitesError)
        }

    @Test
    fun `invite creation omits hubId when no hub is active`() =
        runTest(UnconfinedTestDispatcher()) {
            hubFlow.value = null
            val vm = newViewModel()
            advanceUntilIdle()
            requests.clear()

            vm.createInvite("No Hub", "+15551234568", listOf("role-volunteer"))
            advanceUntilIdle()

            val body = checkNotNull(bodies["POST /api/invites"]) { "no POST body recorded" }
            val json = Json.parseToJsonElement(body).jsonObject
            assertTrue("hubId must be omitted, not null, when no hub is active", "hubId" !in json)
        }

    @Test
    fun `the dead admin-prefixed route answers 404, exactly as the real server`() {
        // Pins the reproduction from #1047: the dispatcher mirrors the real
        // route table, so the path the app used before this fix 404s here too.
        val request = okhttp3.Request.Builder()
            .url(server.url("/api/admin/invites"))
            .build()
        OkHttpClient().newCall(request).execute().use { response ->
            assertEquals(404, response.code)
        }
    }
}
