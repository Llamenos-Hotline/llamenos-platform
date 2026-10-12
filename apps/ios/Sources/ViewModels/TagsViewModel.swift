import Foundation

// MARK: - DecryptedTag

/// A tag with its E2EE fields decrypted for display.
/// Falls back to the raw stored value when the hub key is unavailable or the
/// ciphertext does not open — matching the desktop `decryptTag` behavior.
struct DecryptedTag: Identifiable, Sendable {
    let id: String
    /// URL-safe slug (server-visible identifier).
    let name: String
    let label: String
    let color: String
    let category: String?
    let createdAt: String

    init(tag: Tag, hubKey: Data?) {
        self.init(
            id: tag.id,
            name: tag.name,
            encryptedLabel: tag.encryptedLabel,
            color: tag.color,
            encryptedCategory: tag.encryptedCategory,
            createdAt: tag.createdAt,
            hubKey: hubKey
        )
    }

    init(tag: TagResponse, hubKey: Data?) {
        self.init(
            id: tag.id,
            name: tag.name,
            encryptedLabel: tag.encryptedLabel,
            color: tag.color,
            encryptedCategory: tag.encryptedCategory,
            createdAt: tag.createdAt,
            hubKey: hubKey
        )
    }

    private init(
        id: String,
        name: String,
        encryptedLabel: String,
        color: String,
        encryptedCategory: String?,
        createdAt: String,
        hubKey: Data?
    ) {
        self.id = id
        self.name = name
        self.color = color
        self.createdAt = createdAt
        if let hubKey {
            label = HubFieldCrypto.decrypt(
                ciphertextHex: encryptedLabel,
                label: CryptoLabels.LABEL_TAG_ENCRYPT,
                hubKey: hubKey
            ) ?? encryptedLabel
            if let encryptedCategory {
                category = HubFieldCrypto.decrypt(
                    ciphertextHex: encryptedCategory,
                    label: CryptoLabels.LABEL_TAG_ENCRYPT,
                    hubKey: hubKey
                )
            } else {
                category = nil
            }
        } else {
            label = encryptedLabel
            category = nil
        }
    }
}

// MARK: - TagsViewModel

@Observable
final class TagsViewModel {
    private let tagsAPI: TagsAPIServiceProtocol
    private let hubKeyProvider: () -> Data?

    var tags: [DecryptedTag] = []
    var isLoading = false
    var errorMessage: String?

    init(tagsAPI: TagsAPIServiceProtocol, hubKeyProvider: @escaping () -> Data?) {
        self.tagsAPI = tagsAPI
        self.hubKeyProvider = hubKeyProvider
    }

    /// Tags grouped by decrypted category for picker display.
    /// The uncategorized group sorts last and uses the localized fallback.
    var groupedByCategory: [(category: String, tags: [DecryptedTag])] {
        let uncategorized = NSLocalizedString("tags_uncategorized", comment: "General")
        var groups: [String: [DecryptedTag]] = [:]
        for tag in tags {
            groups[tag.category ?? uncategorized, default: []].append(tag)
        }
        return groups
            .map { (category: $0.key, tags: $0.value.sorted { $0.label < $1.label }) }
            .sorted { lhs, rhs in
                if lhs.category == uncategorized { return false }
                if rhs.category == uncategorized { return true }
                return lhs.category < rhs.category
            }
    }

    func loadTags() async {
        guard !isLoading else { return }
        isLoading = true
        errorMessage = nil
        do {
            let hubKey = hubKeyProvider()
            tags = try await tagsAPI.listTags().map { DecryptedTag(tag: $0, hubKey: hubKey) }
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    /// Slug for a display label, matching the desktop `useCreateTag` mutation:
    /// lowercase, whitespace to dashes, strip anything outside [a-z0-9-].
    static func slugify(_ label: String) -> String {
        label
            .lowercased()
            .replacingOccurrences(of: "\\s+", with: "-", options: .regularExpression)
            .replacingOccurrences(of: "[^a-z0-9-]", with: "", options: .regularExpression)
    }

    @discardableResult
    func createTag(label: String, color: String, category: String?) async throws -> DecryptedTag {
        guard let hubKey = hubKeyProvider() else {
            throw TagsViewModelError.noHubKey
        }
        let trimmed = label.trimmingCharacters(in: .whitespaces)
        let encryptedLabel = try HubFieldCrypto.encrypt(
            plaintext: trimmed,
            label: CryptoLabels.LABEL_TAG_ENCRYPT,
            hubKey: hubKey
        )
        let trimmedCategory = category?.trimmingCharacters(in: .whitespaces)
        let encryptedCategory = try trimmedCategory.flatMap { raw in
            raw.isEmpty ? nil : try HubFieldCrypto.encrypt(
                plaintext: raw,
                label: CryptoLabels.LABEL_TAG_ENCRYPT,
                hubKey: hubKey
            )
        }
        let created = try await tagsAPI.createTag(
            id: UUID().uuidString,
            name: Self.slugify(trimmed),
            encryptedLabel: encryptedLabel,
            color: color,
            encryptedCategory: encryptedCategory
        )
        let decrypted = DecryptedTag(tag: created, hubKey: hubKey)
        tags.append(decrypted)
        tags.sort { $0.label < $1.label }
        return decrypted
    }

    func deleteTag(_ tagId: String) async throws {
        _ = try await tagsAPI.deleteTag(tagId: tagId)
        tags.removeAll { $0.id == tagId }
    }
}

enum TagsViewModelError: Error, LocalizedError {
    case noHubKey

    var errorDescription: String? {
        NSLocalizedString("error_no_hub_key", comment: "Hub key not available")
    }
}
