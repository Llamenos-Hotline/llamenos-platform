package org.llamenos.hotline

import io.mockk.every
import io.mockk.just
import io.mockk.mockk
import io.mockk.Runs
import kotlinx.coroutines.flow.MutableStateFlow
import org.llamenos.hotline.service.PushRegistrationManager

/**
 * A [PushRegistrationManager] mock with a real (inert) distributor-state flow,
 * for ViewModel tests that collect `distributorState` — a relaxed mock would
 * hand back a chained StateFlow mock that cannot be collected.
 */
fun mockPushRegistrationManager(
    initialState: PushRegistrationManager.DistributorState = PushRegistrationManager.DistributorState.UNKNOWN,
): PushRegistrationManager {
    val manager = mockk<PushRegistrationManager>()
    every { manager.distributorState } returns MutableStateFlow(initialState)
    every { manager.ensureRegistered() } just Runs
    return manager
}
