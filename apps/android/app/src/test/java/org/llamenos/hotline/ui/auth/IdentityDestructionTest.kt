package org.llamenos.hotline.ui.auth

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.llamenos.hotline.FakeBiometricKeyStore
import org.llamenos.hotline.InMemoryKeyValueStore
import org.llamenos.hotline.api.WebSocketService
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.crypto.KeystoreService
import org.llamenos.hotline.mockPushRegistrationManager
import org.llamenos.hotline.screenshots.ScreenshotTestApp
import org.llamenos.hotline.ui.dashboard.DashboardScreen
import org.llamenos.hotline.ui.dashboard.DashboardUiState
import org.llamenos.hotline.ui.dashboard.DashboardViewModel
import org.llamenos.hotline.ui.notes.NotesUiState
import org.llamenos.hotline.ui.notes.NotesViewModel
import org.llamenos.hotline.ui.settings.TestSettingsScreen
import org.llamenos.hotline.ui.theme.LlamenosTheme
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * #2123: destroying the device identity must be impossible without the user confirming.
 *
 * Before the fix the dashboard top bar's Log Out icon destroyed the device key on a single
 * tap while Settings → Log Out asked first, so the confirmation lived in one screen instead
 * of in the action. These tests drive the real screens against a real [AuthViewModel] over
 * an in-memory key store and assert on what is actually stored, not on a callback firing.
 *
 * Runs on the JVM via Robolectric — the same harness as the screenshot tests.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = ScreenshotTestApp::class, qualifiers = "w411dp-h891dp-xxhdpi")
class IdentityDestructionTest {

    @get:Rule
    val composeRule = createComposeRule()

    private lateinit var cryptoService: CryptoService
    private lateinit var keyValueStore: InMemoryKeyValueStore
    private lateinit var viewModel: AuthViewModel

    /** Whether the device keys were still stored at each moment the relay was closed. */
    private val keysStoredAtRelayClose = mutableListOf<Boolean>()

    @Before
    fun setUp() {
        cryptoService = CryptoService()
        keyValueStore = InMemoryKeyValueStore()
        keyValueStore.store(KeystoreService.KEY_ENCRYPTED_KEYS, "{}")
        keyValueStore.store(KeystoreService.KEY_SIGNING_PUBKEY, "testpub")
        cryptoService.setTestKeyState("a".repeat(64), "b".repeat(64), "test-device-id")
        viewModel = AuthViewModel(
            cryptoService,
            keyValueStore,
            FakeBiometricKeyStore(),
            mockk(),
            mockk(relaxed = true),
            mockPushRegistrationManager(),
            mockk<WebSocketService> {
                every { disconnect() } answers {
                    keysStoredAtRelayClose += keyValueStore.contains(KeystoreService.KEY_ENCRYPTED_KEYS)
                }
            },
        )
    }

    private fun assertKeysPresent() {
        assertTrue(keyValueStore.contains(KeystoreService.KEY_ENCRYPTED_KEYS))
        assertTrue(keyValueStore.contains(KeystoreService.KEY_SIGNING_PUBKEY))
    }

    private fun assertKeysDestroyed() {
        assertFalse(keyValueStore.contains(KeystoreService.KEY_ENCRYPTED_KEYS))
        assertFalse(keyValueStore.contains(KeystoreService.KEY_SIGNING_PUBKEY))
    }

    // ---- Dashboard top bar: the icon asks first (#2123) ----

    private fun setDashboard() {
        val dashboardViewModel = mockk<DashboardViewModel>(relaxed = true)
        every { dashboardViewModel.uiState } returns MutableStateFlow(DashboardUiState())
        val notesViewModel = mockk<NotesViewModel>(relaxed = true)
        every { notesViewModel.uiState } returns MutableStateFlow(NotesUiState())

        composeRule.setContent {
            LlamenosTheme {
                DashboardScreen(
                    viewModel = dashboardViewModel,
                    notesViewModel = notesViewModel,
                    onLock = {},
                    onLogout = { viewModel.destroyIdentity(it) },
                    onNavigateToNotes = {},
                    onNavigateToNoteCreate = { _, _ -> },
                    onNavigateToNoteDetail = {},
                    onNavigateToCallHistory = {},
                    onNavigateToReports = {},
                    onNavigateToContacts = {},
                    onNavigateToCases = {},
                    onNavigateToBlasts = {},
                    onNavigateToHelp = {},
                )
            }
        }
    }

    @Test
    fun `one tap on the dashboard log out icon leaves the keys in place`() {
        setDashboard()

        composeRule.onNodeWithTag("logout-button").performClick()

        composeRule.onNodeWithTag("logout-confirmation-dialog").assertIsDisplayed()
        assertKeysPresent()
    }

    @Test
    fun `cancelling the dashboard log out dialog keeps the keys`() {
        setDashboard()

        composeRule.onNodeWithTag("logout-button").performClick()
        composeRule.onNodeWithTag("cancel-logout-button").performClick()

        composeRule.onNodeWithTag("logout-confirmation-dialog").assertDoesNotExist()
        assertKeysPresent()
    }

