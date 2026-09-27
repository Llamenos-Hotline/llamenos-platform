package org.llamenos.hotline.telephony

import android.content.Context
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import io.mockk.mockkStatic
import io.mockk.slot
import io.mockk.unmockkStatic
import io.mockk.verify
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
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
import org.linphone.core.Account
import org.linphone.core.AccountListener
import org.linphone.core.AccountParams
import org.linphone.core.Address
import org.linphone.core.AuthInfo
import org.linphone.core.Call
import org.linphone.core.CallLog
import org.linphone.core.Core
import org.linphone.core.CoreListener
import org.linphone.core.Factory
import org.linphone.core.RegistrationState
import org.llamenos.hotline.R
import org.llamenos.hotline.api.ApiService
import org.llamenos.hotline.api.ShiftClockRepository
import org.llamenos.hotline.api.WebSocketService
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.crypto.KeyValueStore
import org.llamenos.hotline.crypto.KeystoreService
import org.llamenos.hotline.hub.ActiveHubState
import org.llamenos.hotline.model.LlamenosEvent
import org.llamenos.hotline.service.AttributedHubEvent
import org.llamenos.hotline.ui.dashboard.DashboardViewModel
import org.llamenos.hotline.ui.shifts.ShiftsViewModel
import java.util.Collections

