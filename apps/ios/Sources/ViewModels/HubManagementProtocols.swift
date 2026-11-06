import Foundation

// MARK: - HubAPIServiceProtocol

/// Narrow protocol exposing the hub-key fetch, hub-path helper, and generic request method
/// that hub-scoped ViewModels need. Allows test doubles without subclassing the final APIService class.
protocol HubAPIServiceProtocol {
    func getHubKey(_ hubId: String) async throws -> HubKeyEnvelopeResponse
    func hp(_ path: String) -> String
    /// The active hub's path for a hub-owned resource, with no unscoped fallback (#2395).
    func activeHubPath(_ path: String) throws -> String
    func request<T: Decodable>(method: String, path: String, body: (any Encodable)?) async throws -> T
}

extension HubAPIServiceProtocol {
    /// Convenience overload with no body (GET requests).
    func request<T: Decodable>(method: String, path: String) async throws -> T {
        try await request(method: method, path: path, body: nil as (any Encodable)?)
    }

    /// GET a hub-owned resource from the active hub (#2478).
    ///
    /// With no hub there is nothing to ask, and the answer is `.noHub` — a value the
    /// caller assigns through, not an error it can swallow while the last hub's rows
    /// stay on screen. No hub URL configured is the same answer: nothing was asked.
    /// `path` is the unscoped `/api/...` path, query string included.
    func getHubOwned<T: Decodable>(_ path: String, as _: T.Type = T.self) async throws -> HubOwnedRead<T> {
        let scoped: String
        do {
            scoped = try activeHubPath(path)
        } catch APIError.noActiveHub {
            return .noHub
        }
        return try await getHubOwned(scopedPath: scoped)
    }

    /// The GET itself, for a path `getHubOwned(_:as:)` has already scoped to the active hub.
    private func getHubOwned<T: Decodable>(scopedPath: String) async throws -> HubOwnedRead<T> {
        do {
            let response: T = try await request(method: "GET", path: scopedPath)
            return .loaded(response)
        } catch APIError.noBaseURL {
            return .noHub
        }
    }
}

// APIService conforms automatically — its getHubKey, hp, activeHubPath and request signatures match.
extension APIService: HubAPIServiceProtocol {}

// MARK: - HubCryptoServiceProtocol

/// Narrow protocol exposing only the hub-key cache operations that HubManagementViewModel needs.
/// Allows test doubles without subclassing the final CryptoService class.
/// Real implementations live in CryptoService.swift (hasHubKey, loadHubKey, clearHubKeys). Keys stored in Rust.
protocol HubCryptoServiceProtocol {
    func hasHubKey(hubId: String) -> Bool
    func loadHubKey(hubId: String, envelope: HubKeyEnvelopeResponse) throws
}

// CryptoService conforms to HubCryptoServiceProtocol via its real implementations
// in CryptoService.swift (hasHubKey, loadHubKey, clearHubKeys). Keys stored in Rust.
extension CryptoService: HubCryptoServiceProtocol {}
