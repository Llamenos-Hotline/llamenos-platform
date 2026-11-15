import Foundation

// MARK: - Client Wire Models

// Client-only: `GET /api/settings/users/:id/effective-permissions` declares its
// response inline in the route (no named schema), so nothing is generated.
struct EffectivePermissionsWire: Codable, Sendable {
    let userId: String
    let permissions: [String]
}

// MARK: - RolesAPIServiceProtocol

protocol RolesAPIServiceProtocol {
    /// `hubId` set: the roles that hub offers (deployment-wide + its own).
    /// `nil`: the deployment-wide roles alone.
    func listRoles(hubId: String?) async throws -> RoleListResponse
    func getPermissionsCatalog() async throws -> PermissionsCatalogResponse
    func getEffectivePermissions(userId: String, hubId: String?) async throws -> EffectivePermissionsWire
}

// MARK: - RolesAPIService

@Observable
final class RolesAPIService: RolesAPIServiceProtocol, @unchecked Sendable {
    private let apiService: APIService

    init(apiService: APIService) {
        self.apiService = apiService
    }

    /// A hub's own roles exist only under `/api/hubs/:hubId/settings/roles` (#2780) —
    /// `/api/settings/roles` lists the deployment-wide roles and nothing a hub owns.
    func listRoles(hubId: String?) async throws -> RoleListResponse {
        if let hubId {
            let encoded = hubId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? hubId
            return try await apiService.request(method: "GET", path: "/api/hubs/\(encoded)/settings/roles")
        }
        return try await apiService.request(method: "GET", path: "/api/settings/roles")
    }

    func getPermissionsCatalog() async throws -> PermissionsCatalogResponse {
        try await apiService.request(method: "GET", path: "/api/settings/permissions")
    }

    func getEffectivePermissions(userId: String, hubId: String?) async throws -> EffectivePermissionsWire {
        var path = "/api/settings/users/\(userId)/effective-permissions"
        if let hubId {
            let encoded = hubId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? hubId
            path += "?hubId=\(encoded)"
        }
        return try await apiService.request(method: "GET", path: path)
    }
}

// MARK: - DecryptedRole

/// A role with its E2EE name/description resolved for display. Mirrors the
/// desktop `role-vocabulary.ts`; there are three kinds of role (#2780):
/// - seeded defaults carry a plaintext `name` (public constants);
/// - hub-owned roles (`hubId` set) are sealed under that hub's key with
///   LABEL_HUB_ROLE_ENCRYPT — opened in Rust by hub id, the key never enters Swift;
/// - platform roles keep them in per-admin HPKE envelopes
///   (LABEL_PLATFORM_ROLE_NAME_ENCRYPT / _DESC_ENCRYPT, AAD "{roleId}:name" /
///   "{roleId}:description").
/// A role this device cannot open shows its slug, which for a custom role IS its
/// id — never an empty string that would read as "unnamed".
struct DecryptedRole: Identifiable, Sendable {
    let id: String
    let slug: String
    let name: String
    let roleDescription: String
    let permissions: [String]
    let isSystem: Bool
    let isDefault: Bool
    let assignedUserCount: Int?

    /// Permission keys grouped by domain prefix ("calls:answer" → "calls").
    /// Sorted by domain, then key. Global wildcard "*" groups under "system".
    var permissionsByDomain: [(domain: String, keys: [String])] {
        var groups: [String: [String]] = [:]
        for permission in permissions {
            let domain = permission == "*"
                ? "system"
                : (permission.split(separator: ":").first.map(String.init) ?? permission)
            groups[domain, default: []].append(permission)
        }
        return groups
            .map { (domain: $0.key, keys: $0.value.sorted()) }
            .sorted { $0.domain < $1.domain }
    }
}

// MARK: - RolesViewModel

