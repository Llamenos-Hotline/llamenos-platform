import CommonCrypto
import Foundation

// MARK: - APIError

enum APIError: LocalizedError {
    case invalidURL(String)
    case noBaseURL
    case insecureConnection(String)
    case requestFailed(statusCode: Int, body: String)
    case networkError(Error)
    case decodingError(Error)
    case authTokenCreationFailed(Error)

    var errorDescription: String? {
        switch self {
        case .invalidURL(let url):
            return "Invalid URL: \(url)"
        case .noBaseURL:
            return NSLocalizedString("error_no_hub_url", comment: "No hub URL configured")
        case .insecureConnection(let reason):
            return reason
        case .requestFailed(let code, let body):
            return "HTTP \(code): \(body)"
        case .networkError(let error):
            return error.localizedDescription
        case .decodingError(let error):
            return "Decoding error: \(error.localizedDescription)"
        case .authTokenCreationFailed(let error):
            return "Auth token creation failed: \(error.localizedDescription)"
        }
    }
}

// MARK: - Version Status

/// Result of comparing the client's API version against the server's config.
enum VersionStatus: Equatable {
    /// Client is up-to-date with the server.
    case upToDate
    /// A newer version is available but not required.
    case updateAvailable(latestVersion: Int)
    /// Client is too old and must update before continuing.
    case forceUpdate(minVersion: Int)
    /// Version check could not be performed (network error, etc.).
    case unknown
}

// MARK: - App Config Response

/// Response from `GET /api/config` — only the fields the client reads before login:
/// version compatibility and the relay endpoint.
struct AppConfig: Decodable {
    let hotlineName: String
    let apiVersion: Int
    let minApiVersion: Int
    /// WebSocket relay endpoint advertised by the server (currently the path `/ws`).
    /// May be a path relative to the hub URL or an absolute URL. `nil` when the server
    /// has no relay configured.
    let wsRelayUrl: String?
}

// MARK: - Recovery Group Response Types

struct AppRecoveryGroupInfo: Decodable {
    let publicKey: String
    let threshold: Int
    let totalShares: Int
    let commitments: [String]
    let sigchainLinkHash: String
    let delayHours: Int
    let emergencyFloorHours: Int
    let createdAt: String
    let rotatedAt: String?
    let shareHolderLiveness: [ShareHolderLiveness]
}


struct RecoverySessionStatus: Decodable, Identifiable {
    let sessionId: String
    let hubId: String
    let userPubkey: String
    let newDevicePubkey: String
    let status: String
    let contributionCount: Int
    let threshold: Int
    let delayRemainingMs: Int?
    let expiresAt: String
    let createdAt: String
    let contributions: [RecoveryContribution]?
    let emergencyOverride: AppRecoveryEmergencyOverride?

    var id: String { sessionId }
}

struct RecoveryContribution: Decodable {
    let contributorPubkey: String
    let encryptedShare: String
    let contributorSignature: String
    let contributedAt: String
}

struct AppRecoveryEmergencyOverride: Decodable {
    let justification: String
    let approverPubkey: String
    let approverSignature: String
}

struct AppRecoveryInitiateResponse: Decodable {
    let sessionId: String
    let verificationSent: Bool
}

struct RecoveryVerifyResponse: Decodable {
    let ok: Bool
    let expiresAt: String
}

// ShareHolderLiveness is now provided by protocol codegen (Types.swift)

struct ShareEnvelopeResponse: Decodable {
    let shareEnvelope: String
    let shareCommitment: String?
}

struct OkResponse: Decodable {
    let ok: Bool
}

struct ContributeResponse: Decodable {
    let ok: Bool
    let status: String
    let contributionCount: Int
}

// MARK: - APIService

/// URLSession-based REST client for the Llamenos hub API. Injects CryptoService to
/// generate Ed25519 auth tokens for each request. The auth token is sent as a Bearer
/// header containing a JSON object with pubkey, timestamp, and Ed25519 signature.
final class APIService: @unchecked Sendable {
    /// The API version this client is compiled against.
    /// Must match the server's `CURRENT_API_VERSION` in `apps/worker/lib/api-versions.ts`.
    static let apiVersion: Int = 1
    private(set) var baseURL: URL?
    private let cryptoService: CryptoService
    private let hubContext: HubContext
    private let session: URLSession
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    /// Offline write queue. Set by AppState after initialization.
    /// When a write request fails with a network error, the operation is
    /// automatically enqueued for replay when connectivity is restored.
    var offlineQueue: OfflineQueue?

