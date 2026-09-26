import Foundation

// MARK: - ConnectionState

/// WebSocket connection state.
enum ConnectionState: Equatable, Sendable {
    case disconnected
    case connecting
    case connected
    case reconnecting(attempt: Int)

    var isConnected: Bool { self == .connected }

    var statusColor: String {
        switch self {
        case .connected: return "green"
        case .connecting, .reconnecting: return "yellow"
        case .disconnected: return "red"
        }
    }

    var displayText: String {
        switch self {
        case .disconnected:
            return NSLocalizedString("ws_disconnected", comment: "Disconnected")
        case .connecting:
            return NSLocalizedString("ws_connecting", comment: "Connecting...")
        case .connected:
            return NSLocalizedString("ws_connected", comment: "Connected")
        case .reconnecting(let attempt):
            return String(format: NSLocalizedString("ws_reconnecting", comment: "Reconnecting (%d)..."), attempt)
        }
    }
}

// MARK: - AttributedHubEvent

/// A decoded event paired with the hub ID it was received from.
struct AttributedHubEvent: Sendable {
    /// The UUID of the hub this event belongs to (provided directly in the event message).
    let hubId: String
    /// The hub event type decoded from the decrypted event content.
    let event: HubEventType
}

// MARK: - HubEventType

/// Known hub event types parsed from decrypted event content's `type` field.
enum HubEventType: String, Sendable {
    case callRing = "call:ring"
    case callAnswered = "call:answered"
    case callUpdate = "call:update"
    case callEnded = "call:ended"
    case shiftStarted = "shift:started"
    case shiftEnded = "shift:ended"
    case shiftUpdate = "shift:update"
    case noteCreated = "note:created"
    case voicemailNew = "voicemail:new"
    case presenceSummary = "presence:summary"
    case presenceDetail = "presence:detail"
    case messageNew = "message:new"
    case messageStatus = "message:status"
    case conversationNew = "conversation:new"
    case conversationAssigned = "conversation:assigned"
    case conversationClosed = "conversation:closed"
    case deviceWipe = "device:wipe"
    case unknown
}

// MARK: - Wire message types (internal)

private struct WsChallengeFields: Decodable {
    let nonce: String
}

private struct WsIncomingEvent: Decodable, Sendable {
    let v: Int
    let hubId: String
    let kind: Int
    let payload: String
    let epoch: Int
    let ts: Int
}

// MARK: - WebSocketService

/// Native WebSocket client for the Llamenos relay. Uses challenge-response Ed25519 auth,
/// per-hub subscriptions, and epoch-aware AES-256-GCM event decryption.
///
/// Multi-hub routing axiom: the client receives events from EVERY hub the user is a
/// member of, whichever hub is active in the UI. `subscribeToMemberHubs(kinds:)`
/// subscribes to each hub the server lists in its `authenticated` reply — the
/// server-authoritative membership — on every (re)connect.
///
/// Usage:
/// ```swift
/// let ws = WebSocketService(cryptoService: cryptoService)
/// let config = try await apiService.fetchAppConfig()
/// guard let url = WebSocketService.relayURL(hubBaseURL: base, advertised: config.wsRelayUrl) else { return }
/// ws.subscribeToMemberHubs(kinds: [1000, 1001, 20000])
/// await ws.connect(to: url)
/// for await event in ws.attributedEvents {
///     handleEvent(event)
/// }
/// ```
@Observable
final class WebSocketService: @unchecked Sendable {

    // MARK: - Public State

    /// Current connection state, observed by UI for status indicators.
    private(set) var connectionState: ConnectionState = .disconnected

    /// Count of events received since last connect (for diagnostics).
    private(set) var eventCount: Int = 0

    /// Hubs the server says this user is a member of, from the last `authenticated`
    /// reply. Excludes the server's `global` pseudo-hub. Empty until authenticated.
    private(set) var memberHubIds: [String] = []

    // MARK: - Dependencies

    private let cryptoService: CryptoService

    // MARK: - Event Stream

    /// Public async stream of decrypted, hub-attributed typed events.
    var attributedEvents: AsyncStream<AttributedHubEvent> {
        AsyncStream { continuation in
            let id = UUID()
            typedContinuationsLock.lock()
            typedContinuations[id] = continuation
            typedContinuationsLock.unlock()
            continuation.onTermination = { [weak self] _ in
                self?.typedContinuationsLock.lock()
                self?.typedContinuations.removeValue(forKey: id)
                self?.typedContinuationsLock.unlock()
            }
        }
    }

    // MARK: - Private Properties

    private var webSocketTask: URLSessionWebSocketTask?
    private var session: URLSession
    private var relayURL: URL?
    private var reconnectAttempt: Int = 0
    private var isIntentionalDisconnect: Bool = false
    private var receiveTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var authenticated: Bool = false