/// `@MainActor` because this is `@Observable` state that SwiftUI reads on the main thread.
/// Unannotated, the `async` loaders wrote `isLoading`, `roles`… from the global executor while a
/// view body read them (Thread Sanitizer reports the race on `isLoading`), and an Observation
/// write that lands while a body is being evaluated is never delivered. Network calls still
/// suspend off the main thread inside the API service; only the state changes are pinned
/// here. Same defect class as #1918, #2049 and `ReportsViewModel`.
@MainActor
@Observable
final class RolesViewModel {
    private let rolesAPI: RolesAPIServiceProtocol
    private let cryptoService: CryptoService
    private let hubIdProvider: () -> String?

    var roles: [DecryptedRole] = []
    var catalogLabels: [String: String] = [:]
    var isLoading = false
    var errorMessage: String?

    init(
        rolesAPI: RolesAPIServiceProtocol,
        cryptoService: CryptoService,
        hubIdProvider: @escaping () -> String?
    ) {
        self.rolesAPI = rolesAPI
        self.cryptoService = cryptoService
        self.hubIdProvider = hubIdProvider
    }

    /// System roles first, then the default role, then alphabetical —
    /// the desktop role-list.tsx ordering.
    static func sortRoles(_ roles: [DecryptedRole]) -> [DecryptedRole] {
        roles.sorted { lhs, rhs in
            if lhs.isSystem != rhs.isSystem { return lhs.isSystem }
            if lhs.isDefault != rhs.isDefault { return lhs.isDefault }
            return lhs.name.localizedCompare(rhs.name) == .orderedAscending
        }
    }

