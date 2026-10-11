import Foundation

// MARK: - Client Wire Models

// Client-only: the generated `PermissionsCatalogResponse` describes
// `permissions` as an array of {id, label, domain} and `byDomain` entries as
// {id, label}, but the route (`GET /api/settings/permissions`) actually answers
// `Record<String, String>` and {key, label} — the schema in
// packages/protocol/schemas/settings.ts does not match the handler, and the
// desktop client decodes the handler's shape. These models match the handler.
struct PermissionsCatalogWire: Codable, Sendable {
    let permissions: [String: String]
    let byDomain: [String: [PermissionCatalogEntryWire]]
}

struct PermissionCatalogEntryWire: Codable, Sendable {
    let key: String
    let label: String
}

// Client-only: `GET /api/settings/users/:id/effective-permissions` declares its
// response inline in the route (no named schema), so nothing is generated.
struct EffectivePermissionsWire: Codable, Sendable {
    let userId: String
    let permissions: [String]
}

// MARK: - RolesAPIServiceProtocol

protocol RolesAPIServiceProtocol {
    func listRoles() async throws -> RoleListResponse
    func getPermissionsCatalog() async throws -> PermissionsCatalogWire
    func getEffectivePermissions(userId: String, hubId: String?) async throws -> EffectivePermissionsWire
}

// MARK: - RolesAPIService

@Observable
final class RolesAPIService: RolesAPIServiceProtocol, @unchecked Sendable {
    private let apiService: APIService

    init(apiService: APIService) {
        self.apiService = apiService
    }

    func listRoles() async throws -> RoleListResponse {
        try await apiService.request(method: "GET", path: "/api/settings/roles")
    }

    func getPermissionsCatalog() async throws -> PermissionsCatalogWire {
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

/// A role with its E2EE name/description resolved for display.
/// System roles carry plaintext names; custom roles keep them in per-admin
/// HPKE envelopes (LABEL_PLATFORM_ROLE_NAME_ENCRYPT / _DESC_ENCRYPT, AAD
/// "{roleId}:name" / "{roleId}:description" — the desktop construction in
/// platform-roles-section.tsx). Falls back to the slug when no envelope for
/// this device exists or the envelope does not open.
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

@Observable
final class RolesViewModel {
    private let rolesAPI: RolesAPIServiceProtocol
    private let cryptoService: CryptoService

    var roles: [DecryptedRole] = []
    var catalogLabels: [String: String] = [:]
    var isLoading = false
    var errorMessage: String?

    init(rolesAPI: RolesAPIServiceProtocol, cryptoService: CryptoService) {
        self.rolesAPI = rolesAPI
        self.cryptoService = cryptoService
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
            let response = try await rolesAPI.listRoles()
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

    private func decryptRole(_ role: RoleListResponseRole) -> DecryptedRole {
        if role.isSystem, let name = role.name {
            return DecryptedRole(
                id: role.id, slug: role.slug, name: name,
                roleDescription: role.description,
                permissions: role.permissions,
                isSystem: role.isSystem, isDefault: role.isDefault,
                assignedUserCount: role.assignedUserCount.map(Int.init)
            )
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

    private func fallback(_ role: RoleListResponseRole) -> DecryptedRole {
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