    /// Hub subscriptions: hubId → kind list. Retained across reconnects.
    private var subscribedHubs: [String: [Int]] = [:]
    /// Subscriptions buffered before auth completes; flushed in handleAuthenticated().
    private var pendingSubscriptions: [(hubId: String, kinds: [Int])] = []
    /// Kinds to subscribe on every member hub after each authentication, or nil when
    /// `subscribeToMemberHubs(kinds:)` has not been called.
    private var memberHubKinds: [Int]?

    private var typedContinuations: [UUID: AsyncStream<AttributedHubEvent>.Continuation] = [:]
    private let typedContinuationsLock = NSLock()

    private let maxReconnectAttempts = 10
    private let baseReconnectDelay: TimeInterval = 1.0
    private let maxReconnectDelay: TimeInterval = 60.0

    // MARK: - Initialization

    /// Certificate pinning delegate retained by the WebSocket URLSession (NS-2).
    private let pinningDelegate = CertificatePinningDelegate()

    init(cryptoService: CryptoService) {
        self.cryptoService = cryptoService
        let config = URLSessionConfiguration.default
        config.waitsForConnectivity = true
        self.session = URLSession(configuration: config, delegate: pinningDelegate, delegateQueue: nil)
    }

    // MARK: - Relay URL

    /// The server's `global` pseudo-hub. It is not a hub the user belongs to, so it is
    /// never subscribed: hub events must be published to their own hub (#1013).
    static let globalPseudoHubId = "global"

    /// Resolve the relay endpoint advertised by `GET /api/config` (`wsRelayUrl`, e.g.
    /// `/ws`) against the hub's base URL.
    ///
    /// Only `wss://` is returned for remote hosts (`https` maps to `wss`). Cleartext
    /// `ws://` is allowed only for a loopback host — the same rule `APIService` applies
    /// to `http://` — because a loopback socket never crosses the network. Any other
    /// scheme, or a cleartext non-loopback endpoint, returns nil so a MITM-able relay
    /// is never used.
    static func relayURL(hubBaseURL: URL, advertised: String?) -> URL? {
        guard let advertised = advertised?.trimmingCharacters(in: .whitespacesAndNewlines),
              !advertised.isEmpty,
              let resolved = URL(string: advertised, relativeTo: hubBaseURL)?.absoluteURL,
              var components = URLComponents(url: resolved, resolvingAgainstBaseURL: false)
        else { return nil }

        switch components.scheme?.lowercased() {
        case "https", "wss":
            components.scheme = "wss"
        case "http", "ws":
            guard isLoopbackHost(components.host) else { return nil }
            components.scheme = "ws"
        default:
            return nil
        }
        return components.url
    }

    /// Whether the relay URL is acceptable to connect to (see `relayURL(hubBaseURL:advertised:)`).
    static func isAllowedRelayURL(_ url: URL) -> Bool {
        switch url.scheme?.lowercased() {
        case "wss", "https": return true
        case "ws": return isLoopbackHost(url.host)
        default: return false
        }
    }

    private static func isLoopbackHost(_ host: String?) -> Bool {
        guard let host = host?.lowercased() else { return false }
        return host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "[::1]"
    }

    // MARK: - Connect

    /// Connect to the relay at the given URL.
    /// Only `wss://`/`https://` (and `ws://` on a loopback host) are accepted; all
    /// others are rejected to prevent cleartext relay connections that would expose
    /// auth tokens.
    func connect(to url: URL) async {
        guard Self.isAllowedRelayURL(url) else { return }
        relayURL = url
        isIntentionalDisconnect = false
        reconnectAttempt = 0
        await performConnect()
    }

    /// Subscribe to `kinds` on every hub the user is a member of — the hubs the server
    /// lists in its `authenticated` reply — now (if already authenticated) and after
    /// every reconnect. Membership changes are picked up on the next authentication.
    func subscribeToMemberHubs(kinds: [Int]) {
        memberHubKinds = kinds
        if authenticated {
            for hubId in memberHubIds {
                subscribe(hubId: hubId, kinds: kinds)
            }
        }
    }

    /// Subscribe to events for a hub. Safe to call before or after authentication —
    /// subscription messages are buffered and flushed after the auth handshake completes.
    func subscribe(hubId: String, kinds: [Int]) {
        subscribedHubs[hubId] = kinds
        if authenticated {
            sendSubscription(hubId: hubId, kinds: kinds)
        } else {
            // Remove any stale entry for this hub then re-add
            pendingSubscriptions.removeAll { $0.hubId == hubId }
            pendingSubscriptions.append((hubId: hubId, kinds: kinds))
        }
    }