    @Test
    fun `confirming the dashboard log out dialog destroys the keys`() {
        setDashboard()

        composeRule.onNodeWithTag("logout-button").performClick()
        composeRule.onNodeWithTag("confirm-logout-button").performClick()

        assertKeysDestroyed()
    }

    // ---- Settings → Log Out: asks first, destroys only on confirm ----

    @Test
    fun `settings log out keeps the keys until the dialog is confirmed`() {
        composeRule.setContent {
            TestSettingsScreen(onLogout = { viewModel.destroyIdentity(it) })
        }

        composeRule.onNodeWithTag("settings-logout-button").performScrollTo().performClick()

        composeRule.onNodeWithTag("logout-confirmation-dialog").assertIsDisplayed()
        assertKeysPresent()

        composeRule.onNodeWithTag("confirm-logout-button").performClick()

        composeRule.onNodeWithTag("logout-confirmation-dialog").assertDoesNotExist()
        assertKeysDestroyed()
    }

    /**
     * #2527: the relay must be closed BEFORE the identity is cleared. Closed only when the
     * unlocked screens were later popped, a relay handshake still in flight at logout
     * completed for the destroyed identity, announced CONNECTED, and its listeners re-read
     * the server with no hub URL — which crashed the app (the M1 probe's `logout` flow).
     */
    @Test
    fun `confirming log out closes the relay while the identity still exists`() {
        composeRule.setContent {
            TestSettingsScreen(onLogout = { viewModel.destroyIdentity(it) })
        }

        composeRule.onNodeWithTag("settings-logout-button").performScrollTo().performClick()
        assertEquals(emptyList<Boolean>(), keysStoredAtRelayClose)

        composeRule.onNodeWithTag("confirm-logout-button").performClick()

        assertEquals(listOf(true), keysStoredAtRelayClose)
        assertKeysDestroyed()
    }

    @Test
    fun `cancelling the log out dialog keeps the keys and closes it`() {
        composeRule.setContent {
            TestSettingsScreen(onLogout = { viewModel.destroyIdentity(it) })
        }

        composeRule.onNodeWithTag("settings-logout-button").performScrollTo().performClick()
        composeRule.onNodeWithTag("cancel-logout-button").performClick()

        composeRule.onNodeWithTag("logout-confirmation-dialog").assertDoesNotExist()
        assertKeysPresent()
    }

    @Test
    fun `settings emergency wipe keeps the keys until the dialog is confirmed`() {
        composeRule.setContent {
            TestSettingsScreen(onPanicWipe = { viewModel.destroyIdentity(it) })
        }

        composeRule.onNodeWithTag("settings-panic-wipe-button").performScrollTo().performClick()

        composeRule.onNodeWithTag("panic-wipe-dialog").assertIsDisplayed()
        assertKeysPresent()

        composeRule.onNodeWithTag("confirm-panic-wipe-button").performClick()

        assertKeysDestroyed()
    }

    // ---- PIN screen: Reset Identity asks first ----

    private fun setUnlockScreen(onResetIdentity: () -> Unit) {
        composeRule.mainClock.autoAdvance = true
        composeRule.setContent {
            LlamenosTheme {
                PINUnlockScreen(
                    viewModel = viewModel,
                    onAuthenticated = {},
                    onResetIdentity = onResetIdentity,
                )
            }
        }
        // The action row is revealed by an AnimatedVisibility with entrance delays.
        composeRule.mainClock.advanceTimeBy(1_000)
        composeRule.waitForIdle()
    }

    @Test
    fun `reset identity on the PIN screen keeps the keys until the dialog is confirmed`() {
        var resets = 0
        setUnlockScreen(onResetIdentity = { resets++ })

        composeRule.onNodeWithTag("reset-identity").performClick()

        composeRule.onNodeWithTag("reset-identity-dialog").assertIsDisplayed()
        assertKeysPresent()
        assertEquals(0, resets)

        composeRule.onNodeWithTag("confirm-reset-identity-button").performClick()

        assertKeysDestroyed()
        assertEquals(1, resets)
    }

    @Test
    fun `cancelling reset identity keeps the keys`() {
        var resets = 0
        setUnlockScreen(onResetIdentity = { resets++ })

        composeRule.onNodeWithTag("reset-identity").performClick()
        composeRule.onNodeWithTag("cancel-reset-identity-button").performClick()

        composeRule.onNodeWithTag("reset-identity-dialog").assertDoesNotExist()
        assertKeysPresent()
        assertEquals(0, resets)
    }

    // ---- The one non-confirmed clear: residue of a lockout wipe that already happened ----

    @Test
    fun `acknowledging a lockout wipe does nothing when no wipe happened`() {
        viewModel.acknowledgeLockoutWipe()

        assertKeysPresent()
    }
}
