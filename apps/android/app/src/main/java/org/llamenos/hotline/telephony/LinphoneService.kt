package org.llamenos.hotline.telephony

import android.content.Context
import android.util.Log
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import org.linphone.core.Account
import org.linphone.core.AccountListenerStub
import org.linphone.core.AuthInfo
import org.linphone.core.Call
import org.linphone.core.Core
import org.linphone.core.CoreListenerStub
import org.linphone.core.Factory
import org.linphone.core.MediaEncryption
import org.linphone.core.RegistrationState
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.di.ApplicationScope
import org.llamenos.hotline.hub.ActiveHubState
import java.util.Collections
import java.util.LinkedHashMap
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Response body of `GET /api/telephony/sip-token`.
 *
 * Mirrors `SipConnectionParams` in `apps/worker/telephony/sip-tokens.ts`, which is what the
 * server actually sends. The protocol schema on main still describes a different, flat shape;
 * #1190 aligns the schema with the server, and #1189 replaces this hand-written type with the
 * generated `SIPTokenResponse`.
 */
@Serializable
data class SipConnectionParams(
    val provider: String,
    val sip: SipAccountParams,
)

@Serializable
data class SipAccountParams(
    val domain: String,
    val transport: String,
    val username: String,
    val password: String,
    val iceServers: List<SipIceServer> = emptyList(),
    val mediaEncryption: String,
) {
    /** Never let the SIP password reach a log line or crash report. */
    override fun toString(): String =
        "SipAccountParams(domain=$domain, transport=$transport, username=$username, password=<redacted>, " +
            "iceServers=$iceServers, mediaEncryption=$mediaEncryption)"
}

@Serializable
data class SipIceServer(
    val url: String,
    val username: String? = null,
    val credential: String? = null,
) {
    override fun toString(): String = "SipIceServer(url=$url, username=$username, credential=<redacted>)"
}

/**
 * Owns the liblinphone [Core] and the SIP registrations that let this device ring.
 *
 * Multi-hub routing axiom: every member hub is bound to a registration, regardless of which hub
 * is active in the UI. Hubs whose credentials resolve to the same SIP identity share a single
 * account — registering one address-of-record twice would fork every INVITE to two contacts on
 * this device and ring it twice.
 *
 * Registration refresh is left to liblinphone: belle-sip's refresher re-sends REGISTER at a
 * randomised point inside the stack's refresh window (90% by default) of the expiry the
 * registrar granted, retries after failures, and liblinphone re-registers on network changes.
 * State changes are published on [registrationStates] so a lapsed registration is observable.
 *
 * All [Core] calls must happen on the main thread, where liblinphone's auto-iterate runs.
 */
