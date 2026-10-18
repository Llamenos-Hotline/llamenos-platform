import Foundation
import Testing
@testable import Llamenos

final class MockTagsAPIService: TagsAPIServiceProtocol {
    var listTagsResult: Result<[Llamenos.Tag], Error> = .success([])
    var createTagResult: Result<TagResponse, Error>?
    var deleteTagResult: Result<TagDeleteResponse, Error> = .success(TagDeleteResponse(removedFromContacts: 0))
    var lastCreateArgs: (id: String, name: String, encryptedLabel: String, color: String, encryptedCategory: String?)?
    var lastDeletedTagId: String?

    func listTags() async throws -> [Llamenos.Tag] {
        switch listTagsResult {
        case .success(let tags): return tags
        case .failure(let error): throw error
        }
    }

    func createTag(id: String, name: String, encryptedLabel: String, color: String, encryptedCategory: String?) async throws -> TagResponse {
        lastCreateArgs = (id: id, name: name, encryptedLabel: encryptedLabel, color: color, encryptedCategory: encryptedCategory)
        if let result = createTagResult {
            switch result {
            case .success(let response): return response
            case .failure(let error): throw error
            }
        }
        throw URLError(.unsupportedURL)
    }

    func updateTag(tagId: String, encryptedLabel: String?, color: String?, encryptedCategory: String?) async throws -> TagResponse {
        throw URLError(.unsupportedURL)
    }

    func deleteTag(tagId: String) async throws -> TagDeleteResponse {
        lastDeletedTagId = tagId
        switch deleteTagResult {
        case .success(let response): return response
        case .failure(let error): throw error
        }
    }
}

struct TagsViewModelTests {

    private static let hubKey = Data(repeating: 0x42, count: 32)

    private func makeTag(
        id: String = "tag-1",
        name: String = "urgent",
        encryptedLabel: String = "deadbeef",
        color: String = "#ef4444",
        encryptedCategory: String? = nil
    ) -> Llamenos.Tag {
        Llamenos.Tag(
            color: color,
            createdAt: "2026-01-01T00:00:00Z",
            createdBy: "admin",
            encryptedCategory: encryptedCategory,
            encryptedLabel: encryptedLabel,
            hubID: "hub-1",
            id: id,
            name: name
        )
    }

    private func makeTagResponse(
        id: String = "tag-1",
        name: String = "urgent",
        encryptedLabel: String = "deadbeef",
        color: String = "#ef4444",
        encryptedCategory: String? = nil
    ) -> TagResponse {
        TagResponse(
            color: color,
            createdAt: "2026-01-01T00:00:00Z",
            createdBy: "admin",
            encryptedCategory: encryptedCategory,
            encryptedLabel: encryptedLabel,
            hubID: "hub-1",
            id: id,
            name: name
        )
    }

    @Test func loadTagsPopulatesList() async {
        let mock = MockTagsAPIService()
        mock.listTagsResult = .success([makeTag()])
        let vm = TagsViewModel(tagsAPI: mock, hubKeyProvider: { nil })
        await vm.loadTags()
        #expect(vm.tags.count == 1)
        #expect(vm.tags[0].id == "tag-1")
        #expect(vm.isLoading == false)
    }

    @Test func slugifyProducesLowercaseSlugs() {
        #expect(TagsViewModel.slugify("Urgent Care") == "urgent-care")
        #expect(TagsViewModel.slugify("Suivi médical") == "suivi-m-dical")
        #expect(TagsViewModel.slugify("  Padded  ") == "padded")
        #expect(TagsViewModel.slugify("Multiple   Spaces") == "multiple-spaces")
    }

    @Test func createTagCallsAPIAndRefreshes() async throws {
        let mock = MockTagsAPIService()
        let created = makeTagResponse(id: "tag-new", name: "follow-up")
        mock.createTagResult = .success(created)
        mock.listTagsResult = .success([makeTag(id: "tag-new", name: "follow-up")])
        let vm = TagsViewModel(tagsAPI: mock, hubKeyProvider: { Self.hubKey })

        let result = try await vm.createTag(label: "Follow Up", color: "#3b82f6", category: nil)

        #expect(result.id == "tag-new")
        #expect(mock.lastCreateArgs != nil)
        #expect(vm.tags.count == 1)
    }

    @Test func createTagThrowsWithoutHubKey() async {
        let mock = MockTagsAPIService()
        let vm = TagsViewModel(tagsAPI: mock, hubKeyProvider: { nil })
        await #expect(throws: (any Error).self) {
            try await vm.createTag(label: "Test", color: "#000", category: nil)
        }
    }

    @Test func loadTagsSetsErrorOnFailure() async {
        let mock = MockTagsAPIService()
        mock.listTagsResult = .failure(URLError(.notConnectedToInternet))
        let vm = TagsViewModel(tagsAPI: mock, hubKeyProvider: { nil })
        await vm.loadTags()
        #expect(vm.errorMessage != nil)
        #expect(vm.tags.isEmpty)
    }

    @Test func deleteTagRefreshesList() async throws {
        let mock = MockTagsAPIService()
        mock.listTagsResult = .success([])
        let vm = TagsViewModel(tagsAPI: mock, hubKeyProvider: { nil })
        try await vm.deleteTag("tag-1")
        #expect(mock.lastDeletedTagId == "tag-1")
        #expect(vm.tags.isEmpty)
    }
}
