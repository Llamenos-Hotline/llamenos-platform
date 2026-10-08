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
 * [MockWebServer] that only answers the real backend routes
 * (`/api/hubs/{hubId}/shifts`, `/api/hubs/{hubId}/audit` — see apps/worker/app.ts).
 *
 * Regression coverage for issue #1149: the admin client used to call a nonexistent
 * `/api/admin/shifts` / `/api/admin/audit` prefix (caught by the "real routes only"
 * tests below, which 404 on anything else), and `updateShift` used to have no `days`
 * parameter at all — meaning every edit silently rewrote recurrence to Mon-Fri,
 * regardless of the shift's actual schedule (caught by the weekend round-trip test).
 */
@OptIn(ExperimentalCoroutinesApi::class)
class AdminViewModelShiftsTest {

    private lateinit var server: MockWebServer
    private val hubFlow = MutableStateFlow<String?>("hub-a")
    private val requests: MutableList<RecordedRequest> = Collections.synchronizedList(mutableListOf())
    private val bodies: MutableMap<String, String> = Collections.synchronizedMap(mutableMapOf())

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                val path = request.path.orEmpty()
                val body = request.body.readUtf8()
                if (body.isNotEmpty()) bodies[path] = body
                return when {
                    request.method == "PUT" && path.endsWith("/shifts/shift-1") ->
                        MockResponse().setBody("""{"ok":true}""")
                    path.endsWith("/audit") ->
                        MockResponse().setBody("""{"entries":[],"limit":50,"page":1,"total":0}""")
                    path.endsWith("/shifts") -> MockResponse().setBody("""{"shifts":[]}""")
                    else -> MockResponse().setResponseCode(404)
                }
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

    private fun paths() = requests.map { "${it.method} ${it.path}" }

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

            val sentBody = bodies.entries.single { it.key.endsWith("/shifts/shift-1") }.value
            val sentDays = Json.parseToJsonElement(sentBody).jsonObject.getValue("days").jsonArray
                .map { it.jsonPrimitive.content.toInt() }

            assertEquals(listOf(0, 6), sentDays)
        }

    @Test
    fun `updating a shift omits userPubkeys so the volunteer roster is never wiped by a rename`() =
        runTest(UnconfinedTestDispatcher()) {
            val vm = newViewModel()
            advanceUntilIdle()

            vm.updateShift("shift-1", "Renamed", "09:00", "17:00", days = listOf(1, 2, 3, 4, 5))
            advanceUntilIdle()

            val sentBody = bodies.entries.single { it.key.endsWith("/shifts/shift-1") }.value
            assertTrue(
                "userPubkeys must be omitted (not null-serialized) so the server's .optional() leaves it untouched",
                !sentBody.contains("userPubkeys"),
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

            val seen = paths()
            assertTrue(seen.contains("GET /api/hubs/hub-a/shifts"))
            assertTrue(seen.contains("POST /api/hubs/hub-a/shifts"))
            assertTrue(seen.contains("PUT /api/hubs/hub-a/shifts/shift-1"))
            assertTrue(seen.contains("DELETE /api/hubs/hub-a/shifts/shift-1"))
            assertTrue(seen.contains("PUT /api/hubs/hub-a/shifts/fallback"))
            assertTrue(seen.any { it.startsWith("GET /api/hubs/hub-a/audit") })
            assertTrue("no call may hit the nonexistent /admin/shifts or /admin/audit prefix (issue #1149)", seen.none { it.contains("/admin/shifts") || it.contains("/admin/audit") })
        }
}