@Singleton
class LinphoneService @Inject constructor(
    @ApplicationContext private val context: Context,
    private val activeHubState: ActiveHubState,
    private val cryptoService: CryptoService,
    @ApplicationScope private val scope: CoroutineScope,
) {
    private var core: Core? = null

    /** One registration per distinct SIP identity; [hubIds] are the member hubs it serves. */
    private class Registration(
        val account: Account,
        var authInfo: AuthInfo,
        var params: SipAccountParams,
        val hubIds: MutableSet<String>,
        var state: RegistrationState,
    )

    private val lock = Any()
    private val registrations = HashMap<String, Registration>()
    private val identityByHub = HashMap<String, String>()

    private val _registrationStates = MutableStateFlow<Map<String, RegistrationState>>(emptyMap())

    /** Current SIP registration state for every member hub that has been registered. */
    val registrationStates: StateFlow<Map<String, RegistrationState>> = _registrationStates.asStateFlow()

    private val pendingCallHubIds: MutableMap<String, String> = Collections.synchronizedMap(
        object : LinkedHashMap<String, String>(MAX_PENDING_CALLS + 1, 0.75f, true) {
            override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, String>?): Boolean =
                size > MAX_PENDING_CALLS
        }
    )

    companion object {
        private const val TAG = "LinphoneService"

        /** Max pending call→hub mappings retained. Evicts oldest entries to bound memory. */
        private const val MAX_PENDING_CALLS = 100

        /**
         * Expiry requested in each REGISTER. liblinphone's own default; stated explicitly so the
         * refresh cadence is visible here. The registrar may grant less — the refresher follows
         * the granted value, not this one.
         */
        const val REGISTER_EXPIRES_SECONDS = 3600
    }

    fun initialize() {
        try {
            // No config path: the Core keeps its config — including AuthInfo — in memory only,
            // so SIP passwords are never written to disk.
            val core = Factory.instance().createCore(null, null, context)
            core.isCallkitEnabled = true
            core.mediaEncryption = MediaEncryption.SRTP
            core.isMediaEncryptionMandatory = true

            core.audioPayloadTypes.forEach { pt ->
                pt.enable(pt.mimeType == "opus" || pt.mimeType == "PCMU")
            }

            setupCoreListener(core)
            core.start()
            this.core = core
        } catch (e: Exception) {
            // The app stays usable without in-app calling; registerHubAccount reports the
            // missing core to its caller instead of silently doing nothing.
            Log.e(TAG, "liblinphone core failed to initialize", e)
        }
    }

    /**
     * Bind [hubId] to a SIP registration for [sip], creating the account and its [AuthInfo]
     * if no other hub already registered the same identity.
     *
     * @throws IllegalStateException if the core is not initialized or liblinphone rejects the account.
     */
    fun registerHubAccount(hubId: String, sip: SipAccountParams) {
        val core = checkNotNull(core) { "liblinphone core is not initialized" }
        val identity = identityKey(sip)
        synchronized(lock) {
            identityByHub[hubId]?.takeIf { it != identity }?.let { releaseHub(core, hubId) }

            val existing = registrations[identity]
            if (existing != null) {
                existing.hubIds += hubId
                identityByHub[hubId] = identity
                if (existing.params != sip) {
                    // Rotated credentials for the same identity: swap the AuthInfo, re-REGISTER.
                    core.removeAuthInfo(existing.authInfo)
                    existing.authInfo = createAuthInfo(sip).also(core::addAuthInfo)
                    existing.params = sip
                    existing.account.refreshRegister()
                } else if (existing.state != RegistrationState.Ok && existing.state != RegistrationState.Progress) {
                    existing.account.refreshRegister()
                }
                publishStates()
                return
            }

            val authInfo = createAuthInfo(sip)
            core.addAuthInfo(authInfo)

            val factory = Factory.instance()
            val params = core.createAccountParams()
            val identityAddress = checkNotNull(factory.createAddress("sip:${sip.username}@${sip.domain}")) {
                "Invalid SIP identity for hub $hubId"
            }
            val serverAddress = checkNotNull(factory.createAddress("sip:${sip.domain};transport=${sip.transport}")) {
                "Invalid SIP server for hub $hubId"
            }
            check(params.setIdentityAddress(identityAddress) == 0) { "liblinphone rejected the SIP identity" }
            check(params.setServerAddress(serverAddress) == 0) { "liblinphone rejected the SIP server" }
            params.expires = REGISTER_EXPIRES_SECONDS
            params.isRegisterEnabled = true

            val account = core.createAccount(params)
            account.addListener(object : AccountListenerStub() {
                override fun onRegistrationStateChanged(account: Account, state: RegistrationState, message: String) {
                    onRegistrationState(identity, state, message)
                }
            })
            if (core.addAccount(account) != 0) {
                core.removeAuthInfo(authInfo)
                throw IllegalStateException("liblinphone rejected the SIP account for hub $hubId")
            }
            registrations[identity] = Registration(
                account = account,
                authInfo = authInfo,
                params = sip,
                hubIds = mutableSetOf(hubId),
                state = RegistrationState.Progress,
            )
            identityByHub[hubId] = identity
            publishStates()
        }
    }

    /** Drop [hubId]'s binding; the account is unregistered once no member hub uses it. */
    fun unregisterHubAccount(hubId: String) {
        val core = core ?: return
        synchronized(lock) {
            releaseHub(core, hubId)
            publishStates()
        }
    }

    /** Unbind every hub not in [hubIds] — e.g. hubs the user has left. */
    fun retainHubAccounts(hubIds: Set<String>) {
        val core = core ?: return
        synchronized(lock) {
            (identityByHub.keys - hubIds).forEach { releaseHub(core, it) }
            publishStates()
        }
    }

    /** Unregister every SIP account (clock-out). */
    fun unregisterAll() {
        val core = core ?: return
        synchronized(lock) {
            identityByHub.keys.toList().forEach { releaseHub(core, it) }
            publishStates()
        }
    }

    /** Hub IDs currently bound to a SIP registration. */
    fun registeredHubIds(): Set<String> = synchronized(lock) { identityByHub.keys.toSet() }

    fun storePendingCallHub(callId: String, hubId: String) {
        pendingCallHubIds.put(callId, hubId)
    }

    private fun createAuthInfo(sip: SipAccountParams): AuthInfo =
        checkNotNull(
            Factory.instance().createAuthInfo(sip.username, null, sip.password, null, null, sip.domain)
        ) { "liblinphone could not create AuthInfo" }

    /** Caller holds [lock]. */
    private fun releaseHub(core: Core, hubId: String) {
        val identity = identityByHub.remove(hubId) ?: return
        val registration = registrations[identity] ?: return
        registration.hubIds -= hubId
        if (registration.hubIds.isEmpty()) {
            registrations.remove(identity)
            // Removing a registered account makes liblinphone send REGISTER with Expires: 0.
            core.removeAccount(registration.account)
            core.removeAuthInfo(registration.authInfo)
        }
    }

    private fun onRegistrationState(identity: String, state: RegistrationState, message: String) {
        synchronized(lock) {
            val registration = registrations[identity] ?: return
            registration.state = state
            publishStates()
        }
        if (state == RegistrationState.Failed) {
            Log.w(TAG, "SIP registration failed: $message")
        }
    }

    /** Caller holds [lock]. */
    private fun publishStates() {
        _registrationStates.value = identityByHub.mapNotNull { (hubId, identity) ->
            registrations[identity]?.let { hubId to it.state }
        }.toMap()
    }

    private fun identityKey(sip: SipAccountParams): String =
        "${sip.username}@${sip.domain};transport=${sip.transport}"

    private fun setupCoreListener(core: Core) {
        core.addListener(object : CoreListenerStub() {
            override fun onCallStateChanged(
                core: Core,
                call: Call,
                state: Call.State,
                message: String,
            ) {
                val callId = call.callLog?.callId ?: return
                when (state) {
                    // An incoming call reaches Connected only after it was answered on this
                    // device. That — not the ring (IncomingReceived) — is the answer path on
                    // which the multi-hub axiom allows switching the active hub, and only while
                    // the app is unlocked.
                    Call.State.Connected -> {
                        val hubId = pendingCallHubIds.remove(callId) ?: return
                        if (call.dir == Call.Dir.Incoming && cryptoService.isUnlocked) {
                            scope.launch { activeHubState.setActiveHub(hubId) }
                        }
                    }
                    Call.State.Released, Call.State.End, Call.State.Error -> {
                        pendingCallHubIds.remove(callId)
                    }
                    else -> {}
                }
            }
        })
    }

    internal fun pendingCallHubIdForTesting(callId: String): String? = pendingCallHubIds.get(callId)
    internal fun consumePendingCallHubForTesting(callId: String) { pendingCallHubIds.remove(callId) }
}
