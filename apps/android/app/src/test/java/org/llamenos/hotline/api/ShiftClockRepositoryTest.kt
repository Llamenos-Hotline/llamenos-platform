package org.llamenos.hotline.api

import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
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
}
