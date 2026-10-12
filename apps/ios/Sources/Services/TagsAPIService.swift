import Foundation

// MARK: - TagsAPIServiceProtocol

protocol TagsAPIServiceProtocol {
    func listTags() async throws -> [Tag]
    func createTag(id: String, name: String, encryptedLabel: String, color: String, encryptedCategory: String?) async throws -> TagResponse
    func updateTag(tagId: String, encryptedLabel: String?, color: String?, encryptedCategory: String?) async throws -> TagResponse
    func deleteTag(tagId: String) async throws -> TagDeleteResponse
}

// MARK: - TagsAPIService

/// API service for hub tags (E2EE labels — see TagsViewModel for the crypto half).
/// Wire types are the generated protocol types (`Tag`, `TagResponse`, `CreateTagBody`, …).
@Observable
final class TagsAPIService: TagsAPIServiceProtocol, @unchecked Sendable {
    private let apiService: APIService

    init(apiService: APIService) {
        self.apiService = apiService
    }

    func listTags() async throws -> [Tag] {
        let response: TagListResponse = try await apiService.request(
            method: "GET",
            path: apiService.hp("/api/tags")
        )
        return response.tags
    }

    func createTag(id: String, name: String, encryptedLabel: String, color: String, encryptedCategory: String?) async throws -> TagResponse {
        let body = CreateTagBody(
            color: color,
            encryptedCategory: encryptedCategory,
            encryptedLabel: encryptedLabel,
            id: id,
            name: name
        )
        return try await apiService.request(
            method: "POST",
            path: apiService.hp("/api/tags"),
            body: body
        )
    }

    /// A nil field is omitted from the PATCH body (left unchanged). The generated
    /// `UpdateTagBody` cannot encode an explicit null, so clearing a set category
    /// stays a desktop-only operation for now.
    func updateTag(tagId: String, encryptedLabel: String?, color: String?, encryptedCategory: String?) async throws -> TagResponse {
        let body = UpdateTagBody(
            color: color,
            encryptedCategory: encryptedCategory,
            encryptedLabel: encryptedLabel
        )
        return try await apiService.request(
            method: "PATCH",
            path: apiService.hp("/api/tags/\(tagId)"),
            body: body
        )
    }

    func deleteTag(tagId: String) async throws -> TagDeleteResponse {
        try await apiService.request(
            method: "DELETE",
            path: apiService.hp("/api/tags/\(tagId)")
        )
    }
}