/**
 * #1188: clocking in must leave this device registered to ring for every member hub.
 *
 * The HTTP side is real — a real [ApiService] talks to [MockWebServer] serving the server's
 * actual response shapes — and so are [SipRegistrar] and [LinphoneService]. Only liblinphone
 * itself is replaced: its native library does not load on the JVM, so an actual SIP REGISTER
 * cannot happen here. These tests therefore assert everything up to the liblinphone boundary:
 * one account per SIP identity added to the core, an [AuthInfo] carrying the password, every
 * member hub bound to a registration, and registration state following liblinphone's callbacks.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class SipRegistrationTest {

    private val server = MockWebServer()
    private val requests = Collections.synchronizedList(mutableListOf<String>())
    @Volatile private var sipTokenResponse: MockResponse = sipTokenOk()

    private val factory = mockk<Factory>()
    private val core = mockk<Core>(relaxed = true)
    private val authInfos = mutableListOf<CreatedAuthInfo>()
    private val accounts = mutableListOf<Account>()
    private val accountParams = mutableListOf<AccountParams>()
    private val accountListeners = mutableMapOf<Account, AccountListener>()
    private val coreListener = slot<CoreListener>()

    private val activeHubId = MutableStateFlow<String?>(HUB_A)
    private val activeHubState = mockk<ActiveHubState>(relaxed = true).also {
        every { it.activeHubId } returns activeHubId
    }
    private val cryptoService = mockk<CryptoService>(relaxed = true)
    private val appScope = TestScope(UnconfinedTestDispatcher())

    private lateinit var apiService: ApiService
    private lateinit var linphoneService: LinphoneService
    private lateinit var sipRegistrar: SipRegistrar
    private lateinit var shiftClockRepository: ShiftClockRepository

    private data class CreatedAuthInfo(
        val username: String?,
        val userId: String?,
        val password: String?,
        val ha1: String?,
        val realm: String?,
        val domain: String?,
        val authInfo: AuthInfo,
    )

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path ?: ""
                requests += "${request.method} $path"
                // The shapes apps/worker/routes/shifts.ts actually returns.
                return when {
                    path.endsWith("/shifts/clock-in") || path.endsWith("/shifts/clock-out") ->
                        MockResponse().setBody("""{"ok":true}""")
                    path.endsWith("/shifts/my-status") ->
                        MockResponse().setBody("""{"onShift":false,"currentShift":null,"nextShift":null}""")
                    path.endsWith("/shifts") -> MockResponse().setBody("""{"shifts":[]}""")
                    path == "/api/hubs" -> MockResponse().setBody(HUBS_JSON)
                    path == "/api/telephony/sip-token" -> sipTokenResponse
                    else -> MockResponse().setResponseCode(404).setBody("""{"error":"Not Found"}""")
                }
            }
        }
        server.start()

        mockkStatic(Factory::class)
        every { Factory.instance() } returns factory
        every { factory.createCore(any(), any(), any()) } returns core
        every { core.audioPayloadTypes } returns emptyArray()
        every { core.addListener(capture(coreListener)) } returns Unit
        every { factory.createAddress(any()) } answers { mockk<Address>(relaxed = true) }
        every { factory.createAuthInfo(any(), any(), any(), any(), any(), any()) } answers {
            mockk<AuthInfo>(relaxed = true).also { authInfo ->
                authInfos += CreatedAuthInfo(
                    username = arg(0), userId = arg(1), password = arg(2),
                    ha1 = arg(3), realm = arg(4), domain = arg(5), authInfo = authInfo,
                )
            }
        }
        every { core.createAccountParams() } answers {
            mockk<AccountParams>(relaxed = true).also { accountParams += it }
        }
        every { core.createAccount(any()) } answers {
            mockk<Account>(relaxed = true).also { account ->
                every { account.addListener(any()) } answers { accountListeners[account] = firstArg() }
                accounts += account
            }
        }
        every { core.addAccount(any()) } returns 0

        val store = mockk<KeyValueStore>(relaxed = true)
        every { store.retrieve(KeystoreService.KEY_HUB_URL) } returns server.url("/").toString().trimEnd('/')
        apiService = ApiService(
            authInterceptor = mockk(relaxed = true),
            retryInterceptor = mockk(relaxed = true),
            keystoreService = store,
            activeHubState = activeHubState,
        ).also {
            it.ioDispatcher = UnconfinedTestDispatcher()
            it.client = OkHttpClient()
        }
        linphoneService = LinphoneService(mockk<Context>(relaxed = true), activeHubState, cryptoService, appScope)
        linphoneService.initialize()
        sipRegistrar = SipRegistrar(apiService, linphoneService)
        shiftClockRepository = ShiftClockRepository(apiService)
    }

    @After
    fun tearDown() {
        server.shutdown()
        unmockkStatic(Factory::class)
        Dispatchers.resetMain()
    }

    private fun shiftsViewModel() = ShiftsViewModel(apiService, activeHubState, shiftClockRepository, sipRegistrar)

    // ---- Registration on clock-in ----

    @Test
    fun `clockIn registers every member hub with SIP credentials attached`() {
        val vm = shiftsViewModel()
        assertEquals("no registration before clocking in", emptySet<String>(), linphoneService.registeredHubIds())

        vm.clockIn()

        // Every member hub — not only the active one — is bound to a registration.
        assertEquals(setOf(HUB_A, HUB_B), linphoneService.registeredHubIds())
        assertEquals(setOf(HUB_A, HUB_B), linphoneService.registrationStates.value.keys)

        // The password reaches liblinphone as an AuthInfo for the SIP domain.
        val created = authInfos.single()
        assertEquals(SIP_USERNAME, created.username)
        assertEquals(SIP_PASSWORD, created.password)
        assertEquals(SIP_DOMAIN, created.domain)
        verify { core.addAuthInfo(created.authInfo) }

        // Both hubs got the same identity from the server, so they share ONE account:
        // registering one AOR twice would ring this device twice per call.
        val account = accounts.single()
        verify(exactly = 1) { core.addAccount(account) }
        val params = accountParams.single()
        verify { params.isRegisterEnabled = true }
        verify { params.expires = LinphoneService.REGISTER_EXPIRES_SECONDS }
        verify { factory.createAddress("sip:$SIP_USERNAME@$SIP_DOMAIN") }
        verify { factory.createAddress("sip:$SIP_DOMAIN;transport=tls") }

        assertTrue(requests.contains("POST /api/hubs/$HUB_A/shifts/clock-in"))
        assertTrue(requests.contains("GET /api/hubs"))
        assertTrue(requests.contains("GET /api/telephony/sip-token"))
        assertNull(vm.uiState.value.callSetupErrorRes)
    }

    private fun dashboardViewModel(): DashboardViewModel {
        val webSocketService = mockk<WebSocketService>(relaxed = true)
        every { webSocketService.connectionState } returns
            MutableStateFlow(WebSocketService.ConnectionState.DISCONNECTED)
        every { webSocketService.typedEvents } returns MutableSharedFlow<AttributedHubEvent<LlamenosEvent>>()
        return DashboardViewModel(
            cryptoService,
            webSocketService,
            apiService,
            mockk(relaxed = true),
            activeHubState,
            mockk(relaxed = true),
            shiftClockRepository,
            sipRegistrar,
        )
    }

    @Test
    fun `dashboard clockIn registers every member hub`() {
        val vm = dashboardViewModel()

        vm.clockIn()

        assertEquals(setOf(HUB_A, HUB_B), linphoneService.registeredHubIds())
        assertEquals(SIP_PASSWORD, authInfos.single().password)
        verify(exactly = 1) { core.addAccount(accounts.single()) }
    }

    @Test
    fun `hubs with distinct SIP identities each get their own account and AuthInfo`() {
        linphoneService.registerHubAccount(HUB_A, sipParams(username = "vol_a", password = "pw-a"))
        linphoneService.registerHubAccount(HUB_B, sipParams(username = "vol_b", password = "pw-b"))

        assertEquals(listOf("pw-a", "pw-b"), authInfos.map { it.password })
        assertEquals(2, accounts.size)
        accounts.forEach { verify(exactly = 1) { core.addAccount(it) } }
        assertEquals(setOf(HUB_A, HUB_B), linphoneService.registeredHubIds())
    }

    @Test
    fun `clockOut unregisters every account and drops its credentials`() {
        val vm = shiftsViewModel()
        vm.clockIn()
        val account = accounts.single()
        val authInfo = authInfos.single().authInfo

        vm.clockOut()

        verify { core.removeAccount(account) }
        verify { core.removeAuthInfo(authInfo) }
        assertEquals(emptySet<String>(), linphoneService.registeredHubIds())
        assertEquals(emptyMap<String, RegistrationState>(), linphoneService.registrationStates.value)
    }

    @Test
    fun `phone-only call preference registers nothing and reports no error`() {
        sipTokenResponse = MockResponse().setResponseCode(400)
            .setBody("""{"error":"Call preference is set to phone only. Enable VoIP in settings."}""")
        val vm = shiftsViewModel()

        vm.clockIn()

        assertEquals(emptySet<String>(), linphoneService.registeredHubIds())
        verify(exactly = 0) { core.addAccount(any()) }
        assertNull(vm.uiState.value.callSetupErrorRes)
    }

    @Test
    fun `a failed credential fetch is surfaced instead of swallowed`() {
        sipTokenResponse = MockResponse().setResponseCode(500).setBody("""{"error":"boom"}""")
        val vm = shiftsViewModel()

        vm.clockIn()

        assertEquals(emptySet<String>(), linphoneService.registeredHubIds())
        assertEquals(R.string.dashboard_error_in_app_calls_unavailable, vm.uiState.value.callSetupErrorRes)
    }

    @Test
    fun `registration state follows liblinphone's account callbacks`() {
        shiftsViewModel().clockIn()
        val account = accounts.single()
        val listener = accountListeners.getValue(account)

        listener.onRegistrationStateChanged(account, RegistrationState.Ok, "Registration successful")
        assertEquals(
            mapOf(HUB_A to RegistrationState.Ok, HUB_B to RegistrationState.Ok),
            linphoneService.registrationStates.value,
        )

        listener.onRegistrationStateChanged(account, RegistrationState.Failed, "Unauthorized")
        assertEquals(RegistrationState.Failed, linphoneService.registrationStates.value[HUB_A])
        assertEquals(RegistrationState.Failed, linphoneService.registrationStates.value[HUB_B])
    }

    // ---- Clock state is per hub: clocking out of one hub keeps the others ringing ----

    @Test
    fun `clocking out of one hub keeps registrations while still clocked in to another`() {
        val vm = shiftsViewModel()
        vm.clockIn()
        activeHubId.value = HUB_B
        vm.clockIn()
        val account = accounts.single()

        vm.clockOut()

        assertEquals(setOf(HUB_A), shiftClockRepository.clockedIn.value.keys)
        assertEquals(setOf(HUB_A, HUB_B), linphoneService.registeredHubIds())
        verify(exactly = 0) { core.removeAccount(account) }
    }

    @Test
    fun `clocking out of the last clocked-in hub unregisters`() {
        val vm = shiftsViewModel()
        vm.clockIn()
        activeHubId.value = HUB_B
        vm.clockIn()
        vm.clockOut()
        activeHubId.value = HUB_A

        vm.clockOut()

        assertEquals(emptyMap<String, String>(), shiftClockRepository.clockedIn.value)
        assertEquals(emptySet<String>(), linphoneService.registeredHubIds())
        verify { core.removeAccount(accounts.single()) }
    }

    @Test
    fun `a clock-out that leaves a hub clocked in retries a registration that had failed`() {
        sipTokenResponse = MockResponse().setResponseCode(500).setBody("""{"error":"boom"}""")
        val vm = shiftsViewModel()
        vm.clockIn()
        activeHubId.value = HUB_B
        vm.clockIn()
        assertEquals(emptySet<String>(), linphoneService.registeredHubIds())
        assertEquals(R.string.dashboard_error_in_app_calls_unavailable, vm.uiState.value.callSetupErrorRes)

        sipTokenResponse = sipTokenOk()
        vm.clockOut()

        assertEquals(setOf(HUB_A), shiftClockRepository.clockedIn.value.keys)
        assertEquals(setOf(HUB_A, HUB_B), linphoneService.registeredHubIds())
        assertNull(vm.uiState.value.callSetupErrorRes)
    }

    @Test
    fun `dashboard clockOut of one hub keeps registrations while another is clocked in`() {
        val vm = dashboardViewModel()
        vm.clockIn()
        activeHubId.value = HUB_B
        vm.clockIn()

        vm.clockOut()

        assertEquals(setOf(HUB_A, HUB_B), linphoneService.registeredHubIds())

        activeHubId.value = HUB_A
        vm.clockOut()

        assertEquals(emptySet<String>(), linphoneService.registeredHubIds())
    }

    // ---- Active hub switch: answer path only ----

    private fun incomingCall(callId: String): Call {
        val callLog = mockk<CallLog>()
        every { callLog.callId } returns callId
        val call = mockk<Call>()
        every { call.callLog } returns callLog
        every { call.dir } returns Call.Dir.Incoming
        return call
    }

    @Test
    fun `ringing does not switch the active hub`() {
        linphoneService.storePendingCallHub("call-1", HUB_B)
        every { cryptoService.isUnlocked } returns true

        coreListener.captured.onCallStateChanged(core, incomingCall("call-1"), Call.State.IncomingReceived, "")

        coVerify(exactly = 0) { activeHubState.setActiveHub(any()) }
    }

    @Test
    fun `answering with the app unlocked switches to the call's hub`() {
        linphoneService.storePendingCallHub("call-1", HUB_B)
        every { cryptoService.isUnlocked } returns true
        val call = incomingCall("call-1")

        coreListener.captured.onCallStateChanged(core, call, Call.State.IncomingReceived, "")
        coVerify(exactly = 0) { activeHubState.setActiveHub(any()) }

        coreListener.captured.onCallStateChanged(core, call, Call.State.Connected, "")
        coVerify(exactly = 1) { activeHubState.setActiveHub(HUB_B) }
    }

    @Test
    fun `answering while the app is locked leaves the active hub alone`() {
        linphoneService.storePendingCallHub("call-1", HUB_B)
        every { cryptoService.isUnlocked } returns false

        coreListener.captured.onCallStateChanged(core, incomingCall("call-1"), Call.State.Connected, "")

        coVerify(exactly = 0) { activeHubState.setActiveHub(any()) }
    }

    private companion object {
        const val HUB_A = "hub-a"
        const val HUB_B = "hub-b"
        const val SIP_USERNAME = "vol_0123456789abcdef"
        const val SIP_PASSWORD = "s3cret-sip-password"
        const val SIP_DOMAIN = "sip.example.org"

        val HUBS_JSON = """
            {"hubs":[
              {"id":"$HUB_A","name":"Hub A","slug":"hub-a","status":"active","createdBy":"admin",
               "createdAt":"2026-09-01T00:00:00Z","updatedAt":"2026-09-01T00:00:00Z"},
              {"id":"$HUB_B","name":"Hub B","slug":"hub-b","status":"active","createdBy":"admin",
               "createdAt":"2026-09-01T00:00:00Z","updatedAt":"2026-09-01T00:00:00Z"}
            ]}
        """.trimIndent()

        /** The shape `apps/worker/telephony/sip-tokens.ts` actually returns. */
        fun sipTokenOk(): MockResponse = MockResponse().setBody(
            """
            {"provider":"asterisk","sip":{"domain":"$SIP_DOMAIN","transport":"tls",
             "username":"$SIP_USERNAME","password":"$SIP_PASSWORD",
             "iceServers":[{"url":"stun:$SIP_DOMAIN:3478"}],"mediaEncryption":"zrtp"}}
            """.trimIndent(),
        )

        fun sipParams(username: String, password: String) = SipAccountParams(
            domain = SIP_DOMAIN,
            transport = "tls",
            username = username,
            password = password,
            mediaEncryption = "srtp",
        )
    }
}
