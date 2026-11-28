import Foundation
import Observation

/// `@MainActor` (#1920 audit): SwiftUI reads this `@Observable` state on the main thread,
/// so every write has to land there too. Unisolated, each `async` method ran on the global
/// executor under Swift 5.9 and wrote state from a GCD worker mid-render — the data race
/// Thread Sanitizer reported in #1918, #2049 and #1811. Network calls still suspend off the
/// main thread inside the API layer; only the state changes are pinned here.
@MainActor
@Observable
final class ContactFormViewModel {
    var displayName = ""
    var phone = ""
    var email = ""
    var tags: [String] = []
    var notes = ""
    var isSaving = false
    var error: String?

    private let cryptoService: CryptoService

    init(cryptoService: CryptoService) {
        self.cryptoService = cryptoService
    }

    func populate(from contact: DirectoryContact) {
        displayName = contact.displayName
        if let identifiers = contact.identifiers {
            phone = identifiers.first(where: { $0.type == .phone })?.value ?? ""
            email = identifiers.first(where: { $0.type == .email })?.value ?? ""
        }
    }

    /// Create a new encrypted contact.
    ///
    /// Encrypts all PII (name, phone, email, notes) client-side using HPKE
    /// before sending to the server. The server never sees plaintext PII.
    ///
    /// No search index is sent: a blind index is an HMAC under the hub key, the hub
    /// key lives in Rust and never enters Swift, and the crate exports no blind-index
    /// call yet (#2779). The desktop sends none either (#2139), so a contact is
    /// created and read the same way from every client.
    func save(hubId: String, readerPubkeys: [String], apiService: ContactsAPIService) async throws -> Contact {
        isSaving = true
        defer { isSaving = false }

        let trimmedName = displayName.trimmingCharacters(in: .whitespaces)
        guard !trimmedName.isEmpty else {
            throw ContactFormError.emptyDisplayName
        }

        // Encrypt summary tier (displayName, tags)
        let summaryJSON = try encodeSummary(displayName: trimmedName, tags: tags)
        let summaryResult = try cryptoService.encryptContactData(
            jsonPayload: summaryJSON,
            readerPubkeys: readerPubkeys,
            shape: .contactProfileKey
        )

        // Encrypt PII tier (identifiers, notes)
        let piiJSON = try encodePII(phone: phone, email: email, notes: notes)
        let piiResult: (ciphertextHex: String, envelopes: [RecipientEnvelope])?
        if let piiJSON {
            piiResult = try cryptoService.encryptContactData(
                jsonPayload: piiJSON,
                readerPubkeys: readerPubkeys,
                shape: .contactIdKey
            )
        } else {
            piiResult = nil
        }

        let summaryEnvelopes = summaryResult.envelopes.map {
            SharedAdminEnvelope(ct: $0.ct, enc: $0.enc, pubkey: $0.pubkey)
        }

        let piiEnvelopes = piiResult?.envelopes.map {
            SharedAdminEnvelope(ct: $0.ct, enc: $0.enc, pubkey: $0.pubkey)
        }

        let body = CreateContactBody(
            blindIndexes: nil,
            encryptedPII: piiResult?.ciphertextHex,
            encryptedSummary: summaryResult.ciphertextHex,
            hubID: hubId,
            identifierHashes: [],
            nameHash: nil,
            piiEnvelopes: piiEnvelopes,
            summaryEnvelopes: summaryEnvelopes,
            tagHashes: nil,
            trigramTokens: nil
        )

        return try await apiService.createContact(body)
    }

    /// Update an existing encrypted contact.
    func update(contactId: String, hubId: String, readerPubkeys: [String], apiService: ContactsAPIService) async throws -> Contact {
        isSaving = true
        defer { isSaving = false }

        let trimmedName = displayName.trimmingCharacters(in: .whitespaces)
        guard !trimmedName.isEmpty else {
            throw ContactFormError.emptyDisplayName
        }

        // Encrypt summary
        let summaryJSON = try encodeSummary(displayName: trimmedName, tags: tags)
        let summaryResult = try cryptoService.encryptContactData(
            jsonPayload: summaryJSON,
            readerPubkeys: readerPubkeys,
            shape: .contactProfileKey
        )

        // Encrypt PII
        let piiJSON = try encodePII(phone: phone, email: email, notes: notes)
        let piiResult: (ciphertextHex: String, envelopes: [RecipientEnvelope])?
        if let piiJSON {
            piiResult = try cryptoService.encryptContactData(
                jsonPayload: piiJSON,
                readerPubkeys: readerPubkeys,
                shape: .contactIdKey
            )
        } else {
            piiResult = nil
        }

        let summaryEnvelopes = summaryResult.envelopes.map {
            SharedAdminEnvelope(ct: $0.ct, enc: $0.enc, pubkey: $0.pubkey)
        }

        let piiEnvelopes = piiResult?.envelopes.map {
            SharedAdminEnvelope(ct: $0.ct, enc: $0.enc, pubkey: $0.pubkey)
        }

        let body = UpdateContactBody(
            blindIndexes: nil,
            encryptedPII: piiResult?.ciphertextHex,
            encryptedSummary: summaryResult.ciphertextHex,
            hubID: hubId,
            identifierHashes: nil,
            nameHash: nil,
            piiEnvelopes: piiEnvelopes,
            summaryEnvelopes: summaryEnvelopes,
            tagHashes: nil,
            trigramTokens: nil
        )

        return try await apiService.updateContact(id: contactId, body: body)
    }

    // MARK: - Encryption Helpers

    private func encodeSummary(displayName: String, tags: [String]) throws -> String {
        let summary: [String: Any] = [
            "displayName": displayName,
            "tags": tags,
        ]
        let data = try JSONSerialization.data(withJSONObject: summary)
        guard let json = String(data: data, encoding: .utf8) else {
            throw ContactFormError.encodingFailed
        }
        return json
    }

    private func encodePII(phone: String, email: String, notes: String) throws -> String? {
        let trimmedPhone = phone.trimmingCharacters(in: .whitespaces)
        let trimmedEmail = email.trimmingCharacters(in: .whitespaces)
        let trimmedNotes = notes.trimmingCharacters(in: .whitespaces)

        var identifiers: [[String: Any]] = []
        if !trimmedPhone.isEmpty {
            identifiers.append(["type": "phone", "value": trimmedPhone, "isPrimary": true])
        }
        if !trimmedEmail.isEmpty {
            identifiers.append(["type": "email", "value": trimmedEmail, "isPrimary": identifiers.isEmpty])
        }

        if identifiers.isEmpty && trimmedNotes.isEmpty {
            return nil
        }

        var pii: [String: Any] = ["identifiers": identifiers]
        if !trimmedNotes.isEmpty {
            pii["notes"] = trimmedNotes
        }

        let data = try JSONSerialization.data(withJSONObject: pii)
        guard let json = String(data: data, encoding: .utf8) else {
            throw ContactFormError.encodingFailed
        }
        return json
    }
}

enum ContactFormError: Error, LocalizedError {
    case emptyDisplayName
    case encodingFailed

    var errorDescription: String? {
        switch self {
        case .emptyDisplayName:
            return NSLocalizedString("error_empty_display_name", comment: "Display name is required")
        case .encodingFailed:
            return NSLocalizedString("error_encoding_failed", comment: "Failed to encode contact data")
        }
    }
}
