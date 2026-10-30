import Foundation
import os

// MARK: - IncidentRow

/// One incident as the banner and the incident view show it.
struct IncidentRow: Identifiable, Sendable {
    let incident: Incident
    /// True when the incident is in a hub other than the active one.
    let inOtherHub: Bool
    /// That hub's name, when known; nil for the active hub or an unknown name.
    let otherHubName: String?

    var id: String { incident.id }
}

// MARK: - IncidentService

/// Every open hub incident the user is responsible for, across EVERY hub they are a
/// member of (B-INCIDENTS-CLIENTS, operator rule V).
///
/// - The source of truth is the permission-filtered `GET /hubs/:hubId/incidents?open=true`,
///   one per member hub. What the server returns is what is shown; a member it returns
///   nothing to sees nothing. Reach is never decided here.
/// - `KIND_HUB_INCIDENT` is a doorbell (`HubEventType.hubIncident`): it re-reads THAT
///   hub's list, once. The event's own `{incidentId, state}` is never stored or shown.
/// - Multi-hub axiom: nothing here reads or changes the active hub; `rows(activeHubId:)`
///   uses it only to label and order.
@MainActor
@Observable
final class IncidentService {
    private let apiService: any HubAPIServiceProtocol
    private let logger = Logger(subsystem: "org.llamenos.hotline", category: "Incidents")

    /// hubId → that hub's open incidents, exactly as the server listed them.
    private(set) var incidentsByHub: [String: [Incident]] = [:]
    /// hubId → hub name, for labelling an incident in a hub other than the active one.
    private(set) var hubNames: [String: String] = [:]
    /// The incident view is showing — set by a banner tap or an incident-push tap.
    var isIncidentViewPresented = false

    init(apiService: any HubAPIServiceProtocol) {
        self.apiService = apiService
    }

    /// Open incidents, active hub first, then oldest first.
    func rows(activeHubId: String?) -> [IncidentRow] {
        incidentsByHub.values
            .flatMap { $0 }
            .sorted { a, b in
                let aOther = a.hubID != activeHubId
                let bOther = b.hubID != activeHubId
                if aOther != bOther { return !aOther }
                return a.openedAt < b.openedAt
            }
            .map { incident in
                let other = incident.hubID != activeHubId
                return IncidentRow(
                    incident: incident,
                    inOtherHub: other,
                    otherHubName: other ? hubNames[incident.hubID] : nil
                )
            }
    }

    /// Re-read every member hub's open incidents. A hub whose read fails keeps what it
    /// last showed: an incident must not vanish because one request did.
    func refreshAll(hubs: [SharedHub]) async {
        hubNames = Dictionary(hubs.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
        var next: [String: [Incident]] = [:]
        for hub in hubs {
            if let list = await fetch(hub.id) {
                next[hub.id] = list
            } else if let previous = incidentsByHub[hub.id] {
                next[hub.id] = previous
            }
        }
        guard !Task.isCancelled else { return }
        incidentsByHub = next
    }

    /// Route a relay event. `KIND_HUB_INCIDENT` re-reads that one hub — nothing is taken
    /// from the event itself; every other event is ignored.
    func handle(_ attributed: AttributedHubEvent) async {
        guard attributed.event == .hubIncident else { return }
        await refresh(hubId: attributed.hubId)
    }

    /// Re-read one hub's open incidents — the response to that hub's doorbell.
    func refresh(hubId: String) async {
        guard let list = await fetch(hubId), !Task.isCancelled else { return }
        incidentsByHub[hubId] = list
    }

    /// Forget everything. Called on logout so the next session starts clean.
    func reset() {
        incidentsByHub = [:]
        hubNames = [:]
        isIncidentViewPresented = false
    }

    private func fetch(_ hubId: String) async -> [Incident]? {
        do {
            let response: HubIncidentListResponse = try await apiService.request(
                method: "GET",
                path: APIService.hubPath(hubId, "/api/incidents?open=true")
            )
            return response.incidents
        } catch {
            logger.warning("Incidents for \(hubId, privacy: .public) unavailable: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }
}
