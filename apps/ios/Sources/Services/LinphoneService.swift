import Foundation
import os

#if canImport(linphonesw)
import linphonesw
#endif

// MARK: - LinphoneServiceProtocol

/// Protocol for SIP account lifecycle operations. Implemented by `LinphoneService` for
/// production and by test doubles in unit tests.
protocol LinphoneServiceProtocol: AnyObject {
    /// Register a SIP account serving `hubId`. Throws when the account cannot be
    /// registered — including `LinphoneError.sdkNotLinked` in builds without the SDK.
    func registerHubAccount(hubId: String, sipParams: SipTokenResponse) throws
    func unregisterHubAccount(hubId: String)
    /// Drop every SIP registration. Called on clock-out, which ends the shift for all hubs.
    func unregisterAllHubAccounts()
    func handleVoipPush(callId: String, hubId: String)
}

// MARK: - LinphoneError

enum LinphoneError: LocalizedError, Equatable {
    /// This build was compiled without the Linphone SDK, so no SIP account can exist.
    case sdkNotLinked
    case notInitialized
    case invalidCredentials(String)
    case insecureTransport(String)
    case accountRegistrationFailed(String)
    case coreStartFailed(String)

    var errorDescription: String? {
        switch self {
        case .sdkNotLinked:
            return "Linphone SDK is not linked into this build; SIP registration is impossible"
        case .notInitialized:
            return "Linphone Core not initialized"
        case .invalidCredentials(let msg):
            return "SIP credentials rejected: \(msg)"
        case .insecureTransport(let transport):
            return "SIP transport '\(transport)' refused: only TLS is allowed"
        case .accountRegistrationFailed(let msg):
            return "SIP account registration failed: \(msg)"
        case .coreStartFailed(let msg):
            return "Linphone Core failed to start: \(msg)"
        }
    }
}

// MARK: - SipTokenResponse

/// SIP connection parameters returned by `GET /api/telephony/sip-token` (not hub-scoped).
///
/// Hand-written to mirror what the server actually sends — `SipConnectionParams` in
/// `apps/worker/telephony/sip-tokens.ts`: `{ provider, sip: { domain, transport, username,
/// password, iceServers, mediaEncryption } }`. Unknown keys (e.g. `issuedAt`/`expiresAt`)
/// are ignored. #1189 replaces this with the generated `SIPTokenResponse` once #1190 makes
/// the schema describe this shape; only `SipAccountConfiguration.init(_:)` reads it.
///
/// `iceServers` and `mediaEncryption` are decoded but not yet applied: the core mandates
/// SRTP regardless of what the server advertises (Asterisk advertises ZRTP). The media
/// encryption target is a cross-client decision (#1173), not made here.
struct SipTokenResponse: Decodable {
    struct Credentials: Decodable {
        let domain: String
        let transport: String
        let username: String
        let password: String
        let iceServers: [IceServer]
        let mediaEncryption: String
    }

    struct IceServer: Decodable {
        let url: String
        let username: String?
        let credential: String?
    }

    let provider: String
    let sip: Credentials
}

// MARK: - SipAccountConfiguration

/// Everything liblinphone needs to register one SIP account, derived from server
/// credentials and validated before any of it reaches the SIP stack.
///
/// This is SDK-independent on purpose: the Linphone code path is compiled out of
/// builds without the SDK, so the part that decides *what* gets registered — identity,
/// registrar, and the `AuthInfo` that carries the password — lives here, where unit
/// tests exercise it in every build.
struct SipAccountConfiguration: Equatable {
    /// Fields handed to `Factory.createAuthInfo`. Without an `AuthInfo` the registrar's
    /// digest challenge goes unanswered and REGISTER fails with 401.
    struct Auth: Equatable {
        let username: String
        let userId: String
        let password: String
        /// nil: the server does not send a realm, and liblinphone answers a challenge for
        /// any realm when none is pinned. Pinning the domain here would break registrars
        /// (Asterisk, Twilio) whose realm differs from their host name.
        let realm: String?
        let domain: String
    }

    /// Address-of-record, e.g. `sip:vol_abc@sip.example.org`. Accounts are keyed on it:
    /// hubs that share credentials share one registration.
    let identityURI: String
    /// Registrar, e.g. `sip:sip.example.org;transport=tls`.
    let serverURI: String
    let auth: Auth

