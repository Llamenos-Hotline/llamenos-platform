package org.llamenos.hotline.ui.admin

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

/**
 * The sidebar's permissions come from the server's `GET /api/auth/me` — the one
 * endpoint that reports the viewer's effective permissions (account-wide, the same
 * set the desktop client gates its sidebar on). The mock answers only that route
 * and 404s everything else, as the real server does.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class AdminSidebarViewModelTest {

    private lateinit var server: MockWebServer
    private var meResponse: MockResponse = MockResponse()
    private val paths = mutableListOf<String>()

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                paths += "${request.method} ${request.path}"
                return if (request.method == "GET" && request.path == "/api/auth/me") {
                    meResponse
                } else {
                    MockResponse().setResponseCode(404).setBody("""{"error":"Not Found"}""")
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

    private fun me(permissions: String) = MockResponse().setBody(
        """{"pubkey":"${"a".repeat(64)}","roles":["role-hub-admin"],"permissions":$permissions,
            "primaryRole":null,"name":"Admin","transcriptionEnabled":false,"spokenLanguages":["en"],
            "uiLanguage":"en","profileCompleted":true,"onBreak":false,"callPreference":"phone",
            "webauthnRequired":false,"webauthnRegistered":false}""",
    )

    private fun newViewModel(): AdminSidebarViewModel {
        val store = InMemoryKeyValueStore()
        store.store(KeystoreService.KEY_HUB_URL, server.url("/").toString().trimEnd('/'))
        val activeHubState = mockk<ActiveHubState>(relaxed = true)
        every { activeHubState.activeHubId } returns MutableStateFlow<String?>("hub-a")
        val apiService = ApiService(
            authInterceptor = mockk(relaxed = true),
            retryInterceptor = mockk(relaxed = true),
            keystoreService = store,
            activeHubState = activeHubState,
        ).also {
            it.client = OkHttpClient()
            it.ioDispatcher = UnconfinedTestDispatcher()
        }
        return AdminSidebarViewModel(apiService)
    }

    @Test
    fun `the viewer's permissions from auth me are what the sidebar evaluates`() =
        runTest(UnconfinedTestDispatcher()) {
            meResponse = me("""["settings:read","bans:read"]""")
            val vm = newViewModel()
            advanceUntilIdle()

            val state = vm.state.value
            assertTrue("expected Loaded, was $state", state is AdminSidebarState.Loaded)
            val visible = AdminNavConfig.thisHubItems.visibleTo((state as AdminSidebarState.Loaded).permissions)
            assertTrue("bans" in visible.map { it.slug })
            assertEquals(emptyList<AdminNavItem>(), AdminNavConfig.platformItems.visibleTo(state.permissions))
            assertEquals(listOf("GET /api/auth/me"), paths)
        }

    @Test
    fun `a failed permission lookup lists nothing and can be retried`() =
        runTest(UnconfinedTestDispatcher()) {
            meResponse = MockResponse().setResponseCode(500).setBody("""{"error":"boom"}""")
            val vm = newViewModel()
            advanceUntilIdle()
            assertEquals(AdminSidebarState.Failed, vm.state.value)

            meResponse = me("""["*"]""")
            vm.load()
            advanceUntilIdle()
            assertEquals(AdminSidebarState.Loaded(listOf("*")), vm.state.value)
        }
}
