package org.llamenos.hotline.ui.auth

import io.mockk.coEvery
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.llamenos.hotline.InMemoryKeyValueStore
import org.llamenos.hotline.R
import org.llamenos.hotline.api.ApiService
import org.llamenos.hotline.api.InviteRepository
import org.llamenos.hotline.crypto.AuthToken
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.crypto.KeystoreService
import org.llamenos.hotline.hub.ActiveHubState

/**
 * What onboarding tells a volunteer when the server rate-limits them.
 *
 * `GET /api/invites/validate/:code` is capped at 5 requests per minute per CLIENT IP
 * (apps/worker/routes/invites.ts), and answers `429 {"error":"Too many requests"}` with
 * `Retry-After: 60`. That cap is reachable by ordinary use: a volunteer who retypes a
 * code a few times, or several volunteers enrolling from one office or carrier NAT,
 * share the one bucket.
 *
 * [InviteRepository] surfaces the status as `ApiException.code` — its own test says so,
 * "for the ViewModel to classify" — and the ViewModel did not classify it. A 429 fell
 * through to the catch-all and the screen said the invite code was invalid, about a code
 * the server had not even looked at. The volunteer re-types a good code, which spends
 * another request against the same bucket and extends the lockout.
 *
 * These tests drive the real ViewModel and the real [ApiService] against a server that
 * answers exactly what the deployed one answers, and assert the string the user is shown
 * — not the exception type, which is what made this invisible.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class InviteViewModelRateLimitTest {

    private val code = "3f6f8f2c-9f3e-4a2b-b1c1-2d4e6f8091a2"

    private lateinit var server: MockWebServer
    private lateinit var viewModel: InviteViewModel

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        server = MockWebServer()
        server.start()
        val store = InMemoryKeyValueStore()
        store.store(KeystoreService.KEY_HUB_URL, server.url("/").toString().trimEnd('/'))
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
        val cryptoService = mockk<CryptoService>()
        coEvery {
            cryptoService.createAuthTokenWithoutNonce("POST", "/api/invites/redeem")
        } returns AuthToken("ab".repeat(32), 1_700_000_000_000L, "cd".repeat(64), null)
        viewModel = InviteViewModel(InviteRepository(apiService, cryptoService))
    }

    @After
    fun tearDown() {
        server.shutdown()
        Dispatchers.resetMain()
    }

    /**
     * The state once the in-flight call has resolved.
     *
     * [InviteRepository.redeemInvite] hops to [Dispatchers.IO] itself rather than to
     * ApiService's injectable dispatcher, so redemption is genuinely asynchronous here and
     * reading `uiState.value` straight after [InviteViewModel.redeem] observes the in-flight
     * state, not the outcome. Both entry points set VALIDATING/REDEEMING synchronously
     * before launching, so leaving either one is the signal that the call has landed.
     */
    private suspend fun settled(): InviteUiState = withContext(Dispatchers.Default) {
        withTimeout(10_000) {
            viewModel.uiState.first {
                it.stage != InviteStage.VALIDATING && it.stage != InviteStage.REDEEMING
            }
        }
    }

    /** What apps/worker/routes/invites.ts actually sends once the per-IP cap is spent. */
    private fun rateLimited() = MockResponse()
        .setResponseCode(429)
        .setHeader("Retry-After", "60")
        .setBody("""{"error":"Too many requests"}""")

    @Test
    fun `a rate-limited validation says to wait, not that the code is invalid`() = runTest {
        server.enqueue(rateLimited())

        viewModel.updateInput(code)
        viewModel.validate()

        val state = settled()
        assertEquals(
            "a 429 must not be reported as a bad invite code",
            R.string.enroll_error_rate_limited,
            state.errorRes,
        )
        assertEquals(InviteStage.NONE, state.stage)
    }

    @Test
    fun `a rate-limited redemption says to wait, not that redemption failed`() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"valid":true}"""))
        viewModel.updateInput(code)
        viewModel.validate()
        assertEquals(InviteStage.VALID, settled().stage)

        server.enqueue(rateLimited())
        viewModel.redeem()

        val state = settled()
        assertEquals(
            "a 429 must not be reported as a redemption failure",
            R.string.enroll_error_rate_limited,
            state.errorRes,
        )
        // The invite is still good — the user may retry once the window passes.
        assertEquals(InviteStage.VALID, state.stage)
    }

    @Test
    fun `a genuinely invalid code still says the code is invalid`() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"valid":false}"""))

        viewModel.updateInput(code)
        viewModel.validate()

        assertEquals(R.string.onboarding_invalid_code, settled().errorRes)
    }

    @Test
    fun `a server error during validation is not reported as a bad code either`() = runTest {
        server.enqueue(MockResponse().setResponseCode(503).setBody("""{"error":"unavailable"}"""))

        viewModel.updateInput(code)
        viewModel.validate()

        assertEquals(
            "a 503 is the hub being down, not a bad invite",
            R.string.connection_failed,
            settled().errorRes,
        )
    }
}
