import Foundation

#if canImport(linphonesw)
import linphonesw
#endif

// MARK: - LinphoneServiceProtocol

/// Protocol for SIP account lifecycle operations. Implemented by `LinphoneService` for
/// production and by test doubles in unit tests.
protocol LinphoneServiceProtocol: AnyObject {
    func registerHubAccount(hubId: String, sipParams: SipTokenResponse) throws
    func unregisterHubAccount(hubId: String)
    func handleVoipPush(callId: String, hubId: String)
}

// MARK: - LinphoneError

enum LinphoneError: LocalizedError {
    case notInitialized
    case accountRegistrationFailed(String)
    case coreStartFailed(String)

    var errorDescription: String? {
        switch self {
        case .notInitialized:
            return "Linphone Core not initialized"
        case .accountRegistrationFailed(let msg):
            return "SIP account registration failed: \(msg)"
        case .coreStartFailed(let msg):
            return "Linphone Core failed to start: \(msg)"
        }
    }
}

// MARK: - SipTokenResponse

/// SIP credentials returned by `GET /api/hubs/{hubId}/telephony/sip-token`.
/// Used to register the volunteer's SIP account for the active shift.
struct SipTokenResponse: Decodable {
    let username: String
    let domain: String
    let password: String
    let transport: String
    let expiry: Int
}

// MARK: - LinphoneService

/// Manages a Linphone SIP core instance for real-time VoIP call handling.
///
/// One SIP account is registered per hub the volunteer is on-shift for.
/// The `pendingCallHubIds` map correlates incoming VoIP push payloads
/// (which carry a `callId` and `hubId`) with the Linphone `Call` object
/// that subsequently arrives in `onCallStateChanged`, so the hub context
/// can be switched before the call is presented to the volunteer.
///
/// The SDK is linked through the `linphonesw` Swift package (apps/ios/project.yml);
/// `#if canImport(linphonesw)` only matters for a build that drops that dependency.
@Observable
final class LinphoneService: LinphoneServiceProtocol {
    // MARK: - Private State

    /// callId → hubId map set by VoIP push before Linphone fires onCallStateChanged.
    private var pendingCallHubIds: [String: String] = [:]
    private let pendingCallLock = NSLock()
    private weak var hubContext: HubContext?

    #if canImport(linphonesw)
    private var core: Core?
    private var hubAccounts: [String: Account] = [:]

    /// liblinphone's LC_SIP_TRANSPORT_DONTBIND, which the Swift wrapper does not export.
    private static let sipTransportDontBind = -2
    #endif

    // MARK: - Initialization

    init() {}

    /// Configure the service with an app-wide HubContext and start the Linphone Core.
    /// Call this once from AppState or LlamenosApp after the hub context is ready.
    func initialize(hubContext: HubContext) throws {
        self.hubContext = hubContext
        #if canImport(linphonesw)
        let factory = Factory.Instance
        // No config path: nothing is persisted to a linphonerc. (A relative path resolves
        // against the process working directory, which is not writable on iOS.)
        let core = try factory.createCore(
            configPath: nil,
            factoryConfigPath: nil,
            systemContext: nil
        )

        // Client-only SIP: bind no listening socket. The SDK default binds TLS on a random
        // port on every interface — from app launch, on shift or not — which exposes the SIP
        // parser to anyone on the same network and fingerprints the device as running a SIP
        // stack. DONTBIND still lets a registered account connect out and receive calls over
        // that connection (liblinphone documents it for mobile clients).
        let transports = try factory.createTransports()
        transports.udpPort = Self.sipTransportDontBind
        transports.tcpPort = Self.sipTransportDontBind
        transports.tlsPort = Self.sipTransportDontBind
        transports.dtlsPort = 0 // disabled
        try core.setTransports(newValue: transports)

        // liblinphone's push support registers its own PKPushRegistry. PushKit/CallKit stays
        // off until verified on a device — see the `voip` note in apps/ios/project.yml.
        core.pushNotificationEnabled = false

        core.callkitEnabled = true
        try core.setMediaencryption(newValue: .SRTP)
        core.mediaEncryptionMandatory = true

        // Allow only Opus and G.711 µ-law; disable all others.
        for pt in core.audioPayloadTypes {
            _ = pt.enable(enabled: pt.mimeType == "opus" || pt.mimeType == "PCMU")
        }

        setupCoreDelegate(core: core)
        try core.start()
        self.core = core
        #endif
    }

    // MARK: - SIP Account Management

