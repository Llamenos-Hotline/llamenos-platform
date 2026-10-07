import Foundation
import UIKit

// MARK: - EventsViewModel

/// View model for the Events screen. Loads events (CMS records with category='event'),
/// handles pagination, search, and detail selection.
@Observable
final class EventsViewModel {
    private let apiService: APIService
    private let cryptoService: CryptoService

    // MARK: - State

    var events: [EventListResponseEvent] = []
    var totalEvents: Int = 0
    var currentPage: Int = 1
    let pageSize: Int = 50

    var selectedEvent: EventListResponseEvent?
    var selectedEntityType: EntityType?

    /// Entity types with category='event' only.
    var eventEntityTypes: [EntityType] = []

    /// All entity types (for reference).
    var allEntityTypes: [EntityType] = []

    /// Whether CMS is enabled.
    var cmsEnabled: Bool?

    /// Decrypted event details keyed by event ID.
    var decryptedDetails: [String: DecryptedEventDetails] = [:]

    // Loading states
    var isLoading: Bool = false
    var isLoadingDetail: Bool = false
    var isSaving: Bool = false

    // Linked data for detail view
    var linkedCases: [CaseEventListResponseLink] = []
    var linkedReports: [ReportEventListResponseLink] = []
    var subEvents: [EventListResponseEvent] = []
    var isLoadingLinks: Bool = false

    var errorMessage: String?
    var searchQuery: String = ""

    // MARK: - Computed

    var hasMorePages: Bool {
        totalEvents > currentPage * pageSize
    }

    var totalPages: Int {
        max(1, Int(ceil(Double(totalEvents) / Double(pageSize))))
    }

    func entityType(for id: String) -> EntityType? {
        allEntityTypes.first { $0.id == id }
    }

    func statusDef(for event: EventListResponseEvent) -> SharedStatus? {
        entityType(for: event.entityTypeID)?.statuses.first { $0.value == event.statusHash }
    }

    func decryptedTitle(for eventId: String) -> String? {
        decryptedDetails[eventId]?.title
    }

    // MARK: - Init

    init(apiService: APIService, cryptoService: CryptoService) {
        self.apiService = apiService
        self.cryptoService = cryptoService
    }

    // MARK: - Initial Load

    /// Load CMS status, entity types, and initial events.
    func loadInitial() async {
        // Check CMS enabled
        do {
            let enabled: CaseManagementEnabledResponse = try await apiService.request(
                method: "GET", path: apiService.hp("/api/settings/cms/case-management")
            )
            cmsEnabled = enabled.enabled
        } catch {
            cmsEnabled = false
        }

        guard cmsEnabled == true else { return }

        // Load entity types
        do {
            let response: EntityTypeListResponse = try await apiService.request(
                method: "GET", path: apiService.hp("/api/settings/cms/entity-types")
            )
            allEntityTypes = response.entityTypes.filter { !$0.isArchived }
            eventEntityTypes = allEntityTypes.filter { $0.category == .event }
        } catch {
            errorMessage = error.localizedDescription
        }

        await loadEvents()
    }

    // MARK: - Load Events

