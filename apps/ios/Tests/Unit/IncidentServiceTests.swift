import Foundation
import Testing
@testable import Llamenos

// MARK: - IncidentServiceTests
//
// The incident banner's data (B-INCIDENTS-CLIENTS, operator rule V). The user is a member
// of hubs A and B and is browsing hub A. The mocked server answers
// `GET /api/hubs/:hubId/incidents?open=true` exactly as the real route does: already
// filtered to the caller's permissions in that hub.

@MainActor
struct IncidentServiceTests {

    private let hubs = [
        makeIncidentHub(id: "hub-A", name: "Northside line"),
        makeIncidentHub(id: "hub-B", name: "Riverside line"),
    ]

    private static func path(_ hubId: String) -> String { "/api/hubs/\(hubId)/incidents?open=true" }

    /// A mock whose incident GET answers from `byHub` for THIS user.
    private func makeAPI(_ byHub: @escaping () -> [String: [Incident]]) -> MockHubAPIService {
        let api = MockHubAPIService()
        api.requestStub = { _, path in
            for hubId in ["hub-A", "hub-B"] where path == Self.path(hubId) {
                return HubIncidentListResponse(incidents: byHub()[hubId] ?? [])
            }
            throw URLError(.unsupportedURL)
        }
        return api
    }

    @Test func anOpenIncidentTheServerListsIsShown() async {
        let api = makeAPI { ["hub-A": [makeIncident(id: "inc-A", hubId: "hub-A")]] }
        let service = IncidentService(apiService: api)

        await service.refreshAll(hubs: hubs)

        let rows = service.rows(activeHubId: "hub-A")
        #expect(rows.map(\.incident.id) == ["inc-A"])
        #expect(rows.first?.inOtherHub == false)
        #expect(Set(api.requestedPaths) == [Self.path("hub-A"), Self.path("hub-B")])
    }

    @Test func aMemberTheServerReturnsNothingToSeesNothing() async {
        // The incident exists, but this user lacks its permission: the filtered GET is empty.
        let api = makeAPI { [:] }
        let service = IncidentService(apiService: api)

        await service.refreshAll(hubs: hubs)

        #expect(service.rows(activeHubId: "hub-A").isEmpty)
    }

    @Test func aDoorbellReReadsExactlyThatHubOnceAndTakesNothingFromThePayload() async {
        var server: [String: [Incident]] = [:]
        let api = makeAPI { server }
        let service = IncidentService(apiService: api)
        await service.refreshAll(hubs: hubs)
        api.resetRequestedPaths()

        server["hub-B"] = [makeIncident(id: "inc-B", hubId: "hub-B", total: 7)]
        // The doorbell carries no detail: all it says is "something in hub-B changed".
        await service.handle(AttributedHubEvent(hubId: "hub-B", event: .hubIncident))

        #expect(api.requestedPaths == [Self.path("hub-B")])
        let row = service.rows(activeHubId: "hub-A").first
        #expect(row?.incident.id == "inc-B")
        #expect(row?.incident.totalCount == 7)
    }

    @Test func otherRelayEventsFetchNothing() async {
        let api = makeAPI { [:] }
        let service = IncidentService(apiService: api)

        await service.handle(AttributedHubEvent(hubId: "hub-B", event: .callRing))
        await service.handle(AttributedHubEvent(hubId: "hub-B", event: .unknown))

        #expect(api.requestedPaths.isEmpty)
    }

    @Test func anIncidentInANonActiveHubIsSurfacedWithItsHubName() async {
        let api = makeAPI { ["hub-B": [makeIncident(id: "inc-B", hubId: "hub-B", category: "provider-media")]] }
        let service = IncidentService(apiService: api)

        await service.refreshAll(hubs: hubs)
        await service.handle(AttributedHubEvent(hubId: "hub-B", event: .hubIncident))

        // Hub A is the one being browsed; the hub-B incident is still listed, and labelled.
        let row = service.rows(activeHubId: "hub-A").first
        #expect(row?.incident.hubID == "hub-B")
        #expect(row?.inOtherHub == true)
        #expect(row?.otherHubName == "Riverside line")
    }

    @Test func activeHubIncidentsComeFirst() async {
        let api = makeAPI {
            ["hub-A": [makeIncident(id: "inc-A", hubId: "hub-A", openedAt: "2026-10-30T10:00:00.000Z")],
             "hub-B": [makeIncident(id: "inc-B", hubId: "hub-B", openedAt: "2026-10-30T08:00:00.000Z")]]
        }
        let service = IncidentService(apiService: api)

        await service.refreshAll(hubs: hubs)

        #expect(service.rows(activeHubId: "hub-A").map(\.incident.id) == ["inc-A", "inc-B"])
    }

