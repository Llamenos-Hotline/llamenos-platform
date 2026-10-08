import Foundation
import Testing
@testable import Llamenos

// MARK: - LinphoneServiceTests
//
// These tests exercise the `pendingCallHubIds` map in LinphoneService, which does not
// touch liblinphone. What a started Core exposes is covered by `LinphoneServiceCoreTests`
// below; SIP registration itself is not exercised anywhere (see that suite's note).

struct LinphoneServiceTests {

    @Test func handleVoipPushStoresCallIdToHubIdMapping() {
        let svc = LinphoneService()
        svc.handleVoipPush(callId: "call-abc-001", hubId: "hub-uuid-001")
        #expect(svc.pendingCallHubIdForTesting("call-abc-001") == "hub-uuid-001")
    }

    @Test func pendingCallHubIdRemovedAfterConsumption() {
        let svc = LinphoneService()
        svc.handleVoipPush(callId: "call-abc-001", hubId: "hub-uuid-001")
        svc.consumePendingCallHubForTesting("call-abc-001")
        #expect(svc.pendingCallHubIdForTesting("call-abc-001") == nil)
    }

    @Test func separateCallIdsAreTrackedIndependently() {
        let svc = LinphoneService()
        svc.handleVoipPush(callId: "call-aaa", hubId: "hub-001")
        svc.handleVoipPush(callId: "call-bbb", hubId: "hub-002")
        #expect(svc.pendingCallHubIdForTesting("call-aaa") == "hub-001")
        #expect(svc.pendingCallHubIdForTesting("call-bbb") == "hub-002")
    }

    @Test func unknownCallIdReturnsNil() {
        let svc = LinphoneService()
        #expect(svc.pendingCallHubIdForTesting("call-unknown") == nil)
    }

    @Test func overwritingCallIdUpdatesHubId() {
        let svc = LinphoneService()
        svc.handleVoipPush(callId: "call-abc-001", hubId: "hub-uuid-001")
        svc.handleVoipPush(callId: "call-abc-001", hubId: "hub-uuid-002")
        #expect(svc.pendingCallHubIdForTesting("call-abc-001") == "hub-uuid-002")
    }
}

// MARK: - LinphoneServiceCoreTests
//
// These start the real liblinphone Core — the SDK is linked through the `linphonesw`
// Swift package (apps/ios/project.yml). They pin what a started Core does to the DEVICE
// before any account exists, because the app starts one at launch for every user, on
// shift or not: which ports it binds, which of its own key stores it creates, where it
// writes them, and whether they reach a backup.
//
// Registration is deliberately NOT exercised: `/api/telephony/sip-token` hands out the
// hub's shared trunk credential (#1203), so the registration path stays unwired until
// that is redesigned. Nothing here may send a REGISTER.

@MainActor
struct LinphoneServiceCoreTests {

