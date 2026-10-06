import Foundation
import Testing
@testable import Llamenos

// MARK: - LinphoneServiceTests
//
// The Linphone SDK is not linked into this build, so every liblinphone call is compiled
// out. What IS tested here, in every build, is the SDK-independent logic that decides
// behaviour: the call→hub map, ring-vs-answer hub routing, the account configuration
// (including the AuthInfo that carries the password), and per-identity account
// bookkeeping. A real SIP REGISTER is NOT exercised anywhere — see #1188.

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

// MARK: - Ring vs answer hub routing (#1188 item 5)

/// CLAUDE.md multi-hub routing axiom: a ringing call must never change the active hub.
/// Only answering, with the app unlocked, may switch to the call's hub.
struct LinphoneCallRoutingTests {
    private func makeService(activeHub: String, unlocked: Bool) throws -> (LinphoneService, HubContext) {
        let hubContext = HubContext()
        hubContext.setActiveHub(activeHub)
        let svc = LinphoneService()
        try svc.initialize(hubContext: hubContext, isAppUnlocked: { unlocked })
        return (svc, hubContext)
    }

    @Test func ringingDoesNotSwitchActiveHub() throws {
        let (svc, hubContext) = try makeService(activeHub: "hub-A", unlocked: true)
        svc.handleVoipPush(callId: "call-1", hubId: "hub-B")

        let switched = svc.handleCallEvent(callId: "call-1", event: .ringing)

        #expect(switched == nil)
        #expect(hubContext.activeHubId == "hub-A")
        #expect(svc.pendingCallHubIdForTesting("call-1") == "hub-B", "mapping kept for the answer")
    }

    @Test func answeringWhileUnlockedSwitchesToTheCallsHub() throws {
        let (svc, hubContext) = try makeService(activeHub: "hub-A", unlocked: true)
        svc.handleVoipPush(callId: "call-1", hubId: "hub-B")
        svc.handleCallEvent(callId: "call-1", event: .ringing)

        let switched = svc.handleCallEvent(callId: "call-1", event: .answered)

        #expect(switched == "hub-B")
        #expect(hubContext.activeHubId == "hub-B")
        #expect(svc.pendingCallHubIdForTesting("call-1") == nil)
    }

    @Test func answeringWhileLockedDoesNotSwitch() throws {
        let (svc, hubContext) = try makeService(activeHub: "hub-A", unlocked: false)
        svc.handleVoipPush(callId: "call-1", hubId: "hub-B")

        let switched = svc.handleCallEvent(callId: "call-1", event: .answered)

        #expect(switched == nil)
        #expect(hubContext.activeHubId == "hub-A")
    }

    @Test func endedCallDropsTheMapping() throws {
        let (svc, hubContext) = try makeService(activeHub: "hub-A", unlocked: true)
        svc.handleVoipPush(callId: "call-1", hubId: "hub-B")

        svc.handleCallEvent(callId: "call-1", event: .ended)

        #expect(svc.pendingCallHubIdForTesting("call-1") == nil)
        #expect(svc.handleCallEvent(callId: "call-1", event: .answered) == nil)
        #expect(hubContext.activeHubId == "hub-A")
    }

    @Test func answeringAnUnmappedCallDoesNothing() throws {
        let (svc, hubContext) = try makeService(activeHub: "hub-A", unlocked: true)
        #expect(svc.handleCallEvent(callId: "call-unknown", event: .answered) == nil)
        #expect(hubContext.activeHubId == "hub-A")
    }
}

// MARK: - SIP account configuration (#1188 item 1)

struct SipAccountConfigurationTests {
    private func token(
        username: String = "vol_abc",
        domain: String = "sip.example.org",
        password: String = "s3cret",
        transport: String = "tls"
    ) -> SipTokenResponse {
        SipTokenResponse(
            provider: "asterisk",
            sip: .init(
                domain: domain,
                transport: transport,
                username: username,
                password: password,
                iceServers: [],
                mediaEncryption: "srtp"
            )
        )
    }

