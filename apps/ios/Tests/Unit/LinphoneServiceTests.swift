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
// Swift package (apps/ios/project.yml). They pin what a started Core exposes BEFORE any
// account exists, because the app starts it at launch for every user, on shift or not.
//
// Registration is deliberately NOT exercised: `/api/telephony/sip-token` hands out the
// hub's shared trunk credential (#1203), so the registration path stays unwired until
// that is redesigned. Nothing here may send a REGISTER.

@MainActor
struct LinphoneServiceCoreTests {

    /// Start a Core the way the app does and return its configuration. Fails — never
    /// skips — when no Core exists, which is what a build without the SDK produces.
    private func startedCore() throws -> LinphoneService.CoreConfigurationSnapshot {
        let svc = LinphoneService()
        try svc.initialize(hubContext: HubContext())
        return try #require(
            svc.coreConfigurationForTesting(),
            "initialize() started no Core — the Linphone SDK is not linked into this build"
        )
    }

    @Test func startedCoreListensOnNoSipPort() throws {
        let config = try startedCore()
        // A listening SIP socket on a volunteer's phone is reachable by anyone on the same
        // network and fingerprints the device as running a SIP stack. The SDK default binds
        // TLS on a random port (-1); every transport must be do-not-bind (-2) or off (0).
        #expect(config.configuredPorts.values.allSatisfy { $0 == -2 || $0 == 0 }, "\(config.configuredPorts)")
        #expect(config.boundPorts.values.allSatisfy { $0 <= 0 }, "bound: \(config.boundPorts)")
    }

    @Test func startedCoreDoesNotRegisterForPushKit() throws {
        // liblinphone's push support creates its own PKPushRegistry. PushKit/CallKit stays
        // off until it is verified on a device (project.yml `voip` note).
        #expect(try startedCore().pushNotificationEnabled == false)
    }

    @Test func startedCoreHasNoAccounts() throws {
        #expect(try startedCore().accountCount == 0)
    }

    @Test func startedCoreMandatesSrtp() throws {
        #expect(try startedCore().srtpMandatory)
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