    /// Start a Core the way the app does, return its configuration, and stop it.
    /// Fails — never skips — when no Core exists, which is what a build without the SDK
    /// produces. Stopping matters: these all share one process and one state directory, so
    /// leaking Cores would leave several live stacks iterating over the same SQLite files.
    private func startedCore() throws -> LinphoneService.CoreConfigurationSnapshot {
        let svc = LinphoneService()
        try svc.initialize(hubContext: HubContext())
        defer { svc.shutdown() }
        return try #require(
            svc.coreConfigurationForTesting(),
            "initialize() started no Core — the Linphone SDK is not linked into this build"
        )
    }

    @Test func startedCoreIsTlsOnlyAndBindsNothing() throws {
        let config = try startedCore()
        // A listening SIP socket on a volunteer's phone is reachable by anyone on the same
        // network and fingerprints the device as running a SIP stack. The SDK default binds
        // TLS on a random port (-1).
        //
        // Exact values, not "-2 or 0": DONTBIND (-2) leaves a transport ENABLED for
        // outbound use, and the registrar address is built from a server-supplied transport
        // string. Only TLS may be reachable at all, so udp/tcp/dtls must be OFF (0), not
        // merely unbound.
        #expect(config.configuredPorts == ["udp": 0, "tcp": 0, "tls": -2, "dtls": 0],
                "\(config.configuredPorts)")
        // Guard the next assertion against passing vacuously: a nil `transportsUsed` is
        // what a failed apply looks like, and it flattens to all-zeros.
        #expect(config.transportsUsedPresent, "Core reported no transportsUsed at all")
        #expect(config.boundPorts.values.allSatisfy { $0 <= 0 }, "bound: \(config.boundPorts)")
    }

    @Test func startedCoreDoesNotRegisterForPushKit() throws {
        // liblinphone's push support creates its own PKPushRegistry. PushKit/CallKit stays
        // off until it is verified on a device (project.yml `voip` note).
        #expect(try startedCore().pushNotificationEnabled == false)
    }

    @Test func startedCoreLeavesCallKitModeOff() throws {
        // In callkit mode liblinphone suppresses its own ring tone and defers presenting
        // the call to the app's CXProvider. There is no CXProvider, so `true` means a
        // foreground call that arrives silently. This failing is the signal that someone
        // flipped it without adding the CallKit integration (#748).
        #expect(try startedCore().callkitEnabled == false)
    }

    @Test func startedCoreDoesNotGenerateLimeKeys() throws {
        // liblinphone's own messaging E2EE. Unused here — this app's E2EE is
        // packages/crypto — but an enabled engine persists an X25519 identity and one-time
        // prekeys, and will upload them given a server URL. Key material we neither use nor
        // rotate must not exist.
        #expect(try startedCore().limeX3DhEnabled == false)
    }

    @Test func startedCoreKeepsItsStateOffBackupAndOutOfTheSdkDefaultDirectory() throws {
        let config = try startedCore()
        // liblinphone's data dir and file names are compiled in, NOT derived from
        // configPath: a Core started with configPath: nil still creates linphone.db,
        // call-history.db, friends.db, x3dh.c25519.sqlite3 and zrtp-secrets.db. The SDK
        // default location is inside the iCloud/iTunes backup, so once calls flow the call
        // log would carry caller SIP URIs off the device in cleartext SQLite.
        let path = try #require(config.stateDirectoryPath)
        #expect(path.hasSuffix("/llamenos-sip"), "state directory is \(path)")
        #expect(config.stateDirectoryExcludedFromBackup, "state directory is in the backup")
        #expect(config.sdkDefaultDirectoryExists == false,
                "liblinphone wrote to its compiled-in Application Support/linphone directory")
    }

    @Test func startedCoreDoesNotLogSipMessages() throws {
        // belle-sip prints whole SIP messages — headers, AOR, Contact, and once calls flow
        // the caller's number — at Message and below. Asserted against liblinphone's own
        // log-level mask getter, not against the value we assigned.
        let config = try startedCore()
        #expect(config.sdkLogExcludesSipMessages,
                "SDK log level mask is \(config.sdkLogLevelMask)")
    }

    @Test func startedCoreHasNoAccounts() throws {
        #expect(try startedCore().accountCount == 0)
    }

    @Test func startedCoreRefusesWeakMedia() throws {
        // Which suite is negotiated (SRTP-SDES vs DTLS-SRTP) is #1173's cross-client
        // decision and is being settled in the Android transport work, so this does not
        // assert either one. It does exclude both None (0) and ZRTP (2): ZRTP offers plain
        // RTP/AVP in the SDP and agrees keys in-band on the media path, so media is
        // unencrypted until the DH completes, and its MITM protection rests on a short
        // authentication string this app has no UI for.
        let config = try startedCore()
        #expect(config.mediaEncryptionMandatory)
        #expect([1, 3].contains(config.mediaEncryption),
                "mediaEncryption rawValue \(config.mediaEncryption) is neither SRTP (1) nor DTLS (3)")
    }

    @Test func initializeIsIdempotent() throws {
        // LlamenosApp calls initialize from the root view's onAppear, which a second scene
        // or a scene reconnection fires again on this same object. A second Core would
        // auto-iterate alongside the first over one set of SQLite files.
        let svc = LinphoneService()
        try svc.initialize(hubContext: HubContext())
        defer { svc.shutdown() }
        let first = try #require(svc.coreConfigurationForTesting())
        try svc.initialize(hubContext: HubContext())
        #expect(try #require(svc.coreConfigurationForTesting()) == first)
    }

    @Test func startedCoreOffersOnlyOpusAndPcmu() throws {
        #expect(try startedCore().enabledAudioCodecs == ["opus", "PCMU"])
    }

    @Test func registerBeforeInitializeThrowsNotInitialized() throws {
        // Before the SDK was linked this call compiled to a no-op and "succeeded".
        let svc = LinphoneService()
        // Decoded from the server's recorded bytes, not built here: a token constructed
        // in Swift is what made this test pass against a model the server could never
        // satisfy (#1659). See `SipTokenFixture`.
        let params = try SipTokenFixture.token()
        #expect(throws: LinphoneError.self) {
            try svc.registerHubAccount(hubId: "hub-uuid-001", sipParams: params)
        }
    }

    @Test func registerAppliesTheIssuedCredentialToAStartedCore() throws {
        // The decode fix is only half of #1659: `registerHubAccount` previously set the
        // identity and server addresses and nothing else, so even a token that HAD
        // decoded produced an account with no password (401 on the first REGISTER), no
        // NAT policy (host candidates only), the SDK's bundled CA set instead of the
        // published anchor, and a hardcoded media encryption the registrar's endpoint
        // cannot negotiate. Assert it reaches liblinphone's own state.
        let svc = LinphoneService()
        try svc.initialize(hubContext: HubContext())
        defer { svc.shutdown() }

        let token = try SipTokenFixture.token()
        try svc.registerHubAccount(hubId: "hub-uuid-001", sipParams: token)

        let applied = try #require(svc.registrationForTesting(hubId: "hub-uuid-001"))
        #expect(applied.identityAddress == "sip:\(token.sip.username)@\(token.sip.domain)")
        #expect(applied.hasAuthInfo, "no AuthInfo means a 401 on the first REGISTER")
        #expect(applied.registerEnabled)
        #expect(applied.expires == LinphoneService.registerExpiresSeconds)
        // DTLS-SRTP, because that is what the token names — not a client-side constant.
        #expect(applied.mediaEncryption == LinphoneService.MediaEncryptionRawValue.dtls)
        #expect(applied.mediaEncryptionMandatory)
        // ICE with a relay, which is the whole point of #1657.
        #expect(applied.iceEnabled)
        #expect(applied.stunEnabled)
        #expect(applied.turnEnabled)
        #expect(applied.stunServer == "turn.hotline.example.org:3478")
        #expect(applied.stunServerUsername == token.sip.iceServers.first { $0.isTurnRelay }?.username)
        // EXACTLY ONE relay transport, UDP preferred — liblinphone supports no more than
        // one and refuses the second. Asserting all the issued ones is what caught that.
        #expect(applied.udpTurnTransportEnabled)
        #expect(!applied.tcpTurnTransportEnabled)
        #expect(!applied.tlsTurnTransportEnabled)

        svc.unregisterHubAccount(hubId: "hub-uuid-001")
        #expect(svc.registrationForTesting(hubId: "hub-uuid-001") == nil)
    }

    @Test func aStunOnlyTokenRegistersWithoutARelay() throws {
        // What a host with no TURN_HOST/TURN_SECRET hands a client (#1657). It must still
        // register: a volunteer reachable on a reflexive candidate is better than one who
        // is not registered at all. The relay is simply absent, and visibly so.
        let svc = LinphoneService()
        try svc.initialize(hubContext: HubContext())
        defer { svc.shutdown() }

        try svc.registerHubAccount(hubId: "hub-uuid-001", sipParams: try SipTokenFixture.token("sipTokenStunOnly"))
        let applied = try #require(svc.registrationForTesting(hubId: "hub-uuid-001"))
        #expect(applied.iceEnabled)
        #expect(applied.stunEnabled)
        #expect(!applied.turnEnabled, "no credentials were issued, so no relay may be advertised")
        #expect(applied.stunServer == "sip.hotline.example.org:3478")
    }

    @Test func aTcpOnlyRelayCannotBeCarriedByThisSdk() throws {
        // A LIMITATION, pinned — not a behaviour anyone wants.
        //
        // MEASURED on linphone-sdk 5.5.23: `tcpTurnTransportEnabled = true` takes on a
        // NatPolicy object, and is then LOST when the policy is assigned to
        // AccountParams (`turnEnabled` survives, the transport flags do not). So a
        // deployment whose relay is reachable only over TCP gets TURN enabled with no
        // transport, and no relay candidate.
        //
        // It does not affect the real path: `buildVolunteerSipParams` always issues a UDP
        // relay entry alongside the TCP one, and UDP is the one to prefer regardless. This
        // test exists so an SDK upgrade that fixes it FAILS here and gets noticed, instead
        // of the limitation living on as a comment nobody rechecks.
        let svc = LinphoneService()
        try svc.initialize(hubContext: HubContext())
        defer { svc.shutdown() }

        let good = try SipTokenFixture.token()
        let relay = try #require(good.sip.iceServers.first { $0.isTurnRelay })
        let tcpOnly = SipTokenResponse(
            provider: good.provider,
            sip: SipAccountParams(
                domain: good.sip.domain,
                transport: good.sip.transport,
                username: good.sip.username,
                password: good.sip.password,
                mediaEncryption: good.sip.mediaEncryption,
                iceServers: [
                    SipIceServer(url: "stun:turn.hotline.example.org:3478"),
                    SipIceServer(
                        url: "turn:turn.hotline.example.org:3478?transport=tcp",
                        username: relay.username,
                        credential: relay.credential
                    ),
                ]
            )
        )
        try svc.registerHubAccount(hubId: "hub-uuid-001", sipParams: tcpOnly)

        let applied = try #require(svc.registrationForTesting(hubId: "hub-uuid-001"))
        // The relay credential IS carried (the AuthInfo exists), and TURN is on...
        #expect(applied.hasTurnAuthInfo)
        #expect(applied.turnEnabled)
        // ...but no transport survives, so no relay candidate is gathered.
        #expect(!applied.tcpTurnTransportEnabled, "if this now passes, liblinphone carries TCP TURN — drop the UDP-only limitation")
        #expect(!applied.udpTurnTransportEnabled, "and UDP must not be substituted: the operator said TCP")
        // The reflexive candidate still stands, which is what makes this a degradation
        // rather than a failure: registration succeeds and a cone-NAT volunteer connects.
        #expect(applied.iceEnabled)
        #expect(applied.stunEnabled)
        #expect(applied.stunServer == "turn.hotline.example.org:3478")
    }

    @Test func relayTransportIsDerivedFromTheUriNotGuessed() {
        // `turns:` is TLS by scheme (RFC 7065) whatever the hint says, and a bare `turn:`
        // means UDP. A scheme that is not TURN at all has no relay transport.
        #expect(SipIceServer(url: "turn:r:3478").relayTransport == .udp)
        #expect(SipIceServer(url: "turn:r:3478?transport=udp").relayTransport == .udp)
        #expect(SipIceServer(url: "turn:r:3478?transport=tcp").relayTransport == .tcp)
        #expect(SipIceServer(url: "turn:r:3478?transport=tls").relayTransport == .tls)
        #expect(SipIceServer(url: "turns:r:5349").relayTransport == .tls)
        #expect(SipIceServer(url: "stun:r:3478").relayTransport == nil)
        // An unrecognised hint is nil rather than silently UDP: a relay reached over the
        // wrong transport allocates nothing, and guessing hides which it was.
        #expect(SipIceServer(url: "turn:r:3478?transport=sctp").relayTransport == nil)
    }

    @Test func registerRefusesAMediaEncryptionThisClientWillNotCarry() throws {
        // `none` is refused rather than honoured: a crisis hotline's volunteer leg does
        // not carry unencrypted media. So is anything unrecognised.
        let svc = LinphoneService()
        try svc.initialize(hubContext: HubContext())
        defer { svc.shutdown() }

        for value in ["none", "", "aes"] {
            #expect(LinphoneService.mediaEncryptionRawValueForTesting(value) == nil, "\(value) must be refused")
        }
        let raw = LinphoneService.MediaEncryptionRawValue.self
        #expect(LinphoneService.mediaEncryptionRawValueForTesting("dtls-srtp") == raw.dtls)
        #expect(LinphoneService.mediaEncryptionRawValueForTesting("DTLS") == raw.dtls)
        #expect(LinphoneService.mediaEncryptionRawValueForTesting("srtp") == raw.srtp)
        #expect(LinphoneService.mediaEncryptionRawValueForTesting("zrtp") == raw.zrtp)
    }

    @Test func registerRefusesATrustAnchorCarryingPrivateKeyMaterial() throws {
        // The worker strips key material before publishing (`certificatesOnly`), so this
        // is defence in depth — and the direction to fail in. A client that installs a
        // keypair as a trust anchor is a client whose SIP trust decision is unexamined.
        let svc = LinphoneService()
        try svc.initialize(hubContext: HubContext())
        defer { svc.shutdown() }

        let good = try SipTokenFixture.token()
        let poisoned = SipTokenResponse(
            provider: good.provider,
            sip: SipAccountParams(
                domain: good.sip.domain,
                transport: good.sip.transport,
                username: good.sip.username,
                password: good.sip.password,
                mediaEncryption: good.sip.mediaEncryption,
                iceServers: good.sip.iceServers,
                tlsTrustAnchorPem: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n"
            )
        )
        #expect(throws: LinphoneError.self) {
            try svc.registerHubAccount(hubId: "hub-uuid-001", sipParams: poisoned)
        }
        #expect(svc.registrationForTesting(hubId: "hub-uuid-001") == nil)
    }
}
