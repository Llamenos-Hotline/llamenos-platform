package org.llamenos.hotline.telephony

import android.content.Context
import android.util.Log
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.linphone.core.Call
import org.linphone.core.Core
import org.linphone.core.CoreListenerStub
import org.linphone.core.Factory
import org.linphone.core.MediaEncryption
import org.linphone.core.Reason
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.di.ApplicationScope
import org.llamenos.hotline.hub.ActiveHubState
import java.util.Collections
import java.util.LinkedHashMap
import java.util.concurrent.ConcurrentHashMap
import javax.inject.Inject
import javax.inject.Singleton

data class SipTokenResponse(
    val username: String,
    val domain: String,
    val password: String,
    val transport: String,
    val expiry: Int,
)

@Singleton
class LinphoneService @Inject constructor(
    @ApplicationContext private val context: Context,
    private val activeHubState: ActiveHubState,
    private val cryptoService: CryptoService,
    val incomingCallTracker: IncomingCallTracker,
    private val incomingCallNotifier: IncomingCallNotifier,
    @ApplicationScope private val scope: CoroutineScope,
) {
    private var core: Core? = null
    private val hubAccounts = ConcurrentHashMap<String, org.linphone.core.Account>()
    private val pendingCallHubIds: MutableMap<String, String> = Collections.synchronizedMap(
        object : LinkedHashMap<String, String>(MAX_PENDING_CALLS + 1, 0.75f, true) {
            override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, String>?): Boolean =
                size > MAX_PENDING_CALLS
        }
    )

    /**
     * The liblinphone [Call] behind [IncomingCallTracker.ringingCall], so accept/decline can
     * reach it. Single-slot on purpose: the UI rings one call at a time.
     */
    @Volatile
    private var ringingCallHandle: Call? = null

    companion object {
        private const val TAG = "LinphoneService"

        /** Max pending call→hub mappings retained. Evicts oldest entries to bound memory. */
        private const val MAX_PENDING_CALLS = 100
    }

    fun initialize() {
        try {
            val factory = Factory.instance()
            val core = factory.createCore(null, null, context)
            core.isCallkitEnabled = true
            core.mediaEncryption = MediaEncryption.SRTP
            core.isMediaEncryptionMandatory = true

            core.audioPayloadTypes.forEach { pt ->
                pt.enable(pt.mimeType == "opus" || pt.mimeType == "PCMU")
            }

            setupCoreListener(core)
            core.start()
            this.core = core
        } catch (_: Exception) {
            // Initialization failure is non-fatal.
        }
    }

    fun registerHubAccount(hubId: String, sipParams: SipTokenResponse) {
        val core = this.core ?: return
        try {
            val params = core.createAccountParams()
            val identity = Factory.instance().createAddress(
                "sip:${sipParams.username}@${sipParams.domain}"
            )
            params.identityAddress = identity
            val server = Factory.instance().createAddress(
                "sip:${sipParams.domain};transport=${sipParams.transport}"
            )
            params.serverAddress = server
            params.isRegisterEnabled = true
            val account = core.createAccount(params)
            core.addAccount(account)
            hubAccounts[hubId] = account
        } catch (_: Exception) {
            // Registration failure is non-fatal.
        }
    }

    fun unregisterHubAccount(hubId: String) {
        val account = hubAccounts.remove(hubId) ?: return
        core?.removeAccount(account)
    }

    fun storePendingCallHub(callId: String, hubId: String) {
        pendingCallHubIds.put(callId, hubId)
    }

    /**
     * Answer the ringing inbound call (the receiving clause's accept path — the only
     * `acceptCall` call site in the app). Returns false when nothing is ringing.
     */
    fun acceptIncomingCall(): Boolean {
        val call = ringingCallHandle ?: return false
        return try {
            call.accept()
            true
        } catch (e: Exception) {
            Log.w(TAG, "acceptCall failed", e)
            false
        } finally {
            ringingCallHandle = null
            incomingCallTracker.clear()
            incomingCallNotifier.cancel()
        }
    }

    /** Decline the ringing inbound call. Returns false when nothing is ringing. */
    fun declineIncomingCall(): Boolean {
        val call = ringingCallHandle ?: return false
        return try {
            call.decline(Reason.Declined)
            true
        } catch (e: Exception) {
            Log.w(TAG, "declineCall failed", e)
            false
        } finally {
            ringingCallHandle = null
            incomingCallTracker.clear()
            incomingCallNotifier.cancel()
        }
    }

    /**
     * Hub an inbound INVITE arrived for: the push-wake mapping first, else the hub whose
     * registered identity matches the INVITE's To (user@domain — transport and tag params
     * differ between the registered identity and the INVITE's Request-URI, so they are
     * not compared). This SDK's Call has no getAccount(); identity matching is the seam.
     */
    private fun resolveIncomingHubId(call: Call, callId: String): String? {
        pendingCallHubIds[callId]?.let { return it }
        val to = call.toAddress ?: return null
        return hubAccounts.entries.firstOrNull { (_, account) ->
            val identity = account.params?.identityAddress
            identity != null && identity.username == to.username && identity.domain == to.domain
        }?.key
    }

    private fun setupCoreListener(core: Core) {
        core.addListener(object : CoreListenerStub() {
            override fun onCallStateChanged(
                core: Core,
                call: Call,
                state: Call.State,
                message: String,
            ) {
                handleCallState(call, state)
            }
        })
    }

    internal fun handleCallState(call: Call, state: Call.State) {
        val callId = call.callLog?.callId ?: return
        when (state) {
            Call.State.IncomingReceived -> {
                val hubId = resolveIncomingHubId(call, callId)
                // Populate the call→hub mapping for the post-answer switch even when the
                // push-wake path never ran (cold inbound INVITE): resolve it from the
                // registered account and store it. Deliberately NOT consumed here.
                if (hubId != null) storePendingCallHub(callId, hubId)

                val remote = call.remoteAddress
                val info = RingingCallInfo(
                    callId = callId,
                    remoteAddress = remote?.asString() ?: "",
                    remoteDisplayName = remote?.displayName?.takeIf { it.isNotBlank() },
                    hubId = hubId,
                )
                ringingCallHandle = call
                incomingCallTracker.onIncomingReceived(info)
                incomingCallNotifier.showIncomingCall(info)
            }
            // An incoming call reaches Connected only after it was answered on this device,
            // so this — not the ring — is where the multi-hub axiom allows switching the
            // active hub, and only while the app is unlocked. (Overlaps #1200's Connected
            // handler; identical semantics — keep one copy when resolving the merge.)
            Call.State.Connected -> {
                val hubId = pendingCallHubIds.remove(callId) ?: return
                if (call.dir == Call.Dir.Incoming && cryptoService.isUnlocked) {
                    scope.launch { activeHubState.setActiveHub(hubId) }
                }
            }
            Call.State.Released, Call.State.End, Call.State.Error -> {
                pendingCallHubIds.remove(callId)
                incomingCallTracker.onCallTerminated(callId)
                if (ringingCallHandle?.callLog?.callId == callId) ringingCallHandle = null
                incomingCallNotifier.cancel()
            }
            else -> {}
        }
    }

    internal fun pendingCallHubIdForTesting(callId: String): String? = pendingCallHubIds.get(callId)
    internal fun consumePendingCallHubForTesting(callId: String) { pendingCallHubIds.remove(callId) }
    internal fun associateHubAccountForTesting(hubId: String, account: org.linphone.core.Account) {
        hubAccounts[hubId] = account
    }
}
