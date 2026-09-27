import Foundation
import os

// MARK: - AuthStatus

/// Top-level authentication state for the app.
enum AuthStatus: Equatable {
    /// No identity exists — show login/onboarding.
    case unauthenticated
    /// Identity exists but is locked — show PIN unlock.
    case locked
    /// Identity is loaded and device key is in memory — show dashboard.
    case unlocked
}

// MARK: - AppState

/// Root observable state container for the entire app. Holds all service instances
/// and the current auth status. Injected into the SwiftUI environment at the app root.
@Observable
final class AppState {
    // MARK: - Services

    let hubContext: HubContext
    let cryptoService: CryptoService
    let keychainService: KeychainService
    let apiService: APIService
    let authService: AuthService
    let webSocketService: WebSocketService
    let wakeKeyService: WakeKeyService
    let transcriptionService: TranscriptionService
    let crashReportingService: CrashReportingService
    let offlineQueue: OfflineQueue
    let hubActivityService: HubActivityService
    let linphoneService: LinphoneService
    let wipeService: WipeService
    let permissionService: PermissionService

    // MARK: - Auth State

    /// Current authentication status, drives top-level navigation.
    var authStatus: AuthStatus = .unauthenticated

    /// Whether the app is currently locked (background timeout or manual lock).
    /// Distinct from authStatus == .locked because it tracks the explicit "needs re-auth" state.
    var isLocked: Bool = false

    /// Admin decryption pubkey from the server — used for E2EE envelope encryption
    /// so admins can decrypt notes, reports, and messages created by this client.
    var adminDecryptionPubkey: String?

    /// The current user's role. Determines whether admin features are visible.
    /// Loaded from the server after authentication.
    var userRole: UserRole = .volunteer

    /// Whether the current user has admin privileges.
    /// Delegates to PermissionService for fine-grained PBAC.
    var isAdmin: Bool { permissionService.isAdmin }

    /// Check if the current user has a specific permission.
    func hasPermission(_ permission: String) -> Bool {
        permissionService.hasPermission(permission)
    }

    /// Total unread conversation count for the tab badge.
    var unreadConversationCount: Int = 0

    /// Whether this device has been remotely wiped. Once true, shows non-dismissable receipt.
    var isDeviceWiped: Bool = false

    /// Reason for the device wipe, passed to DeviceWipeReceiptView.
    var deviceWipeReason: String = ""

    /// Result of the on-launch version compatibility check against the server.
    var versionStatus: VersionStatus = .unknown

    /// Whether to show the force-update blocking screen.
    var showForceUpdate: Bool = false

    /// Whether to show the soft-update banner (dismissible).
    var showUpdateBanner: Bool = false

    /// Pending hub invite token from a `llamenos://hub-invite?token=` deep link.
    /// Set before the user is authenticated so the login / registration flow can
    /// use it when creating or linking an account to a hub.
    var pendingHubInviteToken: String?

    // MARK: - WebSocket Event Listener

    /// Background task that listens for WebSocket events.
    private var eventListenerTask: Task<Void, Never>?
    /// Resolves the relay endpoint from `/api/config` and connects.
    private var relayConnectTask: Task<Void, Never>?
    private let logger = Logger(subsystem: "org.llamenos.hotline", category: "Relay")

    // MARK: - Initialization