    @Test func aClosedIncidentDisappearsOnlyWhenTheServerStopsListingIt() async {
        var server: [String: [Incident]] = ["hub-A": [makeIncident(id: "inc-A", hubId: "hub-A")]]
        let service = IncidentService(apiService: makeAPI { server })
        await service.refreshAll(hubs: hubs)
        #expect(service.rows(activeHubId: "hub-A").count == 1)

        server["hub-A"] = []
        await service.handle(AttributedHubEvent(hubId: "hub-A", event: .hubIncident))

        #expect(service.rows(activeHubId: "hub-A").isEmpty)
    }

    @Test func aFailedReadKeepsWhatTheHubLastShowed() async {
        var failing = false
        let api = MockHubAPIService()
        api.requestStub = { _, path in
            if failing { throw URLError(.notConnectedToInternet) }
            if path == Self.path("hub-A") { return HubIncidentListResponse(incidents: [makeIncident(id: "inc-A", hubId: "hub-A")]) }
            return HubIncidentListResponse(incidents: [])
        }
        let service = IncidentService(apiService: api)
        await service.refreshAll(hubs: hubs)

        failing = true
        await service.refreshAll(hubs: hubs)

        #expect(service.rows(activeHubId: "hub-A").map(\.incident.id) == ["inc-A"])
    }

    @Test func aDoorbellFetchStillInFlightAtLogoutDoesNotRepopulateTheNextSession() async {
        let api = LogoutDuringFetchAPI()
        let service = IncidentService(apiService: api)
        api.onRequest = { service.reset() }

        await service.handle(AttributedHubEvent(hubId: "hub-A", event: .hubIncident))

        #expect(api.requestCount == 1)
        #expect(service.incidentsByHub.isEmpty)
    }

    @Test func anUnknownCategoryIsLabelledWithTheGenericTitle() {
        #expect(IncidentRowContent.categoryLabel("routing") == NSLocalizedString("incident_title", comment: ""))
        #expect(IncidentRowContent.categoryLabel("spam") == NSLocalizedString("incident_category_spam", comment: ""))
    }
}

// MARK: - Relay doorbell parsing

@MainActor
struct IncidentDoorbellParsingTests {

    @Test func aTypelessDoorbellIsRecognisedByKind() {
        let ws = WebSocketService(cryptoService: CryptoService())
        ws.decryptionHandler = { _, _ in #"{"incidentId":"inc-1","state":"opened"}"# }

        let result = ws.decryptPayload("enc", epoch: 1, hubId: "hub-B", kind: WebSocketService.kindHubIncident)

        #expect(result?.hubId == "hub-B")
        #expect(result?.event == .hubIncident)
    }

    @Test func aDoorbellCarryingMoreThanIncidentIdAndStateIsDropped() {
        let ws = WebSocketService(cryptoService: CryptoService())
        ws.decryptionHandler = { _, _ in #"{"incidentId":"inc-1","state":"opened","category":"spam"}"# }

        #expect(ws.decryptPayload("enc", epoch: 1, hubId: "hub-B", kind: WebSocketService.kindHubIncident) == nil)
    }

    @Test func incidentKindIsSubscribedOnEveryMemberHub() {
        #expect(AppState.relayEventKinds.contains(WebSocketService.kindHubIncident))
    }
}

// MARK: - Helpers

/// Ends the session (via `onRequest`, on the main actor) while the incident read is on
/// the wire, then answers with an incident the next session must never see.
private final class LogoutDuringFetchAPI: HubAPIServiceProtocol, @unchecked Sendable {
    var onRequest: (@MainActor () -> Void)?
    private(set) var requestCount = 0

    func getHubKey(_ hubId: String) async throws -> HubKeyEnvelopeResponse { throw URLError(.unsupportedURL) }
    func hp(_ path: String) -> String { path }

    func request<T: Decodable>(method: String, path: String, body: (any Encodable)?) async throws -> T {
        await MainActor.run {
            requestCount += 1
            onRequest?()
        }
        guard let response = HubIncidentListResponse(incidents: [makeIncident(id: "inc-A", hubId: "hub-A")]) as? T else {
            throw URLError(.cannotDecodeContentData)
        }
        return response
    }
}

private func makeIncidentHub(id: String, name: String) -> SharedHub {
    SharedHub(
        createdAt: "2026-01-01T00:00:00Z",
        createdBy: "pub001",
        description: nil,
        id: id,
        name: name,
        phoneNumber: nil,
        slug: id,
        status: .active,
        updatedAt: "2026-01-01T00:00:00Z"
    )
}

private func makeIncident(
    id: String,
    hubId: String,
    category: String = "spam",
    total: Int = 12,
    openedAt: String = "2026-10-30T09:00:00.000Z"
) -> Incident {
    Incident(
        category: category,
        closedAt: nil,
        counts: ["fail": total],
        hubID: hubId,
        id: id,
        lastSignalAt: "2026-10-30T09:05:00.000Z",
        oldestAgeSeconds: nil,
        openedAt: openedAt,
        peakPerMinute: 4,
        severity: .notify,
        totalCount: total
    )
}
