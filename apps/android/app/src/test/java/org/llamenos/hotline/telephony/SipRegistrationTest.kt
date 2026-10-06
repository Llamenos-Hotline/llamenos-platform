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
import org.junit.Assert.assertFalse
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
import org.linphone.core.MediaEncryption
import org.linphone.core.NatPolicy
import org.linphone.core.RegistrationState
import org.llamenos.hotline.R
import org.llamenos.hotline.api.ApiService
import org.llamenos.hotline.api.ShiftClockRepository
import org.llamenos.hotline.api.WebSocketService
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.crypto.KeyValueStore
import org.llamenos.hotline.crypto.KeystoreService
import org.llamenos.hotline.hub.ActiveHubState
import org.llamenos.hotline.hub.HubRepository
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

    /** Params cloned from a live account — how liblinphone wants a registered account edited. */
    private val clonedAccountParams = mutableListOf<AccountParams>()
    private val accountListeners = mutableMapOf<Account, AccountListener>()
    private val coreListener = slot<CoreListener>()
    private val natPolicies = mutableListOf<NatPolicy>()
    private val appliedEncryptions = mutableListOf<MediaEncryption>()
    private val installedRootCas = mutableListOf<String>()

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
            mockk<AccountParams>(relaxed = true).also { params ->
                accountParams += params
                every { params.clone() } answers {
                    mockk<AccountParams>(relaxed = true).also { clonedAccountParams += it }
                }
            }
        }
        // liblinphone's own capability check: the real core answers for the device, and the
        // service refuses to register when an algorithm is unsupported. Say yes here and let
        // the dedicated test say no.
        every { core.isMediaEncryptionSupported(any()) } returns true
        every { core.setMediaEncryption(any()) } answers { appliedEncryptions += firstArg<MediaEncryption>(); 0 }
        every { core.isMediaEncryptionMandatory } returns true
        every { core.setRootCaData(any()) } answers { installedRootCas += firstArg<String>() }
        every { core.createNatPolicy() } answers {
            mockk<NatPolicy>(relaxed = true).also { natPolicies += it }
        }
        every { core.createAccount(any()) } answers {
            val createdWith = firstArg<AccountParams>()
            mockk<Account>(relaxed = true).also { account ->
                every { account.addListener(any()) } answers { accountListeners[account] = firstArg() }
                // The real Account hands back the params it was created with; editing a
                // registered account means cloning them, changing the clone and assigning it.
                every { account.params } returns createdWith
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
        linphoneService = LinphoneService(
            mockk<Context>(relaxed = true),
            activeHubState,
            cryptoService,
            IncomingCallTracker(),
            mockk<IncomingCallNotifier>(relaxed = true),
            appScope,
        )
        linphoneService.initialize()
        sipRegistrar = SipRegistrar(apiService, linphoneService, appScope)
        shiftClockRepository = ShiftClockRepository(apiService)
    }

    @After
    fun tearDown() {
        server.shutdown()
        unmockkStatic(Factory::class)
        Dispatchers.resetMain()
    }

    private fun shiftsViewModel() = ShiftsViewModel(apiService, activeHubState, shiftClockRepository, sipRegistrar)

    /** The SIP credential's AuthInfo; a TURN relay credential is an AuthInfo on the core too. */
    private fun sipAuthInfo() = authInfos.single { it.username == SIP_USERNAME }

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
        val created = sipAuthInfo()
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

    // ---- #1188: TLS trust, media encryption, ICE ----
    //
    // Each of the three asserts the defect it fixes: SRTP mandated against a DTLS endpoint,
    // a TLS chain with nothing to verify it against, and iceServers parsed then dropped.

    @Test
    fun `TLS chain and hostname are verified for every registration`() {
        shiftsViewModel().clockIn()

        // Registration is over TLS and these are the checks whose absence turned a self-signed
        // PBX certificate into `tlsv1 alert unknown ca`. They are never switched off: the fix is
        // to give the client something to verify AGAINST, below.
        verify { core.verifyServerCertificates(true) }
        verify { core.verifyServerCn(true) }
        verify(exactly = 0) { core.verifyServerCertificates(false) }
        verify(exactly = 0) { core.verifyServerCn(false) }
    }

    @Test
    fun `the server-published trust anchor becomes the core's root CA`() {
        shiftsViewModel().clockIn()

        // setRootCaData REPLACES the trust store, which is the point: for a self-hosted PBX the
        // correct anchor set is exactly this one certificate, so a public CA mis-issuing for the
        // PBX hostname buys an adversary nothing.
        assertEquals(listOf(TRUST_ANCHOR_PEM), installedRootCas)
        assertEquals(setOf(HUB_A, HUB_B), linphoneService.registeredHubIds())
    }

    @Test
    fun `the trust anchor is installed once for hubs sharing an identity`() {
        shiftsViewModel().clockIn()
        assertEquals(1, installedRootCas.size)
    }

    @Test
    fun `a token with no trust anchor registers against the device trust store, still verifying`() {
        sipTokenResponse = sipTokenOk(trustAnchor = null)

        shiftsViewModel().clockIn()

        // A deployment whose SIP edge holds a publicly-trusted certificate publishes no anchor;
        // the device's own roots are then correct and must not be replaced.
        assertTrue(installedRootCas.isEmpty())
        verify { core.verifyServerCertificates(true) }
        assertEquals(setOf(HUB_A, HUB_B), linphoneService.registeredHubIds())
    }

    @Test
    fun `an anchor carrying private key material is refused`() {
        sipTokenResponse = sipTokenOk(
            trustAnchor = "-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n" +
                "-----BEGIN PRIVATE KEY-----\ny\n-----END PRIVATE KEY-----\n",
        )
        val vm = shiftsViewModel()

        vm.clockIn()

        assertTrue(installedRootCas.isEmpty())
        assertEquals(emptySet<String>(), linphoneService.registeredHubIds())
        verify(exactly = 0) { core.addAccount(any()) }
        assertEquals(R.string.dashboard_error_in_app_calls_unavailable, vm.uiState.value.callSetupErrorRes)
    }

    @Test
    fun `an anchor that is not a certificate is refused`() {
        sipTokenResponse = sipTokenOk(trustAnchor = "not a pem at all")
        val vm = shiftsViewModel()

        vm.clockIn()

        assertTrue(installedRootCas.isEmpty())
        assertEquals(emptySet<String>(), linphoneService.registeredHubIds())
    }

    @Test
    fun `the media encryption the server issued is what gets applied, and stays mandatory`() {
        shiftsViewModel().clockIn()

        // The server provisions `media_encryption: dtls` on the PJSIP endpoint and says so in
        // the token. Hardcoding SRTP here — which is what shipped — could not negotiate with it.
        assertTrue("DTLS applied", appliedEncryptions.contains(MediaEncryption.DTLS))
        assertFalse("SRTP never applied for a dtls-srtp credential", appliedEncryptions.contains(MediaEncryption.SRTP))
        assertTrue(core.isMediaEncryptionMandatory)
    }

    @Test
    fun `an SRTP credential applies SRTP, not the default`() {
        sipTokenResponse = sipTokenOk(mediaEncryption = "srtp")

        shiftsViewModel().clockIn()

        assertEquals(MediaEncryption.SRTP, appliedEncryptions.last())
        assertTrue(core.isMediaEncryptionMandatory)
    }

    @Test
    fun `a credential asking for unencrypted media is refused`() {
        sipTokenResponse = sipTokenOk(mediaEncryption = "none")
        val vm = shiftsViewModel()

        vm.clockIn()

        // Not a fallback to plaintext and not a fallback to mandatory-off: no registration.
        assertEquals(emptySet<String>(), linphoneService.registeredHubIds())
        verify(exactly = 0) { core.addAccount(any()) }
        assertEquals(R.string.dashboard_error_in_app_calls_unavailable, vm.uiState.value.callSetupErrorRes)
    }

    @Test
    fun `an unrecognised media encryption is refused`() {
        sipTokenResponse = sipTokenOk(mediaEncryption = "sframe-someday")

        shiftsViewModel().clockIn()

        assertEquals(emptySet<String>(), linphoneService.registeredHubIds())
        verify(exactly = 0) { core.addAccount(any()) }
    }

    @Test
    fun `an algorithm liblinphone cannot do is refused rather than downgraded`() {
        every { core.isMediaEncryptionSupported(MediaEncryption.DTLS) } returns false

        shiftsViewModel().clockIn()

        assertEquals(emptySet<String>(), linphoneService.registeredHubIds())
        verify(exactly = 0) { core.addAccount(any()) }
    }

    @Test
    fun `issued ICE servers become the account's NAT policy with ICE, STUN and TURN enabled`() {
        shiftsViewModel().clockIn()

        // Before this, iceServers was deserialised and dropped: no policy at all, so liblinphone
        // offered host candidates only.
        val policy = natPolicies.single()
        verify { policy.isIceEnabled = true }
        verify { policy.isStunEnabled = true }
        verify { policy.isTurnEnabled = true }
        // The TURN host wins over the STUN host when they differ: the relay candidate is the one
        // a symmetric-NAT volunteer cannot do without.
        verify { policy.stunServer = TURN_HOST }
        verify { policy.stunServerUsername = TURN_USERNAME }
        verify { policy.isUdpTurnTransportEnabled = true }
        verify { policy.isTcpTurnTransportEnabled = true }
        verify { accountParams.single().natPolicy = policy }
    }

    @Test
    fun `the TURN credential reaches liblinphone as an AuthInfo keyed on the TURN username`() {
        shiftsViewModel().clockIn()

        val turnAuth = authInfos.single { it.username == TURN_USERNAME }
        assertEquals(TURN_USERNAME, turnAuth.userId)
        assertEquals(TURN_CREDENTIAL, turnAuth.password)
        verify { core.addAuthInfo(turnAuth.authInfo) }
    }

    @Test
    fun `clocking out drops the TURN credential with the SIP one`() {
        val vm = shiftsViewModel()
        vm.clockIn()
        val turnAuth = authInfos.single { it.username == TURN_USERNAME }

        vm.clockOut()

        verify { core.removeAuthInfo(turnAuth.authInfo) }
    }

    @Test
    fun `STUN-only ICE servers enable ICE and STUN but not TURN`() {
        sipTokenResponse = sipTokenOk(iceServers = STUN_ONLY_ICE_SERVERS)

        shiftsViewModel().clockIn()

        // The honest no-relay case: the server says so when TURN_HOST/TURN_SECRET are unset, and
        // a symmetric-NAT volunteer is then reachable by phone only.
        val policy = natPolicies.single()
        verify { policy.isIceEnabled = true }
        verify { policy.stunServer = "$SIP_DOMAIN:3478" }
        verify(exactly = 0) { policy.isTurnEnabled = true }
        assertTrue(authInfos.none { it.username == TURN_USERNAME })
    }

    @Test
    fun `no ICE servers means no NAT policy rather than an empty one`() {
        sipTokenResponse = sipTokenOk(iceServers = "[]")

        shiftsViewModel().clockIn()

        assertTrue(natPolicies.isEmpty())
        verify { accountParams.single().natPolicy = null }
        assertEquals(setOf(HUB_A, HUB_B), linphoneService.registeredHubIds())
    }

    @Test
    fun `rotated credentials rebuild the NAT policy so the relay keeps working`() {
        shiftsViewModel().clockIn()
        val first = natPolicies.single()

        // A renewed token: same SIP identity, a fresh TURN credential.
        linphoneService.registerHubAccount(
            HUB_A,
            sipParams(SIP_USERNAME, SIP_PASSWORD).copy(
                iceServers = listOf(
                    SipIceServer("stun:$TURN_HOST"),
                    SipIceServer("turn:$TURN_HOST?transport=udp", "9999999999:$SIP_USERNAME", "bmV3"),
                ),
            ),
        )

        assertEquals(2, natPolicies.size)
        val second = natPolicies.last()
        assertTrue(first !== second)
        verify { second.stunServerUsername = "9999999999:$SIP_USERNAME" }
        verify { clonedAccountParams.single().natPolicy = second }
    }

    // ---- #1188: the runtime RECORD_AUDIO grant ----

    @Test
    fun `a refused microphone clocks in but leaves this device unregistered`() {
        val vm = shiftsViewModel()

        vm.clockIn(microphoneGranted = false)

        // The clock-in itself still happens — the volunteer keeps taking phone calls.
        assertTrue(requests.contains("POST /api/hubs/$HUB_A/shifts/clock-in"))
        // But this device is deliberately NOT put into parallel ringing: ringing a device that
        // cannot capture audio only takes the call away from a volunteer who could answer it.
        assertEquals(emptySet<String>(), linphoneService.registeredHubIds())
        verify(exactly = 0) { core.addAccount(any()) }
        assertTrue(requests.none { it == "GET /api/telephony/sip-token" })
        assertEquals(R.string.incoming_call_microphone_required, vm.uiState.value.callSetupErrorRes)
    }

    @Test
    fun `retrying call setup without the microphone is refused, not retried`() {
        val vm = shiftsViewModel()

        vm.retryCallSetup(microphoneGranted = false)

        assertEquals(emptySet<String>(), linphoneService.registeredHubIds())
        assertTrue(requests.none { it == "GET /api/telephony/sip-token" })
        assertEquals(R.string.incoming_call_microphone_required, vm.uiState.value.callSetupErrorRes)
    }

    @Test
    fun `a granted microphone registers as before`() {
        val vm = shiftsViewModel()

        vm.clockIn(microphoneGranted = true)

        assertEquals(setOf(HUB_A, HUB_B), linphoneService.registeredHubIds())
        assertNull(vm.uiState.value.callSetupErrorRes)
    }

    @Test
    fun `dashboard clockIn without the microphone registers nothing`() {
        val vm = dashboardViewModel()

        vm.clockIn(microphoneGranted = false)

        assertEquals(emptySet<String>(), linphoneService.registeredHubIds())
        verify(exactly = 0) { core.addAccount(any()) }
        assertEquals(R.string.incoming_call_microphone_required, vm.uiState.value.errorRes)
    }

    // ---- Core-global settings vs multiple hubs ----

    @Test
    fun `a hub needing different media encryption is refused, not imposed on a live one`() {
        shiftsViewModel().clockIn()
        val liveHubs = linphoneService.registeredHubIds()
        assertEquals(setOf(HUB_A, HUB_B), liveHubs)

        // liblinphone has ONE media-encryption setting for every account, so honouring a
        // newcomer would silently break the media leg of a hub already answering calls.
        val conflicting = sipParams("vol_other", "pw").copy(mediaEncryption = "srtp")
        val failure = runCatching { linphoneService.registerHubAccount("hub-c", conflicting) }
        assertTrue("expected a refusal, got ${failure.getOrNull()}", failure.isFailure)
        assertEquals("the live hubs keep their registration", liveHubs, linphoneService.registeredHubIds())
    }

    @Test
    fun `a hub publishing a different trust anchor is refused, not imposed on a live one`() {
        shiftsViewModel().clockIn()
        val liveHubs = linphoneService.registeredHubIds()

        val other = sipParams("vol_other", "pw").copy(
            tlsTrustAnchorPem = "-----BEGIN CERTIFICATE-----\nT3RoZXI=\n-----END CERTIFICATE-----\n",
        )
        val failure = runCatching { linphoneService.registerHubAccount("hub-c", other) }
        assertTrue("expected a refusal, got ${failure.getOrNull()}", failure.isFailure)
        assertEquals(liveHubs, linphoneService.registeredHubIds())
        // The store the live registration verifies against is untouched.
        assertEquals(listOf(TRUST_ANCHOR_PEM), installedRootCas)
    }

    // ---- ICE server URI parsing (RFC 7064/7065: no "//", so a URL parser mis-reads them) ----

    @Test
    fun `STUN and TURN URIs parse into scheme, host-port and transport`() {
        val stun = SipIceServer("stun:turn.example.org:3478")
        assertEquals("stun", stun.scheme)
        assertEquals("turn.example.org:3478", stun.hostAndPort)
        assertNull(stun.turnTransport)
        assertFalse(stun.isTurnRelay)

        val turn = SipIceServer("turn:turn.example.org:3478?transport=tcp", "1700000000:vol_x", "pw")
        assertEquals("turn", turn.scheme)
        assertEquals("turn.example.org:3478", turn.hostAndPort)
        assertEquals("tcp", turn.turnTransport)
        assertTrue(turn.isTurnRelay)
        assertEquals(1_700_000_000L, turn.turnCredentialExpiresAt)

        // A relay with no credential is not a relay: liblinphone would allocate nothing.
        assertFalse(SipIceServer("turn:turn.example.org:3478").isTurnRelay)
    }

    @Test
    fun `the soonest TURN expiry is the one the client renews against`() {
        val params = sipParams(SIP_USERNAME, SIP_PASSWORD).copy(
            iceServers = listOf(
                SipIceServer("stun:$TURN_HOST"),
                SipIceServer("turn:$TURN_HOST?transport=udp", "2000000000:vol_x", "pw"),
                SipIceServer("turn:$TURN_HOST?transport=tcp", "1900000000:vol_x", "pw"),
            ),
        )
        assertEquals(1_900_000_000L, params.turnCredentialExpiresAt)
        assertNull(sipParams(SIP_USERNAME, SIP_PASSWORD).turnCredentialExpiresAt)
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
            mockk<HubRepository>(relaxed = true),
        )
    }

    @Test
    fun `dashboard clockIn registers every member hub`() {
        val vm = dashboardViewModel()

        vm.clockIn()

        assertEquals(setOf(HUB_A, HUB_B), linphoneService.registeredHubIds())
        assertEquals(SIP_PASSWORD, sipAuthInfo().password)
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
        val authInfo = sipAuthInfo().authInfo

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
        // The ring path (main's inbound-calling feature) reads these on IncomingReceived.
        every { call.remoteAddress } returns mockk<Address>(relaxed = true)
        every { call.toAddress } returns mockk<Address>(relaxed = true)
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

        /** A TURN credential's expiry, far enough out that the renewal timer never fires here. */
        const val TURN_EXPIRY = 4_000_000_000L
        const val TURN_USERNAME = "$TURN_EXPIRY:$SIP_USERNAME"
        const val TURN_CREDENTIAL = "dHVybi1jcmVkZW50aWFs"
        const val TURN_HOST = "turn.example.org:3478"

        /**
         * A certificate-shaped PEM. Only its structure matters here — liblinphone is mocked, so
         * nothing parses it — but it has to be structurally what the server publishes, because
         * the service refuses anything that is not a certificate.
         */
        val TRUST_ANCHOR_PEM = "-----BEGIN CERTIFICATE-----\nMIIBtestanchor\n-----END CERTIFICATE-----\n"

        /** CoTURN's ICE servers as `telephony/registrar.ts` mints them: STUN + TURN udp/tcp. */
        val TURN_ICE_SERVERS = """
            [{"url":"stun:$TURN_HOST"},
             {"url":"turn:$TURN_HOST?transport=udp","username":"$TURN_USERNAME",
              "credential":"$TURN_CREDENTIAL"},
             {"url":"turn:$TURN_HOST?transport=tcp","username":"$TURN_USERNAME",
              "credential":"$TURN_CREDENTIAL"}]
        """.trimIndent()

        /** What the server sends when TURN_HOST/TURN_SECRET are unset: honest STUN only. */
        val STUN_ONLY_ICE_SERVERS = """[{"url":"stun:$SIP_DOMAIN:3478"}]"""

        private fun jsonString(value: String): String =
            "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n") + "\""

        /**
         * The shape `apps/worker/telephony/registrar.ts` actually returns for `provider:
         * asterisk`: TLS transport, DTLS-SRTP (matching the `media_encryption: dtls` it
         * provisions on the PJSIP endpoint), CoTURN ICE servers with time-limited credentials,
         * and the SIP edge's public TLS trust anchor.
         */
        fun sipTokenOk(
            mediaEncryption: String = "dtls-srtp",
            iceServers: String = TURN_ICE_SERVERS,
            trustAnchor: String? = TRUST_ANCHOR_PEM,
        ): MockResponse {
            val anchor = trustAnchor?.let { ",\"tlsTrustAnchorPem\":${jsonString(it)}" } ?: ""
            return MockResponse().setBody(
                "{\"provider\":\"asterisk\",\"sip\":{" +
                    "\"domain\":\"$SIP_DOMAIN\",\"transport\":\"tls\"," +
                    "\"username\":\"$SIP_USERNAME\",\"password\":\"$SIP_PASSWORD\"," +
                    "\"iceServers\":$iceServers," +
                    "\"mediaEncryption\":\"$mediaEncryption\"$anchor}}",
            )
        }

        fun sipParams(username: String, password: String) = SipAccountParams(
            domain = SIP_DOMAIN,
            transport = "tls",
            username = username,
            password = password,
            mediaEncryption = "dtls-srtp",
            tlsTrustAnchorPem = TRUST_ANCHOR_PEM,
        )
    }
}