    @Test func authInfoCarriesThePassword() throws {
        let config = try SipAccountConfiguration(token())
        #expect(config.auth == SipAccountConfiguration.Auth(
            username: "vol_abc",
            userId: "vol_abc",
            password: "s3cret",
            realm: nil,
            domain: "sip.example.org"
        ))
    }

    @Test func identityAndRegistrarUseTls() throws {
        let config = try SipAccountConfiguration(token(transport: "TLS"))
        #expect(config.identityURI == "sip:vol_abc@sip.example.org")
        #expect(config.serverURI == "sip:sip.example.org;transport=tls")
    }

    @Test(arguments: ["udp", "tcp", "", "ws"])
    func nonTlsTransportIsRefused(transport: String) {
        #expect(throws: LinphoneError.insecureTransport(transport)) {
            try SipAccountConfiguration(token(transport: transport))
        }
    }

    @Test func emptyPasswordIsRefused() {
        #expect(throws: LinphoneError.invalidCredentials("password")) {
            try SipAccountConfiguration(token(password: ""))
        }
    }

    @Test(arguments: ["", "a@b", "a;transport=udp", "a b", "a>x", "a:b"])
    func usernameThatCouldInjectIntoTheUriIsRefused(username: String) {
        #expect(throws: LinphoneError.invalidCredentials("username")) {
            try SipAccountConfiguration(token(username: username))
        }
    }

    @Test(arguments: ["", "evil@sip.example.org", "sip.example.org;lr", "sip.example.org?x=1", "a b"])
    func domainThatCouldInjectIntoTheUriIsRefused(domain: String) {
        #expect(throws: LinphoneError.invalidCredentials("domain")) {
            try SipAccountConfiguration(token(domain: domain))
        }
    }

    @Test func domainWithPortIsAccepted() throws {
        let config = try SipAccountConfiguration(token(domain: "sip.example.org:5061"))
        #expect(config.serverURI == "sip:sip.example.org:5061;transport=tls")
    }

    /// In a build without the SDK, registration must fail loudly — never look successful.
    @Test func registrationInThisBuildIsNeverSilentlySuccessful() {
        let svc = LinphoneService()
        let expected: LinphoneError = LinphoneService.isSdkLinked ? .notInitialized : .sdkNotLinked
        #expect(throws: expected) {
            try svc.registerHubAccount(hubId: "hub-A", sipParams: token())
        }
    }

    /// Credentials are validated before the SDK check, so insecure config is caught in every build.
    @Test func insecureCredentialsAreRejectedEvenWithoutTheSdk() {
        let svc = LinphoneService()
        #expect(throws: LinphoneError.insecureTransport("udp")) {
            try svc.registerHubAccount(hubId: "hub-A", sipParams: token(transport: "udp"))
        }
    }
}

// MARK: - Per-hub account bookkeeping (#1188 item 3, iOS)

struct SipAccountRegistryTests {
    @Test func memberHubsSharingCredentialsShareOneAccount() {
        var registry = SipAccountRegistry<String>()
        registry.bind(hubId: "hub-A", identity: "sip:vol@x", handle: "account-1")
        registry.bind(hubId: "hub-B", identity: "sip:vol@x", handle: "account-1")

        #expect(registry.hubIds == ["hub-A", "hub-B"])
        #expect(registry.accountCount == 1)
    }

    @Test func accountSurvivesUntilItsLastHubIsUnbound() {
        var registry = SipAccountRegistry<String>()
        registry.bind(hubId: "hub-A", identity: "sip:vol@x", handle: "account-1")
        registry.bind(hubId: "hub-B", identity: "sip:vol@x", handle: "account-1")

        #expect(registry.unbind(hubId: "hub-A") == nil, "hub-B still uses the account")
        #expect(registry.unbind(hubId: "hub-B") == "account-1")
        #expect(registry.accountCount == 0)
    }

    @Test func distinctCredentialsGetDistinctAccounts() {
        var registry = SipAccountRegistry<String>()
        registry.bind(hubId: "hub-A", identity: "sip:vol@x", handle: "account-1")
        registry.bind(hubId: "hub-B", identity: "sip:vol@y", handle: "account-2")

        #expect(registry.accountCount == 2)
        #expect(registry.handle(forIdentity: "sip:vol@y") == "account-2")
    }

    @Test func rebindingAHubToNewCredentialsReleasesTheOrphanedAccount() {
        var registry = SipAccountRegistry<String>()
        registry.bind(hubId: "hub-A", identity: "sip:vol@x", handle: "account-1")

        let orphan = registry.bind(hubId: "hub-A", identity: "sip:vol@y", handle: "account-2")

        #expect(orphan == "account-1")
        #expect(registry.identity(forHub: "hub-A") == "sip:vol@y")
        #expect(registry.accountCount == 1)
    }

    @Test func unbindAllReturnsEachAccountOnce() {
        var registry = SipAccountRegistry<String>()
        registry.bind(hubId: "hub-A", identity: "sip:vol@x", handle: "account-1")
        registry.bind(hubId: "hub-B", identity: "sip:vol@x", handle: "account-1")
        registry.bind(hubId: "hub-C", identity: "sip:vol@y", handle: "account-2")

        #expect(registry.unbindAll().sorted() == ["account-1", "account-2"])
        #expect(registry.hubIds.isEmpty)
    }
}
