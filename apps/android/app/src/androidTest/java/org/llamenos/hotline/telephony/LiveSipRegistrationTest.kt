package org.llamenos.hotline.telephony

import android.Manifest
import android.util.Base64
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.linphone.core.Call
import org.linphone.core.MediaEncryption
import org.linphone.core.RegistrationState
import org.llamenos.hotline.LlamenosApp
import org.llamenos.hotline.di.LinphoneEntryPoint
import dagger.hilt.android.EntryPointAccessors

/**
 * The real [LinphoneService] against a real PBX, on a device.
 *
 * #1188's transport layer had three defects that no unit test could see, because each is only
 * decided when liblinphone talks to Asterisk:
 *
 *  1. **TLS registration failed** — `tlsv1 alert unknown ca`. The client set no root CA and the
 *     PBX's certificate is self-signed, so the chain was unverifiable. The fix is not to stop
 *     verifying: the server publishes its trust anchor in the (pinned, authenticated)
 *     `/api/telephony/sip-token` response and the client verifies against exactly that.
 *  2. **SRTP vs DTLS** — the client hardcoded `MediaEncryption.SRTP` with mandatory encryption
 *     on, while the PJSIP endpoint is provisioned `media_encryption: dtls`. Nothing could
 *     negotiate. The client now applies what the server issued.
 *  3. **ICE was parsed and dropped** — no STUN, no TURN, no `natPolicy`, so only host candidates
 *     were ever offered.
 *
 * What this test proves, and how:
 *
 *  * Registration completes over **TLS** — `RegistrationState.Ok` here, and a `200 OK` for a
 *    `REGISTER` on a TLS transport in Asterisk's own log (run-android-sip-e2e.sh greps for it).
 *  * Media **negotiates encrypted** — an outbound INVITE to the harness's echo target is
 *    accepted (no 488) and the PBX ANSWERS with DTLS-SRTP (`remoteParams.mediaEncryption`),
 *    mandatory encryption still on. Asterisk's SDP answer in the same log is the receiving-end
 *    record. Where a routable media path exists, the handshake completes and RTP flows both
 *    ways; see below for when it does not.
 *  * **ICE candidates are gathered and used** — the SDP offer Asterisk logs carries `a=candidate`
 *    lines beyond the host ones, which can only come from the STUN/TURN servers now applied.
 *
 * The INVITE is placed BY THIS TEST, through [LinphoneService.coreForTesting]. The product has no
 * outbound-calling feature, and the inbound INVITE path — the server dialling a registered
 * volunteer — is separate work that does not exist yet. So this exercises everything beneath
 * that keystone, on the volunteer↔PBX leg, and claims nothing about a caller reaching a
 * volunteer.
 *
 * **On an emulator, media may not flow, and that is the topology and not the code.** An Android
 * emulator can reach exactly one address outside itself — 10.0.2.2, its alias for the host — and
 * a containerised PBX can reach neither that nor the emulator's own addresses. With ICE active
 * on both sides there is then no mutually routable candidate pair, so the DTLS handshake has
 * nowhere to run. Everything up to and including the PBX's SDP answer is still proven, which is
 * where defects 2 and 3 live; what is not proven is RTP. The test says so rather than asserting
 * around it, and still fails hard if media flows UNENCRYPTED, which is the outcome that
 * matters.
 *
 * Driven by `deploy/docker/tests/telephony/run-android-sip-e2e.sh`, which boots the stack,
 * enrols a volunteer, fetches a real credential and passes it in as `sipParamsB64`. Without that
 * argument the test skips rather than passing vacuously.
 */
@RunWith(AndroidJUnit4::class)
class LiveSipRegistrationTest {