    /// Characters that would let a server-supplied value inject URI parameters,
    /// headers or a second address into the SIP URI we build.
    private static let forbiddenInUser = CharacterSet(charactersIn: "@;?<>:/\\\"").union(.whitespacesAndNewlines)
    private static let forbiddenInHost = CharacterSet(charactersIn: "@;?<>/\\\"").union(.whitespacesAndNewlines)

    init(username: String, domain: String, password: String, transport: String) throws {
        guard !username.isEmpty, username.rangeOfCharacter(from: Self.forbiddenInUser) == nil else {
            throw LinphoneError.invalidCredentials("username")
        }
        guard !domain.isEmpty, domain.rangeOfCharacter(from: Self.forbiddenInHost) == nil else {
            throw LinphoneError.invalidCredentials("domain")
        }
        guard !password.isEmpty else {
            throw LinphoneError.invalidCredentials("password")
        }
        // SRTP keys travel in the SDP (SDES). Over UDP/TCP that SDP is cleartext, so the
        // media keys would be readable on the wire. TLS is the only acceptable transport.
        guard transport.lowercased() == "tls" else {
            throw LinphoneError.insecureTransport(transport)
        }
        identityURI = "sip:\(username)@\(domain)"
        serverURI = "sip:\(domain);transport=tls"
        auth = Auth(username: username, userId: username, password: password, realm: nil, domain: domain)
    }

    init(_ token: SipTokenResponse) throws {
        try self.init(
            username: token.sip.username,
            domain: token.sip.domain,
            password: token.sip.password,
            transport: token.sip.transport
        )
    }
}

// MARK: - SipAccountRegistry

/// Bookkeeping for which hubs a SIP account serves (multi-hub routing axiom: a volunteer
/// in several hubs must be reachable for all of them at once).
///
/// One account exists per distinct identity; each member hub is bound to the identity
/// its credentials name. Today `/api/telephony/sip-token` is not hub-scoped, so every
/// member hub binds to the same identity and a single REGISTER serves them all. If
/// credentials become per-hub, each distinct identity gets its own account — no change
/// needed here. Generic over the account handle so tests run without the SDK.
struct SipAccountRegistry<Handle> {
    private var identityByHub: [String: String] = [:]
    private var handleByIdentity: [String: Handle] = [:]

    /// Hubs that currently have a registration serving them.
    var hubIds: Set<String> { Set(identityByHub.keys) }

    /// Number of distinct SIP accounts (one REGISTER each).
    var accountCount: Int { handleByIdentity.count }

    func identity(forHub hubId: String) -> String? { identityByHub[hubId] }

    func handle(forIdentity identity: String) -> Handle? { handleByIdentity[identity] }

    /// Bind `hubId` to the account for `identity`. Returns an account that no hub
    /// references any more (the hub moved off it) — the caller must remove it.
    @discardableResult
    mutating func bind(hubId: String, identity: String, handle: Handle) -> Handle? {
        let previous = identityByHub.updateValue(identity, forKey: hubId)
        handleByIdentity[identity] = handle
        guard let previous, previous != identity else { return nil }
        return releaseIfOrphaned(previous)
    }

    /// Unbind `hubId`. Returns its account if no other hub still uses it.
    @discardableResult
    mutating func unbind(hubId: String) -> Handle? {
        guard let identity = identityByHub.removeValue(forKey: hubId) else { return nil }
        return releaseIfOrphaned(identity)
    }

    /// Unbind every hub. Returns every account, each exactly once.
    mutating func unbindAll() -> [Handle] {
        let handles = Array(handleByIdentity.values)
        identityByHub.removeAll()
        handleByIdentity.removeAll()
        return handles
    }

    private mutating func releaseIfOrphaned(_ identity: String) -> Handle? {
        guard !identityByHub.values.contains(identity) else { return nil }
        return handleByIdentity.removeValue(forKey: identity)
    }
}

// MARK: - SipCallEvent

