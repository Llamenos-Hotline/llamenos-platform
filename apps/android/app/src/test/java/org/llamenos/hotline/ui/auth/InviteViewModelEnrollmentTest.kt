package org.llamenos.hotline.ui.auth

import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.coVerifyOrder
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.llamenos.hotline.api.ApiException
import org.llamenos.hotline.api.InviteRepository
import org.llamenos.hotline.service.DeviceRegistrationManager
import org.llamenos.protocol.InviteValidationResponse

/**
 * #2119: enrolment ends with the device keys on the server.
 *
 * Redemption is what makes the server know this pubkey, so it is the point where the
 * keys can first be registered — before it, `POST /api/devices/register` is refused as
 * an unknown identity. A phone with no UnifiedPush distributor has no other trigger.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class InviteViewModelEnrollmentTest {

    private val code = "3f6f8f2c-9f3e-4a2b-b1c1-2d4e6f8091a2"

    private lateinit var invites: InviteRepository
    private lateinit var deviceRegistration: DeviceRegistrationManager
    private lateinit var viewModel: InviteViewModel

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        invites = mockk()
        deviceRegistration = mockk()
        coEvery { invites.validate(code) } returns InviteValidationResponse(valid = true)
        coEvery { deviceRegistration.register() } returns Result.success(Unit)
        viewModel = InviteViewModel(invites, deviceRegistration)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private suspend fun redeemed(): InviteUiState = withContext(Dispatchers.Default) {
        withTimeout(10_000) {
            viewModel.uiState.first { it.stage != InviteStage.REDEEMING && it.stage != InviteStage.VALIDATING }
        }
    }

    private suspend fun validated() {
        viewModel.updateInput(code)
        viewModel.validate()
        assertEquals(InviteStage.VALID, redeemed().stage)
    }

    @Test
    fun `the device keys are registered once the invite is redeemed`() = runTest {
        coEvery { invites.redeemInvite(code) } returns Result.success(Unit)
        validated()

        viewModel.redeem()

        assertEquals(InviteStage.REDEEMED, redeemed().stage)
        coVerifyOrder {
            invites.redeemInvite(code)
            deviceRegistration.register()
        }
    }

    @Test
    fun `a failed device registration does not undo a spent invite`() = runTest {
        coEvery { invites.redeemInvite(code) } returns Result.success(Unit)
        coEvery { deviceRegistration.register() } returns Result.failure(java.io.IOException("offline"))
        validated()

        viewModel.redeem()

        assertEquals(InviteStage.REDEEMED, redeemed().stage)
    }

    @Test
    fun `a refused redemption registers nothing`() = runTest {
        coEvery { invites.redeemInvite(code) } returns Result.failure(ApiException(410, "expired"))
        validated()

        viewModel.redeem()

        redeemed()
        coVerify(exactly = 0) { deviceRegistration.register() }
    }
}
