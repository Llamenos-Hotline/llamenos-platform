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
import org.linphone.core.NatPolicy
import org.linphone.core.Reason
import org.linphone.core.RegistrationState
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.di.ApplicationScope
import org.llamenos.hotline.hub.ActiveHubState
import java.util.Collections
import java.util.LinkedHashMap
import java.util.concurrent.ConcurrentHashMap
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
    /**
     * PEM trust anchor for the SIP edge's TLS certificate.
     *
     * A self-hoster has no publicly-trusted certificate for their PBX, so there is nothing in
     * the device trust store that can vouch for it — and turning verification off is not an
     * option on a leg that carries a crisis call. The resolution is that this anchor arrives
     * inside this response, which travelled over the app's own certificate-pinned HTTPS channel
     * ([org.llamenos.hotline.api.ApiService.configurePinning]). Trust in the PBX therefore
     * derives from the API pin: no trust-on-first-use, and the public CA store is not consulted
     * for SIP at all.
     *
     * Null means "verify against the device trust store", which is what a deployment whose SIP
     * edge serves a publicly-trusted certificate wants. It never means "do not verify":
     * [Core.verifyServerCertificates] and [Core.verifyServerCn] stay on either way.
     */
    val tlsTrustAnchorPem: String? = null,
) {
    /** Never let the SIP password reach a log line or crash report. */
    override fun toString(): String =
        "SipAccountParams(domain=$domain, transport=$transport, username=$username, password=<redacted>, " +
            "iceServers=$iceServers, mediaEncryption=$mediaEncryption, " +
            "tlsTrustAnchorPem=${if (tlsTrustAnchorPem == null) "null" else "<${tlsTrustAnchorPem.length} bytes>"})"

    /**
     * The soonest expiry among the issued TURN credentials, as Unix seconds, or null when no
     * relay was issued (STUN-only ICE servers, or none at all).
     */
    val turnCredentialExpiresAt: Long?
        get() = iceServers.mapNotNull { it.turnCredentialExpiresAt }.minOrNull()
}

