package org.llamenos.hotline.api

import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.llamenos.hotline.InMemoryKeyValueStore
import org.llamenos.hotline.crypto.KeystoreService
import org.llamenos.hotline.hub.ActiveHubState

/**
 * Wire behaviour of [ShiftClockRepository] against a real [ApiService] and
 * [MockWebServer] replaying the backend's actual responses
 * (apps/worker/routes/shifts.ts: `{ ok: true }`, 404 when not clocked in).
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ShiftClockRepositoryTest {

    private lateinit var server: MockWebServer
    private lateinit var repository: ShiftClockRepository

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        val store = InMemoryKeyValueStore()
        store.store(KeystoreService.KEY_HUB_URL, server.url("/").toString().trimEnd('/'))
        // No active hub: clock calls must never depend on it.
        val activeHubState = mockk<ActiveHubState>(relaxed = true)
        every { activeHubState.activeHubId } returns MutableStateFlow(null)
        val apiService = ApiService(
            authInterceptor = mockk(relaxed = true),
            retryInterceptor = mockk(relaxed = true),
            keystoreService = store,
            activeHubState = activeHubState,
        ).also {
            it.client = OkHttpClient()
            it.ioDispatcher = UnconfinedTestDispatcher()
        }
        repository = ShiftClockRepository(apiService)
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun ok() = MockResponse().setResponseCode(200).setBody("""{"ok":true}""")

    @Test
    fun `clock in posts to the named hub even when no hub is active`() = runTest {
        server.enqueue(ok())

        repository.clockIn("hub-a")

        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/hubs/hub-a/shifts/clock-in", request.path)
        assertNotNull(repository.clockedIn.value["hub-a"])
    }

    @Test
    fun `clock state is per hub - clocking into one hub leaves another untouched`() = runTest {
        server.enqueue(ok())
        server.enqueue(ok())
        server.enqueue(ok())

        repository.clockIn("hub-a")
        repository.clockIn("hub-b")
        repository.clockOut("hub-a")

        assertEquals("/api/hubs/hub-a/shifts/clock-in", server.takeRequest().path)
        assertEquals("/api/hubs/hub-b/shifts/clock-in", server.takeRequest().path)
        assertEquals("/api/hubs/hub-a/shifts/clock-out", server.takeRequest().path)
        assertEquals(setOf("hub-b"), repository.clockedIn.value.keys)
    }

    @Test
    fun `clocking in twice keeps the original start time`() = runTest {
        server.enqueue(ok())
        server.enqueue(ok())

        repository.clockIn("hub-a")
        val firstStart = repository.clockedIn.value.getValue("hub-a")
        repository.clockIn("hub-a")

        assertEquals(firstStart, repository.clockedIn.value.getValue("hub-a"))
    }

    @Test
    fun `clock out when the server holds no active shift still ends clocked out`() = runTest {
        server.enqueue(ok())
        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"Active shift not found"}"""))

        repository.clockIn("hub-a")
        repository.clockOut("hub-a")

        assertFalse("hub-a" in repository.clockedIn.value)
    }

    @Test
    fun `failed clock in does not mark the hub clocked in`() = runTest {
        server.enqueue(MockResponse().setResponseCode(403).setBody("""{"error":"Forbidden"}"""))

        val error = runCatching { repository.clockIn("hub-a") }.exceptionOrNull()

        assertTrue(error is ApiException && error.code == 403)
        assertTrue(repository.clockedIn.value.isEmpty())
    }

    // ---- heartbeat (#2886) ----

    private fun myStatus(clockedIn: Boolean, at: String? = null) = MockResponse().setResponseCode(200).setBody(
        """{"onShift":false,"clockedIn":$clockedIn,"clockedInAt":${at?.let { "\"$it\"" } ?: "null"}}""",
    )

    @Test
    fun `heartbeat posts to the named hub`() = runTest {
        server.enqueue(ok())
        server.enqueue(ok())
        repository.clockIn("hub-b")
        server.takeRequest()

        val outcome = repository.heartbeat("hub-b")

        assertEquals(ShiftClockRepository.HeartbeatOutcome.ALIVE, outcome)
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/hubs/hub-b/shifts/heartbeat", request.path)
        assertTrue("hub-b" in repository.clockedIn.value)
    }

    @Test
    fun `a 404 heartbeat drops that clock-in and leaves the other hubs`() = runTest {
        server.enqueue(ok())
        server.enqueue(ok())
        repository.clockIn("hub-a")
        repository.clockIn("hub-b")
        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"Active shift not found"}"""))

        val outcome = repository.heartbeat("hub-a")

        assertEquals(ShiftClockRepository.HeartbeatOutcome.LOST, outcome)
        assertEquals(setOf("hub-b"), repository.clockedIn.value.keys)
    }

    @Test
    fun `a 403 heartbeat drops that clock-in`() = runTest {
        server.enqueue(ok())
        repository.clockIn("hub-a")
        server.enqueue(MockResponse().setResponseCode(403).setBody("""{"error":"Forbidden"}"""))

        assertEquals(ShiftClockRepository.HeartbeatOutcome.LOST, repository.heartbeat("hub-a"))
        assertTrue(repository.clockedIn.value.isEmpty())
    }

    @Test
    fun `a heartbeat the server could not answer leaves the clock-in alone`() = runTest {
        server.enqueue(ok())
        repository.clockIn("hub-a")
        server.enqueue(MockResponse().setResponseCode(500).setBody("""{"error":"boom"}"""))

        assertEquals(ShiftClockRepository.HeartbeatOutcome.UNREACHABLE, repository.heartbeat("hub-a"))
        assertTrue("hub-a" in repository.clockedIn.value)
    }

    @Test
    fun `a heartbeat that never reaches the server leaves the clock-in alone`() = runTest {
        server.enqueue(ok())
        repository.clockIn("hub-a")
        server.shutdown()

        assertEquals(ShiftClockRepository.HeartbeatOutcome.UNREACHABLE, repository.heartbeat("hub-a"))
        assertTrue("hub-a" in repository.clockedIn.value)
    }

    @Test
    fun `a clock-in made while a heartbeat was in flight survives that heartbeat's 404`() = runTest {
        server.enqueue(ok())
        repository.clockIn("hub-a")
        // The beat goes out for the first clock-in; the volunteer clocks out and in again before
        // the answer lands, so the 404 describes a clock-in that no longer exists.
        server.dispatcher = object : okhttp3.mockwebserver.Dispatcher() {
            override fun dispatch(request: okhttp3.mockwebserver.RecordedRequest): MockResponse {
                if (request.path!!.endsWith("/heartbeat")) {
                    runBlocking {
                        repository.clockOut("hub-a")
                        repository.clockIn("hub-a")
                    }
                    return MockResponse().setResponseCode(404).setBody("""{"error":"Active shift not found"}""")
                }
                return ok()
            }
        }
        val before = repository.clockedIn.value.getValue("hub-a")
        Thread.sleep(2) // distinct Instant.now() for the new clock-in

        repository.heartbeat("hub-a")

        val after = repository.clockedIn.value["hub-a"]
        assertNotNull(after)
        assertTrue("expected the newer clock-in to be kept", after != before)
    }

    // ---- syncFromServer (#2886) ----

    @Test
    fun `sync adopts the clock-ins the server reports, per hub`() = runTest {
        server.dispatcher = object : okhttp3.mockwebserver.Dispatcher() {
            override fun dispatch(request: okhttp3.mockwebserver.RecordedRequest): MockResponse =
                when (request.path) {
                    "/api/hubs/hub-a/shifts/my-status" -> myStatus(true, "2026-11-21T10:00:00.000Z")
                    "/api/hubs/hub-b/shifts/my-status" -> myStatus(false)
                    else -> MockResponse().setResponseCode(404)
                }
        }

        repository.syncFromServer(listOf("hub-a", "hub-b"))

        assertEquals(mapOf("hub-a" to "2026-11-21T10:00:00.000Z"), repository.clockedIn.value)
    }

    @Test
    fun `sync clears a clock-in the server no longer holds`() = runTest {
        server.enqueue(ok())
        repository.clockIn("hub-a")
        server.takeRequest()
        server.enqueue(myStatus(false))

        repository.syncFromServer(listOf("hub-a"))

        assertTrue(repository.clockedIn.value.isEmpty())
    }

    @Test
    fun `sync keeps a clock-in on a hub it could not reach, and drops hubs that are not member hubs`() = runTest {
        server.enqueue(ok())
        server.enqueue(ok())
        repository.clockIn("hub-a")
        repository.clockIn("hub-gone")
        server.dispatcher = object : okhttp3.mockwebserver.Dispatcher() {
            override fun dispatch(request: okhttp3.mockwebserver.RecordedRequest) =
                MockResponse().setResponseCode(503).setBody("""{"error":"down"}""")
        }

        repository.syncFromServer(listOf("hub-a"))

        assertEquals(setOf("hub-a"), repository.clockedIn.value.keys)
    }

    @Test
    fun `sync does not undo a clock-in made while the status read was in flight`() = runTest {
        server.dispatcher = object : okhttp3.mockwebserver.Dispatcher() {
            override fun dispatch(request: okhttp3.mockwebserver.RecordedRequest): MockResponse {
                if (request.path!!.endsWith("/my-status")) {
                    // Answered "not clocked in" — but the volunteer clocks in before it lands.
                    runBlocking { repository.clockIn("hub-a") }
                    return myStatus(false)
                }
                return ok()
            }
        }

        repository.syncFromServer(listOf("hub-a"))

        assertTrue("hub-a" in repository.clockedIn.value)
    }
}