    /// Certificate pinning delegate (H14). Retained by the URLSession.
    private let pinningDelegate = CertificatePinningDelegate()

    /// - Parameter sessionConfiguration: base configuration for the pinned URLSession.
    ///   Tests pass one carrying a stub `URLProtocol`; production uses `.default`.
    init(
        cryptoService: CryptoService,
        hubContext: HubContext,
        sessionConfiguration: URLSessionConfiguration = .default
    ) {
        self.cryptoService = cryptoService
        self.hubContext = hubContext
        let config = sessionConfiguration
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 60
        config.waitsForConnectivity = true
        // H14: Use certificate pinning delegate for all API requests
        self.session = URLSession(configuration: config, delegate: pinningDelegate, delegateQueue: nil)

        self.encoder = JSONEncoder()
        self.encoder.keyEncodingStrategy = .convertToSnakeCase

        self.decoder = JSONDecoder()
        self.decoder.keyDecodingStrategy = .convertFromSnakeCase
    }

    /// Set or update the hub base URL.
    func configure(baseURL: URL) {
        self.baseURL = baseURL
    }

    /// Set the base URL from a string, validating it first.
    /// H6: Rejects http:// URLs — only HTTPS is allowed for hub connections.
    /// Exception: localhost/127.0.0.1 are allowed over HTTP for local development.
    /// Auto-prepends https:// if no scheme is specified.
    func configure(hubURLString: String) throws {
        var urlString = hubURLString.trimmingCharacters(in: .whitespacesAndNewlines)

        let isLocalhost = urlString.contains("localhost") || urlString.contains("127.0.0.1")

        // H6: Reject insecure HTTP connections (except localhost)
        if urlString.lowercased().hasPrefix("http://"), !isLocalhost {
            throw APIError.insecureConnection(
                NSLocalizedString(
                    "error_http_not_allowed",
                    comment: "HTTP connections are not allowed. Use HTTPS for secure communication."
                )
            )
        }

        // Auto-prepend scheme if none specified
        if !urlString.hasPrefix("http://"), !urlString.hasPrefix("https://") {
            urlString = isLocalhost ? "http://\(urlString)" : "https://\(urlString)"
        }

        // Strip trailing slash
        if urlString.hasSuffix("/") {
            urlString = String(urlString.dropLast())
        }
        guard let url = URL(string: urlString) else {
            throw APIError.invalidURL(hubURLString)
        }
        self.baseURL = url
    }

    /// Scope an `/api/...` path to the active hub (`/api/hubs/{activeHubId}/...`).
    /// Falls back to the bare path if no hub is selected.
    ///
    /// Use this only for browsing the active hub. Anything that belongs to a specific
    /// hub — a call ringing on hub B while hub A is active — must use
    /// `hubPath(_:_:)` with that hub's ID (multi-hub routing axiom).
    func hp(_ path: String) -> String {
        guard let hubId = hubContext.activeHubId else { return path }
        return Self.hubPath(hubId, path)
    }

    /// Scope an `/api/...` path to the given hub.
    ///
    /// The server mounts hub-scoped routes at `/api/hubs/:hubId/...`, so
    /// `/api/calls/active` becomes `/api/hubs/{hubId}/calls/active`.
    static func hubPath(_ hubId: String, _ path: String) -> String {
        let apiPrefix = "/api"
        let rest = path.hasPrefix(apiPrefix + "/") ? String(path.dropFirst(apiPrefix.count)) : path
        return "\(apiPrefix)/hubs/\(hubId)\(rest)"
    }

    /// Test whether the hub URL is reachable. Returns true if the server responds.
    func validateConnection() async -> Bool {
        guard let baseURL else { return false }
        let healthURL = baseURL.appendingPathComponent("/api/health")
        var request = URLRequest(url: healthURL, timeoutInterval: 5)
        request.httpMethod = "GET"
        do {
            let (_, response) = try await session.data(for: request)
            if let httpResponse = response as? HTTPURLResponse {
                return (200...499).contains(httpResponse.statusCode)
            }
            return false
        } catch {
            return false
        }
    }

