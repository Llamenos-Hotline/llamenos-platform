package org.llamenos.hotline.service

import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.llamenos.hotline.InMemoryKeyValueStore
import org.llamenos.hotline.api.ApiService
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.crypto.WakeKeyService
import org.llamenos.hotline.model.RegisterDeviceRequest
import org.llamenos.hotline.model.VoipTokenRequest

/**
 * Fake [UnifiedPushGateway] — the real one wraps the connector's static API,
 * which needs an Android Context and an installed distributor.
 */
private class FakeUnifiedPushGateway : UnifiedPushGateway {
    var ackDistributorValue: String? = null
    var distributorsValue: List<String> = emptyList()
    var selectResult: Boolean = false
    var selectCalls = 0
    var registerCalls = 0
    var unregisterCalls = 0
    var throwOnSelect: Boolean = false

    override fun getAckDistributor(): String? = ackDistributorValue
    override fun getDistributors(): List<String> = distributorsValue

    override fun selectCurrentOrDefaultDistributor(): Boolean {
        selectCalls++
        if (throwOnSelect) throw IllegalStateException("package manager unavailable")
        return selectResult
    }

    override fun register() {
        registerCalls++
    }

    override fun unregister() {
        unregisterCalls++
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
class PushRegistrationManagerTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var gateway: FakeUnifiedPushGateway
    private lateinit var apiService: ApiService
    private lateinit var keystore: InMemoryKeyValueStore
    private lateinit var wakeKeyService: WakeKeyService
    private lateinit var cryptoService: CryptoService

    @Before
    fun setup() {
        gateway = FakeUnifiedPushGateway()
        apiService = mockk()
        keystore = InMemoryKeyValueStore()
        wakeKeyService = mockk()
        every { wakeKeyService.getOrCreateWakePublicKey() } returns "wake-public-key"
        cryptoService = CryptoService()
        cryptoService.setTestKeyState("a".repeat(64), "b".repeat(64), "device-1")
        coEvery { apiService.registerPushEndpoint(any()) } returns Unit
        coEvery { apiService.registerVoipToken(any()) } returns Unit
        coEvery { apiService.clearPushEndpoint(any()) } returns Unit
    }

    private fun createManager(): PushRegistrationManager = PushRegistrationManager(
        gateway,
        apiService,
        keystore,
        wakeKeyService,
        cryptoService,
        CoroutineScope(testDispatcher),
    )

    // ---- Distributor registration (Break 1: nothing ever called register) ----

    @Test
    fun `ensureRegistered selects current-or-default distributor and registers`() = runTest(testDispatcher) {
        gateway.selectResult = true
        val manager = createManager()

        manager.ensureRegistered()

        assertEquals(1, gateway.selectCalls)
        assertEquals(1, gateway.registerCalls)
        assertEquals(
            PushRegistrationManager.DistributorState.REGISTERED,
            manager.distributorState.value,
        )
    }

    @Test
    fun `ensureRegistered is hub-neutral and idempotent across calls`() = runTest(testDispatcher) {
        // Multi-hub axiom: registration is per-device. Repeated calls (login +
        // later unlock) must keep working and must not require any hub state.
        gateway.selectResult = true
        val manager = createManager()

        manager.ensureRegistered()
        manager.ensureRegistered()

        assertEquals(2, gateway.registerCalls)
        assertEquals(
            PushRegistrationManager.DistributorState.REGISTERED,
            manager.distributorState.value,
        )
    }

    @Test
    fun `ensureRegistered with no distributor installed surfaces NO_DISTRIBUTOR`() = runTest(testDispatcher) {
        gateway.selectResult = false
        val manager = createManager()

        manager.ensureRegistered()

        assertEquals(1, gateway.selectCalls)
        assertEquals(0, gateway.registerCalls)
        assertEquals(
            PushRegistrationManager.DistributorState.NO_DISTRIBUTOR,
            manager.distributorState.value,
        )
    }

    @Test
    fun `ensureRegistered recovers once a distributor appears`() = runTest(testDispatcher) {
        gateway.selectResult = false
        val manager = createManager()
        manager.ensureRegistered()
        assertEquals(PushRegistrationManager.DistributorState.NO_DISTRIBUTOR, manager.distributorState.value)

        // User installs ntfy, then retries from the dashboard warning.
        gateway.selectResult = true
        manager.ensureRegistered()

        assertEquals(1, gateway.registerCalls)
        assertEquals(PushRegistrationManager.DistributorState.REGISTERED, manager.distributorState.value)
    }

    // ---- Endpoint mirroring (Break 2: ring path reads voipToken only) ----

    @Test
    fun `onNewEndpoint mirrors endpoint to backend exactly once as both pushToken and voipToken`() =
        runTest(testDispatcher) {
            val manager = createManager()
            val url = "https://ntfy.example.com/upAbCdEf"

            manager.onNewEndpoint(url)

            coVerify(exactly = 1) {
                apiService.registerPushEndpoint(match<RegisterDeviceRequest> { it.pushToken == url })
            }
            // The incoming-call ring path (getVoipTokens) only reads voipToken —
            // without this call the device can never be rung (#955).
            coVerify(exactly = 1) {
                apiService.registerVoipToken(match<VoipTokenRequest> { it.voipToken == url && it.platform == "android" })
            }
        }

    @Test
    fun `onNewEndpoint stores the endpoint as the single local source of truth`() = runTest(testDispatcher) {
        val manager = createManager()
        manager.onNewEndpoint("https://ntfy.example.com/upTopic1")

        assertEquals("https://ntfy.example.com/upTopic1", keystore.retrieve("push-endpoint"))
    }

    @Test
    fun `endpoint rotation mirrors the new endpoint exactly once`() = runTest(testDispatcher) {
        val manager = createManager()

        manager.onNewEndpoint("https://ntfy.example.com/upOld")
        manager.onNewEndpoint("https://ntfy.example.com/upNew")

        coVerify(exactly = 1) {
            apiService.registerPushEndpoint(match<RegisterDeviceRequest> { it.pushToken == "https://ntfy.example.com/upOld" })
        }
        coVerify(exactly = 1) {
            apiService.registerPushEndpoint(match<RegisterDeviceRequest> { it.pushToken == "https://ntfy.example.com/upNew" })
        }
        coVerify(exactly = 1) {
            apiService.registerVoipToken(match<VoipTokenRequest> { it.voipToken == "https://ntfy.example.com/upOld" })
        }
        coVerify(exactly = 1) {
            apiService.registerVoipToken(match<VoipTokenRequest> { it.voipToken == "https://ntfy.example.com/upNew" })
        }
        assertEquals("https://ntfy.example.com/upNew", keystore.retrieve("push-endpoint"))
    }

    @Test
    fun `failed backend mirror is retried by the next ensureRegistered`() = runTest(testDispatcher) {
        var failFirst = true
        coEvery { apiService.registerVoipToken(any()) } answers {
            if (failFirst) throw RuntimeException("backend unreachable") else Unit
        }
        gateway.selectResult = true
        val manager = createManager()

        manager.onNewEndpoint("https://ntfy.example.com/upRetry")
        coVerify(exactly = 1) { apiService.registerVoipToken(any()) }

        failFirst = false
        manager.ensureRegistered()

        coVerify(exactly = 2) { apiService.registerVoipToken(any()) }
        assertNull(keystore.retrieve("push-endpoint-backend-pending"))
    }

    @Test
    fun `successful mirror does not re-register on later ensureRegistered`() = runTest(testDispatcher) {
        gateway.selectResult = true
        val manager = createManager()

        manager.onNewEndpoint("https://ntfy.example.com/upDone")
        manager.ensureRegistered()
        manager.ensureRegistered()

        // The /register route is rate-limited (strict: 5/min) — a completed
        // mirror must not be repeated on every unlock.
        coVerify(exactly = 1) { apiService.registerPushEndpoint(any()) }
        coVerify(exactly = 1) { apiService.registerVoipToken(any()) }
    }

    // ---- Unregister + re-registration ----

    @Test
    fun `onUnregistered clears backend endpoint and re-registers`() = runTest(testDispatcher) {
        gateway.selectResult = true
        val manager = createManager()
        manager.onNewEndpoint("https://ntfy.example.com/upGone")

        manager.onUnregistered()

        coVerify(exactly = 1) { apiService.clearPushEndpoint("https://ntfy.example.com/upGone") }
        assertNull(keystore.retrieve("push-endpoint"))
        // Re-registration attempted (replacement/default distributor may exist).
        assertEquals(1, gateway.registerCalls)
    }

    @Test
    fun `onUnregistered without distributor surfaces NO_DISTRIBUTOR`() = runTest(testDispatcher) {
        gateway.selectResult = false
        val manager = createManager()
        manager.onNewEndpoint("https://ntfy.example.com/upGone")

        manager.onUnregistered()

        assertEquals(PushRegistrationManager.DistributorState.NO_DISTRIBUTOR, manager.distributorState.value)
    }
}
