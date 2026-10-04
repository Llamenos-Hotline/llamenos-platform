import Foundation

#if canImport(linphonesw)
import linphonesw
#endif

// MARK: - LinphoneServiceProtocol

/// Protocol for SIP account lifecycle operations. Implemented by `LinphoneService` for
/// production and by test doubles in unit tests.
protocol LinphoneServiceProtocol: AnyObject {
    func registerHubAccount(hubId: String, sipParams: SIPTokenResponse) throws
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

// MARK: - SIP credentials
// SIP credentials returned by `GET /api/hubs/{hubId}/telephony/sip-token`
// decode to the generated `SIPTokenResponse`.

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
    private var stateDirectory: URL?

    /// liblinphone's LC_SIP_TRANSPORT_DONTBIND, which the Swift wrapper does not export:
    /// the transport stays usable for outbound connections but binds no listening socket.
    private static let sipTransportDontBind = -2
    /// 0 turns a transport off entirely. (-1, the SDK default, means "bind a random port".)
    private static let sipTransportDisabled = 0

    /// Directory liblinphone is pointed at for every file it keeps. Chosen rather than
    /// inherited: see `prepareStateDirectory()`.
    private static let stateDirectoryName = "llamenos-sip"

    /// The only SDK log levels we allow through. Everything at Message and below is
    /// excluded because that is where belle-sip prints whole SIP messages.
    private static let quietLogMask: LogLevel = [.Error, .Fatal]
    /// Levels that must never be enabled.
    private static let forbiddenLogMask: LogLevel = [.Debug, .Trace, .Message, .Warning]
    #endif

    // MARK: - Initialization

    init() {}

    /// Configure the service with an app-wide HubContext and start the Linphone Core.
    ///
    /// Idempotent: `LlamenosApp` calls this from the root view's `onAppear`, which is not
    /// once-per-process — a second scene (iPad multi-window, Stage Manager) or a scene
    /// reconnection fires it again on this same long-lived object. Without the guard that
    /// started a SECOND Core, auto-iterating alongside the first, with two handle sets over
    /// one set of SQLite files.
    func initialize(hubContext: HubContext) throws {
        self.hubContext = hubContext
        #if canImport(linphonesw)
        guard core == nil else { return }

        let factory = Factory.Instance

        // Point liblinphone at a directory we own, prepared before the Core exists because
        // it creates its stores during `start()`.
        let stateDirectory = try Self.prepareStateDirectory()
        factory.dataDir = stateDirectory.path
        factory.configDir = stateDirectory.path

        // belle-sip writes whole SIP messages — AOR, Contact, and once calls flow the
        // caller's number — at Message and below. Pin the mask instead of inheriting
        // whatever the SDK's default is this release.
        //
        // The mask, not `logLevel`: `logLevel` is a willSet-only stored property on the
        // Swift wrapper, so it does not read back from liblinphone (measured — a test
        // asserting it came back false). `logLevelMask` has a real C getter, so what the
        // test checks is the library's actual state rather than our own assignment.
        LoggingService.Instance.logLevelMask = UInt(Self.quietLogMask.rawValue)

        // No config path: nothing is persisted to a linphonerc. (A relative path resolves
        // against the process working directory, which is not writable on iOS.) This does
        // NOT cover the SQLite stores — those follow `factory.dataDir` above.
        let core = try factory.createCore(
            configPath: nil,
            factoryConfigPath: nil,
            systemContext: nil
        )

        // Client-only SIP, TLS only.
        //
        // The SDK default binds TLS on a random port on every interface — from app launch,
        // on shift or not — which exposes belle-sip's parser to anyone on the same network
        // and fingerprints the device as running a SIP stack. DONTBIND removes the listener
        // while still letting a registered account connect out and receive calls over that
        // connection (liblinphone documents it for mobile clients).
        //
        // UDP and TCP are 0, not DONTBIND: DONTBIND leaves a transport ENABLED for outbound
        // use, and the registrar address is built from a server-supplied `transport` value
        // (`registerHubAccount`). A hub config answering "udp" would then put the digest
        // challenge, the AOR, the Contact with this device's IP, and later the whole
        // INVITE/SDP on the wire in cleartext. Turning them off makes that a failed
        // registration instead, which is the right direction to fail in.
        let transports = try factory.createTransports()
        transports.udpPort = Self.sipTransportDisabled
        transports.tcpPort = Self.sipTransportDisabled
        transports.tlsPort = Self.sipTransportDontBind
        transports.dtlsPort = Self.sipTransportDisabled
        try core.setTransports(newValue: transports)

        // liblinphone's push support registers its own PKPushRegistry. PushKit/CallKit stays
        // off until verified on a device — see the `voip` note in apps/ios/project.yml.
        core.pushNotificationEnabled = false

        // callkitEnabled = false, deliberately, and NOT "left as the SDK default".
        // In callkit mode liblinphone suppresses its own ring tone and defers presenting the
        // call (and activating the audio session) to the app's CXProvider. There is no
        // CXProvider in this app, so `true` would make the first foreground call arrive
        // silently. Paired with pushNotificationEnabled = false it is also an inconsistent
        // state to leave behind. False forces the flip to arrive in the same change as the
        // CallKit integration (#748).
        core.callkitEnabled = false

        // LIME X3DH is liblinphone's own messaging E2EE. This app's E2EE is packages/crypto
        // and it has no liblinphone chat, but an enabled engine still generates and persists
        // an X25519 identity plus one-time prekeys (a ~56 KiB x3dh sqlite store appears on a
        // Core that has never had an account) and will upload them to a LIME server the
        // moment account params carry a URL. Key material we neither use nor rotate.
        core.limeX3DhEnabled = false

        // SRTP-SDES, mandatory. Which suite the PBX and the clients agree on (SRTP-SDES vs
        // DTLS-SRTP) is #1173's cross-client decision and the Android transport work owns
        // it; this carries main's existing value rather than pre-empting it. The test asserts
        // the invariant that survives either answer — see `startedCoreRefusesWeakMedia`.
        try core.setMediaencryption(newValue: .SRTP)
        core.mediaEncryptionMandatory = true

        // TODO(#1173): liblinphone verifies SIP/TLS against its own bundled rootca.pem, not
        // the iOS trust store, so neither the app's NSAppTransportSecurity nor any
        // URLSession-level pinning applies to the PBX connection. When TLS to the registrar
        // is wired, set `core.rootCaData` (or `core.rootCa`) to our own trust anchor and
        // leave `verifyServerCertificates` on.

        // Allow only Opus and G.711 µ-law; disable all others.
        for pt in core.audioPayloadTypes {
            _ = pt.enable(enabled: pt.mimeType == "opus" || pt.mimeType == "PCMU")
        }

        setupCoreDelegate(core: core)
        try core.start()
        self.core = core
        self.stateDirectory = stateDirectory
        #endif
    }

