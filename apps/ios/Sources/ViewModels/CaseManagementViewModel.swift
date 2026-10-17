import Foundation
import UIKit

// MARK: - CaseManagementViewModel

/// View model for CMS case management. Fetches entity types, records, interactions,
/// contacts, and evidence from the API. Handles status changes, comments, assignment,
/// summary decryption, and field decryption.
///
/// Main-actor isolated. SwiftUI reads every property here from the main thread, so every
/// write must happen there too. Without the isolation each `async` method ran on the
/// global executor (Swift 5.9 semantics for a nonisolated async function), and the view
/// raced its own model: Thread Sanitizer reports `loadRecords()` writing `isLoading` on a
/// GCD worker while `CaseListView.body` reads it, a hosted CI runner crashed reading
/// `decryptedSummaries` mid-write (`-[__NSTaggedDate objectForKey:]` in
/// `decryptedTitle(for:)`), and a write landing while the body was being evaluated was
/// never observed at all — which is how New Case stayed disabled for 15s after both of
/// its loads had answered in under a second. Network calls still suspend off the main
/// thread inside `APIService`; only the state changes are pinned here.
@MainActor
@Observable
final class CaseManagementViewModel {
    private let apiService: APIService
    private let cryptoService: CryptoService

    // MARK: - Public State

    /// Where the screen is in establishing what it can show. Starts `.loading`, and
    /// `loadInitial()` always settles it on one of the other three — a failed request
    /// is `.failed`, never mistaken for "case management is off".
    var loadState: CaseListLoadState = .loading

    /// Entity type definitions from the template.
    var entityTypes: [CaseEntityTypeDefinition] = []

    /// Why the last records fetch failed, while there are no records to show instead.
    /// Cleared by the next successful fetch.
    var recordsLoadError: String?

    /// Case records from the current query.
    var records: [CaseRecord] = []

    /// Total record count for pagination.
    var totalRecords: Int = 0

    /// Currently selected record for the detail panel.
    var selectedRecord: CaseRecord?

    /// Currently selected entity type for the detail panel.
    var selectedEntityType: CaseEntityTypeDefinition?

    /// Active detail tab.
    var activeTab: DetailTab = .details

    /// Interactions (timeline) for the selected record.
    /// Uses the generated `Interaction` type from protocol codegen (list endpoint response).
    var interactions: [Interaction] = []

    /// Contacts linked to the selected record.
    var contacts: [RecordContactLink] = []

    /// Evidence items for the selected record.
    /// Uses the generated `Evidence` type from protocol codegen.
    var evidence: [Evidence] = []

    // Filters
    var entityTypeFilter: String? = nil
    var statusFilter: String? = nil
    var currentPage: Int = 1
    let pageSize: Int = 50

    // EP06-A4: cross-hub and display type
    var crossHubEnabled: Bool = false
    var displayType: CaseDisplayType = .table

    // Loading states
    var isLoading: Bool = false
    var isLoadingDetail: Bool = false
    var isLoadingInteractions: Bool = false
    var isLoadingContacts: Bool = false
    var isLoadingEvidence: Bool = false
    var isActionInProgress: Bool = false

    /// Error message from last failed operation.
    var errorMessage: String?

    /// Whether the status sheet is shown.
    var showStatusSheet: Bool = false

    /// Whether the comment sheet is shown.
    var showCommentSheet: Bool = false

    /// Whether the create case sheet is shown.
    var showCreateSheet: Bool = false

    // MARK: - Summary & Field Decryption

    /// Decrypted summaries keyed by record ID. Contains title/description extracted from JSON.
    var decryptedSummaries: [String: DecryptedSummary] = [:]

    /// Decrypted field values for the currently selected record.
    var decryptedFieldValues: [String: String] = [:]

    /// Whether field decryption is in progress.
    var isDecryptingFields: Bool = false

    // MARK: - Timeline Sort

    /// Sort order for the timeline. Default is newest first.
    var timelineSortNewestFirst: Bool = true

    /// Sorted interactions based on the current sort order.
    var sortedInteractions: [Interaction] {
        if timelineSortNewestFirst {
            return interactions.sorted { $0.createdAt > $1.createdAt }
        } else {
            return interactions.sorted { $0.createdAt < $1.createdAt }
        }
    }

    // MARK: - Computed

    /// Whether New Case can be offered. Both halves are genuine requirements, not an
    /// artefact of load order: case management must be on for the hub (the server
    /// refuses records otherwise), and creating a case means choosing one of the hub's
    /// entity types — the sheet's type picker, the record's `entityTypeId` and its
    /// default status all come from them. Records are NOT required, so a failed records
    /// fetch leaves New Case available.
    var canCreateCase: Bool {
        loadState == .ready && !entityTypes.isEmpty
    }

