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
            path: apiService.hp("/api/contacts-v2"),
            body: body
        )
    }

    // MARK: - Update

    func updateContact(id: String, body: UpdateContactBody) async throws -> Contact {
        try await apiService.request(
            method: "PATCH",
            path: apiService.hp("/api/contacts-v2/\(id)"),
            body: body
        )
    }

    // MARK: - Get

    func getContact(id: String) async throws -> Contact {
        try await apiService.request(
            method: "GET",
            path: apiService.hp("/api/contacts-v2/\(id)")
        )
    }

    // MARK: - List

    func listContacts(page: Int = 1, limit: Int = 50, contactTypeHash: String? = nil) async throws -> ContactListResponse {
        var path = apiService.hp("/api/contacts-v2") + "?page=\(page)&limit=\(limit)"
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
            path: apiService.hp("/api/contacts-v2/search") + "?tokens=\(encoded)"
        )
    }

    // MARK: - Delete

    func deleteContact(id: String) async throws {
        let _: OkResponse = try await apiService.request(
            method: "DELETE",
            path: apiService.hp("/api/contacts-v2/\(id)")
        )
    }
}

// MARK: - Response Types

// SKIPPED path finding (#1329): this service calls `/api/contacts-v2`, but the
// worker mounts the directory router at `/api/directory` — every call 404s
// today. Retargeting the paths would enable a currently dead feature, so it
// is recorded as a finding rather than changed here. The list response type
// is the generated `ContactListResponse`.

struct ContactDirectorySearchResult: Decodable, Sendable {
    let contacts: [Contact]
}
