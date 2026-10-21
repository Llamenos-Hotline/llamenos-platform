import Foundation

// MARK: - ContactsViewModel

@Observable
final class ContactsViewModel {
    private let apiService: APIService

    var contacts: [ContactSummary] = []
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
    var filteredContacts: [ContactSummary] {
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
            let response: ContactsListResponse = try await apiService.request(
                method: "GET",
                path: path
            )
            contacts = response.contacts
            total = response.total
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
            if let contactType = selectedContactType {
                let encoded = contactType.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? contactType
                path += "&contactType=\(encoded)"
            }
            let response: ContactsListResponse = try await apiService.request(
                method: "GET",
                path: path
            )
            contacts.append(contentsOf: response.contacts)
            total = response.total
            currentPage = nextPage
        } catch {
            // Silently fail for pagination
        }

        isLoading = false
    }

    // MARK: - Search

    /// Search the contact list by identifier.
    ///
    /// The server mounts no contact search: `GET /api/contacts/search` is not a
    /// route, and its path falls into `GET /api/contacts/:hash`, which answers
    /// 200 for a contact whose hash is the word "search" (#2002). A contact is
    /// held only as a hash plus the last four digits of its number, and those
    /// are in every list row, so the search reads the whole list and matches
    /// on them here.
    func search() async {
        isLoading = true
        errorMessage = nil

        do {
            let all = try await fetchAllContacts()
            let matched = all.filter { $0.matches(searchQuery) }
            contacts = matched
            total = matched.count
            currentPage = 1
        } catch {
            if contacts.isEmpty {
                errorMessage = error.localizedDescription
            }
        }

        isLoading = false
    }

    /// Every contact the server lists, page by page, until it has them all.
    ///
    /// Each contact once: the server appends the contacts known only from
    /// conversations to every page of the list, so pages overlap.
    private func fetchAllContacts() async throws -> [ContactSummary] {
        let pageSize = 200
        var all: [ContactSummary] = []
        var seen = Set<String>()
        var page = 1
        while true {
            var path = apiService.hp("/api/contacts") + "?page=\(page)&limit=\(pageSize)"
            if let contactType = selectedContactType {
                let encoded = contactType.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? contactType
                path += "&contactType=\(encoded)"
            }
            let response: ContactsListResponse = try await apiService.request(
                method: "GET",
                path: path
            )
            let fresh = response.contacts.filter { seen.insert($0.contactHash).inserted }
            all.append(contentsOf: fresh)
            if fresh.isEmpty || all.count >= response.total { return all }
            page += 1
        }
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
    let summary: ContactSummary
    var contactHash: String { summary.contactHash }

    var contact: ContactDetail?
    var relationships: [AppContactRelationship] = []
    var isLoading = false
    var isLoadingRelationships = false
    var errorMessage: String?

    init(apiService: APIService, summary: ContactSummary) {
        self.apiService = apiService
        self.summary = summary
    }

    // MARK: - Load Contact Detail

    /// `GET /api/contacts/:hash` returns the contact's activity —
    /// `{notes, conversations}` — not a profile, so the profile is the list row
    /// plus that activity.
    func loadContact() async {
        guard !isLoading else { return }
        isLoading = true
        errorMessage = nil

        do {
            let activity: ContactTimelineDetailResponse = try await apiService.request(
                method: "GET",
                path: apiService.hp("/api/contacts/\(contactHash)")
            )
            contact = ContactDetail(summary: summary, activity: activity)
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
            total = response.total
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
