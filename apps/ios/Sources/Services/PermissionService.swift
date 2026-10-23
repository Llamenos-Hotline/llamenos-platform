import Foundation

// MARK: - PermissionService

/// Permission-Based Access Control (PBAC) for iOS.
/// Resolves fine-grained permissions from the user's role assignments.
/// Mirrors the shared `packages/shared/permissions.ts` logic:
/// - Exact match: "calls:answer"
/// - Domain wildcard: "calls:*" matches "calls:answer"
/// - Global wildcard: "*" matches everything
///
/// `@MainActor` (#1920 audit): only `AppState` (main-actor) writes it, and views read
/// `isAdmin` / `hasPermission` while rendering. Isolation turns that convention into a
/// compile-time guarantee.
@MainActor
@Observable
final class PermissionService {
    /// The user's effective permissions, loaded from `GET /api/auth/me`.
    private(set) var permissions: [String] = []

    /// Update the permission set (called after auth/me response).
    func update(permissions: [String]) {
        self.permissions = permissions
    }

    /// Clear permissions on logout/lock.
    func clear() {
        permissions = []
    }

    /// Check if the current user has a specific permission.
    /// Supports exact match, domain wildcards ("calls:*"), and global wildcard ("*").
    func hasPermission(_ required: String) -> Bool {
        Self.permissionGranted(permissions, required: required)
    }

    /// Static helper matching `permissionGranted` from `packages/shared/permissions.ts`.
    static func permissionGranted(_ granted: [String], required: String) -> Bool {
        // Global wildcard
        if granted.contains("*") { return true }
        // Exact match
        if granted.contains(required) { return true }
        // Domain wildcard (e.g. "calls:*" matches "calls:answer")
        let domain = required.split(separator: ":").first.map(String.init) ?? required
        if granted.contains("\(domain):*") { return true }
        return false
    }

    /// Whether the user has admin-level access (settings:manage permission).
    /// This replaces the binary `isAdmin` check throughout the app.
    var isAdmin: Bool {
        hasPermission("settings:manage")
    }
}
