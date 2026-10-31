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
