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
/// `withMutation(keyPath:)`, so `.task(id: hubContext.browsing)` keeps re-firing.
@Observable
final class HubContext: @unchecked Sendable {

    // MARK: - State

    @ObservationIgnored private let lock = NSLock()
    @ObservationIgnored private var storedActiveHubId: String?
    @ObservationIgnored private var storedMembershipFailure: (any Error)?

    /// The UUID of the currently active hub. nil before first hub is selected.
    var activeHubId: String? {
        access(keyPath: \.activeHubId)
        return lock.withLock { storedActiveHubId }
    }

    /// Why the session's last hub-list fetch failed, or nil when it succeeded (or has not
    /// run). With no active hub this is the difference between "you belong to no hub" —
    /// nothing to browse — and "the hub could not be asked which hubs you belong to",
    /// which is a failure the volunteer must be told about (#2478).
    var membershipFailure: (any Error)? {
        access(keyPath: \.membershipFailure)
        return lock.withLock { storedMembershipFailure }
    }

    /// What a screen browsing the active hub keys its load on (`.task(id:)`).
    ///
    /// The active hub alone is not enough: a screen opened while the hub list is still
    /// loading settles on "no hub". If the load then FAILS the active hub stays nil, so a
    /// screen keyed on it never loads again and shows an empty list for an unreachable hub.
    struct Browsing: Hashable {
        let hubId: String?
        let membershipFailed: Bool
    }

    var browsing: Browsing {
        Browsing(hubId: activeHubId, membershipFailed: membershipFailure != nil)
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

    /// Record the outcome of a hub-list fetch: nil when it succeeded, else why it failed.
    func recordMembershipLoad(failure: (any Error)?) {
        withMutation(keyPath: \.membershipFailure) {
            lock.withLock { storedMembershipFailure = failure }
        }
    }

    private func store(_ hubId: String?) {
        withMutation(keyPath: \.activeHubId) {
            lock.withLock { storedActiveHubId = hubId }
        }
    }
}
