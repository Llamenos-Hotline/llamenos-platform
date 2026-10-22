package org.llamenos.hotline.ui.calls

import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import okhttp3.mockwebserver.MockResponse
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Before
import org.junit.Test
import org.llamenos.hotline.MountedRoutes
import org.llamenos.hotline.MountedRoutes.Companion.json
import org.llamenos.hotline.MountedRoutes.Route
import org.llamenos.hotline.MountedServer
import org.llamenos.hotline.api.ApiException

/**
 * Call-recording playback (#1997), against a real [org.llamenos.hotline.api.ApiService] and
 * a fake server that answers **only** what `apps/worker/routes/calls.ts` mounts under
 * `/api/hubs/:hubId/calls` and 404s everything else.
 *
 * What was wrong: `RecordingPlayer` handed `MediaPlayer` the URL
 * `/api/recordings/:id/audio` — a route that does not exist — and could never have
 * authenticated anyway, because a media player sends no request signature. Nothing
 * rendered it, so the call-history recording badge had no way to play anything. The
 * audio now comes through the signed API client from `GET /calls/:callId/recording`.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class CallRecordingRoutesTest {

    private lateinit var server: MountedServer
    private lateinit var routes: MountedRoutes

    /** RIFF/WAVE header bytes — what the route streams back as `audio/wav`. */
    private val wav = byteArrayOf(0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45)

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        routes = MountedRoutes(
            Route("GET", "/api/hubs/:hubId/calls/history") {
                json("""{"calls":[],"total":0,"page":1,"limit":50}""")
            },
            Route("GET", "/api/hubs/:hubId/calls/:callId/recording") { call ->
                if (call.params["callId"] != "call-1") {
                    return@Route json("""{"error":"No recording available for this call"}""", code = 404)
                }
                MockResponse()
                    .setResponseCode(200)
                    .setHeader("Content-Type", "audio/wav")
                    .setBody(Buffer().write(wav))
            },
        )
        server = MountedServer(routes)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
        server.shutdown()
    }

    private fun newViewModel() = CallHistoryViewModel(server.apiService, server.activeHubState, mockk(relaxed = true))

    @Test
    fun `the recording is fetched from the hub-scoped calls route, byte for byte`() = runTest {
        val audio = newViewModel().loadRecording("call-1")

        assertArrayEquals(wav, audio)
        assertEquals(1, routes.seen().count { it == "GET /api/hubs/hub-a/calls/call-1/recording" })
    }

    @Test
    fun `a call with no recording fails with the route's 404 rather than empty audio`() = runTest {
        val vm = newViewModel()
        val error = assertThrows(ApiException::class.java) {
            runBlocking { vm.loadRecording("call-without-audio") }
        }
        assertEquals(404, error.code)
    }
}
