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

/// Response body of `GET /api/telephony/sip-token`.
///
/// Mirrors `sipTokenResponseSchema` (packages/protocol/schemas/webrtc.ts), which
/// `SipConnectionParams` in apps/worker/telephony/sip-tokens.ts is now `z.infer` of —
/// so this is the shape the server really sends, not the shape its OpenAPI snapshot
/// used to claim.
///
/// It was previously five FLAT, REQUIRED fields (`username`, `domain`, `password`,
/// `transport`, `expiry`). Four of those are one level too deep in the real response
/// and `expiry` has never been sent at all, so `APIService.getSipToken` threw
/// `keyNotFound` on every response the server could produce and
/// `LinphoneService.registerHubAccount` was unreachable — in-app SIP registration
/// could not work on any build (#1659). `expiry` is gone rather than made optional:
/// the registration lifetime is the one the registrar GRANTS in its 200 to REGISTER,
/// which belle-sip's refresher already follows, and the TURN credential's own expiry
/// is carried inside its username (see `turnCredentialExpiresAt`).
///
/// Pinned against the server's BYTES, not against this type:
/// `SipTokenResponseDecodingTests` decodes `apps/ios/Tests/Wire/sip-token-response.json`
/// through `APIService`'s real decoder, and
/// `apps/worker/__tests__/unit/sip-token-wire-body.test.ts` holds that same fixture to
/// `sipTokenResponseSchema` and asserts every key this model REQUIRES is a key the
/// schema declares. Constructing this value in Swift — which is all the previous tests
/// did — confirms the model instead of checking it.
struct SipTokenResponse: Decodable {
    let provider: String
    let sip: SipAccountParams
}

/// The SIP account half of a `/api/telephony/sip-token` response.
struct SipAccountParams: Decodable, Equatable {
    let domain: String
    let transport: String
    let username: String
    let password: String
    let mediaEncryption: String

    /// STUN/TURN servers the client must gather candidates from. Defaulted rather than
    /// required: the server always sends the key, and a client that loses its whole
    /// credential because an ICE list was omitted is a worse failure than one that
    /// registers with host candidates only.
    let iceServers: [SipIceServer]

    /// PEM trust anchor for the SIP edge's TLS certificate.
    ///
    /// A self-hoster has no publicly-trusted certificate for their PBX, so nothing in
    /// the device trust store can vouch for it — and verification is never switched off
    /// on a leg carrying a crisis call. liblinphone does NOT consult the platform trust
    /// store for its SIP socket (it verifies against its own CA set), so this anchor is
    /// the only way that chain becomes verifiable at all. It arrives inside this
    /// response, which travelled over the app's own pinned HTTPS channel, so SIP trust
    /// derives from the API pin: no trust-on-first-use, and the public CA store is not
    /// consulted for SIP.
    ///
    /// Nil means "verify against the device trust store" — correct for a deployment
    /// whose SIP edge serves a publicly-trusted certificate. It never means "do not
    /// verify".
    let tlsTrustAnchorPem: String?

    enum CodingKeys: String, CodingKey {
        case domain, transport, username, password, mediaEncryption, iceServers, tlsTrustAnchorPem
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        domain = try c.decode(String.self, forKey: .domain)
        transport = try c.decode(String.self, forKey: .transport)
        username = try c.decode(String.self, forKey: .username)
        password = try c.decode(String.self, forKey: .password)
        mediaEncryption = try c.decode(String.self, forKey: .mediaEncryption)
        iceServers = try c.decodeIfPresent([SipIceServer].self, forKey: .iceServers) ?? []
        tlsTrustAnchorPem = try c.decodeIfPresent(String.self, forKey: .tlsTrustAnchorPem)
    }

    init(
        domain: String,
        transport: String,
        username: String,
        password: String,
        mediaEncryption: String,
        iceServers: [SipIceServer] = [],
        tlsTrustAnchorPem: String? = nil
    ) {
        self.domain = domain
        self.transport = transport
        self.username = username
        self.password = password
        self.mediaEncryption = mediaEncryption
        self.iceServers = iceServers
        self.tlsTrustAnchorPem = tlsTrustAnchorPem
    }

    /// Never let the SIP password reach a log line or a crash report.
    var redactedDescription: String {
        "SipAccountParams(domain: \(domain), transport: \(transport), username: \(username), "
            + "password: <redacted>, mediaEncryption: \(mediaEncryption), iceServers: \(iceServers), "
            + "tlsTrustAnchorPem: \(tlsTrustAnchorPem.map { "<\($0.count) bytes>" } ?? "nil"))"
    }

