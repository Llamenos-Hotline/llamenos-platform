package org.llamenos.hotline.ui.shifts

import android.app.Application
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.llamenos.hotline.InMemoryKeyValueStore
import org.llamenos.hotline.api.ApiService
import org.llamenos.hotline.api.ShiftClockRepository
import org.llamenos.hotline.crypto.KeystoreService
import org.llamenos.hotline.hub.ActiveHubState
import org.llamenos.hotline.hub.HubRepository
import org.llamenos.hotline.ui.theme.LlamenosTheme
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.net.ServerSocket

private class ShiftsScreenHubUnreachableTestApp : Application()

/**
 * The Android twin of iOS `ShiftFlowUITests.testErrorMessageDisplays` (#2565, #2478).
 *
 * The hub cannot be reached: every request is refused at the socket — the session's
 * hub-list fetch first, so no hub is ever selected. "No active hub" then means the hub
 * could not be asked, not that the volunteer belongs to none, and the Shifts tab must say
 * so. An empty schedule here tells a rostered volunteer they are off shift.
 *
 * Real [ActiveHubState], [HubRepository] and [ApiService]; the real [ShiftsScreen] is
 * rendered, so the assertion is on what the volunteer sees.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = ShiftsScreenHubUnreachableTestApp::class)
class ShiftsScreenHubUnreachableTest {

    @get:Rule
    val composeRule = createComposeRule()

    @get:Rule
    val tmpFolder = TemporaryFolder()

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    /** A loopback port nothing listens on: bound, then released, so connecting is refused. */
    private fun refusedHubUrl(): String {
        val port = ServerSocket(0).use { it.localPort }
        return "http://127.0.0.1:$port"
    }

    @Test
    fun `an unreachable hub is reported on the Shifts tab, and no schedule is shown`() {
        val scope = TestScope(UnconfinedTestDispatcher())
        val activeHubState = ActiveHubState(
            PreferenceDataStoreFactory.create(
                scope = scope,
                produceFile = { tmpFolder.newFile("hub.preferences_pb") },
            ),
            scope,
        )
        val store = InMemoryKeyValueStore()
        store.store(KeystoreService.KEY_HUB_URL, refusedHubUrl())
        val apiService = ApiService(
            authInterceptor = mockk(relaxed = true),
            retryInterceptor = mockk(relaxed = true),
            keystoreService = store,
            activeHubState = activeHubState,
        ).also {
            it.client = OkHttpClient()
            it.ioDispatcher = UnconfinedTestDispatcher()
        }

        // Given I am authenticated against a hub that cannot be reached
        runBlocking {
            HubRepository(apiService, mockk(relaxed = true), activeHubState, mockk(relaxed = true))
                .selectInitialHub()
        }
        val vm = ShiftsViewModel(apiService, activeHubState, ShiftClockRepository(apiService), mockk(relaxed = true))

        // When I navigate to shifts
        composeRule.setContent {
            LlamenosTheme { ShiftsScreen(viewModel = vm) }
        }
        composeRule.waitForIdle()

        // Then the failure is reported and no schedule is shown
        composeRule.onNodeWithTag("shifts-error").assertIsDisplayed()
        composeRule.onNodeWithTag("shifts-empty").assertExists()
        assertTrue("No schedule could be loaded", vm.uiState.value.shifts.isEmpty())
        assertFalse("The failure is the answer, not a wait", vm.uiState.value.isLoading)
    }
}
