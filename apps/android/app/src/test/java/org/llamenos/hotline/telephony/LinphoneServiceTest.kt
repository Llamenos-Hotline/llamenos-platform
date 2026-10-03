package org.llamenos.hotline.telephony

import android.content.Context
import io.mockk.mockk
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import org.junit.Test
import org.llamenos.hotline.hub.ActiveHubState
import kotlin.test.assertEquals
import kotlin.test.assertNull

class LinphoneServiceTest {

    @Test
    fun `storePendingCallHub stores callId to hubId mapping`() {
        val context = mockk<Context>(relaxed = true)
        val activeHubState = mockk<ActiveHubState>(relaxed = true)
        val scope = TestScope(UnconfinedTestDispatcher())

        val svc = LinphoneService(context, activeHubState, mockk(relaxed = true), scope)
        svc.storePendingCallHub("call-abc-123", "hub-uuid-001")

        assertEquals("hub-uuid-001", svc.pendingCallHubIdForTesting("call-abc-123"))
    }

    @Test
    fun `storePendingCallHub mapping is removed after retrieval`() {
        val context = mockk<Context>(relaxed = true)
        val activeHubState = mockk<ActiveHubState>(relaxed = true)
        val scope = TestScope(UnconfinedTestDispatcher())

        val svc = LinphoneService(context, activeHubState, mockk(relaxed = true), scope)
        svc.storePendingCallHub("call-abc-123", "hub-uuid-001")
        svc.consumePendingCallHubForTesting("call-abc-123")

        assertNull(svc.pendingCallHubIdForTesting("call-abc-123"))
    }
}