    /// The soonest expiry among the issued TURN credentials, as Unix seconds, or nil when
    /// no relay was issued (STUN-only ICE servers, or none at all).
    var turnCredentialExpiresAt: TimeInterval? {
        iceServers.compactMap(\.turnCredentialExpiresAt).min()
    }
}

/// The transport a TURN relay is reached over. liblinphone supports exactly one at a
/// time — see `LinphoneService.natPolicy`.
enum RelayTransport: String, Equatable {
    case udp, tcp, tls
}

/// One ICE server from a `/api/telephony/sip-token` response.
struct SipIceServer: Decodable, Equatable, CustomStringConvertible {
    let url: String
    let username: String?
    let credential: String?

    init(url: String, username: String? = nil, credential: String? = nil) {
        self.url = url
        self.username = username
        self.credential = credential
    }

    /// `stun`, `stuns`, `turn` or `turns` — RFC 7064/7065 URIs, which are NOT
    /// hierarchical: there is no `//`, so `URL`/`URLComponents` mis-reads them. One is
    /// tolerated anyway in case an operator writes it.
    var scheme: String {
        String(url.prefix(while: { $0 != ":" })).lowercased()
    }

    /// `host:port`, which is what liblinphone's `NatPolicy.stunServer` takes.
    var hostAndPort: String {
        var rest = url.drop(while: { $0 != ":" }).dropFirst()
        if rest.hasPrefix("//") { rest = rest.dropFirst(2) }
        return String(rest.prefix(while: { $0 != "?" })).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }

    /// The `?transport=` hint on a TURN URI (RFC 7065), lowercased: which transport the
    /// client should reach the relay over. Nil when unspecified, which means UDP.
    var turnTransport: String? {
        guard let q = url.firstIndex(of: "?") else { return nil }
        return url[url.index(after: q)...]
            .split(separator: "&")
            .first { $0.lowercased().hasPrefix("transport=") }
            .map { $0.drop(while: { $0 != "=" }).dropFirst().lowercased() }
            .flatMap { $0.isEmpty ? nil : $0 }
    }

    /// When the time-limited TURN credential stops being honoured, as Unix seconds.
    ///
    /// CoTURN's long-term-credential REST convention (RFC 8489) puts the expiry in the
    /// username itself (`<expiry>:<user>`), so the client can see it without the server
    /// stating it separately — which is why this response carries no `expiry` field.
    var turnCredentialExpiresAt: TimeInterval? {
        guard let username, let colon = username.firstIndex(of: ":") else { return nil }
        return TimeInterval(username[username.startIndex..<colon])
    }

    /// Which transport this entry asks the relay to be reached over, as liblinphone's
    /// NAT policy models it. Nil when the entry is not a TURN URI at all.
    ///
    /// `turns:` implies TLS regardless of any `?transport=` hint (RFC 7065), and a `turn:`
    /// URI with no hint means UDP.
    var relayTransport: RelayTransport? {
        switch scheme {
        case "turns": return .tls
        case "turn":
            switch turnTransport {
            case nil, "udp": return .udp
            case "tcp": return .tcp
            case "tls": return .tls
            default: return nil
            }
        default: return nil
        }
    }

    /// A usable relay: a TURN URI with both halves of a credential. STUN needs neither.
    var isTurnRelay: Bool {
        (scheme == "turn" || scheme == "turns") && username != nil && credential != nil
    }

    /// The TURN credential is a live secret for its (short) lifetime: never let string
    /// interpolation put one in a log line or a crash report. The username is not
    /// secret — it is the expiry and the volunteer's own SIP identity.
    var description: String {
        "SipIceServer(url: \(url), username: \(username ?? "nil"), credential: <redacted>)"
    }
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
    /// The AuthInfos each hub's registration owns: the SIP password, and the TURN
    /// credential when a relay was issued. Tracked so clock-out can remove them from the
    /// Core instead of leaving a clocked-out volunteer's credentials resident in it.
    private var hubAuthInfos: [String: (sip: AuthInfo, turn: AuthInfo?)] = [:]
    /// `username@domain;transport=…` per hub, so a rotated credential on a DIFFERENT
    /// identity replaces its account rather than adding a second registration — two
    /// registrations for one AOR fork every INVITE to two contacts on this device.
    private var registeredIdentities: [String: String] = [:]
    /// The trust anchor currently installed on the Core. Tracked because
    /// `Core.rootCaData` is a `willSet`-only stored property on the Swift wrapper and
    /// does not read back from liblinphone.
    private var appliedTrustAnchor: String?
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

