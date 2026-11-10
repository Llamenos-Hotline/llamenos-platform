package org.llamenos.hotline.ui

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.llamenos.hotline.FakeBiometricKeyStore
import org.llamenos.hotline.InMemoryKeyValueStore
import org.llamenos.hotline.api.InviteRepository
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.crypto.KeystoreService
import org.llamenos.hotline.screenshots.ScreenshotTestApp
import org.llamenos.hotline.service.DeviceRegistrationManager
import org.llamenos.hotline.service.PushRegistrationManager
import org.llamenos.hotline.ui.auth.AuthViewModel
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Regression tests for the session-lock navigation effect (#1339, #1535).
 *
 * The 5-minute background auto-lock in `MainActivity.onStart` only calls
 * [CryptoService.lock]; everything the user sees — the authenticated flag
 * cleared, the current screen replaced by the PIN unlock screen — is this
 * effect's reaction to `unlockedState` going false. Before #1339 the lock
 * path never cleared `isAuthenticated` and the dashboard stayed up; #1535 is
 * the same gap reached through the auto-lock trigger.
 *
 * Runs on the JVM via Robolectric with a mocked [CryptoService]: the native
 * library cannot load here, so `lock()` is stubbed to flip the same flow the
 * real implementation flips.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = ScreenshotTestApp::class)
class SessionLockEffectTest {

    @get:Rule
    val composeRule = createComposeRule()

    private lateinit var navController: NavHostController
    private lateinit var unlockedFlow: MutableStateFlow<Boolean>
    private lateinit var cryptoService: CryptoService
    private lateinit var keystore: KeystoreService
    private lateinit var keyValueStore: InMemoryKeyValueStore
    private lateinit var authViewModel: AuthViewModel

    @Before
    fun setup() {
        unlockedFlow = MutableStateFlow(true)
        cryptoService = mockk()
        every { cryptoService.unlockedState } returns unlockedFlow

        keystore = mockk(relaxed = true)
        keyValueStore = InMemoryKeyValueStore()
        authViewModel = AuthViewModel(
            cryptoService,
            keyValueStore,
            FakeBiometricKeyStore(),
            mockk<InviteRepository>(relaxed = true),
            mockk<DeviceRegistrationManager>(relaxed = true),
            mockk<PushRegistrationManager>(relaxed = true),
        )
    }

    /** Simulate an unlocked session: stored keys exist and the user is authenticated. */
    private fun simulateAuthenticatedSession() {
        keyValueStore.store(KeystoreService.KEY_ENCRYPTED_KEYS, "{}")
        every { keystore.contains(KeystoreService.KEY_ENCRYPTED_KEYS) } returns true
        authViewModel.skipEnrollment()
        assertTrue(authViewModel.uiState.value.isAuthenticated)
    }

    /** What every lock trigger does — the Lock button and MainActivity's auto-lock alike. */
    private fun lock() {
        unlockedFlow.value = false
    }

    private fun mount(startRoute: String) {
        composeRule.setContent {
            navController = rememberNavController()
            NavHost(navController = navController, startDestination = startRoute) {
                composable(LlamenosRoute.Login.route) { }
                composable(LlamenosRoute.PINSet.route) { }
                composable(LlamenosRoute.PINUnlock.route) { }
                composable(LlamenosRoute.Main.route) { }
                composable(LlamenosRoute.NoteDetail.ROUTE_PATTERN) { }
            }
            SessionLockEffect(
                navController = navController,
                cryptoService = cryptoService,
                authViewModel = authViewModel,
                keystoreService = keystore,
            )
        }
        composeRule.waitForIdle()
    }

    private fun awaitRoute(route: String) {
        composeRule.waitUntil(timeoutMillis = 5_000) {
            navController.currentDestination?.route == route
        }
    }

    @Test
    fun `auto-lock on the main screen clears auth state and shows PIN unlock`() {
        simulateAuthenticatedSession()
        mount(LlamenosRoute.Main.route)
        assertEquals(LlamenosRoute.Main.route, navController.currentDestination?.route)

        lock()

        awaitRoute(LlamenosRoute.PINUnlock.route)
        assertFalse(authViewModel.uiState.value.isAuthenticated)
        assertTrue(authViewModel.uiState.value.hasStoredKeys)
        // popUpTo(0) inclusive: no unlocked screen survives on the back stack.
        assertNull(navController.previousBackStackEntry)
    }

    @Test
    fun `auto-lock on a detail screen leaves it for PIN unlock`() {
        simulateAuthenticatedSession()
        mount(LlamenosRoute.Main.route)
        composeRule.runOnIdle { navController.navigate("note/note-1") }
        awaitRoute(LlamenosRoute.NoteDetail.ROUTE_PATTERN)

        lock()

        awaitRoute(LlamenosRoute.PINUnlock.route)
        assertFalse(authViewModel.uiState.value.isAuthenticated)
        assertNull(navController.previousBackStackEntry)
    }

    @Test
    fun `lock while already on an auth route changes nothing`() {
        simulateAuthenticatedSession()
        mount(LlamenosRoute.PINUnlock.route)

        lock()

        // The effect must not stack another unlock screen or touch auth state.
        composeRule.waitForIdle()
        assertEquals(LlamenosRoute.PINUnlock.route, navController.currentDestination?.route)
        assertTrue(authViewModel.uiState.value.isAuthenticated)
    }

    @Test
    fun `lock with no stored keys sends to login`() {
        every { keystore.contains(KeystoreService.KEY_ENCRYPTED_KEYS) } returns false
        authViewModel.skipEnrollment()
        mount(LlamenosRoute.Main.route)

        lock()

        awaitRoute(LlamenosRoute.Login.route)
        assertFalse(authViewModel.uiState.value.isAuthenticated)
    }
}