    /// Perform an authenticated API request.
    ///
    /// - Parameters:
    ///   - method: HTTP method (GET, POST, PUT, DELETE, PATCH).
    ///   - path: API path relative to the base URL (e.g., "/api/identity/me").
    ///   - body: Optional Encodable body for POST/PUT/PATCH requests.
    /// - Returns: Decoded response of type T.
    func request<T: Decodable>(
        method: String,
        path: String,
        body: (any Encodable)? = nil
    ) async throws -> T {
        guard let baseURL else { throw APIError.noBaseURL }

        let fullURL = baseURL.appendingPathComponent(path)
        var urlRequest = URLRequest(url: fullURL)
        urlRequest.httpMethod = method.uppercased()

        // Attach Ed25519 auth token as Bearer header
        if cryptoService.isUnlocked {
            do {
                let token = try cryptoService.createAuthToken(method: method.uppercased(), path: path)
                let nonceField = token.nonce.map { ",\"nonce\":\"\($0)\"" } ?? ""
                let authJSON = """
                {"pubkey":"\(token.pubkey)","timestamp":\(token.timestamp),"token":"\(token.token)"\(nonceField)}
                """
                urlRequest.setValue("Bearer \(authJSON)", forHTTPHeaderField: "Authorization")
            } catch {
                throw APIError.authTokenCreationFailed(error)
            }
        }

        // Encode body
        if let body {
            urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
            urlRequest.httpBody = try encoder.encode(AnyEncodable(body))
        }

        urlRequest.setValue("application/json", forHTTPHeaderField: "Accept")

        // Execute request
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: urlRequest)
        } catch {
            // On network error for write operations, enqueue for offline replay
            if OfflineQueue.isQueueableMethod(method) {
                let bodyString: String?
                if let httpBody = urlRequest.httpBody {
                    bodyString = String(data: httpBody, encoding: .utf8)
                } else {
                    bodyString = nil
                }
                offlineQueue?.enqueue(path: path, method: method.uppercased(), body: bodyString)
            }
            throw APIError.networkError(error)
        }

        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIError.requestFailed(statusCode: 0, body: "Non-HTTP response")
        }

        guard (200...299).contains(httpResponse.statusCode) else {
            let bodyString = String(data: data, encoding: .utf8) ?? "<binary>"
            throw APIError.requestFailed(statusCode: httpResponse.statusCode, body: bodyString)
        }

        // Handle empty 204 responses
        if httpResponse.statusCode == 204 || data.isEmpty {
            if let empty = EmptyResponse() as? T {
                return empty
            }
        }

        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw APIError.decodingError(error)
        }
    }

    /// Perform an authenticated API request with a pre-encoded JSON body.
    ///
    /// Use this when the body must bypass the `convertToSnakeCase` encoder — for example,
    /// when the backend expects camelCase keys (`reportTypeId`, `encryptedContent`).
    ///
    /// - Parameters:
    ///   - method: HTTP method.
    ///   - path: API path relative to the base URL.
    ///   - rawBody: Pre-encoded JSON `Data`.
    /// - Returns: Decoded response of type T.
    func request<T: Decodable>(
        method: String,
        path: String,
        rawBody: Data
    ) async throws -> T {
        guard let baseURL else { throw APIError.noBaseURL }

        let fullURL = baseURL.appendingPathComponent(path)
        var urlRequest = URLRequest(url: fullURL)
        urlRequest.httpMethod = method.uppercased()

        // Attach Ed25519 auth token as Bearer header
        if cryptoService.isUnlocked {
            do {
                let token = try cryptoService.createAuthToken(method: method.uppercased(), path: path)
                let nonceField = token.nonce.map { ",\"nonce\":\"\($0)\"" } ?? ""
                let authJSON = """
                {"pubkey":"\(token.pubkey)","timestamp":\(token.timestamp),"token":"\(token.token)"\(nonceField)}
                """
                urlRequest.setValue("Bearer \(authJSON)", forHTTPHeaderField: "Authorization")
            } catch {
                throw APIError.authTokenCreationFailed(error)
            }
        }

        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.setValue("application/json", forHTTPHeaderField: "Accept")
        urlRequest.httpBody = rawBody

        // Execute request
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: urlRequest)
        } catch {
            // On network error for write operations, enqueue for offline replay
            if OfflineQueue.isQueueableMethod(method) {
                let bodyString = String(data: rawBody, encoding: .utf8)
                offlineQueue?.enqueue(path: path, method: method.uppercased(), body: bodyString)
            }
            throw APIError.networkError(error)
        }

        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIError.requestFailed(statusCode: 0, body: "Non-HTTP response")
        }

        guard (200...299).contains(httpResponse.statusCode) else {
            let bodyString = String(data: data, encoding: .utf8) ?? "<binary>"
            throw APIError.requestFailed(statusCode: httpResponse.statusCode, body: bodyString)
        }

        if httpResponse.statusCode == 204 || data.isEmpty {
            if let empty = EmptyResponse() as? T {
                return empty
            }
        }

        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw APIError.decodingError(error)
        }
    }

    /// Fire-and-forget request with no response body expected.
    func request(
        method: String,
        path: String,
        body: (any Encodable)? = nil
    ) async throws {
        let _: EmptyResponse = try await request(method: method, path: path, body: body)
    }

    // MARK: - CMS Report Types

    /// Fetch CMS report type definitions from the settings endpoint.
    ///
    /// Calls `GET /api/settings/cms/report-types` which returns the full
    /// `ClientReportTypeDefinition` schema including CMS-specific fields like
    /// `hubId`, `isSystem`, `numberingEnabled`, `closedStatuses`, etc.
    ///
    /// Uses a plain `JSONDecoder` (no snake_case conversion) because the
    /// backend returns camelCase keys natively for this endpoint.
    func fetchCmsReportTypes() async throws -> [ClientReportTypeDefinition] {
        let response: ClientReportTypesResponse = try await request(
            method: "GET",
            path: hp("/api/settings/cms/report-types")
        )
        return response.reportTypes
    }

    // MARK: - Hub Key

    /// Fetch the HPKE-wrapped hub key envelope for the given hub.
    /// Path is NOT wrapped with hp() — it uses the explicit hubId parameter.
    func getHubKey(_ hubId: String) async throws -> HubKeyEnvelopeResponse {
        return try await request(
            method: "GET",
            path: "/api/hubs/\(hubId)/key"
        )
    }

    // MARK: - Telephony / SIP

    /// Fetch short-lived SIP credentials for the given hub.
    /// Called when the volunteer clocks in so a SIP account can be registered with Linphone.
    func getSipToken(hubId: String) async throws -> SipTokenResponse {
        return try await request(method: "GET", path: "/api/hubs/\(hubId)/telephony/sip-token")
    }

    // MARK: - Version Check

    /// Compare this client's API version against the server's config.
    /// Returns `.unknown` on network failure — the app should not be blocked if offline.
    /// Uses a plain JSONDecoder because the server sends camelCase keys natively.
    func checkVersionCompatibility() async -> VersionStatus {
        do {
            let config = try await fetchAppConfig()

            if Self.apiVersion < config.minApiVersion {
                return .forceUpdate(minVersion: config.minApiVersion)
            }
            if Self.apiVersion < config.apiVersion {
                return .updateAvailable(latestVersion: config.apiVersion)
            }
            return .upToDate
        } catch {
            return .unknown
        }
    }

    /// Fetch the public `GET /api/config` document (unauthenticated).
    /// Uses a plain JSONDecoder because the endpoint returns camelCase keys
    /// (`apiVersion`, `minApiVersion`, `wsRelayUrl`), not snake_case.
    func fetchAppConfig() async throws -> AppConfig {
        guard let baseURL else { throw APIError.noBaseURL }

        let configURL = baseURL.appendingPathComponent("/api/config")
        var request = URLRequest(url: configURL, timeoutInterval: 10)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIError.requestFailed(statusCode: 0, body: "Non-HTTP response")
        }
        guard (200...299).contains(httpResponse.statusCode) else {
            throw APIError.requestFailed(statusCode: httpResponse.statusCode, body: String(data: data, encoding: .utf8) ?? "")
        }
        return try JSONDecoder().decode(AppConfig.self, from: data)
    }

    // MARK: - Raw Authenticated Request (for OfflineQueue replay)

    /// Execute an authenticated request without decoding the response body.
    ///
    /// Used by `OfflineQueue` to replay queued write operations. Applies the same
    /// Ed25519 auth token, cert-pinning URLSession, and Content-Type headers as the
    /// generic `request<T>` overloads, but returns the raw HTTP status code and body
    /// string instead of a decoded value.
    ///
    /// - Parameters:
    ///   - method: HTTP method (POST, PUT, PATCH, DELETE).
    ///   - path: API path relative to the base URL.
    ///   - body: Pre-serialized JSON body string, or nil.
    /// - Returns: `(statusCode, responseBody)` tuple.
    func rawRequest(method: String, path: String, body: String?) async throws -> (Int, String) {
        guard let baseURL else { throw APIError.noBaseURL }

        let fullURL = baseURL.appendingPathComponent(path)
        var urlRequest = URLRequest(url: fullURL)
        urlRequest.httpMethod = method.uppercased()
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.setValue("application/json", forHTTPHeaderField: "Accept")

        if cryptoService.isUnlocked {
            do {
                let token = try cryptoService.createAuthToken(method: method.uppercased(), path: path)
                let nonceField = token.nonce.map { ",\"nonce\":\"\($0)\"" } ?? ""
                let authJSON = """
                {"pubkey":"\(token.pubkey)","timestamp":\(token.timestamp),"token":"\(token.token)"\(nonceField)}
                """
                urlRequest.setValue("Bearer \(authJSON)", forHTTPHeaderField: "Authorization")
            } catch {
                throw APIError.authTokenCreationFailed(error)
            }
        }

        if let body {
            urlRequest.httpBody = body.data(using: .utf8)
        }

        let (data, response) = try await session.data(for: urlRequest)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIError.requestFailed(statusCode: 0, body: "Non-HTTP response")
        }

        let bodyString = String(data: data, encoding: .utf8) ?? ""
        return (httpResponse.statusCode, bodyString)
    }

    // MARK: - Recovery Group API

    func enrollRecoveryGroup(_ body: [String: Any]) async throws -> OkResponse {
        let jsonData = try JSONSerialization.data(withJSONObject: body)
        return try await request(method: "POST", path: hp("/api/recovery-group/enroll"), rawBody: jsonData)
    }

    func getRecoveryGroup(hubId: String) async throws -> AppRecoveryGroupInfo {
        try await request(method: "GET", path: hp("/api/recovery-group/\(hubId)"))
    }

    func initiateRecovery(hubId: String, userIdentifier: String, newDevicePubkey: String) async throws -> AppRecoveryInitiateResponse {
        let body: [String: String] = [
            "hubId": hubId,
            "userIdentifier": userIdentifier,
            "newDevicePubkey": newDevicePubkey,
        ]
        return try await request(method: "POST", path: "/api/recovery-group/initiate", body: body)
    }

    func verifyRecoveryCode(sessionId: String, verificationCode: String) async throws -> RecoveryVerifyResponse {
        let body: [String: String] = [
            "sessionId": sessionId,
            "verificationCode": verificationCode,
        ]
        return try await request(method: "POST", path: "/api/recovery-group/initiate/verify", body: body)
    }

    func listRecoverySessions() async throws -> [RecoverySessionStatus] {
        guard let hubId = hubContext.activeHubId else { throw APIError.noBaseURL }
        return try await request(method: "GET", path: hp("/api/recovery-group/sessions?hubId=\(hubId)"))
    }

    /// Fetch the current user's share envelope from the recovery group.
    /// Returns the HPKE-encrypted Shamir share and its commitment.
    func getMyShareEnvelope(hubId: String) async throws -> ShareEnvelopeResponse {
        try await request(method: "GET", path: hp("/api/recovery-group/shares/my"))
    }

    func getRecoverySession(sessionId: String) async throws -> RecoverySessionStatus {
        try await request(method: "GET", path: hp("/api/recovery-group/session/\(sessionId)"))
    }

    func contributeRecoveryShare(sessionId: String, encryptedShare: String, contributorSignature: String) async throws -> ContributeResponse {
        let body: [String: String] = [
            "encryptedShare": encryptedShare,
            "contributorSignature": contributorSignature,
        ]
        return try await request(method: "POST", path: hp("/api/recovery-group/session/\(sessionId)/contribute"), body: body)
    }

    func cancelRecoverySession(sessionId: String) async throws -> OkResponse {
        try await request(method: "POST", path: hp("/api/recovery-group/session/\(sessionId)/cancel"))
    }

    func storeUserRecoveryEnvelope(hubId: String, envelope: String) async throws -> OkResponse {
        let body: [String: String] = [
            "hubId": hubId,
            "envelope": envelope,
        ]
        return try await request(method: "POST", path: hp("/api/recovery-group/user-envelope"), body: body)
    }

    func submitShareLivenessProof(hubId: String, proof: String) async throws -> OkResponse {
        let body: [String: String] = [
            "hubId": hubId,
            "proof": proof,
        ]
        return try await request(method: "POST", path: hp("/api/recovery-group/shares/liveness"), body: body)
    }
}