    /// All unique statuses across entity types (for filter dropdown).
    var allStatuses: [CaseEnumOption] {
        var seen = Set<String>()
        var result: [CaseEnumOption] = []
        for et in entityTypes {
            for s in et.statuses where !seen.contains(s.value) {
                seen.insert(s.value)
                result.append(s)
            }
        }
        return result
    }

    /// Whether more pages exist.
    var hasMorePages: Bool {
        totalRecords > currentPage * pageSize
    }

    /// Total pages for pagination display.
    var totalPages: Int {
        max(1, Int(ceil(Double(totalRecords) / Double(pageSize))))
    }

    /// Entity type for a given ID.
    func entityType(for id: String) -> CaseEntityTypeDefinition? {
        entityTypes.first { $0.id == id }
    }

    /// Status definition for a record.
    func statusDef(for record: CaseRecord) -> CaseEnumOption? {
        entityType(for: record.entityTypeId)?.statuses.first { $0.value == record.statusHash }
    }

    /// Decrypted title for a record, if available.
    func decryptedTitle(for recordId: String) -> String? {
        decryptedSummaries[recordId]?.title
    }

    // MARK: - Init

    init(apiService: APIService, cryptoService: CryptoService) {
        self.apiService = apiService
        self.cryptoService = cryptoService
    }

    // MARK: - Data Loading

    /// Establish what the screen can show: whether case management is on for the hub,
    /// and its entity types. Settles `loadState` on `.ready`, `.disabled` or `.failed`,
    /// then loads the first page of records when ready.
    ///
    /// The two requests are independent — the entity-types route is not gated on case
    /// management being on — so they run concurrently, and readiness costs one round
    /// trip rather than two.
    func loadInitial() async {
        loadState = .loading
        entityTypes = []
        recordsLoadError = nil

        async let enabledRequest: CaseManagementEnabledResponse = apiService.request(
            method: "GET", path: apiService.hp("/api/settings/cms/case-management")
        )
        async let typesRequest: EntityTypesResponse = apiService.request(
            method: "GET", path: apiService.hp("/api/settings/cms/entity-types")
        )

        let enabled: Bool
        do {
            enabled = try await enabledRequest.enabled
        } catch {
            // A superseded load (the hub changed and `.task(id:)` restarted it) must not
            // overwrite the state its replacement is establishing.
            guard !Task.isCancelled else { return }
            loadState = .failed(error.localizedDescription)
            return
        }
        guard enabled else {
            // Entity types are irrelevant to a hub without case management; the
            // pending request is cancelled when this scope exits.
            loadState = .disabled
            return
        }

        do {
            let response = try await typesRequest
            entityTypes = response.entityTypes.filter { $0.isArchived != true }
        } catch {
            guard !Task.isCancelled else { return }
            loadState = .failed(error.localizedDescription)
            return
        }
        guard !Task.isCancelled else { return }

        loadState = .ready
        await loadRecords()
    }

    /// Fetch records with current filters.
    func loadRecords() async {
        isLoading = true
        defer { isLoading = false }

        var path = apiService.hp("/api/records") + "?page=\(currentPage)&limit=\(pageSize)"
        if let etFilter = entityTypeFilter {
            path += "&entityTypeId=\(etFilter)"
        }
        if let sFilter = statusFilter {
            path += "&statusHash=\(sFilter)"
        }
        if crossHubEnabled {
            path += "&crossHub=true"
        }

        do {
            let response: RecordsListResponse = try await apiService.request(
                method: "GET", path: path
            )
            records = response.records
            totalRecords = response.total
            recordsLoadError = nil

            // Decrypt summaries for all loaded records
            await decryptRecordSummaries(response.records)
        } catch {
            guard !Task.isCancelled else { return }
            errorMessage = error.localizedDescription
            recordsLoadError = error.localizedDescription
        }
    }

    /// Select a record and load its detail data.
    func selectRecord(_ record: CaseRecord) async {
        selectedRecord = record
        selectedEntityType = entityType(for: record.entityTypeId)
        activeTab = .details

        // Decrypt fields for the selected record
        await decryptRecordFields(record)

        // Preload timeline
        await loadInteractions(for: record.id)
    }

    /// Refresh all data. A screen that never became ready retries its readiness load
    /// rather than fetching records it has no entity types to show.
    func refresh() async {
        guard loadState == .ready else {
            await loadInitial()
            return
        }
        await loadRecords()
        if let selected = selectedRecord {
            await selectRecord(selected)
        }
    }

    // MARK: - Summary Decryption

