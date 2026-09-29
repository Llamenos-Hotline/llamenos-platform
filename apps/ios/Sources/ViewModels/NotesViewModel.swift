import Foundation
import UIKit

// MARK: - NotesViewModel

/// View model for the Notes tab. Fetches encrypted notes from the API, decrypts them
/// using CryptoService, and manages pagination and custom field definitions.
@Observable
final class NotesViewModel {
    private let apiService: HubAPIServiceProtocol
    private let cryptoService: CryptoService

    // MARK: - Public State

    /// Decrypted notes, sorted by creation date (newest first).
    var notes: [DecryptedNote] = []

    /// Custom field definitions fetched from the server.
    var customFields: [CustomFieldDefinition] = []

    /// Whether the initial load is in progress.
    var isLoading: Bool = false

    /// Whether a page load is in progress (for pagination).
    var isLoadingMore: Bool = false

    /// Error message from the last failed operation.
    var errorMessage: String?

    /// Whether there are more notes to load.
    var hasMore: Bool = true

    /// Total number of notes on the server.
    var totalCount: Int = 0

    /// Whether the note creation sheet is shown.
    var showCreateSheet: Bool = false

    // MARK: - Private State

    private var currentPage: Int = 1
    private let pageSize: Int = 50
    private var encryptedNotes: [SharedNote] = []

    // MARK: - Initialization

    init(apiService: HubAPIServiceProtocol, cryptoService: CryptoService) {
        self.apiService = apiService
        self.cryptoService = cryptoService
    }

    // MARK: - Data Loading

    /// Load the first page of notes and custom field definitions.
    func loadNotes() async {
        guard !isLoading else { return }
        isLoading = true
        errorMessage = nil
        currentPage = 1

        async let notesResult: Void = fetchNotesPage(page: 1, replacing: true)
        async let fieldsResult: Void = fetchCustomFields()

        await notesResult
        await fieldsResult

        isLoading = false
    }

    /// Load the next page of notes (pagination).
    func loadMoreNotes() async {
        guard !isLoadingMore, hasMore else { return }
        isLoadingMore = true

        let nextPage = currentPage + 1
        await fetchNotesPage(page: nextPage, replacing: false)

        isLoadingMore = false
    }

    /// Refresh notes (pull-to-refresh).
    func refresh() async {
        isLoading = false
        await loadNotes()
    }

    // MARK: - Note Creation

    /// Encrypt and create a new note using HPKE envelope encryption.
    ///
    /// - Parameters:
    ///   - text: The note body text.
    ///   - fields: Custom field values keyed by field name.
    ///   - callId: The call the note is about. The server requires a note to belong to
    ///     a call or a conversation; this sheet files notes against a call.
    ///   - transcript: Optional call transcript, appended to the note text.
    ///   - adminPubkeys: Admin encryption public keys (X25519) for envelope encryption.
    func createNote(
        text: String,
        fields: [String: AnyCodableValue]?,
        callId: String,
        transcript: String?,
        adminPubkeys: [String]
    ) async throws {
        let noteText = transcript.map { "\(text)\n\n--- Transcript ---\n\($0)" } ?? text
        let payload = NotePayload(text: noteText, fields: fields)
        let payloadJSON = String(data: try JSONEncoder().encode(payload), encoding: .utf8) ?? "{}"

        // Build full recipient list: our encryption key + admin encryption keys
        var recipientPubkeys: [String] = []
        if let ourPubkey = cryptoService.encryptionPubkeyHex {
            recipientPubkeys.append(ourPubkey)
        }
        for adminPubkey in adminPubkeys where !recipientPubkeys.contains(adminPubkey) {
            recipientPubkeys.append(adminPubkey)
        }

        let result = try cryptoService.encryptNote(payload: payloadJSON, recipientPubkeys: recipientPubkeys)

        // Map HPKE envelopes to the protocol wire format
        let authorEnvelope = cryptoService.encryptionPubkeyHex
            .flatMap { ourPubkey in result.envelopes.first(where: { $0.pubkey == ourPubkey }) }
            .map { SharedAuthorEnvelope(ct: $0.envelope.ct, enc: $0.envelope.enc) }

        let adminEnvelopes = result.envelopes
            .filter { $0.pubkey != cryptoService.encryptionPubkeyHex }
            .map { SharedAdminEnvelope(ct: $0.envelope.ct, enc: $0.envelope.enc, pubkey: $0.pubkey) }

        let body = CreateNoteBody(
            adminEnvelopes: adminEnvelopes,
            authorEnvelope: authorEnvelope,
            callID: callId,
            caseID: nil,
            contactHash: nil,
            conversationID: nil,
            encryptedContent: result.ciphertextHex,
            interactionTypeHash: nil
        )

        let _: NoteDetailResponse = try await apiService.request(
            method: "POST",
            path: apiService.hp("/api/notes"),
            body: body
        )

        // Haptic feedback on success
        let generator = UIImpactFeedbackGenerator(style: .medium)
        generator.impactOccurred()

        // Reload notes to include the new one
        await refresh()
    }

