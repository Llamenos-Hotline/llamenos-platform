package org.llamenos.hotline.telephony

import android.content.Context
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import org.junit.Test
import org.linphone.core.Account
import org.linphone.core.AccountParams
import org.linphone.core.Address
import org.linphone.core.Call
import org.linphone.core.CallLog
import org.linphone.core.Reason
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.hub.ActiveHubState
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class LinphoneServiceTest {

    private val context = mockk<Context>(relaxed = true)
    private val activeHubState = mockk<ActiveHubState>(relaxed = true)
    private val cryptoService = mockk<CryptoService>(relaxed = true)
    private val notifier = mockk<IncomingCallNotifier>(relaxed = true)
    private val tracker = IncomingCallTracker()
    private val scope = TestScope(UnconfinedTestDispatcher())

    private fun service(): LinphoneService =
        LinphoneService(context, activeHubState, cryptoService, tracker, notifier, scope)

    /** Mock an inbound INVITE: callLog.callId, remoteAddress display, To user@domain. */
    private fun incomingCall(
        callId: String = "call-abc-123",
        remoteDisplay: String? = "sip:+15551234567@example.org",
        toUsername: String = "volunteer1",
        toDomain: String = "sip.example.org",
    ): Call {
        val call = mockk<Call>(relaxed = true)
        val log = mockk<CallLog>(relaxed = true)
        val remote = mockk<Address>(relaxed = true)
        val to = mockk<Address>(relaxed = true)
        every { log.callId } returns callId
        every { call.callLog } returns log
        every { remote.asString() } returns (remoteDisplay ?: "sip:unknown@example.org")
        every { remote.displayName } returns null
        every { call.remoteAddress } returns remote
        every { to.username } returns toUsername
        every { to.domain } returns toDomain
        every { call.toAddress } returns to
        every { call.dir } returns Call.Dir.Incoming
        return call
    }

    /** Register a hub account whose identity is username@domain (matches Call.toAddress). */
    private fun hubAccount(svc: LinphoneService, hubId: String, username: String, domain: String) {
        val identity = mockk<Address>(relaxed = true)
        every { identity.username } returns username
        every { identity.domain } returns domain
        val params = mockk<AccountParams>(relaxed = true)
        every { params.identityAddress } returns identity
        val account = mockk<Account>(relaxed = true)
        every { account.params } returns params
        svc.associateHubAccountForTesting(hubId, account)
    }

    @Test
    fun `storePendingCallHub stores callId to hubId mapping`() {
        val svc = service()
        svc.storePendingCallHub("call-abc-123", "hub-uuid-001")

        assertEquals("hub-uuid-001", svc.pendingCallHubIdForTesting("call-abc-123"))
    }

    @Test
    fun `storePendingCallHub mapping is removed after retrieval`() {
        val svc = service()
        svc.storePendingCallHub("call-abc-123", "hub-uuid-001")
        svc.consumePendingCallHubForTesting("call-abc-123")

        assertNull(svc.pendingCallHubIdForTesting("call-abc-123"))
    }

    @Test
    fun `incoming INVITE populates pending mapping from the registered account and rings`() {
        val svc = service()
        hubAccount(svc, "hub-uuid-001", "volunteer1", "sip.example.org")

        svc.handleCallState(incomingCall(), org.linphone.core.Call.State.IncomingReceived)

        // Cold inbound INVITE: the call→hub mapping now exists for the post-answer switch.
        assertEquals("hub-uuid-001", svc.pendingCallHubIdForTesting("call-abc-123"))
        val ringing = tracker.ringingCall.value
        assertNotNull(ringing)
        assertEquals("call-abc-123", ringing.callId)
        assertEquals("hub-uuid-001", ringing.hubId)
        assertEquals("sip:+15551234567@example.org", ringing.remoteAddress)
        verify { notifier.showIncomingCall(any()) }
    }

    @Test
    fun `incoming INVITE keeps the push-wake mapping and prefers it for the hub`() {
        val svc = service()
        svc.storePendingCallHub("call-abc-123", "hub-from-push")
        hubAccount(svc, "hub-from-account", "volunteer1", "sip.example.org")

        svc.handleCallState(incomingCall(), org.linphone.core.Call.State.IncomingReceived)

        // NOT consumed at ring time (that would starve the Connected handler), and the
        // push-populated hub wins over account resolution.
        assertEquals("hub-from-push", svc.pendingCallHubIdForTesting("call-abc-123"))
        assertEquals("hub-from-push", tracker.ringingCall.value?.hubId)
    }

    @Test
    fun `incoming INVITE with no resolvable hub still rings but stores no mapping`() {
        val svc = service()

        svc.handleCallState(incomingCall(), org.linphone.core.Call.State.IncomingReceived)

        assertNull(svc.pendingCallHubIdForTesting("call-abc-123"))
        assertNotNull(tracker.ringingCall.value)
    }

    @Test
    fun `Connected on an answered inbound call switches the active hub`() {
        val svc = service()
        every { cryptoService.isUnlocked } returns true
        svc.storePendingCallHub("call-abc-123", "hub-uuid-001")

        svc.handleCallState(incomingCall(), org.linphone.core.Call.State.Connected)

        io.mockk.coVerify { activeHubState.setActiveHub("hub-uuid-001") }
        assertNull(svc.pendingCallHubIdForTesting("call-abc-123"))
    }

    @Test
    fun `Connected does not switch the active hub while the app is locked`() {
        val svc = service()
        every { cryptoService.isUnlocked } returns false
        svc.storePendingCallHub("call-abc-123", "hub-uuid-001")

        svc.handleCallState(incomingCall(), org.linphone.core.Call.State.Connected)

        io.mockk.coVerify(exactly = 0) { activeHubState.setActiveHub(any()) }
    }

    @Test
    fun `caller hanging up clears the ringing surface`() {
        val svc = service()
        hubAccount(svc, "hub-uuid-001", "volunteer1", "sip.example.org")
        svc.handleCallState(incomingCall(), org.linphone.core.Call.State.IncomingReceived)
        assertNotNull(tracker.ringingCall.value)

        svc.handleCallState(incomingCall(), org.linphone.core.Call.State.End)

        assertNull(tracker.ringingCall.value)
        verify { notifier.cancel() }
    }

    @Test
    fun `accept answers the ringing call through liblinphone and clears the surface`() {
        val svc = service()
        hubAccount(svc, "hub-uuid-001", "volunteer1", "sip.example.org")
        val call = incomingCall()
        svc.handleCallState(call, org.linphone.core.Call.State.IncomingReceived)

        assertTrue(svc.acceptIncomingCall())

        verify { call.accept() }
        assertNull(tracker.ringingCall.value)
        verify { notifier.cancel() }
    }

    @Test
    fun `decline terminates the ringing call with Declined reason and clears the surface`() {
        val svc = service()
        hubAccount(svc, "hub-uuid-001", "volunteer1", "sip.example.org")
        val call = incomingCall()
        svc.handleCallState(call, org.linphone.core.Call.State.IncomingReceived)

        assertTrue(svc.declineIncomingCall())

        verify { call.decline(Reason.Declined) }
        assertNull(tracker.ringingCall.value)
        verify { notifier.cancel() }
    }

    @Test
    fun `accept and decline are no-ops when nothing is ringing`() {
        val svc = service()

        assertFalse(svc.acceptIncomingCall())
        assertFalse(svc.declineIncomingCall())
    }
}
