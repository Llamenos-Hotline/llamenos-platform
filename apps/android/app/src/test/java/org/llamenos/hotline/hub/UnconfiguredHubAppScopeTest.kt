package org.llamenos.hotline.hub

import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.llamenos.hotline.InMemoryKeyValueStore
import org.llamenos.hotline.api.ApiService
import org.llamenos.hotline.api.HubNotConfiguredException
import org.llamenos.hotline.api.WebSocketService
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.crypto.WakeKeyService
import org.llamenos.hotline.model.LlamenosEvent
import org.llamenos.hotline.service.AttributedHubEvent
import org.llamenos.hotline.service.DeviceRegistrationManager
import org.llamenos.hotline.service.PushRegistrationManager
import org.llamenos.hotline.service.UnifiedPushGateway
import org.llamenos.hotline.telephony.LinphoneService
import org.llamenos.hotline.telephony.SipRegistrar
import java.io.IOException

/**
 * #2745. The singletons that run on the application scope outlive the session. Logout wipes
 * the hub URL, so a relay reconnect, an incident doorbell or a registration retry that lands
 * afterwards reaches [ApiService.getBaseUrl] with nothing configured. On the application scope
 * there is no exception handler: whatever escapes the collector takes the process down, on
 * the logout path (#2743).
 *
 * These tests use a REAL, unconfigured [ApiService] — not a mock that throws a hand-picked
 * exception — so they pin what `getBaseUrl()` actually throws against what each collector
 * actually catches. The scope below mirrors the production one (`SupervisorJob`, no handler
 * of its own): an exception that escapes a `launch` lands in [uncaught], which is the
 * process crash.
 *
 * Audit of every `@ApplicationScope` user that reaches [ApiService]:
 * - [IncidentRepository]: catches ApiException / IOException / SerializationException — safe
 *   only because the missing URL is an [IOException]. It was the one that crashed.
 * - [SipRegistrar], [DeviceRegistrationManager], [PushRegistrationManager]: catch `Exception`.
 * - `ActiveHubState` and `LinphoneService` never call [ApiService].
 * The scopes owned by `WebSocketService` and `OfflineQueue` wrap their calls in
 * `catch (Exception)` / `catch (IOException)`; `PushService` and `CrashReporter` never reach
 * [ApiService] from a launched coroutine.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class UnconfiguredHubAppScopeTest {

    private val dispatcher = UnconfinedTestDispatcher()
    private val uncaught = mutableListOf<Throwable>()
    private val appScope = CoroutineScope(
        SupervisorJob() + dispatcher + CoroutineExceptionHandler { _, t -> uncaught += t },
    )

    /** Real ApiService; the keystore holds no hub URL, as after logout. */
    private val apiService = ApiService(
        authInterceptor = mockk(relaxed = true),
        retryInterceptor = mockk(relaxed = true),
        keystoreService = InMemoryKeyValueStore(),
        activeHubState = mockk<ActiveHubState>(relaxed = true),
    ).also { it.ioDispatcher = dispatcher }

    private val events = MutableSharedFlow<AttributedHubEvent<LlamenosEvent>>()
    private val connection = MutableStateFlow(WebSocketService.ConnectionState.CONNECTED)
    private val webSocketService = mockk<WebSocketService> {
        every { typedEvents } returns events
        every { connectionState } returns connection
    }

    @After
    fun tearDown() {
        appScope.cancel()
    }

    @Test
    fun `an unconfigured hub is a typed IOException, not a bare IllegalStateException`() = runTest(dispatcher) {
        val failure = runCatching { apiService.getHubs() }.exceptionOrNull()

        assertTrue("expected HubNotConfiguredException, got $failure", failure is HubNotConfiguredException)
        assertTrue("callers that survive network loss must survive this", failure is IOException)
    }

    @Test
    fun `incident reads after logout do not crash the process`() = runTest(dispatcher) {
        val repository = IncidentRepository(apiService, webSocketService, appScope)

        // beginSession's first read, then a reconnect, then a doorbell: every path the
        // repository launches onto the application scope.
        repository.beginSession()
        connection.value = WebSocketService.ConnectionState.DISCONNECTED
        connection.value = WebSocketService.ConnectionState.CONNECTED
        events.emit(AttributedHubEvent("hub-A", LlamenosEvent.HubIncidentChanged("inc-A", "opened")))

        assertEquals("nothing may escape onto the application scope", emptyList<Throwable>(), uncaught)
        assertTrue(repository.state.value.incidents.isEmpty())
    }

    @Test
    fun `device registration after logout does not crash the process`() = runTest(dispatcher) {
        val crypto = CryptoService().also { it.setTestKeyState("a".repeat(64), "b".repeat(64), "device-1") }
        val manager = DeviceRegistrationManager(apiService, crypto, appScope)

        manager.ensureRegistered()

        assertEquals(emptyList<Throwable>(), uncaught)
        assertTrue(manager.register().exceptionOrNull() is HubNotConfiguredException)
    }

    @Test
    fun `push endpoint mirroring after logout does not crash the process`() = runTest(dispatcher) {
        val crypto = CryptoService().also { it.setTestKeyState("a".repeat(64), "b".repeat(64), "device-1") }
        val manager = PushRegistrationManager(
            gateway = mockk<UnifiedPushGateway>(relaxed = true),
            apiService = apiService,
            keystoreService = InMemoryKeyValueStore(),
            wakeKeyService = mockk<WakeKeyService>(relaxed = true),
            cryptoService = crypto,
            scope = appScope,
        )

        manager.onNewEndpoint("https://push.example/topic")
        manager.onUnregistered()

        assertEquals(emptyList<Throwable>(), uncaught)
    }

    @Test
    fun `sip registration after logout reports a failure instead of throwing`() = runTest(dispatcher) {
        val registrar = SipRegistrar(apiService, mockk<LinphoneService>(relaxed = true), appScope)

        val result = registrar.registerMemberHubs()

        assertTrue("expected Failed, got $result", result is SipRegistrar.Result.Failed)
        assertTrue((result as SipRegistrar.Result.Failed).cause is HubNotConfiguredException)
        assertEquals(emptyList<Throwable>(), uncaught)
    }
}
