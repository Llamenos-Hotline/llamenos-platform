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
    /// Why the last refresh of `permissions` did not complete.
    enum RefreshFailure: Equatable {
        /// The server could not be asked. `permissions` is still what the server last
        /// said, so the user keeps exactly the access they had.
        case keptLastKnown
        /// The server could not be asked and has never answered this session, so there
        /// is nothing to keep: `permissions` is empty and gated UI stays hidden. This is
        /// failing closed, and it is stated rather than shown as if it were the truth.
        case noneKnown
    }

    /// The user's effective permissions, loaded from `GET /api/auth/me`.
    private(set) var permissions: [String] = []

    /// Set while the last refresh failed without an answer; cleared by the next answer.
    private(set) var refreshFailure: RefreshFailure?

    /// Whether the server has answered this session. Only an answer sets it.
    private var hasServerAnswer = false

    /// Replace the permission set with the server's answer. An empty set is a legitimate
    /// answer (a 403, or a role with nothing granted); a failed request is not one — it
    /// goes through `recordRefreshFailure()` and leaves `permissions` alone.
    func update(permissions: [String]) {
        self.permissions = permissions
        hasServerAnswer = true
        refreshFailure = nil
    }

    /// The server could not be asked. Keeps the last known permissions: a timeout or a
    /// 5xx says nothing about what this user may do, so it must not change it.
    func recordRefreshFailure() {
        refreshFailure = hasServerAnswer ? .keptLastKnown : .noneKnown
    }

    /// Clear permissions on logout.
    func clear() {
        permissions = []
        hasServerAnswer = false
        refreshFailure = nil
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
