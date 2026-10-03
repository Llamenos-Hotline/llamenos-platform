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

    var events: [AppCaseEvent] = []
    var totalEvents: Int = 0
    var currentPage: Int = 1
    let pageSize: Int = 50

    var selectedEvent: AppCaseEvent?
    var selectedEntityType: CaseEntityTypeDefinition?

    /// Entity types with category='event' only.
    var eventEntityTypes: [CaseEntityTypeDefinition] = []

    /// All entity types (for reference).
    var allEntityTypes: [CaseEntityTypeDefinition] = []

    /// Whether CMS is enabled.
    var cmsEnabled: Bool?

    /// Decrypted event details keyed by event ID.
    var decryptedDetails: [String: DecryptedEventDetails] = [:]

    // Loading states
    var isLoading: Bool = false
    var isLoadingDetail: Bool = false
    var isSaving: Bool = false

    // Linked data for detail view
    var linkedCases: [AppCaseEventLink] = []
    var linkedReports: [ReportEventLink] = []
    var subEvents: [AppCaseEvent] = []
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

    func entityType(for id: String) -> CaseEntityTypeDefinition? {
        allEntityTypes.first { $0.id == id }
    }

    func statusDef(for event: AppCaseEvent) -> CaseEnumOption? {
        entityType(for: event.entityTypeId)?.statuses.first { $0.value == event.statusHash }
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
            let response: EntityTypesResponse = try await apiService.request(
                method: "GET", path: apiService.hp("/api/settings/cms/entity-types")
            )
            allEntityTypes = response.entityTypes.filter { $0.isArchived != true }
            eventEntityTypes = allEntityTypes.filter { $0.category == "event" }
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
            let response: EventsListResponse = try await apiService.request(
                method: "GET",
                path: apiService.hp("/api/events") + "?page=\(currentPage)&limit=\(pageSize)"
            )
            events = response.events
            totalEvents = response.total

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

    func selectEvent(_ event: AppCaseEvent) async {
        selectedEvent = event
        selectedEntityType = entityType(for: event.entityTypeId)
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

    private func loadLinkedData(for event: AppCaseEvent) async {
        isLoadingLinks = true
        defer { isLoadingLinks = false }

        // Load linked records (cases)
        do {
            let response: AppCaseEventLinksResponse = try await apiService.request(
                method: "GET", path: apiService.hp("/api/events/\(event.id)/records")
            )
            linkedCases = response.links
        } catch {
            linkedCases = []
        }

        // Load linked reports
        do {
            let response: ReportEventLinksResponse = try await apiService.request(
                method: "GET", path: apiService.hp("/api/events/\(event.id)/reports")
            )
            linkedReports = response.links
        } catch {
            linkedReports = []
        }

        // Load sub-events
        do {
            let response: SubEventsResponse = try await apiService.request(
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
    private func decryptEventDetails(_ events: [AppCaseEvent]) async {
        guard cryptoService.isUnlocked, let ourPubkey = cryptoService.pubkey else { return }

        for event in events {
            if decryptedDetails[event.id] != nil { continue }

            guard let encrypted = event.encryptedDetails,
                  let envelopes = event.detailEnvelopes,
                  !envelopes.isEmpty else { continue }

            guard let envelope = envelopes.first(where: { $0.pubkey == ourPubkey }) else { continue }

            do {
                let plaintext = try cryptoService.decryptMessage(
                    encryptedContent: encrypted,
                    enc: envelope.enc,
                    ct: envelope.ct
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
    func createEvent(
        entityTypeId: String,
        title: String,
        description: String?,
        startDate: Date,
        endDate: Date?,
        location: String?
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

        // Encrypt the details
        let encryptedContent: String
        let envelopes: [CaseEnvelope]
        do {
            let result = try cryptoService.encryptMessage(
                plaintext: detailsString,
                readerPubkeys: [] // Server adds admin pubkeys
            )
            encryptedContent = result.encryptedContent
            envelopes = result.envelopes.map { env in
                CaseEnvelope(
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

        let body = CreateEventRequest(
            entityTypeId: entityTypeId,
            startDate: isoFormatter.string(from: startDate),
            endDate: endDate.map { isoFormatter.string(from: $0) },
            parentEventId: nil,
            locationPrecision: location != nil ? "neighborhood" : "none",
            locationApproximate: location,
            encryptedDetails: encryptedContent,
            detailEnvelopes: envelopes,
            blindIndexes: [:]
        )

        do {
            let _: AppCaseEvent = try await apiService.request(
                method: "POST", path: apiService.hp("/api/events"), body: body
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