    /// Expiry requested in each REGISTER. liblinphone's own default, stated explicitly so
    /// the refresh cadence is visible here. The registrar may grant less — belle-sip's
    /// refresher follows the GRANTED value, not this one, which is why no `expiry` field
    /// is needed in the token response.
    static let registerExpiresSeconds = 3600

    /// The media encryption the server's `mediaEncryption` string names.
    static func mediaEncryption(for value: String) -> MediaEncryption? {
        switch value.lowercased() {
        case "dtls-srtp", "dtls": return .DTLS
        case "srtp": return .SRTP
        case "zrtp": return .ZRTP
        default: return nil
        }
    }

    /// One registration per distinct SIP identity.
    static func identityKey(_ sip: SipAccountParams) -> String {
        "\(sip.username)@\(sip.domain);transport=\(sip.transport)"
    }

    /// Order the single supported TURN transport is chosen in. See `natPolicy`.
    static let relayTransportPreference: [RelayTransport] = [.udp, .tcp, .tls]
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

        // liblinphone verifies SIP/TLS against its own bundled rootca.pem, not the iOS
        // trust store, so neither the app's NSAppTransportSecurity nor any
        // URLSession-level pinning applies to the PBX connection. The anchor is therefore
        // supplied per-credential: `registerHubAccount` sets `core.rootCaData` from the
        // `tlsTrustAnchorPem` the token publishes (see `applyTlsTrustAnchor`), which
        // REPLACES the bundled set. Certificate verification is never switched off, so an
        // edge whose chain the client cannot build fails to register rather than
        // registering insecurely.

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
    ///
    /// Every field of the issued credential is applied, which is the point: before
    /// #1659 this set only the identity and server addresses, so even a response that
    /// had decoded would have produced an account with no password (401 on the first
    /// REGISTER), no NAT policy (host candidates only — reachable on the same LAN and
    /// nowhere else), the SDK's bundled CA set rather than the published trust anchor
    /// (`tlsv1 alert unknown ca` against a self-hosted PBX), and a hardcoded media
    /// encryption the registrar's endpoint cannot negotiate.
    func registerHubAccount(hubId: String, sipParams: SipTokenResponse) throws {
        #if canImport(linphonesw)
        guard let core else { throw LinphoneError.notInitialized }
        let sip = sipParams.sip

        // Both of these refuse rather than degrade: an unencryptable media leg and an
        // unverifiable TLS chain are each a reason not to register at all. They are
        // core-global, so they are applied before anything is bound.
        try applyMediaEncryption(core: core, sip: sip)
        try applyTlsTrustAnchor(core: core, sip: sip)

        let identityKey = Self.identityKey(sip)
        if let existing = hubAccounts[hubId], registeredIdentities[hubId] != identityKey {
            // Rotated onto a different identity: drop the old account first, or this
            // device holds two registrations and every INVITE forks to both contacts.
            core.removeAccount(account: existing)
            releaseAuthInfo(core: core, hubId: hubId)
            hubAccounts[hubId] = nil
        }

        let authInfo = try Factory.Instance.createAuthInfo(
            username: sip.username,
            userid: nil,
            passwd: sip.password,
            ha1: nil,
            realm: nil,
            domain: sip.domain
        )
        core.addAuthInfo(info: authInfo)

        // liblinphone resolves the TURN password through a SECOND AuthInfo keyed on the
        // TURN username (which is what `NatPolicy.stunServerUsername` names), so the
        // relay credential never has to be held on the policy itself.
        let turnAuthInfo = try turnAuthInfo(for: sip)
        turnAuthInfo.map { core.addAuthInfo(info: $0) }

        let params = try core.createAccountParams()
        let identity = try Factory.Instance.createAddress(
            addr: "sip:\(sip.username)@\(sip.domain)"
        )
        try params.setIdentityaddress(newValue: identity)
        let server = try Factory.Instance.createAddress(
            addr: "sip:\(sip.domain);transport=\(sip.transport)"
        )
        try params.setServeraddress(newValue: server)
        params.expires = Self.registerExpiresSeconds
        params.registerEnabled = true
        // The issued ICE servers, finally applied. Without a NAT policy liblinphone
        // offers host candidates only, and Asterisk's endpoint has `ice_support: yes`
        // waiting for the other half.
        params.natPolicy = try natPolicy(core: core, sip: sip)

        let account = try core.createAccount(params: params)
        do {
            try core.addAccount(account: account)
        } catch {
            core.removeAuthInfo(info: authInfo)
            turnAuthInfo.map { core.removeAuthInfo(info: $0) }
            throw LinphoneError.accountRegistrationFailed("\(error)")
        }
        if let previous = hubAccounts[hubId] { core.removeAccount(account: previous) }
        hubAccounts[hubId] = account
        hubAuthInfos[hubId] = (authInfo, turnAuthInfo)
        registeredIdentities[hubId] = identityKey
        #else
        _ = (hubId, sipParams)
        #endif
    }

