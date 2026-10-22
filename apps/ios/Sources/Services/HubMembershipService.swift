import Foundation
import os

// MARK: - HubMembershipService

/// Session-level loader for the user's hub memberships (#1720).
///
/// Until #1720 the ONLY call site that fetched `GET /api/hubs` was
/// `HubManagementViewModel.loadHubs`, reached from Settings → Hubs and nowhere
/// else — not sign-in, not PIN unlock, not session restore. A user who never
/// opened that screen had:
///
///   - no active hub: `ShiftsViewModel.clockIn` refused with "No hub selected"
///     and every hub-scoped read fell back to the unscoped path, which the
///     server resolves to hub "" (the #1241 failure shape); and
///   - no hub keys: nothing had ever called the (dead) `AppState.loadAllHubKeys`,
///     so all E2EE hub content stayed undecryptable.
///
/// The relay path did NOT share the defect — `WebSocketService` subscribes from
/// the server-authoritative membership in its `authenticated` reply — but the
/// multi-hub routing axiom's browsing/decryption side had no membership set to
/// work from until a settings screen was visited.
///
/// Active-hub reconciliation mirrors Android's `HubRepository.loadInitialHub`
/// (#1340): keep the persisted choice while it is still a membership; otherwise
/// select the first hub; clear a stale choice when the user belongs to none.
/// This is browsing context only, and every call site is a session-establishment
/// path (unlock, onboarding completion, test-harness registration) — background
/// push handling never goes through here.
///
/// `@MainActor` (#1920 audit): SwiftUI reads this `@Observable` state on the main thread,
/// so every write has to land there too. Unisolated, each `async` method ran on the global
/// executor under Swift 5.9 and wrote state from a GCD worker mid-render — the data race
/// Thread Sanitizer reported in #1918, #2049 and #1811. Network calls still suspend off the
/// main thread inside the API layer; only the state changes are pinned here.
@MainActor
@Observable
final class HubMembershipService {
    private let apiService: any HubAPIServiceProtocol
    private let cryptoService: any HubCryptoServiceProtocol
    private let hubContext: HubContext
    private let logger = Logger(subsystem: "org.llamenos.hotline", category: "HubMembership")

    // MARK: - State

    /// Hubs the server listed for this user on the last successful load.
    /// Empty before the first load and after `reset()`.
    private(set) var memberHubs: [SharedHub] = []

    /// Whether at least one load has succeeded since launch or the last reset.
    private(set) var hasLoaded: Bool = false

    // MARK: - Init

    init(
        apiService: any HubAPIServiceProtocol,
        cryptoService: any HubCryptoServiceProtocol,
        hubContext: HubContext
    ) {
        self.apiService = apiService
        self.cryptoService = cryptoService
        self.hubContext = hubContext
    }

    // MARK: - Loading

    /// Fetch the user's hubs from the authenticated API and make the session
    /// hub-aware: reconcile the active hub against current membership, then
    /// eager-load hub keys so encrypted content is decryptable without visiting
    /// Settings → Hubs first.
    ///
    /// Non-fatal on failure: a network error at unlock leaves the persisted
    /// active hub and the previous membership snapshot untouched, and the next
    /// unlock (or a visit to Settings → Hubs) retries.
    ///
    /// - Returns: true when the hub list was fetched and applied.
    @discardableResult
    func loadMembership() async -> Bool {
        let hubs: [SharedHub]
        do {
            let response: HubsListResponse = try await apiService.request(
                method: "GET", path: "/api/hubs", body: nil
            )
            hubs = response.hubs
        } catch {
            logger.warning("Hub membership load failed: \(error.localizedDescription, privacy: .public)")
            return false
        }

        // A logout cancels the calling task while the fetch is in flight; never
        // apply membership to a session that has since ended.
        guard !Task.isCancelled else { return false }

        memberHubs = hubs
        hasLoaded = true
        reconcileActiveHub(hubs: hubs)
        await eagerLoadHubKeys(for: hubs)
        return true
    }

    /// Forget the membership snapshot. Called on logout so a stale list never
    /// leaks into the next session.
    func reset() {
        memberHubs = []
        hasLoaded = false
    }

    // MARK: - Active Hub Reconciliation

    /// Keep the persisted active hub while it is still a membership; otherwise
    /// take the first hub; clear the choice when the user belongs to none.
    private func reconcileActiveHub(hubs: [SharedHub]) {
        if let current = hubContext.activeHubId, hubs.contains(where: { $0.id == current }) {
            return
        }
        if let first = hubs.first {
            hubContext.setActiveHub(first.id)
        } else {
            hubContext.clearActiveHub()
        }
    }

    // MARK: - Eager Hub Key Loading

    /// Pre-fetch and cache hub keys for all member hubs in parallel. A failure
    /// on one hub never fails the load or blocks the others — partial key
    /// loading is better than blocking the session, and operations that need a
    /// missing key fail with their own error at the point of use.
    private func eagerLoadHubKeys(for hubs: [SharedHub]) async {
        await withTaskGroup(of: Void.self) { group in
            for hub in hubs where !cryptoService.hasHubKey(hubId: hub.id) {
                group.addTask { [apiService, cryptoService, logger] in
                    do {
                        let envelope = try await apiService.getHubKey(hub.id)
                        try cryptoService.loadHubKey(hubId: hub.id, envelope: envelope)
                    } catch {
                        logger.debug("No key loaded for hub \(hub.id, privacy: .public): \(error.localizedDescription, privacy: .public)")
                    }
                }
            }
        }
    }
}