// MARK: - Entity File Upload

/// Local API response type — distinct from the codegen EntityFileUploadResponse
/// because the decoder uses convertFromSnakeCase and expects String dates (not Date).
struct APIFileUploadResponse: Decodable {
    let fileId: String
    let uploadedAt: String
}

extension APIService {
    /// Upload encrypted file data as multipart/form-data to the entity-file endpoint.
    func uploadEntityFile(encryptedData: Data, fileName: String) async throws -> APIFileUploadResponse {
        guard let baseURL else { throw APIError.noBaseURL }

        let boundary = UUID().uuidString
        var body = Data()
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"file\"; filename=\"\(fileName)\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: application/octet-stream\r\n\r\n".data(using: .utf8)!)
        body.append(encryptedData)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)

        let path = hp("/api/uploads/entity-file")
        let fullURL = baseURL.appendingPathComponent(path)
        var urlRequest = URLRequest(url: fullURL)
        urlRequest.httpMethod = "POST"
        urlRequest.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        urlRequest.setValue("application/json", forHTTPHeaderField: "Accept")
        urlRequest.httpBody = body

        if cryptoService.isUnlocked {
            let token = try cryptoService.createAuthToken(method: "POST", path: path)
            let authJSON = """
            {"pubkey":"\(token.pubkey)","timestamp":\(token.timestamp),"token":"\(token.token)"}
            """
            urlRequest.setValue("Bearer \(authJSON)", forHTTPHeaderField: "Authorization")
        }

        let (data, response) = try await session.data(for: urlRequest)
        guard let httpResponse = response as? HTTPURLResponse,
              (200...299).contains(httpResponse.statusCode) else {
            let bodyString = String(data: data, encoding: .utf8) ?? "<binary>"
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            throw APIError.requestFailed(statusCode: code, body: bodyString)
        }
        return try decoder.decode(APIFileUploadResponse.self, from: data)
    }
}