    /// Register a SIP account for the given hub. Called when the volunteer clocks in.
    func registerHubAccount(hubId: String, sipParams: SipTokenResponse) throws {
        #if canImport(linphonesw)
        guard let core else { throw LinphoneError.notInitialized }
        let params = try core.createAccountParams()
        let identity = try Factory.Instance.createAddress(
            addr: "sip:\(sipParams.username)@\(sipParams.domain)"
        )
        try params.setIdentityaddress(newValue: identity)
        let server = try Factory.Instance.createAddress(
            addr: "sip:\(sipParams.domain);transport=\(sipParams.transport)"
        )
        try params.setServeraddress(newValue: server)
        params.registerEnabled = true
        let account = try core.createAccount(params: params)
        try core.addAccount(account: account)
        hubAccounts[hubId] = account
        #endif
    }

    /// Unregister the SIP account for the given hub. Called when the volunteer clocks out.
    func unregisterHubAccount(hubId: String) {
        #if canImport(linphonesw)
        guard let account = hubAccounts.removeValue(forKey: hubId) else { return }
        core?.removeAccount(account: account)
        #endif
    }

    // MARK: - VoIP Push Handling

    /// Record the hub ID that triggered a VoIP push for a given call ID.
    /// Called by PushKit before Linphone fires `onCallStateChanged(.IncomingReceived)`.
    func handleVoipPush(callId: String, hubId: String) {
        pendingCallLock.lock()
        defer { pendingCallLock.unlock() }
        pendingCallHubIds[callId] = hubId
    }

    // MARK: - Core Delegate (Linphone)

    #if canImport(linphonesw)
    private func setupCoreDelegate(core: Core) {
        let delegate = CoreDelegateStub(
            onCallStateChanged: { [weak self] _, call, state, _ in
                guard let self else { return }
                let callId = call.callLog?.callId ?? ""
                switch state {
                case .IncomingReceived:
                    self.pendingCallLock.lock()
                    let hubId = self.pendingCallHubIds.removeValue(forKey: callId)
                    self.pendingCallLock.unlock()
                    if let hubId {
                        Task { @MainActor in
                            self.hubContext?.setActiveHub(hubId)
                        }
                    }
                case .Released, .End:
                    self.pendingCallLock.lock()
                    self.pendingCallHubIds.removeValue(forKey: callId)
                    self.pendingCallLock.unlock()
                default:
                    break
                }
            }
        )
        core.addDelegate(delegate: delegate)
    }
    #endif

    // MARK: - Test-only Accessors

    #if DEBUG
    /// Returns the pending hub ID for a call ID without consuming it. For unit tests only.
    func pendingCallHubIdForTesting(_ callId: String) -> String? {
        pendingCallLock.lock()
        defer { pendingCallLock.unlock() }
        return pendingCallHubIds[callId]
    }

    /// Remove the pending hub ID for a call ID, simulating post-consumption. For unit tests only.
    func consumePendingCallHubForTesting(_ callId: String) {
        pendingCallLock.lock()
        pendingCallHubIds.removeValue(forKey: callId)
        pendingCallLock.unlock()
    }

    /// SDK-independent snapshot of the running Core's configuration, so unit tests can
    /// assert it without importing `linphonesw`. Nil until `initialize` has started a Core
    /// — which is also what a build without the SDK returns, so tests fail loudly if the
    /// SDK is ever unlinked.
    struct CoreConfigurationSnapshot: Equatable {
        let pushNotificationEnabled: Bool
        let srtpMandatory: Bool
        let enabledAudioCodecs: Set<String>
        /// Configured SIP ports per transport: 0 = disabled, -1 = random, -2 = do not bind.
        let configuredPorts: [String: Int]
        /// Ports the Core actually bound; a value <= 0 means that transport bound nothing.
        let boundPorts: [String: Int]
        let accountCount: Int
    }

    func coreConfigurationForTesting() -> CoreConfigurationSnapshot? {
        #if canImport(linphonesw)
        guard let core else { return nil }
        func ports(_ t: Transports?) -> [String: Int] {
            ["udp": t?.udpPort ?? 0, "tcp": t?.tcpPort ?? 0, "tls": t?.tlsPort ?? 0, "dtls": t?.dtlsPort ?? 0]
        }
        return CoreConfigurationSnapshot(
            pushNotificationEnabled: core.pushNotificationEnabled,
            srtpMandatory: core.mediaEncryption == .SRTP && core.isMediaEncryptionMandatory,
            enabledAudioCodecs: Set(core.audioPayloadTypes.filter { $0.enabled() }.map(\.mimeType)),
            configuredPorts: ports(core.transports),
            boundPorts: ports(core.transportsUsed),
            accountCount: core.accountList.count
        )
        #else
        return nil
        #endif
    }
    #endif
}
