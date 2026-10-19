import Foundation

/// API service for encrypted directory contacts (EP06).
/// All contact data is HPKE-encrypted client-side before transmission.
/// The server never sees plaintext PII.
@Observable
final class ContactsAPIService: @unchecked Sendable {
    private let apiService: APIService

    init(apiService: APIService) {
        self.apiService = apiService
    }

    // MARK: - Create

    func createContact(_ body: CreateContactBody) async throws -> Contact {
        try await apiService.request(
            method: "POST",
            path: apiService.hp("/api/directory"),
            body: body
        )
    }

    // MARK: - Update

    func updateContact(id: String, body: UpdateContactBody) async throws -> Contact {
        try await apiService.request(
            method: "PATCH",
            path: apiService.hp("/api/directory/\(id)"),
            body: body
        )
    }

    // MARK: - Get

    func getContact(id: String) async throws -> Contact {
        try await apiService.request(
            method: "GET",
            path: apiService.hp("/api/directory/\(id)")
        )
    }

    // MARK: - List

    func listContacts(page: Int = 1, limit: Int = 50, contactTypeHash: String? = nil) async throws -> ContactDirectoryListResponse {
        var path = apiService.hp("/api/directory") + "?page=\(page)&limit=\(limit)"
        if let contactTypeHash {
            let encoded = contactTypeHash.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? contactTypeHash
            path += "&contactTypeHash=\(encoded)"
        }
        return try await apiService.request(method: "GET", path: path)
    }

    // MARK: - Search

    func searchContacts(tokens: [String]) async throws -> ContactDirectorySearchResult {
        let joined = tokens.joined(separator: ",")
        let encoded = joined.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? joined
        return try await apiService.request(
            method: "GET",
            path: apiService.hp("/api/directory/search") + "?tokens=\(encoded)"
        )
    }

    // MARK: - Delete

    func deleteContact(id: String) async throws {
        let _: OkResponse = try await apiService.request(
            method: "DELETE",
            path: apiService.hp("/api/directory/\(id)")
        )
    }
}

// MARK: - Response Types

struct ContactDirectoryListResponse: Decodable, Sendable {
    let contacts: [Contact]
    let total: Int
    let page: Int
    let limit: Int
    let hasMore: Bool
}

struct ContactDirectorySearchResult: Decodable, Sendable {
    let contacts: [Contact]
}