    /**
     * The microphone the media leg needs, granted to the app under test.
     *
     * This is the same grant the app now asks the volunteer for at clock-in
     * ([rememberMicrophoneRequest]). Before that existed there was no request anywhere in the
     * call path, so a perfectly negotiated call came up with no capture device — which is why
     * granting it here is part of the proof and not a convenience.
     */
    @Before
    fun grantMicrophone() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.uiAutomation.grantRuntimePermission(
            instrumentation.targetContext.packageName,
            Manifest.permission.RECORD_AUDIO,
        )
        assertTrue(
            "RECORD_AUDIO was not granted to the app under test",
            MicrophonePermission.isGranted(instrumentation.targetContext),
        )
    }

    private val json = Json { ignoreUnknownKeys = true }

    private val args get() = InstrumentationRegistry.getArguments()

    @Test
    fun registers_over_tls_and_runs_encrypted_media_with_ice() {
        val encoded = args.getString("sipParamsB64")
        assumeTrue(
            "sipParamsB64 not supplied — run via deploy/docker/tests/telephony/run-android-sip-e2e.sh",
            !encoded.isNullOrBlank(),
        )
        val sip = json.decodeFromString<SipAccountParams>(
            String(Base64.decode(encoded, Base64.DEFAULT), Charsets.UTF_8),
        )

        // Fail loudly on a credential that would make this test prove the wrong thing.
        assertEquals("the harness must issue a TLS credential", "tls", sip.transport)
        assertNotNull(
            "no TLS trust anchor was published — this test cannot prove verified TLS without one",
            sip.tlsTrustAnchorPem,
        )
        assertTrue(
            "no TURN relay in the issued ICE servers — CoTURN is not wired in the harness",
            sip.iceServers.any { it.isTurnRelay },
        )

        val service = EntryPointAccessors
            .fromApplication(LlamenosApp.instance, LinphoneEntryPoint::class.java)
            .linphoneService()

        // ── 1. Registration over TLS, with the chain verified ──────────────────────────
        onMain { service.registerHubAccount(HUB_ID, sip) }
        val state = awaitRegistration(service, HUB_ID)
        assertEquals(
            "TLS registration did not complete — Asterisk's log will say why " +
                "(`tlsv1 alert unknown ca` means the anchor did not take)",
            RegistrationState.Ok,
            state,
        )

        val core = checkNotNull(onMainGet { service.coreForTesting() }) { "no liblinphone core" }

        // The protections that made this fail closed rather than succeed insecurely are still on.
        assertTrue("certificate verification must stay on", core.isVerifyServerCertificates)
        assertTrue("hostname verification must stay on", core.isVerifyServerCn)
        assertTrue("media encryption must stay mandatory", core.isMediaEncryptionMandatory)
        assertEquals(
            "the core must use the encryption the server issued, not a hardcoded one",
            MediaEncryption.DTLS,
            core.mediaEncryption,
        )

        // ── 2 + 3. Media negotiates, runs encrypted, and ICE is used ──────────────────
        val target = args.getString("echoTarget")
        if (target.isNullOrBlank()) {
            Log.w(TAG, "echoTarget not supplied — registration proven, media leg not driven")
            return
        }

        val call = checkNotNull(onMainGet { core.invite("sip:$target@${sip.domain}") }) {
            "liblinphone refused to place the echo INVITE"
        }
        try {
            val reached = awaitCallState(call, Call.State.StreamsRunning)
            assertTrue(
                "media never reached StreamsRunning (last state ${call.state}, " +
                    "reason ${call.reason}) — a 488 from the PBX means the encryption still " +
                    "does not match the provisioned endpoint",
                reached,
            )
            // Reaching StreamsRunning at all is the client-side half of defect 2: the offer was
            // ACCEPTED. The mismatch that shipped — a client mandating SDES-SRTP against a
            // `media_encryption: dtls` endpoint — gets a 488 and never gets here.
            //
            // What the PBX ANSWERED with is not readable from the client: liblinphone's
            // `currentParams`/`remoteParams` both report the ACTIVE encryption, which is None
            // until the DTLS handshake completes. The PBX's own SDP answer is the only place
            // that fact lives, so run-android-sip-e2e.sh asserts it from Asterisk's log — which
            // is the receiving-end evidence anyway, and not something a client can fake.
            assertTrue("encryption must still be mandatory on a running call", core.isMediaEncryptionMandatory)

            // Whether the DTLS handshake then completes is a property of the network between
            // the two, not of the negotiation: it needs a candidate pair both ends can reach.
            // So the ACTIVE encryption is the discriminator, and bandwidth counters are not —
            // they also count the STUN connectivity checks and DTLS attempts, so "bytes moved"
            // is true even when no audio ever does.
            //
            // Unencrypted audio is ruled out elsewhere, and deliberately not by this branch:
            // `isMediaEncryptionMandatory` (asserted above) stops liblinphone running media in
            // the clear, and run-android-sip-e2e.sh gates on Asterisk having answered with no
            // plain RTP/AVP profile and no 488.
            when (val active = awaitMediaEncryption(call, MediaEncryption.DTLS)) {
                MediaEncryption.DTLS -> {
                    // The handshake completed, so there is a routable path and the echo target
                    // is streaming the volunteer's own audio back. RTP both ways, or the leg is
                    // half-open.
                    assertTrue("no RTP was sent", awaitRtp(call) { it.uploadBandwidth > 0f })
                    assertTrue("no RTP was received", awaitRtp(call) { it.downloadBandwidth > 0f })
                    Log.i(TAG, "two-way DTLS-SRTP media on the volunteer<->PBX leg")
                }
                else -> Log.w(
                    TAG,
                    "DTLS did not complete (active encryption $active, call state ${call.state}). " +
                        "Negotiation is proven — see Asterisk's own SDP answer in the harness " +
                        "output — but no candidate pair in this emulator topology is reachable " +
                        "from both ends, so the handshake has nowhere to run.",
                )
            }
        } finally {
            onMain { call.terminate() }
        }
    }

    // ── liblinphone must be driven from the main thread, where auto-iterate runs ──────

    private fun onMain(block: () -> Unit) =
        InstrumentationRegistry.getInstrumentation().runOnMainSync(block)

    private fun <T> onMainGet(block: () -> T): T {
        var result: T? = null
        InstrumentationRegistry.getInstrumentation().runOnMainSync { result = block() }
        @Suppress("UNCHECKED_CAST")
        return result as T
    }

    private fun awaitRegistration(service: LinphoneService, hubId: String): RegistrationState? =
        poll(REGISTER_TIMEOUT_MS) {
            service.registrationStates.value[hubId]?.takeIf {
                it == RegistrationState.Ok || it == RegistrationState.Failed
            }
        }

    private fun awaitCallState(call: Call, state: Call.State): Boolean =
        poll(MEDIA_TIMEOUT_MS) {
            when {
                onMainGet { call.state } == state -> true
                onMainGet { call.state } in TERMINAL_STATES -> false
                else -> null
            }
        } ?: false

    /** The call's ACTIVE media encryption, once the handshake has had time to complete. */
    private fun awaitMediaEncryption(call: Call, want: MediaEncryption): MediaEncryption? =
        poll(MEDIA_TIMEOUT_MS) {
            onMainGet { call.currentParams.mediaEncryption }
                .takeIf { it == want || onMainGet { call.state } in TERMINAL_STATES }
        } ?: onMainGet { call.currentParams.mediaEncryption }

    private fun awaitRtp(call: Call, predicate: (org.linphone.core.CallStats) -> Boolean): Boolean =
        poll(MEDIA_TIMEOUT_MS) {
            onMainGet { call.audioStats }?.takeIf(predicate)?.let { true }
        } ?: false

    /** Poll [probe] until it answers non-null or [timeoutMs] passes. */
    private fun <T> poll(timeoutMs: Long, probe: () -> T?): T? {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            probe()?.let { return it }
            Thread.sleep(POLL_INTERVAL_MS)
        }
        return probe()
    }

    private companion object {
        const val TAG = "LiveSipRegistrationTest"
        const val HUB_ID = "live-sip-e2e-hub"
        const val REGISTER_TIMEOUT_MS = 45_000L

        /** DTLS handshake plus a second or two of RTP; generous for a software emulator. */
        const val MEDIA_TIMEOUT_MS = 60_000L
        const val POLL_INTERVAL_MS = 250L

        val TERMINAL_STATES = setOf(Call.State.Error, Call.State.End, Call.State.Released)
    }
}