    /// Unregister the SIP account for the given hub. Called when the volunteer clocks out.
    func unregisterHubAccount(hubId: String) {
        #if canImport(linphonesw)
        registeredIdentities[hubId] = nil
        guard let core, let account = hubAccounts.removeValue(forKey: hubId) else { return }
        // Removing a registered account makes liblinphone send REGISTER with Expires: 0.
        core.removeAccount(account: account)
        releaseAuthInfo(core: core, hubId: hubId)
        #endif
    }

    #if canImport(linphonesw)
    /// Drop the AuthInfos this hub's registration owned, so a clocked-out volunteer's
    /// SIP password and relay credential stop living in the Core.
    private func releaseAuthInfo(core: Core, hubId: String) {
        guard let (authInfo, turnAuthInfo) = hubAuthInfos.removeValue(forKey: hubId) else { return }
        core.removeAuthInfo(info: authInfo)
        turnAuthInfo.map { core.removeAuthInfo(info: $0) }
    }

    /// The media encryption the credential names, applied — refusing anything this
    /// client will not carry.
    ///
    /// `none` is deliberately absent from `mediaEncryption(for:)`: a crisis hotline's
    /// volunteer leg does not carry unencrypted media, so an issued credential asking
    /// for it is refused rather than honoured. Anything unrecognised is refused for the
    /// same reason. The ALGORITHM is the server's to choose — it provisions the matching
    /// PJSIP endpoint — which is why this reads the value instead of hardcoding one: the
    /// pair that could not negotiate in #1188 was a client mandating SDES-SRTP against
    /// an endpoint provisioned for DTLS-SRTP.
    private func applyMediaEncryption(core: Core, sip: SipAccountParams) throws {
        guard let encryption = Self.mediaEncryption(for: sip.mediaEncryption) else {
            throw LinphoneError.accountRegistrationFailed(
                "Server asked for media encryption '\(sip.mediaEncryption)', which this client will not use"
            )
        }
        guard core.mediaEncryptionSupported(menc: encryption) else {
            throw LinphoneError.accountRegistrationFailed(
                "liblinphone does not support media encryption \(encryption) on this device"
            )
        }
        try core.setMediaencryption(newValue: encryption)
        guard core.isMediaEncryptionMandatory else {
            throw LinphoneError.accountRegistrationFailed(
                "media encryption is no longer mandatory — refusing a leg that may run in the clear"
            )
        }
    }

    /// Install the server-published trust anchor as the ONLY thing the SIP TLS chain is
    /// verified against, when one was published.
    ///
    /// `Core.rootCaData` is the hook belle-sip's `root_ca_data` is fed from, and it
    /// REPLACES the SDK's bundled anchors rather than adding to them — so "narrower than
    /// the public CA set" is a property, not an intent. This closes the
    /// `TODO(#1173)` in `initialize`.
    ///
    /// Where no anchor is published the set is left alone, which is what a deployment
    /// whose SIP edge holds a publicly-trusted certificate wants: ISRG Root X1 and X2
    /// are both in the SDK's bundled rootca.pem. Verification stays on regardless, so an
    /// unverifiable edge fails to register rather than registering insecurely.
    private func applyTlsTrustAnchor(core: Core, sip: SipAccountParams) throws {
        // Whitespace is TRIMMED FOR THE EMPTINESS CHECK ONLY — `pem` below is the
        // server's bytes verbatim. A PEM whose final `-----END CERTIFICATE-----`
        // has no trailing newline is a classic parser edge, and the worker emits
        // one (`certificatesOnly` joins the blocks and appends "\n"); re-deriving
        // a trimmed copy would hand belle-sip a subtly different document from
        // the one the server published and the one a test can compare against.
        guard let pem = sip.tlsTrustAnchorPem,
              !pem.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { return }
        guard !pem.contains("PRIVATE KEY") else {
            throw LinphoneError.accountRegistrationFailed(
                "SIP TLS trust anchor contains private key material — refusing it"
            )
        }
        guard pem.contains("-----BEGIN CERTIFICATE-----") else {
            throw LinphoneError.accountRegistrationFailed(
                "SIP TLS trust anchor is not a PEM certificate"
            )
        }
        if pem == appliedTrustAnchor { return }
        core.rootCaData = pem
        appliedTrustAnchor = pem
    }