@Serializable
data class SipIceServer(
    val url: String,
    val username: String? = null,
    val credential: String? = null,
) {
    /**
     * `stun`, `stuns`, `turn` or `turns` — RFC 7064/7065 URIs, which are NOT hierarchical: there
     * is no `//`, so a generic URL parser mis-reads them. One is tolerated anyway in case an
     * operator writes it.
     */
    val scheme: String get() = url.substringBefore(':', "").lowercase()

    /** `host:port`, which is what liblinphone's [org.linphone.core.NatPolicy] takes. */
    val hostAndPort: String
        get() = url.substringAfter(':', "").removePrefix("//").substringBefore('?').trimEnd('/')

    /**
     * The `?transport=` hint on a TURN URI (RFC 7065), lowercased: which transport the client
     * should reach the relay over. Null when unspecified, which means UDP.
     */
    val turnTransport: String?
        get() = url.substringAfter('?', "")
            .split('&')
            .firstOrNull { it.startsWith("transport=", ignoreCase = true) }
            ?.substringAfter('=')
            ?.lowercase()
            ?.takeIf { it.isNotEmpty() }

    /**
     * When the time-limited TURN credential stops being honoured, as Unix seconds.
     *
     * CoTURN's long-term-credential REST convention (RFC 8489) puts the expiry in the username
     * itself (`<expiry>:<user>`), so the client can see it without the server having to state it
     * separately. [SipRegistrar] re-fetches the token before this passes — otherwise a volunteer
     * clocked in for longer than the credential's lifetime would lose the relay candidate, which
     * is precisely the candidate a symmetric-NAT volunteer depends on.
     */
    val turnCredentialExpiresAt: Long?
        get() = username?.substringBefore(':', "")?.toLongOrNull()

    /** A usable relay: a TURN URI with both halves of a credential. STUN needs neither. */
    val isTurnRelay: Boolean
        get() = (scheme == "turn" || scheme == "turns") && username != null && credential != null

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
    val incomingCallTracker: IncomingCallTracker,
    private val incomingCallNotifier: IncomingCallNotifier,
    @ApplicationScope private val scope: CoroutineScope,
) {
    private var core: Core? = null

    /** One registration per distinct SIP identity; [hubIds] are the member hubs it serves. */
    private class Registration(
        val account: Account,
        var authInfo: AuthInfo,
        /** TURN credential auth info, when the issued ICE servers include a relay. */
        var turnAuthInfo: AuthInfo?,
        var params: SipAccountParams,
        val hubIds: MutableSet<String>,
        var state: RegistrationState,
    )

    private val lock = Any()

    /**
     * The trust anchor currently installed on the core. Tracked so a repeat registration does
     * not reinstall the same store, and so a token that stops publishing one is noticed.
     */
    @Volatile
    private var appliedTrustAnchor: String? = null

    private val registrations = HashMap<String, Registration>()
    private val identityByHub = HashMap<String, String>()

    /** Hub → the account serving it, for inbound INVITE identity matching. */
    private val hubAccounts = ConcurrentHashMap<String, Account>()

    private val _registrationStates = MutableStateFlow<Map<String, RegistrationState>>(emptyMap())

    /** Current SIP registration state for every member hub that has been registered. */
    val registrationStates: StateFlow<Map<String, RegistrationState>> = _registrationStates.asStateFlow()

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

        /**
         * Expiry requested in each REGISTER. liblinphone's own default; stated explicitly so the
         * refresh cadence is visible here. The registrar may grant less — the refresher follows
         * the granted value, not this one.
         */
        const val REGISTER_EXPIRES_SECONDS = 3600

        /**
         * Media encryption applied before any credential has been issued.
         *
         * DTLS-SRTP, matching what the registrar provisions (`media_encryption: dtls` on each
         * volunteer endpoint — apps/worker/telephony/registrar.ts). Never [MediaEncryption.None]:
         * with [Core.isMediaEncryptionMandatory] on, a wrong value here fails the call, and
         * failing a call is the correct outcome where plaintext media is the alternative.
         */
        val DEFAULT_MEDIA_ENCRYPTION: MediaEncryption = MediaEncryption.DTLS

        /**
         * The media encryption the server's `mediaEncryption` string names.
         *
         * The field has been returned by `/api/telephony/sip-token` and discarded by both
         * clients all along (#1188), while the client hardcoded SRTP and the PBX endpoint was
         * provisioned for DTLS — a pair that cannot negotiate. Reading it is what makes the two
         * sides agree by construction instead of by coincidence.
         *
         * `none` is deliberately absent: a crisis hotline's volunteer leg does not carry
         * unencrypted media, so an issued credential asking for it is refused rather than
         * honoured. Anything unrecognised is refused for the same reason.
         */
        fun mediaEncryptionFor(value: String): MediaEncryption? = when (value.lowercase()) {
            "dtls-srtp", "dtls" -> MediaEncryption.DTLS
            "srtp" -> MediaEncryption.SRTP
            "zrtp" -> MediaEncryption.ZRTP
            else -> null
        }
    }

    fun initialize() {
        try {
            // No config path: the Core keeps its config — including AuthInfo — in memory only,
            // so SIP passwords are never written to disk.
            val core = Factory.instance().createCore(null, null, context)
            core.isCallkitEnabled = true

            // Mandatory encryption is not negotiable: a call that cannot be encrypted must fail,
            // never fall back to plaintext RTP. The ALGORITHM is the server's to choose — it
            // provisions the matching PJSIP endpoint — and [registerHubAccount] applies whatever
            // the issued credential names. DTLS-SRTP is the floor until then: it is what our
            // registrar issues, and it is never "none".
            core.setMediaEncryption(DEFAULT_MEDIA_ENCRYPTION)
            core.isMediaEncryptionMandatory = true

            // Registration is over TLS. Verify the chain AND the hostname, always — these are
            // the checks whose absence made registration fail closed with `tlsv1 alert unknown
            // ca` rather than succeed insecurely, and they stay on. What the chain is verified
            // AGAINST comes from the server: see [SipAccountParams.tlsTrustAnchorPem].
            core.verifyServerCertificates(true)
            core.verifyServerCn(true)

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
            // Both of these refuse rather than degrade: an unencryptable media leg and an
            // unverifiable TLS chain are each a reason not to register at all. They are
            // core-global settings, so they are applied under the lock, before anything is
            // bound, and a conflict with a live registration is refused rather than imposed.
            val encryption = requireMediaEncryption(core, sip, hubId)
            applyTlsTrustAnchor(core, sip, hubId)
            check(core.setMediaEncryption(encryption) == 0) {
                "liblinphone rejected media encryption $encryption"
            }
            check(core.isMediaEncryptionMandatory) {
                "media encryption is no longer mandatory — refusing a leg that may run in the clear"
            }

            identityByHub[hubId]?.takeIf { it != identity }?.let { releaseHub(core, hubId) }

            val existing = registrations[identity]
            if (existing != null) {
                existing.hubIds += hubId
                identityByHub[hubId] = identity
                hubAccounts[hubId] = existing.account
                if (existing.params != sip) {
                    // Rotated credentials for the same identity: swap the AuthInfo, re-REGISTER.
                    // ICE servers rotate with them (TURN credentials are time-limited), so the
                    // account's NAT policy is rebuilt too.
                    core.removeAuthInfo(existing.authInfo)
                    existing.authInfo = createAuthInfo(sip).also(core::addAuthInfo)
                    existing.turnAuthInfo?.let(core::removeAuthInfo)
                    existing.turnAuthInfo = createTurnAuthInfo(sip)?.also(core::addAuthInfo)
                    existing.account.params = existing.account.params.clone().apply {
                        natPolicy = buildNatPolicy(core, sip)
                    }
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
            val turnAuthInfo = createTurnAuthInfo(sip)?.also(core::addAuthInfo)

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
            // The issued ICE servers, finally applied: without a NAT policy liblinphone offers
            // only host candidates, which a volunteer behind any NAT cannot be reached on.
            params.natPolicy = buildNatPolicy(core, sip)

            val account = core.createAccount(params)
            account.addListener(object : AccountListenerStub() {
                override fun onRegistrationStateChanged(account: Account, state: RegistrationState, message: String) {
                    onRegistrationState(identity, state, message)
                }
            })
            if (core.addAccount(account) != 0) {
                core.removeAuthInfo(authInfo)
                turnAuthInfo?.let(core::removeAuthInfo)
                throw IllegalStateException("liblinphone rejected the SIP account for hub $hubId")
            }
            registrations[identity] = Registration(
                account = account,
                authInfo = authInfo,
                turnAuthInfo = turnAuthInfo,
                params = sip,
                hubIds = mutableSetOf(hubId),
                state = RegistrationState.Progress,
            )
            identityByHub[hubId] = identity
            hubAccounts[hubId] = account
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

    /**
     * The media encryption this credential requires, or a failure.
     *
     * Refuses instead of degrading, in both directions: an algorithm the server did not name,
     * and an algorithm this build of liblinphone cannot do. Registering anyway would produce an
     * endpoint that rings and then cannot carry the call, or — with mandatory encryption off,
     * which this app never does — one that carries it in the clear.
     */
    private fun requireMediaEncryption(
        core: Core,
        sip: SipAccountParams,
        hubId: String,
    ): MediaEncryption {
        val encryption = checkNotNull(mediaEncryptionFor(sip.mediaEncryption)) {
            "Server asked for media encryption '${sip.mediaEncryption}', which this client will not use"
        }
        check(core.isMediaEncryptionSupported(encryption)) {
            "liblinphone does not support media encryption $encryption on this device"
        }
        // One setting, every account: changing it for a newcomer would silently break the media
        // leg of a hub already registered. Today `/sip-token` is not hub-scoped so every hub
        // gets the same value and this cannot fire; it exists so that if that ever changes, the
        // hub that loses out is the one being added, loudly, and not one already answering.
        val conflicting = conflictingRegistration(hubId) { live ->
            mediaEncryptionFor(live.mediaEncryption) != encryption
        }
        check(conflicting == null) {
            "hub $hubId needs media encryption $encryption but a live registration needs " +
                "${conflicting?.mediaEncryption} — liblinphone has one setting for both"
        }
        return encryption
    }

    /**
     * Install the server-published trust anchor as the ONLY thing the SIP TLS chain is verified
     * against, when one was published.
     *
     * liblinphone does NOT use the platform trust store for its SIP socket — it verifies against
     * its own CA set, which is why adding a certificate to the Android system store does nothing
     * here and why `tlsv1 alert unknown ca` was the symptom. [Core.setRootCaData] is the hook
     * that set is fed from, so this is the one place the anchor can be supplied at all.
     *
     * MEASURED: with this call, registration against a self-signed PBX certificate succeeds;
     * reverting only this call returns `tlsv1 alert unknown ca` and zero successful REGISTERs.
     *
     * ESTABLISHED: this REPLACES the SDK's bundled anchors rather than adding to them, so
     * "narrower than the public CA set" is a property and not merely an intent. belle-sip's
     * `belle_sip_tls_channel_init` selects the two sources with a short-circuiting `||` —
     * `root_ca_data` first, falling back to the bundled `root_ca` file only if that is unset or
     * fails to parse — and `load_root_ca_from_buffer` frees any previously parsed chain before
     * parsing the buffer. A public CA mis-issuing for the PBX hostname is therefore refused
     * while an anchor is in force.
     *
     * Where no anchor is published the set is left alone, which is exactly what a deployment
     * whose SIP edge holds a publicly-trusted certificate wants: ISRG Root X1 and ISRG Root X2
     * are both in the SDK's bundled rootca.pem (a Mozilla-derived bundle), so a Let's Encrypt
     * certificate on the SIP edge verifies with nothing published. Verification stays on
     * regardless, so an unverifiable edge fails to register rather than registering insecurely.
     */
    private fun applyTlsTrustAnchor(core: Core, sip: SipAccountParams, hubId: String) {
        val pem = sip.tlsTrustAnchorPem?.takeIf { it.isNotBlank() }
        if (pem == null) {
            if (appliedTrustAnchor != null) {
                Log.w(TAG, "SIP token no longer publishes a TLS trust anchor; keeping the one in force")
            }
            return
        }
        check(!pem.contains("PRIVATE KEY")) {
            "SIP TLS trust anchor contains private key material — refusing it"
        }
        check(pem.contains("-----BEGIN CERTIFICATE-----")) {
            "SIP TLS trust anchor is not a PEM certificate"
        }
        if (pem == appliedTrustAnchor) return
        // The trust store is core-global too, so replacing it would leave an already-registered
        // hub verifying against an anchor that does not describe its own edge. Same reasoning as
        // the encryption check above: refuse the newcomer.
        val conflicting = conflictingRegistration(hubId) { live ->
            val other = live.tlsTrustAnchorPem?.takeIf(String::isNotBlank)
            other != null && other != pem
        }
        check(conflicting == null) {
            "hub $hubId publishes a different SIP TLS trust anchor than a live registration — " +
                "liblinphone has one trust store for both"
        }
        core.setRootCaData(pem)
        appliedTrustAnchor = pem
        Log.i(TAG, "SIP TLS trust anchor installed (${pem.length} bytes)")
    }

    /**
     * A live registration serving some hub other than [hubId] whose params [disagrees] with what
     * is being applied. Caller holds [lock].
     */
    private fun conflictingRegistration(
        hubId: String,
        disagrees: (SipAccountParams) -> Boolean,
    ): SipAccountParams? = registrations.values
        .firstOrNull { it.hubIds.any { hub -> hub != hubId } && disagrees(it.params) }
        ?.params

    /**
     * The NAT policy for the issued ICE servers.
     *
     * `iceServers` was parsed and then thrown away (#1188): no STUN, no TURN, no policy — so
     * liblinphone offered host candidates only. Those work on the same LAN and nowhere else.
     *
     * liblinphone takes ONE server address for both roles, so the TURN host wins when the two
     * differ: the relay candidate is the one that cannot be substituted. A volunteer behind a
     * full-cone or address-restricted NAT connects on the server-reflexive candidate STUN
     * discovers; behind a SYMMETRIC NAT the reflexive candidate is useless (the mapping is
     * per-destination), and the relay candidate TURN allocates is what carries the call —
     * CoTURN forwards both halves, so the volunteer never needs an inbound mapping at all. With
     * no TURN server configured the server says so honestly (STUN-only `iceServers`), and a
     * symmetric-NAT volunteer is then reachable only by phone.
     */
    private fun buildNatPolicy(core: Core, sip: SipAccountParams): NatPolicy? {
        if (sip.iceServers.isEmpty()) return null
        val stun = sip.iceServers.firstOrNull { it.scheme == "stun" || it.scheme == "stuns" }
        val turnServers = sip.iceServers.filter { it.scheme == "turn" || it.scheme == "turns" }
        val turn = turnServers.firstOrNull { it.isTurnRelay }
        val address = (turn ?: stun)?.hostAndPort ?: return null

        return core.createNatPolicy().apply {
            isIceEnabled = true
            stunServer = address
            isStunEnabled = true
            if (turn != null) {
                isTurnEnabled = true
                // liblinphone resolves the TURN password through an AuthInfo keyed on this
                // username (see createTurnAuthInfo), so the credential never has to be held here.
                stunServerUsername = turn.username
                isUdpTurnTransportEnabled = turnServers.any { it.turnTransport == null || it.turnTransport == "udp" }
                isTcpTurnTransportEnabled = turnServers.any { it.turnTransport == "tcp" }
                isTlsTurnTransportEnabled = turnServers.any { it.turnTransport == "tls" || it.scheme == "turns" }
            }
        }
    }

    /**
     * AuthInfo for the time-limited TURN credential, which liblinphone looks up by the username
     * set as [NatPolicy.stunServerUsername]. Null when no relay was issued.
     */
    private fun createTurnAuthInfo(sip: SipAccountParams): AuthInfo? {
        val turn = sip.iceServers.firstOrNull { it.isTurnRelay } ?: return null
        val username = turn.username ?: return null
        val credential = turn.credential ?: return null
        return Factory.instance().createAuthInfo(username, username, credential, null, null, null)
    }

    /** Caller holds [lock]. */
    private fun releaseHub(core: Core, hubId: String) {
        val identity = identityByHub.remove(hubId) ?: return
        hubAccounts.remove(hubId)
        val registration = registrations[identity] ?: return
        registration.hubIds -= hubId
        if (registration.hubIds.isEmpty()) {
            registrations.remove(identity)
            // Removing a registered account makes liblinphone send REGISTER with Expires: 0.
            core.removeAccount(registration.account)
            core.removeAuthInfo(registration.authInfo)
            registration.turnAuthInfo?.let(core::removeAuthInfo)
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

    /**
     * The liblinphone [Core], for a test that has to drive it directly.
     *
     * Exists for `LiveSipRegistrationTest`, which places an outbound INVITE at an echo target on
     * a live PBX to prove the media leg negotiates and carries RTP. That belongs in a test, not
     * in the product: this app has no outbound-calling feature, and the inbound INVITE path is
     * separate work (#1188). Exposing the core keeps the dial out of the service rather than
     * adding a capability nothing ships.
     */
    internal fun coreForTesting(): Core? = core

    internal fun pendingCallHubIdForTesting(callId: String): String? = pendingCallHubIds.get(callId)
    internal fun consumePendingCallHubForTesting(callId: String) { pendingCallHubIds.remove(callId) }
    internal fun associateHubAccountForTesting(hubId: String, account: org.linphone.core.Account) {
        hubAccounts[hubId] = account
    }
}
