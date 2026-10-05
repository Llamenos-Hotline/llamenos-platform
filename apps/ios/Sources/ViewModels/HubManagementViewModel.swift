import Foundation
import UIKit

// MARK: - HubManagementViewModel

/// View model for hub listing, creation, and switching.
@Observable
final class HubManagementViewModel {
    private let apiService: any HubAPIServiceProtocol
    private let cryptoService: any HubCryptoServiceProtocol
    private let hubContext: HubContext
    private let feedbackGenerator = UINotificationFeedbackGenerator()

    // MARK: - State

    var hubs: [SharedHub] = []
    var isLoading: Bool = false
    var isSaving: Bool = false
    var isSwitching: Bool = false
    var error: Error?
    /// Hub IDs whose key envelope could not be fetched or unwrapped.
    /// Not an error state: browsing these hubs works, only their encrypted
    /// content cannot be decrypted. The list surfaces that inline per row.
    var hubKeysUnavailable: Set<String> = []
    var errorMessage: String? { error?.localizedDescription }
    var successMessage: String?

    // MARK: - Init

    /// Primary init — uses protocol types so tests can inject mocks.
    init(
        apiService: any HubAPIServiceProtocol,
        cryptoService: any HubCryptoServiceProtocol,
        hubContext: HubContext
    ) {
        self.apiService = apiService
        self.cryptoService = cryptoService
        self.hubContext = hubContext
        feedbackGenerator.prepare()
    }

    // MARK: - Data Loading

    /// Fetch all hubs the user belongs to.
    /// Uses the global /api/hubs path (not hub-prefixed — this is a cross-hub listing).
    func loadHubs() async {
        isLoading = true
        defer { isLoading = false }
        error = nil

        do {
            let response: HubsListResponse = try await apiService.request(
                method: "GET", path: "/api/hubs", body: nil
            )
            hubs = response.hubs

            // Eager-load hub keys for all hubs in parallel. A hub whose key cannot
            // be fetched is still listed and still selectable — only its encrypted
            // content is unreadable, which the row says for itself.
            await eagerLoadHubKeys(for: hubs)

            // If no active hub is set and there are hubs, select the first one
            if hubContext.activeHubId == nil, let first = hubs.first {
                await switchHub(to: first)
            }
        } catch {
            self.error = error
        }
    }

    // MARK: - Eager Hub Key Loading

    /// Pre-fetch and cache hub keys for all hubs in the background.
    /// Runs fetches in parallel. A failure never fails the load — it is recorded
    /// in `hubKeysUnavailable` so the list can say which hubs cannot be decrypted,
    /// instead of disappearing into an empty `catch`.
    func eagerLoadHubKeys(for hubs: [SharedHub]) async {
        let results = await withTaskGroup(of: (String, Bool).self) { group -> [(String, Bool)] in
            for hub in hubs where !cryptoService.hasHubKey(hubId: hub.id) {
                group.addTask { [apiService, cryptoService] in
                    do {
                        let envelope = try await apiService.getHubKey(hub.id)
                        try cryptoService.loadHubKey(hubId: hub.id, envelope: envelope)
                        return (hub.id, true)
                    } catch {
                        #if DEBUG
                        print("[HubKeys] No key for hub \(hub.id): \(error.localizedDescription)")
                        #endif
                        return (hub.id, false)
                    }
                }
            }
            var collected: [(String, Bool)] = []
            for await result in group { collected.append(result) }
            return collected
        }

        for (hubId, loaded) in results {
            if loaded {
                hubKeysUnavailable.remove(hubId)
            } else {
                hubKeysUnavailable.insert(hubId)
            }
        }
    }

    // MARK: - Hub Switching

    /// Switch the active hub.
    ///
    /// The active hub is *browsing context*, and nothing more — CLAUDE.md's
    /// multi-hub routing axiom puts it plainly: "The active hub controls browsing
    /// context only." A hub key is a *decryption* credential, so gating the switch
    /// on having one conflates authorisation to browse with the ability to read
    /// encrypted content. Desktop has never conflated them
    /// (`src/client/lib/config.tsx`, `setActiveHub` switches with no hub key), and
    /// no client creates or distributes hub keys at all yet (#1042) — so the gate
    /// made every switch on iOS fail with a 404 and leave the user stuck in
    /// whichever hub became active first (#1262).
    ///
    /// The context therefore switches first and unconditionally. The key fetch
    /// follows and cannot undo it: a missing key is recorded in
    /// `hubKeysUnavailable` and shown inline on the row, not raised as a blocking
    /// alert. Operations that genuinely need the key to decrypt fail with their
    /// own error at the point of use.
    ///
    /// Reached only from the hub list — a row tap, or `loadHubs` picking a first
    /// hub when none is active yet. Background push handling must never switch
    /// the active hub (see `AppDelegate`, which puts `hubId` in the notification's
    /// userInfo for the *tap* handler instead).
    func switchHub(to hub: SharedHub) async {
        guard hubContext.activeHubId != hub.id else { return }
        isSwitching = true
        error = nil
        defer { isSwitching = false }

        hubContext.setActiveHub(hub.id)
        feedbackGenerator.notificationOccurred(.success)

        await eagerLoadHubKeys(for: [hub])
    }

    /// Whether this hub's encrypted content can be decrypted on this device.
    func hasKey(_ hub: SharedHub) -> Bool {
        !hubKeysUnavailable.contains(hub.id)
    }

    /// Check if a hub is the currently active one. Compares by UUID, not slug.
    func isActive(_ hub: SharedHub) -> Bool {
        hub.id == hubContext.activeHubId
    }

    // MARK: - Hub Creation

    /// Create a new hub.
    func createHub(name: String, slug: String?, description: String?, phoneNumber: String?) async -> Bool {
        isSaving = true
        defer { isSaving = false }
        error = nil

        let body = CreateHubRequest(
            name: name.trimmingCharacters(in: .whitespacesAndNewlines),
            slug: slug?.trimmingCharacters(in: .whitespacesAndNewlines),
            description: description?.trimmingCharacters(in: .whitespacesAndNewlines),
            phoneNumber: phoneNumber?.trimmingCharacters(in: .whitespacesAndNewlines)
        )

        do {
            let response: AppHubResponse = try await apiService.request(
                method: "POST", path: "/api/hubs", body: body as (any Encodable)?
            )
            hubs.append(response.hub)
            successMessage = NSLocalizedString("hubs_created_success", comment: "Hub created successfully")
            feedbackGenerator.notificationOccurred(.success)
            return true
        } catch {
            self.error = error
            feedbackGenerator.notificationOccurred(.error)
            return false
        }
    }
}