    /// The NAT policy for the issued ICE servers, or nil when none were issued.
    ///
    /// liblinphone takes ONE server address for both roles, so the TURN host wins when
    /// the two differ: the relay candidate is the one that cannot be substituted. A
    /// volunteer behind a full-cone or address-restricted NAT connects on the
    /// server-reflexive candidate STUN discovers; behind a SYMMETRIC NAT that candidate
    /// is useless (the mapping is per-destination) and the relay TURN allocates is what
    /// carries the call. With no TURN server configured the server says so honestly
    /// (STUN-only `iceServers`) and a symmetric-NAT volunteer is reachable only by phone.
    private func natPolicy(core: Core, sip: SipAccountParams) throws -> NatPolicy? {
        if sip.iceServers.isEmpty { return nil }
        let stun = sip.iceServers.first { $0.scheme == "stun" || $0.scheme == "stuns" }
        let turnServers = sip.iceServers.filter { $0.scheme == "turn" || $0.scheme == "turns" }
        let turn = turnServers.first { $0.isTurnRelay }
        guard let address = (turn ?? stun)?.hostAndPort, !address.isEmpty else { return nil }

        let policy = try core.createNatPolicy()
        policy.iceEnabled = true
        policy.stunServer = address
        policy.stunEnabled = true
        if let turn {
            policy.turnEnabled = true
            policy.stunServerUsername = turn.username

            // EXACTLY ONE relay transport, not one per issued entry.
            //
            // liblinphone says so itself — "Enabling more than one transport (UDP, TCP,
            // TLS) at a time is currently not supported" on each of the three setters —
            // and it ENFORCES it: MEASURED, setting udp then tcp leaves tcp reading back
            // false (`registerAppliesTheIssuedCredentialToAStartedCore` asserted all the
            // issued transports and failed on exactly that). So a policy built by
            // enabling one per `?transport=` hint in `iceServers` describes something
            // liblinphone will not do, and the reader cannot tell which one it got.
            //
            // The server issues a UDP and a TCP entry for the same relay (see
            // `buildVolunteerSipParams`) precisely so a client can choose. UDP first:
            // relayed RTP over TCP adds head-of-line blocking to a live voice path, and
            // TCP/TLS exist for networks that drop UDP outright.
            // EXACTLY ONE relay transport, and every other one explicitly off.
            //
            // liblinphone says so itself — "Enabling more than one transport (UDP, TCP,
            // TLS) at a time is currently not supported" on each of the three setters.
            // MEASURED on linphone-sdk 5.5.23 (iPhone 17 Pro simulator), by setting each
            // and reading it back, including across the AccountParams assignment:
            //
            //   a fresh NatPolicy has ALL THREE off, turn off
            //   turnEnabled = true leaves all three off  — so not setting one means NO relay
            //   tcpTurnTransportEnabled = true does take on the policy object
            //   but after `params.natPolicy = policy`, turnEnabled survives and the
            //   TRANSPORT FLAGS DO NOT: tcp reads back false.
            //
            // UDP does survive that round trip, which is the case that matters: the
            // server issues a UDP and a TCP entry for the same relay
            // (`buildVolunteerSipParams`), and UDP is the one to want anyway — relayed
            // RTP over TCP adds head-of-line blocking to a live voice path. A deployment
            // whose relay is reachable ONLY over TCP cannot be served through an
            // account-scoped NAT policy on this SDK; see
            // `aTcpOnlyRelayCannotBeCarriedByThisSdk`, which pins that so an SDK upgrade
            // reports it rather than hiding it.
            let chosen = Self.relayTransportPreference.first { wanted in
                turnServers.contains { $0.relayTransport == wanted }
            }
            policy.udpTurnTransportEnabled = chosen == .udp
            policy.tcpTurnTransportEnabled = chosen == .tcp
            policy.tlsTurnTransportEnabled = chosen == .tls
            if chosen == nil {
                // A relay with both halves of a credential but no transport this client
                // recognises. Leave TURN off rather than advertise a relay that cannot be
                // allocated — the reflexive candidate STUN discovers still stands.
                policy.turnEnabled = false
            }
        }
        return policy
    }

