package org.llamenos.hotline.service

import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import okhttp3.mockwebserver.MockResponse
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.llamenos.hotline.MountedRoutes
import org.llamenos.hotline.MountedRoutes.Companion.json
import org.llamenos.hotline.MountedRoutes.Route
import org.llamenos.hotline.MountedServer
import org.llamenos.hotline.api.ShiftClockRepository
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.telephony.SipRegistrar
import java.io.File

/**
 * [ShiftHeartbeat] against a real [ShiftClockRepository] and [org.llamenos.hotline.api.ApiService]
 * talking to a fake server that mounts the routes the worker mounts and judges liveness the way
 * the worker does: a heartbeat to a hub the user is not (or no longer) clocked into is a 404.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ShiftHeartbeatTest {

    /** Hubs the fake server currently holds a live clock-in for. */
    private val live = mutableSetOf<String>()

    private lateinit var mounted: MountedServer
    private lateinit var repository: ShiftClockRepository
    private val unlocked = MutableStateFlow(false)
    private val crypto = mockk<CryptoService>().also { every { it.unlockedState } returns unlocked }
    private val sip = mockk<SipRegistrar>(relaxed = true)

    @Before
    fun setUp() {
        Dispatchers.setMain(StandardTestDispatcher())
        val routes = MountedRoutes(
            Route("GET", "/api/hubs") { json(HUBS) },
            Route("GET", "/api/hubs/:hubId/shifts/my-status") { call ->
                val on = call.params.getValue("hubId") in live
                json("""{"onShift":false,"clockedIn":$on,"clockedInAt":${if (on) "\"2026-11-21T10:00:00.000Z\"" else "null"}}""")
            },
            Route("POST", "/api/hubs/:hubId/shifts/clock-in") { call ->
                live += call.params.getValue("hubId")
                json("""{"ok":true}""")
            },
            Route("POST", "/api/hubs/:hubId/shifts/heartbeat") { call ->
                if (call.params.getValue("hubId") in live) json("""{"ok":true}""")
                else MockResponse().setResponseCode(404).setBody("""{"error":"Active shift not found"}""")
            },
        )
        // No active hub: the heartbeat must never depend on it.
        mounted = MountedServer(routes, activeHub = null)
        repository = ShiftClockRepository(mounted.apiService)
    }

    @After
    fun tearDown() {
        mounted.shutdown()
        Dispatchers.resetMain()
    }

    private fun TestScope.heartbeat() = ShiftHeartbeat(repository, mounted.apiService, crypto, sip, backgroundScope)

    private fun beats(hubId: String) = mounted.routes.seen().count { it == "POST /api/hubs/$hubId/shifts/heartbeat" }

    @Test
    fun `beats every hub it is clocked into, every interval, and never the one it is not`() = runTest {
        live += setOf("hub-a", "hub-b")
        heartbeat().start()
        unlocked.value = true
        runCurrent()
        // The relaunch read the server's clock-ins and re-asserted them at once.
        assertEquals(1, beats("hub-a"))
        assertEquals(1, beats("hub-b"))

        advanceTimeBy(ShiftHeartbeat.HEARTBEAT_INTERVAL_MS)
        runCurrent()
        assertEquals(2, beats("hub-a"))
        assertEquals(2, beats("hub-b"))

        advanceTimeBy(ShiftHeartbeat.HEARTBEAT_INTERVAL_MS)
        runCurrent()
        assertEquals(3, beats("hub-a"))
    }

    @Test
    fun `a hub the user is not clocked into is never beaten`() = runTest {
        live += "hub-a"
        heartbeat().start()
        unlocked.value = true
        runCurrent()
        advanceTimeBy(ShiftHeartbeat.HEARTBEAT_INTERVAL_MS * 2)
        runCurrent()

        assertEquals(0, beats("hub-b"))
        assertTrue(beats("hub-a") >= 3)
    }

    @Test
    fun `nothing is sent while locked, and the clock-in is re-asserted at the next unlock`() = runTest {
        live += "hub-a"
        heartbeat().start()
        runCurrent()
        advanceTimeBy(ShiftHeartbeat.HEARTBEAT_INTERVAL_MS * 3)
        runCurrent()
        assertEquals(emptyList<String>(), mounted.routes.seen())

        unlocked.value = true
        runCurrent()
        assertEquals(1, beats("hub-a"))

        unlocked.value = false
        runCurrent()
        val sent = mounted.routes.seen().size
        advanceTimeBy(ShiftHeartbeat.HEARTBEAT_INTERVAL_MS * 3)
        runCurrent()
        assertEquals(sent, mounted.routes.seen().size)
    }

    @Test
    fun `a clock-in made in the app is beaten`() = runTest {
        heartbeat().start()
        unlocked.value = true
        runCurrent()
        repository.clockIn("hub-a")

        advanceTimeBy(ShiftHeartbeat.HEARTBEAT_INTERVAL_MS)
        runCurrent()

        assertEquals(1, beats("hub-a"))
    }

    @Test
    fun `a 404 ends the clock-in, is not retried, and drops the SIP registrations with the last clock-in`() = runTest {
        live += "hub-a"
        heartbeat().start()
        unlocked.value = true
        runCurrent()
        assertTrue("hub-a" in repository.clockedIn.value)

        // The server's reaper deleted it (the app was away longer than the stale window).
        live.clear()
        advanceTimeBy(ShiftHeartbeat.HEARTBEAT_INTERVAL_MS)
        runCurrent()
        assertEquals(2, beats("hub-a"))
        assertFalse("hub-a" in repository.clockedIn.value)
        coVerify(exactly = 1) { sip.syncWithShift(false) }

        advanceTimeBy(ShiftHeartbeat.HEARTBEAT_INTERVAL_MS * 4)
        runCurrent()
        assertEquals(2, beats("hub-a"))
    }

    @Test
    fun `SIP stays registered while another hub is still clocked in`() = runTest {
        live += setOf("hub-a", "hub-b")
        heartbeat().start()
        unlocked.value = true
        runCurrent()

        live -= "hub-a"
        advanceTimeBy(ShiftHeartbeat.HEARTBEAT_INTERVAL_MS)
        runCurrent()

        assertEquals(setOf("hub-b"), repository.clockedIn.value.keys)
        coVerify(exactly = 0) { sip.syncWithShift(any()) }
    }

    @Test
    fun `returning to the foreground re-reads the server and beats at once`() = runTest {
        val heartbeat = heartbeat()
        heartbeat.start()
        unlocked.value = true
        runCurrent()
        assertEquals(0, beats("hub-a"))

        live += "hub-a" // clocked in from another device while this one was away
        heartbeat.onForeground()
        runCurrent()

        assertEquals(1, beats("hub-a"))
        assertTrue("hub-a" in repository.clockedIn.value)
    }

    @Test
    fun `a heartbeat to an unreachable server does not stop the loop`() = runTest {
        live += "hub-a"
        heartbeat().start()
        unlocked.value = true
        runCurrent()
        mounted.shutdown()

        advanceTimeBy(ShiftHeartbeat.HEARTBEAT_INTERVAL_MS * 2)
        runCurrent()

        assertTrue("an unreachable server is not a lost clock-in", "hub-a" in repository.clockedIn.value)
        verify(exactly = 0) { sip.unregisterAll() }
    }

    @Test
    fun `the interval equals the shared constant the server's stale window is validated against`() {
        val ts = generateSequence(File("").absoluteFile) { it.parentFile }
            .map { File(it, "packages/shared/active-shift-liveness.ts") }
            .first { it.exists() }
            .readText()
        val shared = Regex("""ACTIVE_SHIFT_HEARTBEAT_INTERVAL_MS\s*=\s*([\d_]+)""").find(ts)!!
            .groupValues[1].replace("_", "").toLong()

        assertEquals(shared, ShiftHeartbeat.HEARTBEAT_INTERVAL_MS)
    }

    private companion object {
        val HUBS = """
            {"hubs":[
              {"id":"hub-a","name":"Hub A","slug":"hub-a","status":"active","timezone":"UTC","createdBy":"admin",
               "createdAt":"2026-09-01T00:00:00Z","updatedAt":"2026-09-01T00:00:00Z"},
              {"id":"hub-b","name":"Hub B","slug":"hub-b","status":"active","timezone":"UTC","createdBy":"admin",
               "createdAt":"2026-09-01T00:00:00Z","updatedAt":"2026-09-01T00:00:00Z"}
            ]}
        """.trimIndent()
    }
}
