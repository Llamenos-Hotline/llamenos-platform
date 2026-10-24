package org.llamenos.hotline.service

import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import io.mockk.slot
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.llamenos.hotline.api.ApiService
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.model.RegisterDeviceRequest

/**
 * #2119: the device keys reach the server as part of enrolment, with no push
 * endpoint involved — a phone without a UnifiedPush distributor is the default.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class DeviceRegistrationManagerTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var apiService: ApiService
    private lateinit var cryptoService: CryptoService

    @Before
    fun setup() {
        apiService = mockk()
        cryptoService = CryptoService()
        cryptoService.setTestKeyState("a".repeat(64), "b".repeat(64), "device-1")
        coEvery { apiService.registerDevice(any()) } returns Unit
    }

    private fun createManager() = DeviceRegistrationManager(
        apiService,
        cryptoService,
        CoroutineScope(testDispatcher),
    )

    @Test
    fun `registers both device keys without any push endpoint`() = runTest(testDispatcher) {
        val sent = slot<RegisterDeviceRequest>()
        coEvery { apiService.registerDevice(capture(sent)) } returns Unit

        val result = createManager().register()

        assertTrue(result.isSuccess)
        assertEquals("a".repeat(64), sent.captured.ed25519Pubkey)
        assertEquals("b".repeat(64), sent.captured.x25519Pubkey)
        assertNull(sent.captured.pushToken)
        assertNull(sent.captured.wakeKeyPublic)
    }

    @Test
    fun `registers once per process for unchanged keys`() = runTest(testDispatcher) {
        val manager = createManager()

        manager.register()
        manager.register()
        manager.ensureRegistered()

        coVerify(exactly = 1) { apiService.registerDevice(any()) }
    }

    @Test
    fun `registers again when the device keys change`() = runTest(testDispatcher) {
        val manager = createManager()
        manager.register()

        cryptoService.setTestKeyState("c".repeat(64), "d".repeat(64), "device-2")
        manager.register()

        coVerify(exactly = 2) { apiService.registerDevice(any()) }
    }

    @Test
    fun `a failed registration is reported and retried on the next call`() = runTest(testDispatcher) {
        coEvery { apiService.registerDevice(any()) } throws java.io.IOException("offline") andThen Unit
        val manager = createManager()

        val first = manager.register()
        val second = manager.register()

        assertTrue(first.isFailure)
        assertTrue(second.isSuccess)
        coVerify(exactly = 2) { apiService.registerDevice(any()) }
    }

    @Test
    fun `locked keys register nothing and fail`() = runTest(testDispatcher) {
        cryptoService = CryptoService()

        val result = createManager().register()

        assertTrue(result.isFailure)
        coVerify(exactly = 0) { apiService.registerDevice(any()) }
    }
}
