import Foundation

// MARK: - ContactsViewModel

@Observable
final class ContactsViewModel {
    private let apiService: APIService

    var contacts: [SharedContactTimelineListResponseContact] = []
    var total: Int = 0
    var currentPage: Int = 1
    var searchQuery: String = ""
    var isLoading = false
    var errorMessage: String?

    /// Available contact types from the entity schema for filtering.
    var contactTypes: [String] = []

    /// Currently selected contact type filter (nil = all types).
    var selectedContactType: String?

    var hasMore: Bool { contacts.count < total }

    /// Filtered contacts based on selected contact type.
    var filteredContacts: [SharedContactTimelineListResponseContact] {
        contacts
    }

    init(apiService: APIService) {
        self.apiService = apiService
    }

    // MARK: - Load Contacts

    func loadContacts() async {
        guard !isLoading else { return }
        isLoading = true
        errorMessage = nil

        do {
            var path = apiService.hp("/api/contacts") + "?page=1&limit=50"
            if let contactType = selectedContactType {
                let encoded = contactType.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? contactType
                path += "&contactType=\(encoded)"
            }
            let response: ContactTimelineListResponse = try await apiService.request(
                method: "GET",
                path: path
            )
            contacts = response.contacts
            total = Int(response.total)
            currentPage = 1
        } catch {
            if contacts.isEmpty {
                errorMessage = error.localizedDescription
            }
        }

        isLoading = false
    }

    // MARK: - Load More (Pagination)

    func loadMore() async {
        guard hasMore, !isLoading else { return }
        isLoading = true

        let nextPage = currentPage + 1
        do {
            var path = apiService.hp("/api/contacts") + "?page=\(nextPage)&limit=50"
            if !searchQuery.isEmpty {
                let encoded = searchQuery.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? searchQuery
                path += "&search=\(encoded)"
            }
            if let contactType = selectedContactType {
                let encoded = contactType.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? contactType
                path += "&contactType=\(encoded)"
            }
            let response: ContactTimelineListResponse = try await apiService.request(
                method: "GET",
                path: path
            )
            contacts.append(contentsOf: response.contacts)
            total = Int(response.total)
            currentPage = nextPage
        } catch {
            // Silently fail for pagination
        }

        isLoading = false
    }

    // MARK: - Search (Trigram)

    func search() async {
        isLoading = true
        errorMessage = nil

        do {
            let query = searchQuery.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? searchQuery
            var path = apiService.hp("/api/contacts/search") + "?q=\(query)"
            if let contactType = selectedContactType {
                let encoded = contactType.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? contactType
                path += "&contactType=\(encoded)"
            }
            let response: ContactTimelineListResponse = try await apiService.request(
                method: "GET",
                path: path
            )
            contacts = response.contacts
            total = Int(response.total)
            currentPage = 1
        } catch {
            if contacts.isEmpty {
                errorMessage = error.localizedDescription
            }
        }

        isLoading = false
    }

    // MARK: - Filter by Contact Type

    func filterByContactType(_ contactType: String?) async {
        selectedContactType = contactType
        contacts = []
        total = 0
        currentPage = 1
        if searchQuery.isEmpty {
            await loadContacts()
        } else {
            await search()
        }
    }

    // MARK: - Refresh

    func refresh() async {
        searchQuery = ""
        selectedContactType = nil
        await loadContacts()
    }
}

// MARK: - ContactDetailViewModel

/// ViewModel for contact profile detail, including linked cases and relationships.
@Observable
final class ContactDetailViewModel {
    private let apiService: APIService
    let contactHash: String

    var contact: ContactDetail?
    var relationships: [AppContactRelationship] = []
    var isLoading = false
    var isLoadingRelationships = false
    var errorMessage: String?

    init(apiService: APIService, contactHash: String) {
        self.apiService = apiService
        self.contactHash = contactHash
    }

    // MARK: - Load Contact Detail

    func loadContact() async {
        guard !isLoading else { return }
        isLoading = true
        errorMessage = nil

        do {
            let response: ContactDetailResponse = try await apiService.request(
                method: "GET",
                path: apiService.hp("/api/contacts/\(contactHash)")
            )
            contact = response.contact
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoading = false
    }

    // MARK: - Load Relationships

    func loadRelationships() async {
        guard !isLoadingRelationships else { return }
        isLoadingRelationships = true

        do {
            let response: AppContactRelationshipsResponse = try await apiService.request(
                method: "GET",
                path: apiService.hp("/api/contacts/\(contactHash)/relationships")
            )
            relationships = response.relationships
        } catch {
            // Relationships are optional — silently fail
        }

        isLoadingRelationships = false
    }

    // MARK: - Load All

    func loadAll() async {
        async let contactResult: Void = loadContact()
        async let relationshipsResult: Void = loadRelationships()
        await contactResult
        await relationshipsResult
    }

    func refresh() async {
        await loadAll()
    }
}

// MARK: - ContactTimelineViewModel

@Observable
final class ContactTimelineViewModel {
    private let apiService: APIService
    let contactHash: String

    var events: [ContactTimelineEvent] = []
    var total: Int = 0
    var isLoading = false
    var errorMessage: String?

    init(apiService: APIService, contactHash: String) {
        self.apiService = apiService
        self.contactHash = contactHash
    }

    func loadTimeline() async {
        guard !isLoading else { return }
        isLoading = true
        errorMessage = nil

        do {
            let response: ContactTimelineResponse = try await apiService.request(
                method: "GET",
                path: apiService.hp("/api/contacts/\(contactHash)/timeline") + "?limit=100"
            )
            events = response.events
            total = Int(response.total)
        } catch {
            if events.isEmpty {
                errorMessage = error.localizedDescription
            }
        }

        isLoading = false
    }

    func refresh() async {
        await loadTimeline()
    }
}