    /// Fetch events with current pagination.
    func loadEvents() async {
        guard !eventEntityTypes.isEmpty else {
            isLoading = false
            return
        }

        isLoading = true
        defer { isLoading = false }

        do {
            let response: EventListResponse = try await apiService.request(
                method: "GET",
                path: apiService.hp("/api/events") + "?page=\(currentPage)&limit=\(pageSize)"
            )
            events = response.events
            totalEvents = Int(response.total)

            // Decrypt details for display
            await decryptEventDetails(response.events)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - Refresh

    func refresh() async {
        currentPage = 1
        await loadEvents()
    }

    // MARK: - Selection

    func selectEvent(_ event: EventListResponseEvent) async {
        selectedEvent = event
        selectedEntityType = entityType(for: event.entityTypeID)
        await loadLinkedData(for: event)
    }

    func clearSelection() {
        selectedEvent = nil
        selectedEntityType = nil
        linkedCases = []
        linkedReports = []
        subEvents = []
    }

    // MARK: - Linked Data

    private func loadLinkedData(for event: EventListResponseEvent) async {
        isLoadingLinks = true
        defer { isLoadingLinks = false }

        // Load linked records (cases)
        do {
            let response: CaseEventListResponse = try await apiService.request(
                method: "GET", path: apiService.hp("/api/events/\(event.id)/records")
            )
            linkedCases = response.links
        } catch {
            linkedCases = []
        }

        // Load linked reports
        do {
            let response: ReportEventListResponse = try await apiService.request(
                method: "GET", path: apiService.hp("/api/events/\(event.id)/reports")
            )
            linkedReports = response.links
        } catch {
            linkedReports = []
        }

        // Load sub-events
        do {
            let response: EventListResponse = try await apiService.request(
                method: "GET",
                path: apiService.hp("/api/events/\(event.id)/subevents")
            )
            subEvents = response.events
        } catch {
            subEvents = []
        }
    }

    // MARK: - Decryption

    /// Decrypt event details for display (title, description).
    private func decryptEventDetails(_ events: [EventListResponseEvent]) async {
        guard cryptoService.isUnlocked, let ourPubkey = cryptoService.pubkey else { return }

        for event in events {
            if decryptedDetails[event.id] != nil { continue }

            let encrypted = event.encryptedDetails
            let envelopes = event.detailEnvelopes
            guard !envelopes.isEmpty else { continue }

            guard let envelope = envelopes.first(where: { $0.pubkey == ourPubkey }) else { continue }

            do {
                let hpkeEnvelope = HpkeEnvelope(
                    v: 3,
                    labelId: 0,
                    enc: envelope.enc,
                    ct: envelope.ct
                )
                let plaintext = try cryptoService.decryptMessage(
                    encryptedContent: encrypted,
                    envelope: hpkeEnvelope
                )
                if let data = plaintext.data(using: .utf8),
                   let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    let details = DecryptedEventDetails(
                        title: json["title"] as? String ?? json["name"] as? String,
                        description: json["description"] as? String,
                        location: json["location"] as? String
                    )
                    decryptedDetails[event.id] = details
                }
            } catch {
                // Decryption failed — skip
            }
        }
    }

    // MARK: - Create Event

    /// Create a new event. Returns true on success.
    ///
    /// - Parameter adminPubkeys: X25519 admin decryption pubkeys that must also
    ///   be able to read the event details. The event route stores
    ///   `detailEnvelopes` verbatim (`CasesService.createEvent`) and never adds
    ///   readers of its own, so every reader has to be wrapped for here or
    ///   admin accountability access is lost — see
    ///   `docs/security/CRYPTO_ARCHITECTURE.md`.
    func createEvent(
        entityTypeId: String,
        title: String,
        description: String?,
        startDate: Date,
        endDate: Date?,
        location: String?,
        adminPubkeys: [String]
    ) async -> Bool {
        isSaving = true
        defer { isSaving = false }
        errorMessage = nil

        // Build plaintext details JSON
        var detailsDict: [String: Any] = ["title": title]
        if let desc = description, !desc.isEmpty {
            detailsDict["description"] = desc
        }
        if let loc = location, !loc.isEmpty {
            detailsDict["location"] = loc
        }

        guard let detailsData = try? JSONSerialization.data(withJSONObject: detailsDict),
              let detailsString = String(data: detailsData, encoding: .utf8) else {
            errorMessage = NSLocalizedString("events_encode_error", comment: "Failed to encode event details")
            return false
        }

        // Encrypt the details for the author and every admin reader.
        let encryptedContent: String
        let envelopes: [SharedAdminEnvelope]
        do {
            let result = try cryptoService.encryptMessage(
                plaintext: detailsString,
                readerPubkeys: adminPubkeys
            )
            encryptedContent = result.encryptedContent
            envelopes = result.envelopes.map { env in
                SharedAdminEnvelope(
                    ct: env.ct,
                    enc: env.enc,
                    pubkey: env.pubkey
                )
            }
        } catch {
            errorMessage = error.localizedDescription
            return false
        }

        let isoFormatter = ISO8601DateFormatter()
        isoFormatter.formatOptions = [.withInternetDateTime]

        // The server requires eventTypeHash/statusHash. The create UI has no
        // event-type concept, so the type hash is sent empty (finding #1329:
        // event-type picker semantics need a product decision); the status
        // hash comes from the entity type's default status.
        let body = CreateEventBody(
            blindIndexes: [:],
            detailEnvelopes: envelopes,
            encryptedDetails: encryptedContent,
            endDate: endDate.map { isoFormatter.string(from: $0) },
            entityTypeID: entityTypeId,
            eventTypeHash: "",
            locationApproximate: location,
            locationPrecision: location != nil ? .neighborhood : .none,
            parentEventID: nil,
            startDate: isoFormatter.string(from: startDate),
            statusHash: entityType(for: entityTypeId)?.defaultStatus ?? ""
        )

        do {
            // `wireBody:` and not `body:` — `createEventBodySchema` requires
            // camelCase keys (`entityTypeId`, `detailEnvelopes`, `encryptedDetails`),
            // which the default encoder's `.convertToSnakeCase` would rewrite into
            // keys the route validator rejects.
            let _: ProtocolEvent = try await apiService.request(
                method: "POST", path: apiService.hp("/api/events"), wireBody: body
            )
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            await loadEvents()
            return true
        } catch {
            errorMessage = error.localizedDescription
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            return false
        }
    }

    // MARK: - Pagination

    func nextPage() async {
        guard hasMorePages else { return }
        currentPage += 1
        await loadEvents()
    }

    func previousPage() async {
        guard currentPage > 1 else { return }
        currentPage -= 1
        await loadEvents()
    }
}

// MARK: - DecryptedEventDetails

struct DecryptedEventDetails {
    let title: String?
    let description: String?
    let location: String?
}