    /// Decrypt the encrypted summary of each record to extract title/description.
    /// This runs on the list view to show titles in case cards.
    private func decryptRecordSummaries(_ records: [CaseRecord]) async {
        guard cryptoService.isUnlocked, let ourPubkey = cryptoService.pubkey else { return }

        for record in records {
            // Skip if already decrypted
            if decryptedSummaries[record.id] != nil { continue }

            guard let encryptedSummary = record.encryptedSummary,
                  let envelopes = record.summaryEnvelopes,
                  !envelopes.isEmpty else { continue }

            // Find our envelope
            guard let envelope = envelopes.first(where: { $0.pubkey == ourPubkey }) else { continue }

            do {
                let plaintext = try cryptoService.decryptRecordData(
                    ciphertextHex: encryptedSummary,
                    enc: envelope.enc,
                    ct: envelope.ct,
                    label: CryptoLabels.LABEL_CASE_SUMMARY
                )
                if let data = plaintext.data(using: .utf8),
                   let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    let summary = DecryptedSummary(
                        title: json["title"] as? String,
                        description: json["description"] as? String
                    )
                    decryptedSummaries[record.id] = summary
                }
            } catch {
                // Decryption failed — skip this record
            }
        }
    }

    // MARK: - Field Decryption

    /// Decrypt encrypted fields for the selected record to display in the detail view.
    private func decryptRecordFields(_ record: CaseRecord) async {
        isDecryptingFields = true
        defer { isDecryptingFields = false }
        decryptedFieldValues = [:]

        guard cryptoService.isUnlocked, let ourPubkey = cryptoService.pubkey else { return }

        guard let encryptedFields = record.encryptedFields,
              let envelopes = record.fieldEnvelopes,
              !envelopes.isEmpty else { return }

        guard let envelope = envelopes.first(where: { $0.pubkey == ourPubkey }) else { return }

        do {
            let plaintext = try cryptoService.decryptRecordData(
                ciphertextHex: encryptedFields,
                enc: envelope.enc,
                ct: envelope.ct,
                label: CryptoLabels.LABEL_CASE_FIELDS
            )
            if let data = plaintext.data(using: .utf8),
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                var values: [String: String] = [:]
                for (key, value) in json {
                    if let str = value as? String {
                        values[key] = str
                    } else if let num = value as? NSNumber {
                        values[key] = num.stringValue
                    } else if let bool = value as? Bool {
                        values[key] = bool ? "Yes" : "No"
                    } else if let arr = value as? [String] {
                        values[key] = arr.joined(separator: ", ")
                    } else {
                        values[key] = String(describing: value)
                    }
                }
                decryptedFieldValues = values
            }
        } catch {
            // Field decryption failed — fields will show as encrypted
        }
    }

    // MARK: - Detail Tab Data

    /// Load interactions (timeline) for a record.
    func loadInteractions(for recordId: String) async {
        isLoadingInteractions = true
        defer { isLoadingInteractions = false }

        do {
            let response: InteractionListResponse = try await apiService.request(
                method: "GET", path: apiService.hp("/api/records/\(recordId)/interactions") + "?limit=100"
            )
            interactions = response.interactions
        } catch {
            interactions = []
        }
    }

    /// Load contacts linked to a record.
    func loadContacts(for recordId: String) async {
        isLoadingContacts = true
        defer { isLoadingContacts = false }

        do {
            let response: RecordContactsResponse = try await apiService.request(
                method: "GET", path: apiService.hp("/api/records/\(recordId)/contacts")
            )
            contacts = response.contacts
        } catch {
            contacts = []
        }
    }

    /// Load evidence for a record.
    func loadEvidence(for recordId: String) async {
        isLoadingEvidence = true
        defer { isLoadingEvidence = false }

        do {
            let response: EvidenceListResponse = try await apiService.request(
                method: "GET", path: apiService.hp("/api/records/\(recordId)/evidence") + "?limit=100"
            )
            evidence = response.evidence
        } catch {
            evidence = []
        }
    }

    // MARK: - Actions

    /// Update record status.
    func updateStatus(recordId: String, newStatus: String) async {
        isActionInProgress = true
        defer { isActionInProgress = false }

        do {
            let _: CaseRecord = try await apiService.request(
                method: "PATCH", path: apiService.hp("/api/records/\(recordId)"),
                body: UpdateRecordRequest(statusHash: newStatus, severityHash: nil)
            )
            await loadRecords()
            if selectedRecord?.id == recordId {
                // Refresh selected record
                do {
                    let fresh: CaseRecord = try await apiService.request(
                        method: "GET", path: apiService.hp("/api/records/\(recordId)")
                    )
                    selectedRecord = fresh
                    // Reload timeline to reflect status change interaction
                    await loadInteractions(for: recordId)
                } catch { /* keep stale */ }
            }
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        } catch {
            errorMessage = error.localizedDescription
            UINotificationFeedbackGenerator().notificationOccurred(.error)
        }
    }

    /// Add a comment interaction to a record.
    func addComment(recordId: String, text: String) async {
        isActionInProgress = true
        defer { isActionInProgress = false }

        do {
            // Encrypt the comment content
            let encrypted = try cryptoService.encryptMessage(
                plaintext: text,
                readerPubkeys: [] // Server adds admin pubkeys
            )

            let envelopes = encrypted.envelopes.map { env in
                CaseEnvelope(
                    ct: env.ct,
                    enc: env.enc,
                    pubkey: env.pubkey
                )
            }

            let body = CreateInteractionRequest(
                interactionType: "comment",
                encryptedContent: encrypted.encryptedContent,
                contentEnvelopes: envelopes,
                interactionTypeHash: "comment_hash"
            )

            let _: CaseInteraction = try await apiService.request(
                method: "POST", path: apiService.hp("/api/records/\(recordId)/interactions"),
                body: body
            )

            // Reload timeline
            await loadInteractions(for: recordId)
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        } catch {
            errorMessage = error.localizedDescription
            UINotificationFeedbackGenerator().notificationOccurred(.error)
        }
    }

    /// Assign the current user to a record.
    func assignToMe(recordId: String) async {
        guard let pubkey = cryptoService.pubkey else { return }
        isActionInProgress = true
        defer { isActionInProgress = false }

        do {
            try await apiService.request(
                method: "POST", path: apiService.hp("/api/records/\(recordId)/assign"),
                body: AssignRecordRequest(pubkeys: [pubkey])
            )
            await loadRecords()
            // Refresh selected record if it's the one we assigned
            if selectedRecord?.id == recordId {
                do {
                    let fresh: CaseRecord = try await apiService.request(
                        method: "GET", path: apiService.hp("/api/records/\(recordId)")
                    )
                    selectedRecord = fresh
                } catch { /* keep stale */ }
            }
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Unassign the current user from a record.
    func unassignFromMe(recordId: String) async {
        guard let pubkey = cryptoService.pubkey else { return }
        isActionInProgress = true
        defer { isActionInProgress = false }

        do {
            try await apiService.request(
                method: "POST", path: apiService.hp("/api/records/\(recordId)/unassign"),
                body: UnassignRecordRequest(pubkey: pubkey)
            )
            await loadRecords()
            // Refresh selected record
            if selectedRecord?.id == recordId {
                do {
                    let fresh: CaseRecord = try await apiService.request(
                        method: "GET", path: apiService.hp("/api/records/\(recordId)")
                    )
                    selectedRecord = fresh
                } catch { /* keep stale */ }
            }
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Toggle timeline sort order.
    func toggleTimelineSort() {
        timelineSortNewestFirst.toggle()
    }

    // MARK: - Pagination

    func nextPage() async {
        guard hasMorePages else { return }
        currentPage += 1
        await loadRecords()
    }

    func previousPage() async {
        guard currentPage > 1 else { return }
        currentPage -= 1
        await loadRecords()
    }

    func setEntityTypeFilter(_ id: String?) async {
        entityTypeFilter = id
        currentPage = 1
        await loadRecords()
    }

    func setStatusFilter(_ hash: String?) async {
        statusFilter = hash
        currentPage = 1
        await loadRecords()
    }
}

// MARK: - CaseListLoadState

/// What the Cases screen has established about the active hub. Each case renders a
/// distinct, identifiable view in `CaseListView`, so a user — and a UI test — can tell a
/// screen that is still loading from one whose load failed and one where case
/// management is simply off.
enum CaseListLoadState: Equatable, Sendable {
    /// The case-management status or entity types have not answered yet.
    case loading
    /// The hub answered that case management is off.
    case disabled
    /// Case management is on and the hub's entity types are loaded.
    case ready
    /// A required request failed; carries the error to show.
    case failed(String)
}

// MARK: - CaseDisplayType

enum CaseDisplayType: String, CaseIterable, Sendable {
    case table = "table"
    case calendar = "calendar"
    case timeline = "timeline"
}

// MARK: - DetailTab

enum DetailTab: String, CaseIterable, Sendable {
    case details = "Details"
    case timeline = "Timeline"
    case contacts = "Contacts"
    case evidence = "Evidence"
}

// MARK: - DecryptedSummary

/// Decrypted case record summary containing title and description.
struct DecryptedSummary {
    let title: String?
    let description: String?
}

// MARK: - Request Bodies

struct UnassignRecordRequest: Codable, Sendable {
    let pubkey: String
}