    /// Stop and release the Core. Safe to call when none is running, and present in a
    /// build without the SDK so that callers — including the tests whose whole job is to
    /// FAIL when the SDK is missing — still compile and reach their assertion.
    func shutdown() {
        #if canImport(linphonesw)
        core?.stop()
        core = nil
        hubAccounts.removeAll()
        #endif
    }

    #if canImport(linphonesw)
    /// Create the directory liblinphone keeps its state in, excluded from backup and
    /// protected at rest, and return it.
    ///
    /// liblinphone does NOT derive these from `configPath`: the data directory and the file
    /// names are compiled in, so a Core started with `configPath: nil` still creates
    /// `linphone.db`, `call-history.db`, `friends.db`, `x3dh.c25519.sqlite3` and
    /// `zrtp-secrets.db` under `Library/Application Support/linphone/` — measured on a Core
    /// that had never had an account. That location is in the iCloud/iTunes backup by
    /// default and carries only the container's default protection class, so once calls flow
    /// `linphone.db`'s call log would put caller SIP URIs and numbers in cleartext SQLite,
    /// off the device, outside our at-rest model. Hence an app-owned directory instead.
    ///
    /// `.complete` means these files are unreadable while the device is locked. That is
    /// correct while the app is foreground-only (#748 decision (a) — no PushKit wake, so the
    /// Core only ever starts with the device unlocked). It MUST be revisited in the change
    /// that adds the `voip` background mode, which is why a test pins the current value.
    private static func prepareStateDirectory() throws -> URL {
        let base = try FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask,
            appropriateFor: nil, create: true
        )
        var dir = base.appendingPathComponent(stateDirectoryName, isDirectory: true)
        try FileManager.default.createDirectory(
            at: dir, withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.complete]
        )
        var resourceValues = URLResourceValues()
        resourceValues.isExcludedFromBackup = true
        try dir.setResourceValues(resourceValues)
        return dir
    }
    #endif

    // MARK: - SIP Account Management

    /// Register a SIP account for the given hub. Called when the volunteer clocks in.
    func registerHubAccount(hubId: String, sipParams: SIPTokenResponse) throws {
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
        /// False unless a CXProvider exists — see the note in `initialize`.
        let callkitEnabled: Bool
        /// liblinphone's own messaging E2EE; unused here and must stay off.
        let limeX3DhEnabled: Bool
        /// `MediaEncryption.rawValue`: 0 None, 1 SRTP, 2 ZRTP, 3 DTLS. The raw value rather
        /// than a derived Bool so a later reader can tighten the assertion without
        /// re-plumbing this struct.
        let mediaEncryption: Int
        /// The Core-level default, copied into call params. Not a whole-system guarantee:
        /// a later `createCallParams` path can still override it per call.
        let mediaEncryptionMandatory: Bool
        let enabledAudioCodecs: Set<String>
        /// Configured SIP ports per transport: 0 = disabled, -1 = random, -2 = do not bind.
        let configuredPorts: [String: Int]
        /// Whether the Core reported a `transportsUsed` at all. Without this, `boundPorts`
        /// is near-vacuous: a nil `Transports` — exactly what a failed apply looks like —
        /// flattens to all-zeros and satisfies any "nothing bound" assertion.
        let transportsUsedPresent: Bool
        /// Ports the Core actually bound; a value <= 0 means that transport bound nothing.
        let boundPorts: [String: Int]
        let accountCount: Int
        /// The SDK's log-level mask as liblinphone reports it — carried for the failure
        /// message only.
        let sdkLogLevelMask: UInt
        /// Whether that mask excludes every level at which belle-sip prints SIP messages.
        /// Computed here because the test target deliberately does not import `linphonesw`,
        /// so it cannot name the cases.
        let sdkLogExcludesSipMessages: Bool
        /// Absolute path liblinphone was pointed at for its own files.
        let stateDirectoryPath: String?
        /// Whether that directory is excluded from iCloud/iTunes backup.
        let stateDirectoryExcludedFromBackup: Bool
        /// Whether the SDK's compiled-in default directory
        /// (`Library/Application Support/linphone`) exists — it must not.
        let sdkDefaultDirectoryExists: Bool
    }

    func coreConfigurationForTesting() -> CoreConfigurationSnapshot? {
        #if canImport(linphonesw)
        guard let core else { return nil }
        func ports(_ t: Transports?) -> [String: Int] {
            ["udp": t?.udpPort ?? 0, "tcp": t?.tcpPort ?? 0, "tls": t?.tlsPort ?? 0, "dtls": t?.dtlsPort ?? 0]
        }
        let appSupport = try? FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: false
        )
        let sdkDefault = appSupport?.appendingPathComponent("linphone", isDirectory: true)
        let excluded = (try? stateDirectory?.resourceValues(forKeys: [.isExcludedFromBackupKey]))?
            .isExcludedFromBackup ?? false
        return CoreConfigurationSnapshot(
            pushNotificationEnabled: core.pushNotificationEnabled,
            callkitEnabled: core.callkitEnabled,
            limeX3DhEnabled: core.limeX3DhEnabled,
            mediaEncryption: core.mediaEncryption.rawValue,
            mediaEncryptionMandatory: core.isMediaEncryptionMandatory,
            enabledAudioCodecs: Set(core.audioPayloadTypes.filter { $0.enabled() }.map(\.mimeType)),
            configuredPorts: ports(core.transports),
            transportsUsedPresent: core.transportsUsed != nil,
            boundPorts: ports(core.transportsUsed),
            accountCount: core.accountList.count,
            sdkLogLevelMask: LoggingService.Instance.logLevelMask,
            sdkLogExcludesSipMessages:
                LoggingService.Instance.logLevelMask & UInt(Self.forbiddenLogMask.rawValue) == 0,
            stateDirectoryPath: stateDirectory?.path,
            stateDirectoryExcludedFromBackup: excluded,
            sdkDefaultDirectoryExists: sdkDefault.map { FileManager.default.fileExists(atPath: $0.path) } ?? false
        )
        #else
        return nil
        #endif
    }
    #endif
}