    init(hubContext: HubContext) {
        self.hubContext = hubContext
        let crypto = CryptoService()
        let keychain = KeychainService()
        let api = APIService(cryptoService: crypto, hubContext: hubContext)
        let auth = AuthService(cryptoService: crypto, keychainService: keychain)
        let ws = WebSocketService(cryptoService: crypto)
        let wake = WakeKeyService(keychainService: keychain, cryptoService: crypto, apiService: api)
        let transcription = TranscriptionService()
        let crashReporting = CrashReportingService()
        let offline = OfflineQueue(apiService: api)
        let hubActivity = HubActivityService()
        let linphone = LinphoneService()
        let permission = PermissionService()

        self.cryptoService = crypto
        self.keychainService = keychain
        self.apiService = api
        self.authService = auth
        self.webSocketService = ws
        self.wakeKeyService = wake
        self.transcriptionService = transcription
        self.crashReportingService = crashReporting
        self.offlineQueue = offline
        self.hubActivityService = hubActivity
        self.linphoneService = linphone
        self.permissionService = permission
        self.wipeService = WipeService(
            keychainService: keychain,
            cryptoService: crypto,
            wakeKeyService: wake,
            offlineQueue: offline,
            crashReportingService: crashReporting,
            webSocketService: ws
        )

        // Wire offline queue into API service for automatic enqueue on network errors
        api.offlineQueue = offline

        #if UI_TESTING
        // Handle launch arguments BEFORE reading persisted state
        // so --reset-keychain clears everything before we configure services
        handleLaunchArguments()
        #endif

        // Configure API base URL if stored
        if let hubURL = auth.hubURL {
            try? api.configure(hubURLString: hubURL)
            SecurityEventService.shared.configure(baseURL: api.baseURL)
        }

        // Start retrying queued security events (e.g. cert pin mismatches from a
        // previous session) as soon as the network is available. Independent of
        // auth state — a pin failure can happen before login.
        SecurityEventService.shared.startMonitoring()

        // Generate wake keypair on first launch (non-blocking)
        try? wake.ensureKeypairExists()

        // Determine initial auth state
        resolveAuthStatus()

        // Load cached admin decryption pubkey so it's available immediately after unlock
        // (before the async fetchUserRole() completes)
        adminDecryptionPubkey = try? keychain.retrieveString(key: KeychainKey.adminDecryptionPubkey)
    }

    // MARK: - Launch Arguments (Test Support)