    // MARK: - Note Decryption

    /// Find the matching envelope for our pubkey and decrypt the note using HPKE.
    func decryptNote(_ encrypted: SharedNote) -> DecryptedNote? {
        guard let ourPubkey = cryptoService.encryptionPubkeyHex else { return nil }

        // Find our envelope — check author envelope first (volunteer's own note)
        var envelope: HpkeEnvelope?

        if encrypted.authorPubkey == ourPubkey, let authorEnv = encrypted.authorEnvelope {
            envelope = HpkeEnvelope(
                v: 3,
                labelId: 0,
                enc: authorEnv.enc,
                ct: authorEnv.ct
            )
        }

        // Then check admin envelopes
        if envelope == nil, let adminEnvs = encrypted.adminEnvelopes {
            if let ourEnvelope = adminEnvs.first(where: { $0.pubkey == ourPubkey }) {
                envelope = HpkeEnvelope(
                    v: 3,
                    labelId: 0,
                    enc: ourEnvelope.enc,
                    ct: ourEnvelope.ct
                )
            }
        }

        guard let hpkeEnvelope = envelope else {
            return nil
        }

        do {
            let decryptedJSON = try cryptoService.decryptNote(
                ciphertextHex: encrypted.encryptedContent,
                envelope: hpkeEnvelope
            )

            let payload = try JSONDecoder().decode(NotePayload.self, from: Data(decryptedJSON.utf8))

            return DecryptedNote(
                id: encrypted.id,
                payload: payload,
                authorPubkey: encrypted.authorPubkey,
                callId: encrypted.callID,
                conversationId: encrypted.conversationID,
                createdAt: DateFormatting.parseISO(encrypted.createdAt) ?? Date(),
                updatedAt: DateFormatting.parseISO(encrypted.updatedAt)
            )
        } catch {
            return nil
        }
    }

    // MARK: - Private Helpers

    private func fetchNotesPage(page: Int, replacing: Bool) async {
        do {
            let response: NoteListResponse = try await apiService.request(
                method: "GET",
                path: apiService.hp("/api/notes?page=\(page)&limit=\(pageSize)")
            )

            if replacing {
                encryptedNotes = response.notes
            } else {
                encryptedNotes.append(contentsOf: response.notes)
            }

            totalCount = Int(response.total)
            currentPage = page
            hasMore = encryptedNotes.count < totalCount

            // Decrypt all notes
            notes = encryptedNotes.compactMap(decryptNote)
        } catch {
            if case APIError.noBaseURL = error {
                // Hub not configured — show empty state, no error
            } else {
                errorMessage = error.localizedDescription
            }
        }
    }

    private func fetchCustomFields() async {
        do {
            let response: CustomFieldsResponse = try await apiService.request(
                method: "GET",
                path: apiService.hp("/api/settings/custom-fields")
            )
            customFields = response.fields
                .filter { $0.visibleToVolunteers }
                .sorted { $0.order < $1.order }
        } catch {
            // Custom fields are optional — silently continue without them
            customFields = []
        }
    }

}
