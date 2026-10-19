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
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.llamenos.hotline.InMemoryKeyValueStore
import org.llamenos.hotline.crypto.KeystoreService
import org.llamenos.hotline.hub.ActiveHubState
import org.llamenos.protocol.SharedRole

/**
 * [ApiService.getMemberDirectory] must read the HUB-SCOPED directory. The unscoped
 * /api/identity/members needs the global `users:read`, which a hub admin does not hold, and it
 * resolves admin-vs-volunteer globally instead of in the browsing hub (#1992).
 */
@OptIn(ExperimentalCoroutinesApi::class)
class MemberDirectoryApiTest {

    private lateinit var server: MockWebServer
    private val activeHubId = MutableStateFlow<String?>("hub-a")
    private lateinit var api: ApiService

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        val store = InMemoryKeyValueStore()
        store.store(KeystoreService.KEY_HUB_URL, server.url("/").toString().trimEnd('/'))
        val activeHubState = mockk<ActiveHubState>(relaxed = true)
        every { activeHubState.activeHubId } returns activeHubId
        api = ApiService(
            authInterceptor = mockk(relaxed = true),
            retryInterceptor = mockk(relaxed = true),
            keystoreService = store,
            activeHubState = activeHubState,
        ).also {
            it.client = OkHttpClient()
            it.ioDispatcher = UnconfinedTestDispatcher()
        }
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun `the directory is read from the active hub's route and decoded`() = runTest {
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"members":[{"id":"${"a".repeat(64)}","pubkey":"${"a".repeat(64)}",
                   "displayName":"Ada","role":"volunteer","status":"active",
                   "createdAt":"2026-01-01T00:00:00Z"}]}""",
            ),
        )

        val directory = api.getMemberDirectory()

        val request = server.takeRequest()
        assertEquals("GET", request.method)
        assertEquals("/api/hubs/hub-a/identity/members", request.path)
        assertEquals(SharedRole.Volunteer, directory.members.single().role)
    }

    @Test
    fun `with no active hub it fails instead of falling back to the unscoped route`() = runTest {
        activeHubId.value = null

        val failure = runCatching { api.getMemberDirectory() }.exceptionOrNull()

        assertTrue("expected IllegalStateException, got $failure", failure is IllegalStateException)

        assertEquals("no request may reach the server", 0, server.requestCount)
    }
}