// MARK: - Helper Types

/// Type-erased Encodable wrapper for passing heterogeneous body types.
private struct AnyEncodable: Encodable {
    private let encodeFunc: (Encoder) throws -> Void

    init(_ wrapped: any Encodable) {
        self.encodeFunc = { encoder in
            try wrapped.encode(to: encoder)
        }
    }

    func encode(to encoder: Encoder) throws {
        try encodeFunc(encoder)
    }
}

/// Placeholder for endpoints that return no body (204, empty response).
struct EmptyResponse: Decodable {
    init() {}
}

// MARK: - Certificate Pinning (H14)

/// Pin configuration for a single deployment. Each deployment (self-hosted org)
/// has its own TLS certificate chain. Pins target the intermediate CA — not the
/// leaf — so routine cert renewal does not break pinning.
struct PinConfig {
    /// Base64-encoded SHA-256 SPKI hashes for trusted intermediate CAs.
    let hashes: [String]
    /// ISO-8601 `notBefore` / `notAfter` — ignored for static pins, used for dynamic rotation.
    let notBefore: Date?
    let notAfter: Date?
}

/// Deployment-configurable certificate pins.
///
/// Static defaults pin against Let's Encrypt intermediate CAs (ISRG Root X1 + X2)
/// because the production deployment uses 1984 DNS + Let's Encrypt, NOT Cloudflare.
///
/// Pin hashes target the **intermediate CA SPKI** (Subject Public Key Info), not the
/// leaf certificate. This means normal cert renewal (which reuses the same CA) does
/// not trigger a pin mismatch.
///
/// Dynamic pin updates: on launch, clients fetch `GET /api/config/pins` which returns
/// an Ed25519-signed pin list. If the fetch fails, static defaults remain active.
enum CertificatePins {