/// SDK-independent view of the Linphone call states that matter for hub routing.
enum SipCallEvent: Equatable {
    /// The call is ringing (Linphone `IncomingReceived` / `PushIncomingReceived`).
    case ringing
    /// The volunteer answered (Linphone `Connected` on an incoming call).
    case answered
    /// The call finished or failed (Linphone `End` / `Released` / `Error`).
    case ended
}

// MARK: - LinphoneService

/// Manages a Linphone SIP core instance for real-time VoIP call handling.
///
/// SDK STATUS: the Linphone SDK is NOT linked into this app today. Everything that touches
/// liblinphone is behind `#if canImport(linphonesw)` and compiled out; in that build
/// `registerHubAccount` throws `LinphoneError.sdkNotLinked` (it never pretends to succeed)
/// and `LinphoneService.isSdkLinked` is false. See `apps/ios/project.yml` (`voip` background
/// mode note) and #1188 item 6 for what linking requires.
///
/// Hub routing: `pendingCallHubIds` correlates an incoming-call push (`callId` + `hubId`)
/// with the Linphone `Call` that follows. Ringing is hub-agnostic — it never changes the
/// active hub. Only answering, with the app unlocked, switches the active hub to the
/// call's hub (CLAUDE.md multi-hub routing axiom).
@Observable
final class LinphoneService: LinphoneServiceProtocol {
    /// Whether this build contains the Linphone SDK.
    static let isSdkLinked: Bool = {
        #if canImport(linphonesw)
        return true
        #else
        return false
        #endif
    }()

    // MARK: - Private State

    /// callId → hubId map set by VoIP push before Linphone fires onCallStateChanged.
    private var pendingCallHubIds: [String: String] = [:]
    private let pendingCallLock = NSLock()
    private weak var hubContext: HubContext?
    /// Whether the app is unlocked. The answer path may switch hubs only when it is.
    @ObservationIgnored
    private var isAppUnlocked: () -> Bool = { false }
    private let logger = Logger(subsystem: "org.llamenos.hotline", category: "SIP")

    #if canImport(linphonesw)
    @ObservationIgnored private var core: Core?
    @ObservationIgnored private var coreDelegate: CoreDelegateStub?
    @ObservationIgnored private var accounts = SipAccountRegistry<Account>()
    #endif

    // MARK: - Initialization

    init() {}

    /// Configure the service with the app-wide HubContext and start the Linphone Core.
    /// Call this once from LlamenosApp after the hub context is ready.
    ///
    /// - Parameter isAppUnlocked: evaluated at answer time; the active hub is switched
    ///   to the answered call's hub only when this returns true.
    func initialize(hubContext: HubContext, isAppUnlocked: @escaping () -> Bool) throws {
        self.hubContext = hubContext
        self.isAppUnlocked = isAppUnlocked
        #if canImport(linphonesw)
        // No config path: accounts and AuthInfo (which holds the SIP password) stay in
        // memory instead of being persisted to a plaintext linphonerc in the container.
        let core = try Factory.Instance.createCore(
            configPath: nil,
            factoryConfigPath: nil,
            systemContext: nil
        )
        core.callkitEnabled = true
        try core.setMediaencryption(newValue: .SRTP)
        core.mediaEncryptionMandatory = true

        // Allow only Opus and G.711 µ-law; disable all others.
        for pt in core.audioPayloadTypes {
            _ = pt.enable(enabled: pt.mimeType == "opus" || pt.mimeType == "PCMU")
        }

        setupCoreDelegate(core: core)
        do {
            try core.start()
        } catch {
            throw LinphoneError.coreStartFailed(error.localizedDescription)
        }
        self.core = core
        #else
        logger.notice("Linphone SDK not linked into this build — in-app SIP calling is unavailable")
        #endif
    }

    // MARK: - SIP Account Management

