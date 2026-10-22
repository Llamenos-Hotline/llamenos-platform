import Foundation

// MARK: - TagsAPIServiceProtocol

protocol TagsAPIServiceProtocol {
    func listTags(hubId: String) async throws -> [Tag]
    func createTag(hubId: String, id: String, name: String, encryptedLabel: String, color: String, encryptedCategory: String?) async throws -> TagResponse
    func updateTag(hubId: String, tagId: String, encryptedLabel: String?, color: String?, encryptedCategory: String?) async throws -> TagResponse
    func deleteTag(hubId: String, tagId: String) async throws -> TagDeleteResponse
}

// MARK: - TagsAPIService

/// API service for hub tags (E2EE labels — see TagsViewModel for the crypto half).
/// Wire types are the generated protocol types (`Tag`, `TagResponse`, `CreateTagBody`, …).
/// Tags are mounted only under `/api/hubs/:hubId/tags`, so every call names its hub
/// explicitly via `APIService.hubPath` — `hp()` would fall back to the unmounted bare
/// `/api/tags` when no hub is active.
/// `Tag` is the element type of `TagListResponse.tags`; quicktype names it from the
/// property (`tags` → `Tag`), not `TagListResponseTag` — see `generated/swift/Types.swift`.
@Observable
final class TagsAPIService: TagsAPIServiceProtocol, @unchecked Sendable {
    private let apiService: APIService

    init(apiService: APIService) {
        self.apiService = apiService
    }

    func listTags(hubId: String) async throws -> [Tag] {
        let response: TagListResponse = try await apiService.request(
            method: "GET",
            path: APIService.hubPath(hubId, "/api/tags")
        )
        return response.tags
    }

    func createTag(hubId: String, id: String, name: String, encryptedLabel: String, color: String, encryptedCategory: String?) async throws -> TagResponse {
        let body = CreateTagBody(
            color: color,
            encryptedCategory: encryptedCategory,
            encryptedLabel: encryptedLabel,
            id: id,
            name: name
        )
        return try await apiService.request(
            method: "POST",
            path: APIService.hubPath(hubId, "/api/tags"),
            body: body
        )
    }

    /// A nil field is omitted from the PATCH body (left unchanged). The generated
    /// `UpdateTagBody` cannot encode an explicit null, so clearing a set category
    /// stays a desktop-only operation for now.
    func updateTag(hubId: String, tagId: String, encryptedLabel: String?, color: String?, encryptedCategory: String?) async throws -> TagResponse {
        let body = UpdateTagBody(
            color: color,
            encryptedCategory: encryptedCategory,
            encryptedLabel: encryptedLabel
        )
        return try await apiService.request(
            method: "PATCH",
            path: APIService.hubPath(hubId, "/api/tags/\(tagId)"),
            body: body
        )
    }

    func deleteTag(hubId: String, tagId: String) async throws -> TagDeleteResponse {
        try await apiService.request(
            method: "DELETE",
            path: APIService.hubPath(hubId, "/api/tags/\(tagId)")
        )
    }
}
