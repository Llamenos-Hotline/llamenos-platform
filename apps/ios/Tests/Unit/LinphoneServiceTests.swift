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

    @Test func registerBeforeInitializeThrowsNotInitialized() {
        // Before the SDK was linked this call compiled to a no-op and "succeeded".
        let svc = LinphoneService()
        let params = SipTokenResponse(
            username: "user", domain: "sip.example.org",
            password: "pass", transport: "tls", expiry: 3600
        )
        #expect(throws: LinphoneError.self) {
            try svc.registerHubAccount(hubId: "hub-uuid-001", sipParams: params)
        }
    }
}
