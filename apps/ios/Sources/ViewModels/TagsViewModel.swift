import Foundation

// MARK: - HubFieldCrypting

/// The hub-field seal/open surface the tag screens need. The hub key lives in
/// Rust (`MobileState`) and is addressed by hub id — it never enters Swift.
/// A protocol so tests can substitute the real `CryptoService` or a double
/// without subclassing the final class.
protocol HubFieldCrypting {
    func hasHubKey(hubId: String) -> Bool
    func encryptHubField(plaintext: String, hubId: String, label: String) throws -> String
    func decryptHubField(ciphertextHex: String, hubId: String, label: String) -> String?
}

extension CryptoService: HubFieldCrypting {}

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

    /// `decrypt` opens one stored field under the active hub's key, or is nil
    /// when no hub is active.
    init(tag: Tag, decrypt: ((String) -> String?)?) {
        self.init(
            id: tag.id,
            name: tag.name,
            encryptedLabel: tag.encryptedLabel,
            color: tag.color,
            encryptedCategory: tag.encryptedCategory,
            createdAt: tag.createdAt,
            decrypt: decrypt
        )
    }

    init(tag: TagResponse, decrypt: ((String) -> String?)?) {
        self.init(
            id: tag.id,
            name: tag.name,
            encryptedLabel: tag.encryptedLabel,
            color: tag.color,
            encryptedCategory: tag.encryptedCategory,
            createdAt: tag.createdAt,
            decrypt: decrypt
        )
    }

    private init(
        id: String,
        name: String,
        encryptedLabel: String,
        color: String,
        encryptedCategory: String?,
        createdAt: String,
        decrypt: ((String) -> String?)?
    ) {
        self.id = id
        self.name = name
        self.color = color
        self.createdAt = createdAt
        label = decrypt?(encryptedLabel) ?? encryptedLabel
        category = encryptedCategory.flatMap { decrypt?($0) }
    }
}

// MARK: - TagsViewModel

/// `@MainActor` because this is `@Observable` state that SwiftUI reads on the main thread.
/// Unannotated, the `async` loaders wrote `isLoading`, `tags`… from the global executor while a
/// view body read them (Thread Sanitizer reports the race on `isLoading`), and an Observation
/// write that lands while a body is being evaluated is never delivered. Network calls still
/// suspend off the main thread inside the API service; only the state changes are pinned
/// here. Same defect class as #1918, #2049 and `ReportsViewModel`.
@MainActor
@Observable
final class TagsViewModel {
    private let tagsAPI: TagsAPIServiceProtocol
    private let crypto: any HubFieldCrypting
    private let hubIdProvider: () -> String?

    var tags: [DecryptedTag] = []
    var isLoading = false
    var errorMessage: String?

    init(
        tagsAPI: TagsAPIServiceProtocol,
        crypto: any HubFieldCrypting,
        hubIdProvider: @escaping () -> String?
    ) {
        self.tagsAPI = tagsAPI
        self.crypto = crypto
        self.hubIdProvider = hubIdProvider
    }

    /// Decrypts one stored tag field under the active hub's key; nil when no hub is active.
    private func fieldDecryptor() -> ((String) -> String?)? {
        guard let hubId = hubIdProvider() else { return nil }
        return { [crypto] ciphertextHex in
            crypto.decryptHubField(
                ciphertextHex: ciphertextHex,
                hubId: hubId,
                label: CryptoLabels.LABEL_TAG_ENCRYPT
            )
        }
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
            let decrypt = fieldDecryptor()
            tags = try await tagsAPI.listTags().map { DecryptedTag(tag: $0, decrypt: decrypt) }
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
        guard let hubId = hubIdProvider(), crypto.hasHubKey(hubId: hubId) else {
            throw TagsViewModelError.noHubKey
        }
        let trimmed = label.trimmingCharacters(in: .whitespaces)
        let encryptedLabel = try crypto.encryptHubField(
            plaintext: trimmed,
            hubId: hubId,
            label: CryptoLabels.LABEL_TAG_ENCRYPT
        )
        let trimmedCategory = category?.trimmingCharacters(in: .whitespaces)
        let encryptedCategory = try trimmedCategory.flatMap { raw in
            raw.isEmpty ? nil : try crypto.encryptHubField(
                plaintext: raw,
                hubId: hubId,
                label: CryptoLabels.LABEL_TAG_ENCRYPT
            )
        }
        let created = try await tagsAPI.createTag(
            id: UUID().uuidString,
            name: Self.slugify(trimmed),
            encryptedLabel: encryptedLabel,
            color: color,
            encryptedCategory: encryptedCategory
        )
        let decrypted = DecryptedTag(tag: created, decrypt: fieldDecryptor())
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
