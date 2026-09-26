package org.llamenos.hotline.hub

import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import org.junit.Test
import org.llamenos.hotline.api.ApiService
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.protocol.HubKeyEnvelopeResponse
import org.llamenos.hotline.model.HubKeyEnvelopeResponseEnvelope

class HubRepositoryTest {

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
            ),
            generation = 1,
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
}