    /// Register a SIP account serving the given hub. Called for every member hub on clock-in.
    func registerHubAccount(hubId: String, sipParams: SipTokenResponse) throws {
        // Validate before anything else so bad credentials are rejected in every build.
        let config = try SipAccountConfiguration(sipParams)
        #if canImport(linphonesw)
        guard let core else { throw LinphoneError.notInitialized }
        do {
            // Credentials first: the registrar challenges REGISTER, and without an
            // AuthInfo liblinphone cannot answer — the registration 401s.
            let authInfo = try Factory.Instance.createAuthInfo(
                username: config.auth.username,
                userid: config.auth.userId,
                passwd: config.auth.password,
                ha1: nil,
                realm: config.auth.realm,
                domain: config.auth.domain
            )
            core.addAuthInfo(info: authInfo)

            let account: Account
            if let existing = accounts.handle(forIdentity: config.identityURI) {
                // Another member hub already registered this identity; one REGISTER serves both.
                account = existing
                account.refreshRegister()
            } else {
                let params = try core.createAccountParams()
                try params.setIdentityaddress(newValue: Factory.Instance.createAddress(addr: config.identityURI))
                try params.setServeraddress(newValue: Factory.Instance.createAddress(addr: config.serverURI))
                params.registerEnabled = true
                account = try core.createAccount(params: params)
                try core.addAccount(account: account)
            }
            if let orphan = accounts.bind(hubId: hubId, identity: config.identityURI, handle: account) {
                remove(orphan, from: core)
            }
        } catch {
            throw LinphoneError.accountRegistrationFailed(error.localizedDescription)
        }
        #else
        _ = config
        throw LinphoneError.sdkNotLinked
        #endif
    }

    /// Stop serving the given hub. Its account is removed once no member hub uses it.
    func unregisterHubAccount(hubId: String) {
        #if canImport(linphonesw)
        guard let core, let orphan = accounts.unbind(hubId: hubId) else { return }
        remove(orphan, from: core)
        #endif
    }

    /// Remove every SIP account. Called on clock-out.
    func unregisterAllHubAccounts() {
        #if canImport(linphonesw)
        guard let core else { return }
        for account in accounts.unbindAll() {
            remove(account, from: core)
        }
        #endif
    }

    #if canImport(linphonesw)
    /// Unregister and drop an account together with its credentials, so the SIP
    /// password does not outlive the registration it was issued for.
    private func remove(_ account: Account, from core: Core) {
        let authInfo = account.findAuthInfo()
        core.removeAccount(account: account)
        if let authInfo {
            core.removeAuthInfo(info: authInfo)
        }
    }
    #endif

    // MARK: - VoIP Push Handling

    /// Record the hub ID that triggered a VoIP push for a given call ID.
    /// Called by the push handler before Linphone reports the call.
    func handleVoipPush(callId: String, hubId: String) {
        pendingCallLock.lock()
        defer { pendingCallLock.unlock() }
        pendingCallHubIds[callId] = hubId
    }

    // MARK: - Call Events (hub routing)

    /// Apply a call state transition to hub routing. Returns the hub switched to, if any.
    ///
    /// - `ringing`: hub-agnostic. Never touches the active hub; the call→hub mapping is kept
    ///   for the answer.
    /// - `answered`: consumes the mapping and, only if the app is unlocked, switches the
    ///   active hub to the call's hub.
    /// - `ended`: drops the mapping.
    @discardableResult
    func handleCallEvent(callId: String, event: SipCallEvent) -> String? {
        switch event {
        case .ringing:
            return nil
        case .answered:
            pendingCallLock.lock()
            let hubId = pendingCallHubIds.removeValue(forKey: callId)
            pendingCallLock.unlock()
            guard let hubId, isAppUnlocked() else { return nil }
            hubContext?.setActiveHub(hubId)
            return hubId
        case .ended:
            pendingCallLock.lock()
            pendingCallHubIds.removeValue(forKey: callId)
            pendingCallLock.unlock()
            return nil
        }
    }

    // MARK: - Core Delegate (Linphone)

    #if canImport(linphonesw)
    private func setupCoreDelegate(core: Core) {
        let delegate = CoreDelegateStub(
            onCallStateChanged: { [weak self] _, call, state, _ in
                guard let self else { return }
                let callId = call.callLog?.callId ?? ""
                let event: SipCallEvent
                switch state {
                case .IncomingReceived, .PushIncomingReceived:
                    event = .ringing
                case .Connected where call.dir == .Incoming:
                    event = .answered
                case .End, .Released, .Error:
                    event = .ended
                default:
                    return
                }
                DispatchQueue.main.async {
                    self.handleCallEvent(callId: callId, event: event)
                }
            }
        )
        core.addDelegate(delegate: delegate)
        coreDelegate = delegate
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
    #endif
}