    private func performConnect() async {
        guard let url = relayURL else { return }

        webSocketTask?.cancel(with: .goingAway, reason: nil)
        receiveTask?.cancel()
        authenticated = false

        connectionState = reconnectAttempt > 0
            ? .reconnecting(attempt: reconnectAttempt)
            : .connecting

        // URLSessionWebSocketTask requires ws:// or wss:// schemes. Convert https:// → wss://.
        // connect(to:) already rejects http:// and non-loopback ws://.
        let wsURL: URL
        if url.scheme == "https", var components = URLComponents(url: url, resolvingAgainstBaseURL: false) {
            components.scheme = "wss"
            wsURL = components.url ?? url
        } else {
            wsURL = url
        }
        let task = session.webSocketTask(with: wsURL)
        webSocketTask = task
        task.resume()

        // Receive loop drives the entire auth + event pipeline
        receiveTask = Task { [weak self] in
            await self?.receiveLoop()
        }
    }

    // MARK: - Disconnect

    /// Gracefully disconnect from the relay.
    func disconnect() {
        isIntentionalDisconnect = true
        reconnectTask?.cancel()
        receiveTask?.cancel()
        webSocketTask?.cancel(with: .normalClosure, reason: nil)
        webSocketTask = nil
        authenticated = false
        connectionState = .disconnected
    }

    // MARK: - Receive Loop

    private func receiveLoop() async {
        guard let task = webSocketTask else { return }

        while !Task.isCancelled {
            do {
                let message = try await task.receive()
                let text: String
                switch message {
                case .string(let s): text = s
                case .data(let d):
                    guard let s = String(data: d, encoding: .utf8) else { continue }
                    text = s
                @unknown default: continue
                }
                handleServerMessage(text)
            } catch {
                if !Task.isCancelled {
                    await handleDisconnect(error: error)
                }
                return
            }
        }
    }

    // MARK: - Message Dispatch

    private func handleServerMessage(_ text: String) {
        guard let data = text.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = obj["type"] as? String else { return }

        switch type {
        case "challenge":
            guard let nonce = obj["nonce"] as? String else { return }
            handleChallenge(nonce: nonce)

        case "authenticated":
            handleAuthenticated(serverHubs: obj["hubs"] as? [String] ?? [])

        case "event":
            guard
                let v = obj["v"] as? Int,
                let hubId = obj["hubId"] as? String,
                let kind = obj["kind"] as? Int,
                let payload = obj["payload"] as? String,
                let epoch = obj["epoch"] as? Int,
                let ts = obj["ts"] as? Int
            else { return }
            let msg = WsIncomingEvent(v: v, hubId: hubId, kind: kind, payload: payload, epoch: epoch, ts: ts)
            handleEvent(msg)

        case "subscribed", "unsubscribed", "pong":
            break

        case "error":
            if (obj["code"] as? String) == "auth_failed" {
                authenticated = false
            }

        default:
            break
        }
    }

    // MARK: - Auth Handshake

    private func handleChallenge(nonce: String) {
        guard let pubkey = cryptoService.signingPubkeyHex else { return }

        let ts = Int(Date().timeIntervalSince1970 * 1000)
        // Signed message format: LABEL_WS_CHALLENGE:{pubkey}:{nonce}:{ts}
        let signedMessage = "\(CryptoLabels.LABEL_WS_CHALLENGE):\(pubkey):\(nonce):\(ts)"
        guard
            let msgData = signedMessage.data(using: .utf8),
            let sig = try? cryptoService.ed25519Sign(
                messageHex: msgData.map { String(format: "%02x", $0) }.joined()
            )
        else { return }

        let authPayload: [String: Any] = [
            "type": "auth",
            "pubkey": pubkey,
            "nonce": nonce,
            "ts": ts,
            "sig": sig,
        ]
        guard
            let authData = try? JSONSerialization.data(withJSONObject: authPayload),
            let authText = String(data: authData, encoding: .utf8),
            let task = webSocketTask
        else { return }

        Task {
            try? await task.send(.string(authText))
        }
    }

    private func handleAuthenticated(serverHubs: [String]) {
        authenticated = true
        reconnectAttempt = 0
        eventCount = 0
        connectionState = .connected
        memberHubIds = serverHubs.filter { $0 != Self.globalPseudoHubId }

        if let kinds = memberHubKinds {
            // The server rejects subscriptions to hubs the user is not a member of, so
            // drop any left over from a membership that has since ended.
            let members = Set(memberHubIds)
            subscribedHubs = subscribedHubs.filter { members.contains($0.key) }
            pendingSubscriptions.removeAll { !members.contains($0.hubId) }
            for hubId in memberHubIds where subscribedHubs[hubId] == nil {
                subscribedHubs[hubId] = kinds
            }
        }
        flushPendingSubscriptions()
    }

