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

@MainActor
struct TagsViewModelTests {

    // key = 0x42×32 reproduces the desktop-produced ciphertext below
    // (nonce 0x07×12, AAD = LABEL_TAG_ENCRYPT) — it decrypts to "Urgent".
    private static let hubKeyHex = String(repeating: "42", count: 32)
    private static let urgentCiphertext = "0707070707070707070707072d903ac9db856df12c7b9e44a64e237900b1010e005d"

    /// A real `CryptoService` holding the hub key for `hubId` in Rust. Each test uses its own hub id: the
    /// Rust key table is process-global, so tests must not clear it.
    private func makeCrypto(hubId: String?) -> CryptoService {
        let crypto = CryptoService()
        if let hubId { crypto.storeHubKeyForTesting(hubId: hubId, keyHex: Self.hubKeyHex) }
        return crypto
    }

    private func makeViewModel(
        _ mock: MockTagsAPIService, crypto: CryptoService, activeHubId: String?
    ) -> TagsViewModel {
        TagsViewModel(tagsAPI: mock, crypto: crypto, hubIdProvider: { activeHubId })
    }

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

    @Test func loadTagsDecryptsLabelsUnderTheActiveHubKey() async {
        let crypto = makeCrypto(hubId: "tags-load")
        let mock = MockTagsAPIService()
        mock.listTagsResult = .success([makeTag(encryptedLabel: Self.urgentCiphertext)])
        let vm = makeViewModel(mock, crypto: crypto, activeHubId: "tags-load")
        await vm.loadTags()
        #expect(vm.tags.count == 1)
        #expect(vm.tags[0].id == "tag-1")
        #expect(vm.tags[0].label == "Urgent")
        #expect(vm.isLoading == false)
    }

    @Test func loadTagsFallsBackToTheStoredValueWithoutAKey() async {
        let mock = MockTagsAPIService()
        mock.listTagsResult = .success([makeTag(encryptedLabel: Self.urgentCiphertext)])
        // No hub active, and an active hub that holds no key: both show the raw value.
        for activeHubId in [nil, "tags-no-key"] as [String?] {
            let vm = makeViewModel(mock, crypto: makeCrypto(hubId: nil), activeHubId: activeHubId)
            await vm.loadTags()
            #expect(vm.tags[0].label == Self.urgentCiphertext)
            #expect(vm.tags[0].category == nil)
        }
    }

    @Test func slugifyMatchesTheDesktopSlug() {
        #expect(TagsViewModel.slugify("Urgent Care") == "urgent-care")
        #expect(TagsViewModel.slugify("Multiple   Spaces") == "multiple-spaces")
        // Characters outside [a-z0-9-] are dropped, not dashed (desktop `useCreateTag`).
        #expect(TagsViewModel.slugify("Suivi médical") == "suivi-mdical")
    }

    @Test func createTagSealsTheLabelInRustAndTrimsTheSlug() async throws {
        let crypto = makeCrypto(hubId: "tags-create")
        let mock = MockTagsAPIService()
        mock.createTagResult = .success(makeTagResponse(id: "tag-new", name: "padded"))
        let vm = makeViewModel(mock, crypto: crypto, activeHubId: "tags-create")

        let result = try await vm.createTag(label: "  Padded  ", color: "#3b82f6", category: " Care ")

        #expect(result.id == "tag-new")
        let args = try #require(mock.lastCreateArgs)
        #expect(args.name == "padded")
        #expect(args.encryptedLabel != "Padded")
        #expect(crypto.decryptHubField(
            ciphertextHex: args.encryptedLabel, hubId: "tags-create", label: CryptoLabels.LABEL_TAG_ENCRYPT
        ) == "Padded")
        let encryptedCategory = try #require(args.encryptedCategory)
        #expect(crypto.decryptHubField(
            ciphertextHex: encryptedCategory, hubId: "tags-create", label: CryptoLabels.LABEL_TAG_ENCRYPT
        ) == "Care")
        #expect(vm.tags.count == 1)
    }

    @Test func createTagThrowsWithoutAHubKey() async {
        let mock = MockTagsAPIService()
        // No active hub, and an active hub whose key is not loaded.
        for activeHubId in [nil, "tags-no-key"] as [String?] {
            let vm = makeViewModel(mock, crypto: makeCrypto(hubId: nil), activeHubId: activeHubId)
            await #expect(throws: TagsViewModelError.self) {
                try await vm.createTag(label: "Test", color: "#000", category: nil)
            }
        }
        #expect(mock.lastCreateArgs == nil)
    }

    @Test func loadTagsSetsErrorOnFailure() async {
        let mock = MockTagsAPIService()
        mock.listTagsResult = .failure(URLError(.notConnectedToInternet))
        let vm = makeViewModel(mock, crypto: makeCrypto(hubId: nil), activeHubId: nil)
        await vm.loadTags()
        #expect(vm.errorMessage != nil)
        #expect(vm.tags.isEmpty)
    }

    @Test func deleteTagRemovesItFromTheList() async throws {
        let mock = MockTagsAPIService()
        mock.listTagsResult = .success([makeTag()])
        let vm = makeViewModel(mock, crypto: makeCrypto(hubId: nil), activeHubId: nil)
        await vm.loadTags()
        #expect(vm.tags.count == 1)
        try await vm.deleteTag("tag-1")
        #expect(mock.lastDeletedTagId == "tag-1")
        #expect(vm.tags.isEmpty)
    }
}