    // MARK: - Let's Encrypt Intermediate CA SPKI SHA-256 Hashes

    /// ISRG Root X1 (RSA 4096, cross-signed by DST Root CA X3).
    /// Extracted via:
    ///   curl -s https://letsencrypt.org/certs/isrgrootx1.pem \
    ///     | openssl x509 -pubkey -noout | openssl pkey -pubin -outform der \
    ///     | openssl dgst -sha256 -binary | base64
    static let isrgRootX1Hash = "C5+lpZ7tcVwmwQIMcRtPbsQtWLABXhQzejna0wHFr8M="

    /// ISRG Root X2 (ECDSA P-384, backup root).
    /// Extracted via same procedure against isrg-root-x2.pem.
    static let isrgRootX2Hash = "diGVwiVYbubAI3RW4hB9xU8e/CH2GGvrTcuvhPy/MzA="

    /// Static default pins — used until dynamic pins are fetched and verified.
    /// Minimum 2 distinct CA pins for backup (RFC 7469 §2.5 recommendation).
    static let defaultHashes: [String] = [
        isrgRootX1Hash,
        isrgRootX2Hash,
    ]

    /// The currently active pin set. Starts with static defaults; replaced by
    /// verified dynamic pins after a successful fetch from the server.
    private(set) static var active = PinConfig(
        hashes: defaultHashes,
        notBefore: nil,
        notAfter: nil
    )