    // MARK: - Subscriptions

    private func flushPendingSubscriptions() {
        // Send buffered subscriptions accumulated before auth
        let pending = pendingSubscriptions
        pendingSubscriptions = []
        for sub in pending {
            sendSubscription(hubId: sub.hubId, kinds: sub.kinds)
        }
        // Re-subscribe to all known hubs on reconnect (pending may not have them all)
        for (hubId, kinds) in subscribedHubs {
            if !pending.contains(where: { $0.hubId == hubId }) {
                sendSubscription(hubId: hubId, kinds: kinds)
            }
        }
    }

    private func sendSubscription(hubId: String, kinds: [Int]) {
        send(["type": "subscribe", "hubId": hubId, "kinds": kinds])
    }

    private func send(_ message: [String: Any]) {
        guard
            let data = try? JSONSerialization.data(withJSONObject: message, options: [.sortedKeys]),
            let text = String(data: data, encoding: .utf8)
        else { return }
        #if DEBUG
        outboundMessageObserver?(text)
        #endif
        guard let task = webSocketTask else { return }
        Task { try? await task.send(.string(text)) }
    }

    // MARK: - Event Handling

    private func handleEvent(_ msg: WsIncomingEvent) {
        eventCount += 1
        if let attributed = decryptPayload(msg.payload, epoch: msg.epoch, hubId: msg.hubId) {
            emit(attributed)
        }
    }

    // MARK: - Decryption

    #if DEBUG
    /// Overridable decryption closure for unit testing.
    /// Receives (ciphertextHex, epoch) and returns plaintext JSON string, or nil on failure.
    var decryptionHandler: (String, Int) -> String? = { _, _ in nil }
    #endif

    /// Decrypt an event payload and return a typed attributed event.
    /// In DEBUG builds, `decryptionHandler` is tried first to allow test injection.
    internal func decryptPayload(_ payload: String, epoch: Int, hubId: String) -> AttributedHubEvent? {
        let json: String?
        #if DEBUG
        json = decryptionHandler(payload, epoch)
            ?? cryptoService.decryptServerEvent(ciphertextHex: payload, epoch: epoch)
        #else
        json = cryptoService.decryptServerEvent(ciphertextHex: payload, epoch: epoch)
        #endif
        guard let json, let eventType = parseHubEvent(json) else { return nil }
        return AttributedHubEvent(hubId: hubId, event: eventType)
    }

    private func parseHubEvent(_ json: String) -> HubEventType? {
        guard
            let data = json.data(using: .utf8),
            let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let type = obj["type"] as? String
        else { return nil }
        return HubEventType(rawValue: type) ?? .unknown
    }

    // MARK: - Emission

    private func emit(_ attributed: AttributedHubEvent) {
        typedContinuationsLock.lock()
        let active = Array(typedContinuations.values)
        typedContinuationsLock.unlock()
        for continuation in active {
            continuation.yield(attributed)
        }
    }

    // MARK: - Reconnection

    private func handleDisconnect(error: Error?) async {
        guard !isIntentionalDisconnect else {
            connectionState = .disconnected
            return
        }

        authenticated = false
        reconnectAttempt += 1

        guard reconnectAttempt <= maxReconnectAttempts else {
            connectionState = .disconnected
            return
        }

        connectionState = .reconnecting(attempt: reconnectAttempt)

        let delay = min(
            baseReconnectDelay * pow(2.0, Double(reconnectAttempt - 1)),
            maxReconnectDelay
        )
        let jitter = Double.random(in: 0...(delay * 0.3))

        reconnectTask = Task {
            try? await Task.sleep(for: .seconds(delay + jitter))
            guard !Task.isCancelled, !isIntentionalDisconnect else { return }
            // Re-queue all known subscriptions as pending before reconnect
            pendingSubscriptions = subscribedHubs.map { (hubId: $0.key, kinds: $0.value) }
            await performConnect()
        }
    }

    // MARK: - Test Support

    #if DEBUG
    /// Inject a typed event directly into the attributed stream for unit testing.
    internal func emitAttributedEvent(hubId: String, eventType: HubEventType) {
        emit(AttributedHubEvent(hubId: hubId, event: eventType))
    }

    /// Observes every client→server message as it is sent, for unit testing.
    var outboundMessageObserver: ((String) -> Void)?

    /// Feed a raw server message through the real dispatch path, for unit testing.
    internal func receiveServerMessageForTesting(_ text: String) {
        handleServerMessage(text)
    }
    #endif
}
