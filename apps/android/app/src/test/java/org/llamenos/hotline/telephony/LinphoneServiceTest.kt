package org.llamenos.hotline.telephony

import android.content.Context
import io.mockk.coVerify
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
import org.linphone.core.CallParams
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

    /**
     * Mock an inbound INVITE: callLog.callId (the SIP Call-ID, which the PBX generates per
     * leg), the `X-Llamenos-Push-Ref` header the bridge stamps on an in-app leg, the remote
     * display, and To user@domain.
     */
    private fun incomingCall(
        callId: String = SIP_CALL_ID,
        pushRef: String? = null,
        remoteDisplay: String? = "sip:+15551234567@example.org",
        toUsername: String = "volunteer1",
        toDomain: String = "sip.example.org",
        dir: Call.Dir = Call.Dir.Incoming,
    ): Call {
        val call = mockk<Call>(relaxed = true)
        val log = mockk<CallLog>(relaxed = true)
        val remote = mockk<Address>(relaxed = true)
        val to = mockk<Address>(relaxed = true)
        val remoteParams = mockk<CallParams>(relaxed = true)
        every { log.callId } returns callId
        every { call.callLog } returns log
        every { remoteParams.getCustomHeader(any()) } returns null
        every { remoteParams.getCustomHeader("X-Llamenos-Push-Ref") } returns pushRef
        every { call.remoteParams } returns remoteParams
        every { remote.asString() } returns (remoteDisplay ?: "sip:unknown@example.org")
        every { remote.displayName } returns null
        every { call.remoteAddress } returns remote
        every { to.username } returns toUsername
        every { to.domain } returns toDomain
        every { call.toAddress } returns to
        every { call.dir } returns dir
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
    fun `storePendingCallHub stores pushRef to hubId mapping`() {
        val svc = service()
        svc.storePendingCallHub(PUSH_REF, "hub-uuid-001")

        assertEquals("hub-uuid-001", svc.pushedCallHubIdForTesting(PUSH_REF))
    }

    @Test
    fun `incoming INVITE resolves its hub from the registered account and rings`() {
        val svc = service()
        hubAccount(svc, "hub-uuid-001", "volunteer1", "sip.example.org")

        svc.handleCallState(incomingCall(), Call.State.IncomingReceived)

        // Cold inbound INVITE (no push): the hub comes from the one account it was sent to.
        assertEquals("hub-uuid-001", svc.ringingCallHubIdForTesting(SIP_CALL_ID))
        val ringing = tracker.ringingCall.value
        assertNotNull(ringing)
        assertEquals(SIP_CALL_ID, ringing.callId)
        assertEquals("hub-uuid-001", ringing.hubId)
        assertEquals("sip:+15551234567@example.org", ringing.remoteAddress)
        verify { notifier.showIncomingCall(any()) }
    }

    @Test
    fun `incoming INVITE finds the pushed hub by its push ref, not by its SIP Call-ID`() {
        // The VoIP push's `call-id` is the server's random pushRef (apps/worker/lib/voip-push.ts);
        // the INVITE's Call-ID is minted by the PBX for the leg. They never match, so the only
        // way the push's hub reaches the ring is the push-ref header the bridge stamps.
        val svc = service()
        // One identity bound to both hubs, as `/sip-token` issues it: only the push can say
        // which of them this INVITE is for.
        svc.storePendingCallHub(PUSH_REF, "hub-from-push")
        hubAccount(svc, "hub-from-account", "volunteer1", "sip.example.org")
        hubAccount(svc, "hub-from-push", "volunteer1", "sip.example.org")

        svc.handleCallState(incomingCall(pushRef = PUSH_REF), Call.State.IncomingReceived)

        assertEquals("hub-from-push", tracker.ringingCall.value?.hubId)
        assertEquals("hub-from-push", svc.ringingCallHubIdForTesting(SIP_CALL_ID))
    }

    @Test
    fun `a pushed hub this device holds no registration for is not trusted`() {
        // The VoIP push is unauthenticated (cleartext through the distributor). A hub it
        // names that this device never registered for is not a hub to answer into.
        val svc = service()
        every { cryptoService.isUnlocked } returns true
        hubAccount(svc, "hub-a", "volunteer1", "sip.example.org")
        svc.storePendingCallHub(PUSH_REF, "hub-not-a-member")
        val call = incomingCall(pushRef = PUSH_REF)

        svc.handleCallState(call, Call.State.IncomingReceived)
        // Falls back to the identity the INVITE was sent to — here, unambiguously hub-a.
        assertEquals("hub-a", tracker.ringingCall.value?.hubId)
        svc.handleCallState(call, Call.State.Connected)

        coVerify(exactly = 0) { activeHubState.setActiveHub("hub-not-a-member") }
        coVerify(exactly = 1) { activeHubState.setActiveHub("hub-a") }
    }

    @Test
    fun `incoming INVITE to an identity shared by several hubs names no hub rather than guessing`() {
        // `/sip-token` is not hub-scoped, so every member hub binds the same SIP identity. An
        // INVITE with no push ref then cannot say which hub it is for; picking one would
        // switch the volunteer into the wrong hub on answer.
        val svc = service()
        hubAccount(svc, "hub-a", "volunteer1", "sip.example.org")
        hubAccount(svc, "hub-b", "volunteer1", "sip.example.org")

        svc.handleCallState(incomingCall(), Call.State.IncomingReceived)

        assertNotNull(tracker.ringingCall.value, "the call still rings")
        assertNull(tracker.ringingCall.value?.hubId)
        assertNull(svc.ringingCallHubIdForTesting(SIP_CALL_ID))
    }

    @Test
    fun `incoming INVITE with no resolvable hub still rings but stores no mapping`() {
        val svc = service()

        svc.handleCallState(incomingCall(), Call.State.IncomingReceived)

        assertNull(svc.ringingCallHubIdForTesting(SIP_CALL_ID))
        assertNotNull(tracker.ringingCall.value)
    }

    @Test
    fun `a ring does not switch the active hub, even with the app unlocked`() {
        val svc = service()
        every { cryptoService.isUnlocked } returns true
        hubAccount(svc, "hub-b", "volunteer1", "sip.example.org")
        svc.storePendingCallHub(PUSH_REF, "hub-b")

        svc.handleCallState(incomingCall(pushRef = PUSH_REF), Call.State.IncomingReceived)

        coVerify(exactly = 0) { activeHubState.setActiveHub(any()) }
    }

    @Test
    fun `answering a pushed call while unlocked switches to the call's hub`() {
        val svc = service()
        every { cryptoService.isUnlocked } returns true
        hubAccount(svc, "hub-b", "volunteer1", "sip.example.org")
        svc.storePendingCallHub(PUSH_REF, "hub-b")
        val call = incomingCall(pushRef = PUSH_REF)

        svc.handleCallState(call, Call.State.IncomingReceived)
        coVerify(exactly = 0) { activeHubState.setActiveHub(any()) }
        assertTrue(svc.acceptIncomingCall())
        svc.handleCallState(call, Call.State.Connected)

        coVerify(exactly = 1) { activeHubState.setActiveHub("hub-b") }
        assertNull(svc.ringingCallHubIdForTesting(SIP_CALL_ID))
    }

    @Test
    fun `answering while the app is locked leaves the active hub alone`() {
        val svc = service()
        every { cryptoService.isUnlocked } returns false
        hubAccount(svc, "hub-b", "volunteer1", "sip.example.org")
        svc.storePendingCallHub(PUSH_REF, "hub-b")
        val call = incomingCall(pushRef = PUSH_REF)

        svc.handleCallState(call, Call.State.IncomingReceived)
        svc.handleCallState(call, Call.State.Connected)

        coVerify(exactly = 0) { activeHubState.setActiveHub(any()) }
    }

    @Test
    fun `a declined or missed call never switches the active hub`() {
        val svc = service()
        every { cryptoService.isUnlocked } returns true
        hubAccount(svc, "hub-b", "volunteer1", "sip.example.org")
        svc.storePendingCallHub(PUSH_REF, "hub-b")
        val call = incomingCall(pushRef = PUSH_REF)

        svc.handleCallState(call, Call.State.IncomingReceived)
        assertTrue(svc.declineIncomingCall())
        svc.handleCallState(call, Call.State.End)
        svc.handleCallState(call, Call.State.Released)

        coVerify(exactly = 0) { activeHubState.setActiveHub(any()) }
        assertNull(svc.ringingCallHubIdForTesting(SIP_CALL_ID))
    }

    @Test
    fun `an outgoing call reaching Connected never switches the active hub`() {
        val svc = service()
        every { cryptoService.isUnlocked } returns true
        hubAccount(svc, "hub-b", "volunteer1", "sip.example.org")

        svc.handleCallState(incomingCall(dir = Call.Dir.Outgoing), Call.State.Connected)

        coVerify(exactly = 0) { activeHubState.setActiveHub(any()) }
    }

    @Test
    fun `caller hanging up clears the ringing surface`() {
        val svc = service()
        hubAccount(svc, "hub-uuid-001", "volunteer1", "sip.example.org")
        svc.handleCallState(incomingCall(), Call.State.IncomingReceived)
        assertNotNull(tracker.ringingCall.value)

        svc.handleCallState(incomingCall(), Call.State.End)

        assertNull(tracker.ringingCall.value)
        verify { notifier.cancel() }
    }

    @Test
    fun `accept answers the ringing call through liblinphone and clears the surface`() {
        val svc = service()
        hubAccount(svc, "hub-uuid-001", "volunteer1", "sip.example.org")
        val call = incomingCall()
        svc.handleCallState(call, Call.State.IncomingReceived)

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
        svc.handleCallState(call, Call.State.IncomingReceived)

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

    private companion object {
        /** The server's opaque push reference — what the VoIP push carries as `call-id`. */
        const val PUSH_REF = "3f9c0e2a7b1d4c58a6e0f1b2c3d4e5f6"
        /** The SIP Call-ID the PBX minted for this leg: unrelated to [PUSH_REF]. */
        const val SIP_CALL_ID = "a84b4c76e66710@pbx.example.org"
    }
}