    /// AuthInfo for the time-limited TURN credential, which liblinphone looks up by the
    /// username set as `NatPolicy.stunServerUsername`. Nil when no relay was issued.
    private func turnAuthInfo(for sip: SipAccountParams) throws -> AuthInfo? {
        guard let turn = sip.iceServers.first(where: { $0.isTurnRelay }),
              let username = turn.username,
              let credential = turn.credential
        else { return nil }
        return try Factory.Instance.createAuthInfo(
            username: username,
            userid: username,
            passwd: credential,
            ha1: nil,
            realm: nil,
            domain: nil
        )
    }
    #endif

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

    /// SDK-independent snapshot of what one hub's registration actually asked liblinphone
    /// for. The test target deliberately does not import `linphonesw`, so every SDK enum
    /// is carried as its raw value — the same convention as
    /// `CoreConfigurationSnapshot.mediaEncryption`.
    ///
    /// It reads back from the Account/NatPolicy objects liblinphone holds, not from the
    /// values this file passed in, so it cannot pass while the apply silently failed.
    struct RegistrationSnapshot: Equatable {
        let identityAddress: String?
        let serverAddress: String?
        let registerEnabled: Bool
        let expires: Int
        /// Whether a matching AuthInfo exists in the Core. Without one the registrar
        /// answers 401 and no volunteer is ever rung.
        let hasAuthInfo: Bool
        /// Whether a TURN AuthInfo exists for the relay credential.
        let hasTurnAuthInfo: Bool
        /// `MediaEncryption.rawValue`: 0 None, 1 SRTP, 2 ZRTP, 3 DTLS.
        let mediaEncryption: Int
        let mediaEncryptionMandatory: Bool
        let iceEnabled: Bool
        let stunEnabled: Bool
        let turnEnabled: Bool
        let stunServer: String?
        let stunServerUsername: String?
        let udpTurnTransportEnabled: Bool
        let tcpTurnTransportEnabled: Bool
        let tlsTurnTransportEnabled: Bool
        /// Length of the trust anchor installed on the Core, or nil when none is.
        let trustAnchorByteCount: Int?
    }

    func registrationForTesting(hubId: String) -> RegistrationSnapshot? {
        #if canImport(linphonesw)
        guard let core, let account = hubAccounts[hubId] else { return nil }
        let params = account.params
        let policy = params?.natPolicy
        let authInfos = hubAuthInfos[hubId]
        return RegistrationSnapshot(
            identityAddress: params?.identityAddress?.asStringUriOnly(),
            serverAddress: params?.serverAddress?.asStringUriOnly(),
            registerEnabled: params?.registerEnabled ?? false,
            expires: params?.expires ?? 0,
            hasAuthInfo: authInfos?.sip != nil && core.authInfoList.contains { $0.username == params?.identityAddress?.username },
            hasTurnAuthInfo: authInfos?.turn != nil,
            mediaEncryption: core.mediaEncryption.rawValue,
            mediaEncryptionMandatory: core.isMediaEncryptionMandatory,
            iceEnabled: policy?.iceEnabled ?? false,
            stunEnabled: policy?.stunEnabled ?? false,
            turnEnabled: policy?.turnEnabled ?? false,
            stunServer: policy?.stunServer,
            stunServerUsername: policy?.stunServerUsername,
            udpTurnTransportEnabled: policy?.udpTurnTransportEnabled ?? false,
            tcpTurnTransportEnabled: policy?.tcpTurnTransportEnabled ?? false,
            tlsTurnTransportEnabled: policy?.tlsTurnTransportEnabled ?? false,
            trustAnchorByteCount: appliedTrustAnchor?.count
        )
        #else
        _ = hubId
        return nil
        #endif
    }

    /// `MediaEncryption.rawValue` for a server-supplied `mediaEncryption` string, or nil
    /// when this client refuses it. Raw value because the test target cannot name the
    /// SDK's enum.
    static func mediaEncryptionRawValueForTesting(_ value: String) -> Int? {
        #if canImport(linphonesw)
        return mediaEncryption(for: value)?.rawValue
        #else
        _ = value
        return nil
        #endif
    }

    /// Raw values of the encryptions this client will carry, for assertions that must not
    /// hardcode liblinphone's numbering.
    enum MediaEncryptionRawValue {
        static let none = 0
        static let srtp = 1
        static let zrtp = 2
        static let dtls = 3
    }
    #endif
}
