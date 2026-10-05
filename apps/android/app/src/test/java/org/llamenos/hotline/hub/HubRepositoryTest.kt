package org.llamenos.hotline.hub

import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import org.llamenos.hotline.api.ApiService
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.model.Hub
import org.llamenos.hotline.model.HubsListResponse
import org.llamenos.protocol.HubKeyEnvelopeResponse
import org.llamenos.hotline.model.HubKeyEnvelopeResponseEnvelope
import org.llamenos.protocol.SharedHubDetailResponseStatus

class HubRepositoryTest {

    @get:Rule
    val tmpFolder = TemporaryFolder()

    private val apiService = mockk<ApiService>()
    private val cryptoService = mockk<CryptoService>(relaxed = true)
    private val activeHubState = mockk<ActiveHubState>(relaxed = true)

    private val repo = HubRepository(apiService, cryptoService, activeHubState)

    private fun makeEnvelope(enc: String = "aabb", ct: String = "ccdd") =
        HubKeyEnvelopeResponse(
            envelope = HubKeyEnvelopeResponseEnvelope(
                enc = enc,
                pubkey = "pub",
                ct = ct,
            )
        )

    /**
     * Real [ActiveHubState] backed by a throwaway Preferences DataStore, so selection
     * tests observe what the production code path actually persists — no mocked state,
     * no test hook writing the active hub ID.
     */
    @OptIn(ExperimentalCoroutinesApi::class)
    private fun makeRealActiveHubState(): ActiveHubState {
        val dispatcher = UnconfinedTestDispatcher()
        val scope = TestScope(dispatcher)
        val dataStore = PreferenceDataStoreFactory.create(
            scope = scope,
            produceFile = { tmpFolder.newFile("hub-${System.nanoTime()}.preferences_pb") },
        )
        return ActiveHubState(dataStore, scope)
    }

    private fun makeHub(id: String) = Hub(
        createdAt = "2026-01-01T00:00:00Z",
        createdBy = "admin-pubkey",
        id = id,
        name = "Hub $id",
        slug = id,
        status = SharedHubDetailResponseStatus.Active,
        updatedAt = "2026-01-01T00:00:00Z",
    )

    @Test
    fun `switchHub persists hub ID immediately then fetches key`() = runTest {
        val envelope = makeEnvelope()
        coEvery { apiService.getHubKey("hub-uuid-001") } returns envelope
        coEvery { activeHubState.setActiveHub(any()) } returns Unit
        every { cryptoService.hasHubKey(any()) } returns false

        repo.switchHub("hub-uuid-001")

        // Hub ID is persisted first so the UI updates immediately.
        // Key fetch happens after — it's only needed for E2EE operations.
        coVerify(ordering = io.mockk.Ordering.ORDERED) {
            activeHubState.setActiveHub("hub-uuid-001")
            cryptoService.loadHubKey("hub-uuid-001", envelope)
        }
    }

    @Test
    fun `switchHub persists hub ID even if key fetch throws`() = runTest {
        every { cryptoService.hasHubKey(any()) } returns false
        coEvery { apiService.getHubKey(any()) } throws RuntimeException("network error")
        coEvery { activeHubState.setActiveHub(any()) } returns Unit

        repo.switchHub("hub-uuid-001")

        coVerify(exactly = 1) { activeHubState.setActiveHub("hub-uuid-001") }
        coVerify(exactly = 0) { cryptoService.loadHubKey(any(), any()) }
    }

    @Test
    fun `switchHub skips fetch if key already cached`() = runTest {
        every { cryptoService.hasHubKey("hub-uuid-001") } returns true
        coEvery { activeHubState.setActiveHub(any()) } returns Unit

        repo.switchHub("hub-uuid-001")

        coVerify(exactly = 0) { apiService.getHubKey(any()) }
        coVerify(exactly = 1) { activeHubState.setActiveHub("hub-uuid-001") }
    }

    // ── ensureInitialHub (issue #1340: must fire after login and on session restore) ──

    @OptIn(ExperimentalCoroutinesApi::class)
    @Test
    fun `ensureInitialHub selects the first hub when none is persisted`() =
        runTest(UnconfinedTestDispatcher()) {
            val state = makeRealActiveHubState()
            val api = mockk<ApiService>()
            coEvery { api.getHubs() } returns
                HubsListResponse(listOf(makeHub("hub-aaa"), makeHub("hub-bbb")))
            // Key already cached — switchHub skips the key fetch; this test isolates selection.
            val crypto = mockk<CryptoService>(relaxed = true)
            every { crypto.hasHubKey(any()) } returns true

            HubRepository(api, crypto, state).ensureInitialHub()

            assertEquals("hub-aaa", state.activeHubId.value)
        }

    @OptIn(ExperimentalCoroutinesApi::class)
    @Test
    fun `ensureInitialHub keeps the persisted hub and never fetches the hub list`() =
        runTest(UnconfinedTestDispatcher()) {
            val state = makeRealActiveHubState()
            // Simulates session restore: the persisted choice is hydrated.
            state.setActiveHub("hub-chosen")
            val api = mockk<ApiService>(relaxed = true)

            HubRepository(api, mockk(relaxed = true), state).ensureInitialHub()

            assertEquals("hub-chosen", state.activeHubId.value)
            coVerify(exactly = 0) { api.getHubs() }
        }

    @OptIn(ExperimentalCoroutinesApi::class)
    @Test
    fun `ensureInitialHub does nothing when the user belongs to no hubs`() =
        runTest(UnconfinedTestDispatcher()) {
            val state = makeRealActiveHubState()
            val api = mockk<ApiService>()
            coEvery { api.getHubs() } returns HubsListResponse(emptyList())

            HubRepository(api, mockk(relaxed = true), state).ensureInitialHub()

            assertNull(state.activeHubId.value)
        }

    @OptIn(ExperimentalCoroutinesApi::class)
    @Test
    fun `ensureInitialHub survives a hub list fetch failure`() =
        runTest(UnconfinedTestDispatcher()) {
            val state = makeRealActiveHubState()
            val api = mockk<ApiService>()
            coEvery { api.getHubs() } throws java.io.IOException("offline")

            HubRepository(api, mockk(relaxed = true), state).ensureInitialHub()

            assertNull(state.activeHubId.value)
        }
}