    #if UI_TESTING
    /// Handle launch arguments for XCUITest automation.
    /// These flags let UI tests set up specific states without going through full flows.
    private func handleLaunchArguments() {
        let args = ProcessInfo.processInfo.arguments

        if args.contains("--reset-keychain") {
            keychainService.deleteAll()
            // AuthService cached hasStoredKeys/hubURL from init — reset stale values
            authService.logout()
            // The active hub lives in UserDefaults, which survives relaunches on the
            // same simulator — without this a test inherits the previous test's hub.
            hubContext.clearActiveHub()
        }

        // Configure hub URL for API access (must come before --test-register)
        if let hubIndex = args.firstIndex(of: "--test-hub-url"),
           hubIndex + 1 < args.count {
            let hubURL = args[hubIndex + 1]
            try? apiService.configure(hubURLString: hubURL)
            try? authService.setHubURL(hubURL)
        }

        if args.contains("--test-authenticated") {
            if args.contains("--test-volunteer-identity") {
                // Use a separate volunteer keypair (NOT the admin key)
                cryptoService.setMockVolunteerIdentity()
            } else {
                // Default: a fresh device key per launch; --test-register makes it an admin.
                cryptoService.setMockIdentity()
            }
            isLocked = false
        }

        if args.contains("--test-admin") {
            userRole = .admin
        }

        // Register identity with server (must come after keypair + hub URL)
        if args.contains("--test-register") && cryptoService.isUnlocked {
            let hubId = args.firstIndex(of: "--test-hub-id")
                .flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil }
                .flatMap { $0.isEmpty ? nil : $0 }
            registerTestIdentity(asAdmin: !args.contains("--test-volunteer-identity"), hubId: hubId)
            // After successful registration, connect WebSocket and fetch role
            // so the dashboard shows "Connected" and the correct user role.
            connectWebSocketIfConfigured()
            fetchUserRole()
        }
    }

    /// Register this launch's device identity with the test server the way an admin
    /// adds a member in production: the well-known test admin — whose signing seed
    /// BaseUITest hands the app in `XCTEST_ADMIN_SECRET`, and whose pubkey the server
    /// runs with as ADMIN_PUBKEY — creates the user through `POST /api/users` and adds
    /// it to the test class's hub through `POST /api/hubs/{hubId}/members`. That hub
    /// becomes the active hub, so hub-scoped screens browse the class's own hub.
    ///
    /// This replaces a one-shot `POST /api/auth/bootstrap`. `setMockIdentity()` makes a
    /// fresh key every launch and the test server always already has an admin, so the
    /// bootstrap answered 403 every time and every API-connected UI test ran against a
    /// server answering 401 to everything it did (#1221). The volunteer path read
    /// `XCTEST_ADMIN_SECRET`, which no test ever set, and registered the X25519
    /// encryption key where the server authenticates the Ed25519 signing key.
    ///
    /// A registration failure is fatal: an unregistered app would turn every
    /// assertion after it into an assertion about a 401 error state.
    private func registerTestIdentity(asAdmin: Bool, hubId: String?) {
        guard let baseURL = apiService.baseURL else {
            fatalError("UI_TESTING: --test-register requires --test-hub-url")
        }
        guard let devicePubkey = cryptoService.signingPubkeyHex else {
            fatalError("UI_TESTING: --test-register requires --test-authenticated")
        }
        guard let adminSecretHex = ProcessInfo.processInfo.environment["XCTEST_ADMIN_SECRET"],
              !adminSecretHex.isEmpty else {
            fatalError("UI_TESTING: --test-register requires XCTEST_ADMIN_SECRET in the launch environment")
        }

        sendAsTestAdmin(
            baseURL: baseURL,
            adminSecretHex: adminSecretHex,
            path: "/api/users",
            body: [
                "pubkey": devicePubkey,
                "name": asAdmin ? "iOS UI Test Admin" : "iOS UI Test Volunteer",
                "phone": "",
                "roleIds": [asAdmin ? "role-super-admin" : "role-volunteer"],
            ]
        )

        if let hubId {
            sendAsTestAdmin(
                baseURL: baseURL,
                adminSecretHex: adminSecretHex,
                path: "/api/hubs/\(hubId)/members",
                body: [
                    "pubkey": devicePubkey,
                    "roleIds": [asAdmin ? "role-hub-admin" : "role-volunteer"],
                ]
            )
            hubContext.setActiveHub(hubId)
        }
    }

    /// POST `body` to `path`, signed as the test admin. Blocks (max 30s) — test setup
    /// only, before any view exists; a CI runner still booting its simulator has
    /// kept the backend busy for 30s. Any non-2xx outcome is fatal (see above).
    private func sendAsTestAdmin(baseURL: URL, adminSecretHex: String, path: String, body: [String: Any]) {
        let token: AuthToken
        do {
            token = try CryptoService.createAuthTokenStatic(secretHex: adminSecretHex, method: "POST", path: path)
        } catch {
            fatalError("UI_TESTING: could not sign \(path) as the test admin: \(error)")
        }
        var auth: [String: Any] = ["pubkey": token.pubkey, "timestamp": Int(token.timestamp), "token": token.token]
        if let nonce = token.nonce { auth["nonce"] = nonce }

        var request = URLRequest(url: baseURL.appendingPathComponent(String(path.dropFirst())))
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        // Server expects: Bearer {"pubkey":"...","timestamp":...,"token":"..."}
        guard let authJSON = try? JSONSerialization.data(withJSONObject: auth),
              let bodyJSON = try? JSONSerialization.data(withJSONObject: body) else {
            fatalError("UI_TESTING: could not encode \(path) request")
        }
        request.setValue("Bearer \(String(decoding: authJSON, as: UTF8.self))", forHTTPHeaderField: "Authorization")
        request.httpBody = bodyJSON

        var outcome = "timed out after 30s"
        let sem = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { data, response, error in
            defer { sem.signal() }
            if let error {
                outcome = error.localizedDescription
            } else if let http = response as? HTTPURLResponse {
                outcome = (200...299).contains(http.statusCode)
                    ? "ok"
                    : "HTTP \(http.statusCode) \(String(decoding: data ?? Data(), as: UTF8.self))"
            }
        }.resume()
        _ = sem.wait(timeout: .now() + 32)
        if outcome != "ok" {
            fatalError("UI_TESTING: registering the test identity failed at POST \(path): \(outcome)")
        }
    }
    #endif // UI_TESTING

    // MARK: - Auth Status Resolution

    /// Determine auth status from service state. Called on init and after state transitions.
    func resolveAuthStatus() {
        if cryptoService.isUnlocked && !isLocked {
            authStatus = .unlocked
        } else if authService.hasStoredKeys {
            authStatus = .locked
        } else {
            authStatus = .unauthenticated
        }
    }

    // MARK: - Lock / Unlock

    /// Lock the app: clear device key from memory, set locked state.
    func lockApp() {
        authService.lock()
        isLocked = true
        authStatus = .locked
    }

    /// Called after successful PIN/biometric unlock.
    func didUnlock() {
        isLocked = false
        authStatus = .unlocked
        connectWebSocketIfConfigured()
        fetchUserRole()
        offlineQueue.startMonitoring()
        // Replay any queued operations now that we're authenticated
        Task { await offlineQueue.replay() }
        // Retry any queued security events (e.g. a cert pin mismatch seen while
        // locked or logged out) now that we're back online and unlocked.
        Task { await SecurityEventService.shared.flush() }
    }

    /// Fetch admin decryption pubkey from the API if not already cached.
    /// Call this before any encryption operation to guarantee the pubkey is available.
    func ensureAdminPubkeyLoaded() async {
        if adminDecryptionPubkey != nil { return }
        do {
            let response: AuthMeResponse = try await apiService.request(
                method: "GET",
                path: "/api/auth/me"
            )
            await MainActor.run {
                self.adminDecryptionPubkey = response.adminDecryptionPubkey
                if let pubkey = response.adminDecryptionPubkey {
                    try? self.keychainService.storeString(pubkey, key: KeychainKey.adminDecryptionPubkey)
                }
            }
        } catch {
            // Non-fatal — the cached value (if any) will be used
        }
    }

    /// Called after successful onboarding (new identity or import + PIN set).
    func didCompleteOnboarding() {
        isLocked = false
        authStatus = .unlocked

        // Configure API with the stored hub URL
        if let hubURL = authService.hubURL {
            try? apiService.configure(hubURLString: hubURL)
            SecurityEventService.shared.configure(baseURL: apiService.baseURL)
        }

        connectWebSocketIfConfigured()
        fetchUserRole()
        offlineQueue.startMonitoring()
        Task { await SecurityEventService.shared.flush() }
    }

    /// Handle a device wipe command from the server.
    func handleDeviceWipe(reason: String) {
        wipeService.wipeAll()
        deviceWipeReason = reason
        isDeviceWiped = true
    }

    /// Called when the user logs out / resets identity.
    func didLogout() {
        wipeService.logout()
        eventListenerTask?.cancel()
        eventListenerTask = nil
        relayConnectTask?.cancel()
        relayConnectTask = nil
        authService.logout()
        isLocked = false
        authStatus = .unauthenticated
        userRole = .volunteer
        adminDecryptionPubkey = nil
        keychainService.delete(key: KeychainKey.adminDecryptionPubkey)
        permissionService.clear()
        unreadConversationCount = 0
    }

    // MARK: - Hub Key Management

    /// Load hub keys for all hubs in parallel. Called after login.
    /// Fetches each hub's HPKE-wrapped key envelope from the API and unwraps it
    /// into Rust CryptoState. Failures on individual hubs are logged and skipped —
    /// partial key loading is better than blocking the entire login flow.
    func loadAllHubKeys(hubs: [SharedHub]) async {
        await withTaskGroup(of: Void.self) { group in
            for hub in hubs {
                guard !cryptoService.hasHubKey(hubId: hub.id) else { continue }
                group.addTask { [apiService, cryptoService] in
                    do {
                        let envelope = try await apiService.getHubKey(hub.id)
                        try cryptoService.loadHubKey(hubId: hub.id, envelope: envelope)
                    } catch {
                        #if DEBUG
                        print("[HubKeys] Failed to load key for hub \(hub.id): \(error.localizedDescription)")
                        #endif
                    }
                }
            }
        }
    }

    /// Clear hub key cache on lock / logout.
    /// Evicts all hub symmetric keys from Rust memory and resets the active hub.
    func clearHubKeys() {
        cryptoService.clearHubKeys()
        hubContext.clearActiveHub()
    }

    // MARK: - WebSocket Connection

    /// Check API version compatibility with the server on app launch.
    /// Fetches `/api/config` and compares `minApiVersion` / `apiVersion` against the client.
    func checkVersionCompatibility() {
        Task {
            let status = await apiService.checkVersionCompatibility()
            await MainActor.run {
                self.versionStatus = status
                switch status {
                case .forceUpdate:
                    self.showForceUpdate = true
                    self.showUpdateBanner = false
                case .updateAvailable:
                    self.showForceUpdate = false
                    self.showUpdateBanner = true
                case .upToDate, .unknown:
                    self.showForceUpdate = false
                    self.showUpdateBanner = false
                }
            }
        }
    }

    /// Fetch the current user's role and permissions from the API after authentication.
    func fetchUserRole() {
        Task {
            do {
                let response: AuthMeResponse = try await apiService.request(
                    method: "GET",
                    path: "/api/auth/me"
                )
                await MainActor.run {
                    // Store fine-grained permissions from the server
                    self.permissionService.update(permissions: response.permissions ?? [])

                    // Legacy role field — kept for backward compat with views that
                    // haven't migrated to hasPermission() yet
                    let hasAdminRole = response.roles.contains { $0.contains("admin") }
                    self.userRole = hasAdminRole ? .admin : .volunteer

                    // Store admin decryption pubkey for E2EE envelope encryption
                    self.adminDecryptionPubkey = response.adminDecryptionPubkey
                    // Persist to keychain so it's available immediately on next unlock
                    if let pubkey = response.adminDecryptionPubkey {
                        try? self.keychainService.storeString(pubkey, key: KeychainKey.adminDecryptionPubkey)
                    }

                    // Store server event keys in Rust CryptoState for epoch-aware decryption.
                    // current key is required; previous key is optional (used during epoch rotation).
                    if let keyHex = response.serverEventKeyHex {
                        try? self.cryptoService.setServerEventKeys(
                            currentHex: keyHex,
                            previousHex: response.serverEventKeyPrevHex
                        )
                    }
                }
            } catch {
                // Default to volunteer if role fetch fails
                await MainActor.run {
                    self.userRole = .volunteer
                    self.permissionService.clear()
                }
            }
        }
    }

    /// Relay event kinds subscribed on every member hub: call ring/update/voicemail,
    /// new message, conversation assigned, presence. Mirrors the desktop client.
    static let relayEventKinds = [1000, 1001, 1002, 1010, 1011, 20000]

    /// Connect WebSocket to the relay if a hub URL is configured.
    ///
    /// The relay endpoint is the one the server advertises in `GET /api/config`
    /// (`wsRelayUrl`), never a hard-coded suffix. Every hub the user is a member of is
    /// subscribed — not only the active hub — so a ring on any hub reaches the app
    /// (multi-hub routing axiom).
    private func connectWebSocketIfConfigured() {
        guard authService.hubURL != nil, let hubBaseURL = apiService.baseURL else { return }

        webSocketService.subscribeToMemberHubs(kinds: Self.relayEventKinds)

        // Start (or restart) the attributed-event consumer that drives per-hub activity state.
        eventListenerTask?.cancel()
        eventListenerTask = Task { [weak self] in
            guard let self else { return }
            for await attributed in webSocketService.attributedEvents {
                hubActivityService.handle(attributed)
            }
        }

        relayConnectTask?.cancel()
        relayConnectTask = Task { [weak self] in
            guard let self else { return }
            guard let relayURL = await resolveRelayURL(hubBaseURL: hubBaseURL) else { return }
            await webSocketService.connect(to: relayURL)
        }
    }

    /// Fetch the server-advertised relay endpoint, retrying with backoff while the
    /// server is unreachable. Returns nil if the server advertises no relay, advertises
    /// one that fails the transport rule, or stays unreachable.
    private func resolveRelayURL(hubBaseURL: URL) async -> URL? {
        let maxAttempts = 5
        for attempt in 0..<maxAttempts {
            do {
                let config = try await apiService.fetchAppConfig()
                guard let url = WebSocketService.relayURL(hubBaseURL: hubBaseURL, advertised: config.wsRelayUrl) else {
                    logger.error("Relay unavailable: server advertised wsRelayUrl=\(config.wsRelayUrl ?? "nil", privacy: .public)")
                    return nil
                }
                return url
            } catch {
                if Task.isCancelled { return nil }
                logger.warning("Relay config fetch failed (attempt \(attempt + 1)): \(error.localizedDescription, privacy: .public)")
                if attempt + 1 < maxAttempts {
                    try? await Task.sleep(for: .seconds(pow(2.0, Double(attempt))))
                }
            }
        }
        return nil
    }
}

// MARK: - API Response Types

/// Response from `GET /api/auth/me`.
struct AuthMeResponse: Decodable {
    let pubkey: String
    let roles: [String]
    let permissions: [String]?
    let name: String?
    let profileCompleted: Bool?
    let onBreak: Bool?
    let adminDecryptionPubkey: String?
    let serverEventKeyHex: String?
    let serverEventKeyPrevHex: String?
}