    /// Whether certificate pinning is active (at least one pin configured).
    static var isEnabled: Bool {
        return !active.hashes.isEmpty
    }

    /// Replace the active pin set with dynamically-fetched, server-signed pins.
    /// Called by `PinUpdateService` after signature verification succeeds.
    static func updatePins(_ config: PinConfig) {
        active = config
    }

    /// Reset to static defaults (e.g. if dynamic pin list expires).
    static func resetToDefaults() {
        active = PinConfig(hashes: defaultHashes, notBefore: nil, notAfter: nil)
    }
}

/// URLSessionDelegate that enforces certificate pinning against trusted intermediate
/// CA SPKI hashes. Pin mismatch is a **hard failure** — the connection is refused
/// unconditionally with no fallback to unpinned TLS.
final class CertificatePinningDelegate: NSObject, URLSessionDelegate {
    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        // Only handle server trust challenges
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let serverTrust = challenge.protectionSpace.serverTrust else {
            completionHandler(.performDefaultHandling, nil)
            return
        }

        // Allow localhost / 127.0.0.1 without pinning (local development)
        let host = challenge.protectionSpace.host
        if host == "localhost" || host == "127.0.0.1" {
            completionHandler(.performDefaultHandling, nil)
            return
        }

        // If pinning is not configured, fall through to default TLS validation
        guard CertificatePins.isEnabled else {
            completionHandler(.performDefaultHandling, nil)
            return
        }

        // Validate the certificate chain
        guard let certificateChain = SecTrustCopyCertificateChain(serverTrust) as? [SecCertificate] else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }

        let activePins = CertificatePins.active.hashes
        var pinMatched = false
        var observedHashes: [String] = []
        for certificate in certificateChain {
            if let publicKey = SecCertificateCopyKey(certificate) {
                var error: Unmanaged<CFError>?
                if let publicKeyData = SecKeyCopyExternalRepresentation(publicKey, &error) as Data? {
                    let hash = sha256Base64(publicKeyData)
                    observedHashes.append(hash)
                    if activePins.contains(hash) {
                        pinMatched = true
                        break
                    }
                }
            }
        }

        if pinMatched {
            completionHandler(.useCredential, URLCredential(trust: serverTrust))
        } else {
            // Hard fail: pin mismatch — report security event and refuse connection.
            #if DEBUG
            print("[CertPinning] HARD FAIL: Pin mismatch for host: \(host). Connection refused.")
            #endif
            SecurityEventService.shared.report(
                .certPinMismatch(activePins: activePins, observedPins: observedHashes)
            )
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }

    /// Compute SHA-256 hash of data, return as base64 string.
    private func sha256Base64(_ data: Data) -> String {
        var hash = [UInt8](repeating: 0, count: 32)
        data.withUnsafeBytes { buffer in
            _ = CC_SHA256(buffer.baseAddress, CC_LONG(data.count), &hash)
        }
        return Data(hash).base64EncodedString()
    }
}

// MARK: - Dynamic Pin Update

/// Response from `GET /api/config/pins` — server-signed pin list for rotation
/// without requiring an app update.
struct PinListResponse: Decodable {
    let pins: [PinEntry]
    let signature: String
    let notBefore: String
    let notAfter: String

    struct PinEntry: Decodable {
        let algorithm: String
        let hash: String
        let label: String
    }
}

