package org.llamenos.hotline

import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.llamenos.hotline.api.ApiService
import org.llamenos.hotline.crypto.KeystoreService
import org.llamenos.hotline.hub.ActiveHubState
import java.util.Collections

/**
 * A fake server that answers **only** the method/path pairs the worker mounts and
 * 404s everything else, exactly as Hono does — so a client that calls a route the
 * server does not have fails here the way it fails against a real backend, instead
 * of being echoed a 200 that confirms its own bug.
 *
 * The route table each test hands in is a **mirror** of `apps/worker/routes/` (one file per router), not a
 * source of truth. `apps/worker/__tests__/unit/mobile-client-routes.test.ts` is what
 * holds the Android call sites to the worker's real Hono route table; these tests hold
 * the *behaviour* behind those call sites: the request reaches the route, carries the
 * body the route's schema takes, and what the route stores is what the screen then reads.
 *
 * `:name` segments in a [Route.pattern] capture one path segment each.
 */
class MountedRoutes(vararg routes: Route) : Dispatcher() {

    class Route(
        val method: String,
        val pattern: String,
        val handler: (Call) -> MockResponse,
    ) {
        private val names = pattern.split('/').filter { it.startsWith(":") }.map { it.drop(1) }
        private val regex = Regex(
            pattern.split('/').joinToString("/", prefix = "^", postfix = "$") { segment ->
                if (segment.startsWith(":")) "([^/]+)" else Regex.escape(segment)
            },
        )

        fun match(request: RecordedRequest): Map<String, String>? {
            if (request.method != method) return null
            val path = request.path.orEmpty().substringBefore('?')
            val values = regex.matchEntire(path)?.groupValues?.drop(1) ?: return null
            return names.zip(values).toMap()
        }
    }

    class Call(val request: RecordedRequest, val params: Map<String, String>, val body: String)

    private val table = routes.toList()
    val requests: MutableList<RecordedRequest> = Collections.synchronizedList(mutableListOf())
    private val bodies: MutableList<Pair<String, String>> = Collections.synchronizedList(mutableListOf())

    override fun dispatch(request: RecordedRequest): MockResponse {
        requests += request
        val body = request.body.readUtf8()
        val key = "${request.method} ${request.path.orEmpty().substringBefore('?')}"
        bodies += key to body
        for (route in table) {
            val params = route.match(request) ?: continue
            return route.handler(Call(request, params, body))
        }
        return MockResponse().setResponseCode(404).setBody("""{"error":"Not Found"}""")
    }

    /** `METHOD /path` for every request seen so far, query strings dropped. */
    fun seen(): List<String> = requests.map { "${it.method} ${it.path.orEmpty().substringBefore('?')}" }

    /** Request bodies sent to `METHOD /path`, oldest first. */
    fun bodiesSentTo(methodAndPath: String): List<String> =
        bodies.filter { it.first == methodAndPath }.map { it.second }

    companion object {
        fun json(body: String, code: Int = 200): MockResponse =
            MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body)
    }
}

/**
 * Starts a [MockWebServer] driven by [routes] and returns it with a real [ApiService]
 * pointed at it — real path building, real `hp()` hub scoping, real JSON config.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class MountedServer(val routes: MountedRoutes, activeHub: String? = "hub-a") {
    val hubFlow = MutableStateFlow(activeHub)
    private val server = MockWebServer().apply {
        dispatcher = routes
        start()
    }

    val activeHubState: ActiveHubState = mockk<ActiveHubState>(relaxed = true).also {
        every { it.activeHubId } returns hubFlow
    }

    val apiService: ApiService by lazy {
        val store = InMemoryKeyValueStore()
        store.store(KeystoreService.KEY_HUB_URL, server.url("/").toString().trimEnd('/'))
        ApiService(
            authInterceptor = mockk(relaxed = true),
            retryInterceptor = mockk(relaxed = true),
            keystoreService = store,
            activeHubState = activeHubState,
        ).also {
            it.client = OkHttpClient()
            it.ioDispatcher = UnconfinedTestDispatcher()
        }
    }

    fun shutdown() = server.shutdown()
}
