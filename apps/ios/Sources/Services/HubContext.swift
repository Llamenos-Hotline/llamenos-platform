import Foundation

// MARK: - HubContext

/// Lightweight observable container for the currently active hub ID.
///
/// Created once in LlamenosApp as @State and passed into AppState.init() and
/// APIService.init() via constructor injection. Views receive it via
/// @Environment(HubContext.self). No circular dependency — HubContext depends on nothing.
///
/// Persistence: UserDefaults key "activeHubId" (UUID string). Migrates from legacy
/// "activeHubSlug" key on first read if present.
///
/// Thread-safe, deliberately NOT `@MainActor` (#1920 audit). Views read `activeHubId` on
/// main, but `APIService.hp(_:)` reads it synchronously from whatever executor the request
/// runs on — `ContactsAPIService` and `APIService`'s own async helpers run on the global
/// executor — and `hp` is a synchronous path builder, so main-actor isolation would force
/// every one of those call sites async. The value lives behind a lock instead, and the
/// property still participates in Observation through `access(keyPath:)` /
/// `withMutation(keyPath:)`, so `.task(id: hubContext.activeHubId)` keeps re-firing.
@Observable
final class HubContext: @unchecked Sendable {

    // MARK: - State

    @ObservationIgnored private let lock = NSLock()
    @ObservationIgnored private var storedActiveHubId: String?

    /// The UUID of the currently active hub. nil before first hub is selected.
    var activeHubId: String? {
        access(keyPath: \.activeHubId)
        return lock.withLock { storedActiveHubId }
    }

    // MARK: - Init

    init() {
        // Migrate from legacy slug-based storage if present and no UUID stored yet
        if UserDefaults.standard.string(forKey: "activeHubSlug") != nil,
           UserDefaults.standard.string(forKey: "activeHubId") == nil {
            // Can't migrate slug→UUID without an API call; clear legacy key and start fresh
            UserDefaults.standard.removeObject(forKey: "activeHubSlug")
        }
        self.storedActiveHubId = UserDefaults.standard.string(forKey: "activeHubId")
    }

    // MARK: - Mutations

    /// Set the active hub and persist to UserDefaults.
    func setActiveHub(_ hubId: String) {
        store(hubId)
        UserDefaults.standard.set(hubId, forKey: "activeHubId")
    }

    /// Clear the active hub (used on logout).
    func clearActiveHub() {
        store(nil)
        UserDefaults.standard.removeObject(forKey: "activeHubId")
    }

    private func store(_ hubId: String?) {
        withMutation(keyPath: \.activeHubId) {
            lock.withLock { storedActiveHubId = hubId }
        }
    }
}
