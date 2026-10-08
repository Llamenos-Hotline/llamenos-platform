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
 * AdminViewModel's shift CRUD and audit log calls, against a real [ApiService] and a
 * [MockWebServer] that answers **only** the method/path pairs the worker actually
 * mounts, and 404s everything else exactly as the real server does.
 *
 * That last part is the whole point, and the first version of this test got it wrong:
 * its dispatcher answered `PUT .../shifts/shift-1` with a 200 and the test then
 * asserted a `PUT` had been sent. The server mounts `shifts.patch('/:id')` and no
 * `PUT` on that path, so the test pinned a 404 as if it were the contract — a mock
 * that answers whatever the client asks confirms any bug the client has. See #1724,
 * where the same wrong-verb defect covers nine admin settings screens.
 *
 * The route table below is a mirror of the server's, not a source of truth.
 * `apps/worker/__tests__/unit/mobile-client-routes.test.ts` is what holds every
 * literal route the mobile clients call against the worker's real route table, so a
 * drift between this mirror and the server fails there (#1728).
 *
 * Also regression coverage for #1149: the admin client used to call a nonexistent
 * `/api/admin/shifts` / `/api/admin/audit` prefix, and `updateShift` had no `days`
 * parameter, so every edit silently rewrote recurrence to Mon-Fri.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class AdminViewModelShiftsTest {

    private lateinit var server: MockWebServer
    private val hubFlow = MutableStateFlow<String?>("hub-a")
    private val requests: MutableList<RecordedRequest> = Collections.synchronizedList(mutableListOf())
    private val bodies: MutableMap<String, String> = Collections.synchronizedMap(mutableMapOf())

    /**
     * One route the worker mounts: the method, a pattern for the path (`{id}` stands
     * for any single path segment, and a query string is always allowed), and the
     * body to answer with.
     */
    private data class Route(val method: String, val path: String, val body: String = """{"ok":true}""") {
        private val regex = Regex(
            "^" + Regex.escape(path).replace("{id}", "\\E[^/]+\\Q") + "(\\?.*)?$",
        )

        fun matches(request: RecordedRequest): Boolean =
            request.method == method && regex.matches(request.path.orEmpty())
    }

    /**
     * Every route this test's subject is allowed to reach — `apps/worker/routes/shifts.ts`
     * and `audit.ts`, mounted hub-scoped at `apps/worker/app.ts`. Note `PATCH` for a
     * shift update and `PUT` only for the fallback group: the two are genuinely
     * different verbs on the same router, which is how the mismatch survived review.
     */
    private val routes = listOf(
        Route("GET", "/api/hubs/hub-a/shifts", """{"shifts":[]}"""),
        Route("POST", "/api/hubs/hub-a/shifts"),
        Route("PATCH", "/api/hubs/hub-a/shifts/{id}"),
        Route("DELETE", "/api/hubs/hub-a/shifts/{id}"),
        Route("PUT", "/api/hubs/hub-a/shifts/fallback"),
        Route("GET", "/api/hubs/hub-a/audit", """{"entries":[],"limit":50,"page":1,"total":0}"""),
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
                // `/shifts/fallback` is listed before `/shifts/{id}` would match it,
                // but they differ by method, so order is not load-bearing here.
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

    /** The body sent to the one shift-update request, whatever verb it used. */
    private fun shiftUpdateBody(): String =
        bodies.entries.single { it.key.contains("/shifts/shift-1") }.value

    @Test
    fun `a shift update uses PATCH, the only update verb the server mounts`() =
        runTest(UnconfinedTestDispatcher()) {
            val vm = newViewModel()
            advanceUntilIdle()

            vm.updateShift("shift-1", "Renamed", "09:00", "17:00", days = listOf(1, 2, 3, 4, 5))
            advanceUntilIdle()

            assertTrue(
                "expected PATCH /api/hubs/hub-a/shifts/shift-1, saw ${seen()}",
                seen().contains("PATCH /api/hubs/hub-a/shifts/shift-1"),
            )
            assertTrue(
                "PUT /api/shifts/:id is not mounted — the server answers 404 and the edit is lost",
                seen().none { it.startsWith("PUT ") && it.contains("/shifts/shift-1") },
            )
            // The outcome, not just the request: the dispatcher 404s an unmounted
            // method, and `requestNoContent` throws on a 404, so a wrong verb lands
            // here as an error on the screen.
            assertNull(
                "a shift update against the real route must not report an error",
                vm.uiState.value.adminShiftsError,
            )
        }

    @Test
    fun `updating a shift's name sends the existing recurrence unchanged, never a Mon-Fri default`() =
        runTest(UnconfinedTestDispatcher()) {
            val vm = newViewModel()
            advanceUntilIdle()

            // A weekend-only shift (Sun=0, Sat=6) — the edit dialog pre-fills `days` from
            // the shift being edited and always passes it through explicitly.
            vm.updateShift(
                shiftId = "shift-1",
                name = "Weekend Coverage",
                startTime = "10:00",
                endTime = "18:00",
                days = listOf(0, 6),
            )
            advanceUntilIdle()

            val sentDays = Json.parseToJsonElement(shiftUpdateBody()).jsonObject.getValue("days")
                .jsonArray.map { it.jsonPrimitive.content.toInt() }

            assertEquals(listOf(0, 6), sentDays)
            assertNull(vm.uiState.value.adminShiftsError)
        }

    @Test
    fun `updating a shift omits userPubkeys so the volunteer roster is never wiped by a rename`() =
        runTest(UnconfinedTestDispatcher()) {
            val vm = newViewModel()
            advanceUntilIdle()

            vm.updateShift("shift-1", "Renamed", "09:00", "17:00", days = listOf(1, 2, 3, 4, 5))
            advanceUntilIdle()

            assertTrue(
                "userPubkeys must be omitted (not null-serialized) so the server's .optional() leaves it untouched",
                !shiftUpdateBody().contains("userPubkeys"),
            )
        }

    @Test
    fun `shift CRUD and audit target the real hub-scoped routes, never api-admin-shifts or api-admin-audit`() =
        runTest(UnconfinedTestDispatcher()) {
            val vm = newViewModel()
            advanceUntilIdle()

            vm.loadAdminShifts()
            vm.createShift("New Shift", "09:00", "17:00", days = listOf(1, 2, 3, 4, 5))
            vm.updateShift("shift-1", "Name", "09:00", "17:00", days = listOf(1, 2, 3, 4, 5))
            vm.deleteShift("shift-1")
            vm.setFallbackGroup(listOf("pk1"))
            vm.loadAuditLog()
            advanceUntilIdle()

            val seen = seen()
            assertTrue(seen.contains("GET /api/hubs/hub-a/shifts"))
            assertTrue(seen.contains("POST /api/hubs/hub-a/shifts"))
            assertTrue(seen.contains("PATCH /api/hubs/hub-a/shifts/shift-1"))
            assertTrue(seen.contains("DELETE /api/hubs/hub-a/shifts/shift-1"))
            assertTrue(seen.contains("PUT /api/hubs/hub-a/shifts/fallback"))
            assertTrue(seen.any { it.startsWith("GET /api/hubs/hub-a/audit") })
            assertTrue(
                "no call may hit the nonexistent /admin/shifts or /admin/audit prefix (issue #1149)",
                seen.none { it.contains("/admin/shifts") || it.contains("/admin/audit") },
            )
            // Every one of those reached a mounted route, so none of them 404'd.
            assertNull(vm.uiState.value.adminShiftsError)
            assertNull(vm.uiState.value.auditError)
        }

    /// The mock is a server, not an echo: it must refuse a method the worker does not
    /// mount. Without this, the dispatcher's 404 branch is never exercised and the
    /// assertions above could pass against a mock that answers anything.
    @Test
    fun `the mock refuses a verb the server does not mount`() =
        runTest(UnconfinedTestDispatcher()) {
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

            val error = runCatching {
                apiService.requestNoContent("PUT", "/api/hubs/hub-a/shifts/shift-1")
            }.exceptionOrNull()

            assertTrue(
                "PUT on a PATCH-only route must 404, or this suite proves nothing about verbs; got $error",
                error is org.llamenos.hotline.api.ApiException && error.code == 404,
            )
        }
}
