package org.llamenos.hotline.telephony

import kotlinx.coroutines.test.runTest
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class IncomingCallTrackerTest {

    private val info1 = RingingCallInfo(
        callId = "call-1",
        remoteAddress = "sip:+15551234567@example.org",
        remoteDisplayName = null,
        hubId = "hub-1",
    )
    private val info2 = RingingCallInfo(
        callId = "call-2",
        remoteAddress = "sip:+15557654321@example.org",
        remoteDisplayName = "Jane",
        hubId = null,
    )

    @Test
    fun `incoming call is exposed as ringing`() = runTest {
        val tracker = IncomingCallTracker()

        assertNull(tracker.ringingCall.value)
        tracker.onIncomingReceived(info1)

        assertEquals(info1, tracker.ringingCall.value)
    }

    @Test
    fun `a second incoming call replaces the first in the ringing surface`() = runTest {
        val tracker = IncomingCallTracker()

        tracker.onIncomingReceived(info1)
        tracker.onIncomingReceived(info2)

        assertEquals(info2, tracker.ringingCall.value)
    }

    @Test
    fun `termination of a different call does not clear the ringing surface`() = runTest {
        val tracker = IncomingCallTracker()

        tracker.onIncomingReceived(info1)
        tracker.onCallTerminated("call-other")

        assertEquals(info1, tracker.ringingCall.value)
    }

    @Test
    fun `termination of the ringing call clears the surface`() = runTest {
        val tracker = IncomingCallTracker()

        tracker.onIncomingReceived(info1)
        tracker.onCallTerminated("call-1")

        assertNull(tracker.ringingCall.value)
    }

    @Test
    fun `accept or decline clears the surface`() = runTest {
        val tracker = IncomingCallTracker()

        tracker.onIncomingReceived(info1)
        tracker.clear()

        assertNull(tracker.ringingCall.value)
    }
}