    func loadRoles(includeCatalog: Bool) async {
        guard !isLoading else { return }
        isLoading = true
        errorMessage = nil
        do {
            let response = try await rolesAPI.listRoles(hubId: hubIdProvider())
            roles = Self.sortRoles(response.roles.map(decryptRole))
            if includeCatalog, let catalog = try? await rolesAPI.getPermissionsCatalog() {
                catalogLabels = catalog.permissions
            }
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    /// Human label for a permission key from the catalog, else the raw key.
    func label(for permissionKey: String) -> String {
        catalogLabels[permissionKey] ?? permissionKey
    }

    // MARK: - Envelope Decryption

    private func decryptRole(_ role: RoleResponse) -> DecryptedRole {
        if let name = role.name {
            return DecryptedRole(
                id: role.id, slug: role.slug, name: name,
                roleDescription: role.description,
                permissions: role.permissions,
                isSystem: role.isSystem, isDefault: role.isDefault,
                assignedUserCount: role.assignedUserCount.map(Int.init)
            )
        }

        if let hubId = role.hubID {
            return decryptHubRole(role, hubId: hubId)
        }

        guard let myPubkey = cryptoService.encryptionPubkeyHex,
              let envelope = role.envelopes?.first(where: { $0.adminPubkey == myPubkey }),
              let name = openRoleField(envelope.encryptedName, roleId: role.id, field: "name")
        else {
            return fallback(role)
        }

        let description = openRoleField(envelope.encryptedDescription, roleId: role.id, field: "description") ?? ""
        return DecryptedRole(
            id: role.id, slug: role.slug, name: name,
            roleDescription: description,
            permissions: role.permissions,
            isSystem: role.isSystem, isDefault: role.isDefault,
            assignedUserCount: role.assignedUserCount.map(Int.init)
        )
    }

    private func decryptHubRole(_ role: RoleResponse, hubId: String) -> DecryptedRole {
        guard let sealedName = role.encryptedName,
              let name = cryptoService.decryptHubField(
                  ciphertextHex: sealedName, hubId: hubId, label: CryptoLabels.LABEL_HUB_ROLE_ENCRYPT
              )
        else {
            return fallback(role)
        }
        let description = role.encryptedDescription.flatMap {
            cryptoService.decryptHubField(
                ciphertextHex: $0, hubId: hubId, label: CryptoLabels.LABEL_HUB_ROLE_ENCRYPT
            )
        } ?? ""
        return DecryptedRole(
            id: role.id, slug: role.slug, name: name,
            roleDescription: description,
            permissions: role.permissions,
            isSystem: role.isSystem, isDefault: role.isDefault,
            assignedUserCount: role.assignedUserCount.map(Int.init)
        )
    }

    private func fallback(_ role: RoleResponse) -> DecryptedRole {
        DecryptedRole(
            id: role.id, slug: role.slug, name: role.slug,
            roleDescription: "",
            permissions: role.permissions,
            isSystem: role.isSystem, isDefault: role.isDefault,
            assignedUserCount: role.assignedUserCount.map(Int.init)
        )
    }

    /// `encrypted` is the server string: JSON of the Rust-serialized
    /// HpkeEnvelope ({v, labelId, enc, ct} with base64url enc/ct) — passed to
    /// the UniFFI record unchanged.
    private func openRoleField(_ encrypted: String, roleId: String, field: String) -> String? {
        guard let jsonData = encrypted.data(using: .utf8),
              let wire = try? JSONDecoder().decode(RoleFieldEnvelopeWire.self, from: jsonData) else {
            return nil
        }
        let label = field == "name"
            ? CryptoLabels.LABEL_PLATFORM_ROLE_NAME_ENCRYPT
            : CryptoLabels.LABEL_PLATFORM_ROLE_DESC_ENCRYPT
        let aadHex = Data("\(roleId):\(field)".utf8).map { String(format: "%02x", $0) }.joined()
        guard let plaintextHex = try? cryptoService.hpkeOpen(
            envelope: HpkeEnvelope(v: wire.v, labelId: wire.labelId, enc: wire.enc, ct: wire.ct),
            expectedLabel: label,
            aadHex: aadHex
        ), let bytes = Data(hexString: plaintextHex) else {
            return nil
        }
        return String(data: bytes, encoding: .utf8)
    }
}

/// Wire shape of the JSON string inside `RoleEnvelope.encryptedName/Description`:
/// the serde form of `HpkeEnvelope` (base64url enc/ct), exactly what the desktop
/// seals and what the UniFFI record consumes.
private struct RoleFieldEnvelopeWire: Codable {
    let v: UInt8
    let labelId: UInt8
    let enc: String
    let ct: String
}

// MARK: - EffectivePermissionsViewModel

/// `@MainActor` because this is `@Observable` state that SwiftUI reads on the main thread.
/// Unannotated, the `async` loaders wrote `isLoading`, `permissions`… from the global executor while a
/// view body read them (Thread Sanitizer reports the race on `isLoading`), and an Observation
/// write that lands while a body is being evaluated is never delivered. Network calls still
/// suspend off the main thread inside the API service; only the state changes are pinned
/// here. Same defect class as #1918, #2049 and `ReportsViewModel`.
@MainActor
@Observable
final class EffectivePermissionsViewModel {
    private let rolesAPI: RolesAPIServiceProtocol
    let userId: String

    var permissions: [String] = []
    var isLoading = false
    var errorMessage: String?

    init(rolesAPI: RolesAPIServiceProtocol, userId: String) {
        self.rolesAPI = rolesAPI
        self.userId = userId
    }

    var permissionsByDomain: [(domain: String, keys: [String])] {
        var groups: [String: [String]] = [:]
        for permission in permissions {
            let domain = permission == "*"
                ? "system"
                : (permission.split(separator: ":").first.map(String.init) ?? permission)
            groups[domain, default: []].append(permission)
        }
        return groups
            .map { (domain: $0.key, keys: $0.value.sorted()) }
            .sorted { $0.domain < $1.domain }
    }

    func load(hubId: String?) async {
        guard !isLoading else { return }
        isLoading = true
        errorMessage = nil
        do {
            let response = try await rolesAPI.getEffectivePermissions(userId: userId, hubId: hubId)
            permissions = response.permissions.sorted()
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }
}
