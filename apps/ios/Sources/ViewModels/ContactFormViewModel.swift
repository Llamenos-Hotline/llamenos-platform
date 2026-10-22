import CommonCrypto
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
    func save(hubId: String, hubKey: Data, readerPubkeys: [String], apiService: ContactsAPIService) async throws -> Contact {
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
            label: CryptoLabels.LABEL_CONTACT_PROFILE
        )

        // Encrypt PII tier (identifiers, notes)
        let piiJSON = try encodePII(phone: phone, email: email, notes: notes)
        let piiResult: (ciphertextHex: String, envelopes: [RecipientEnvelope])?
        if let piiJSON {
            piiResult = try cryptoService.encryptContactData(
                jsonPayload: piiJSON,
                readerPubkeys: readerPubkeys,
                label: CryptoLabels.LABEL_CONTACT_ID
            )
        } else {
            piiResult = nil
        }

        // Build blind indexes for server-side search
        let hubKeyBytes = [UInt8](hubKey)
        let identifierHashes = buildIdentifierHashes(name: trimmedName, phone: phone, email: email, hubKey: hubKeyBytes)
        let nameHash = hmacBlindIndex(hubKey: hubKeyBytes, field: "name", value: trimmedName)
        let trigramTokens = buildTrigramTokens(value: trimmedName, hubKey: hubKeyBytes)

        let summaryEnvelopes = summaryResult.envelopes.map {
            SharedAdminEnvelope(ct: $0.ct, enc: $0.enc, pubkey: $0.pubkey)
        }

        let piiEnvelopes = piiResult?.envelopes.map {
            SharedAdminEnvelope(ct: $0.ct, enc: $0.enc, pubkey: $0.pubkey)
        }

        let body = CreateContactBody(
            blindIndexes: nil,
            contactTypeHash: nil,
            encryptedPII: piiResult?.ciphertextHex,
            encryptedSummary: summaryResult.ciphertextHex,
            hubID: hubId,
            identifierHashes: identifierHashes,
            nameHash: nameHash,
            piiEnvelopes: piiEnvelopes,
            statusHash: nil,
            summaryEnvelopes: summaryEnvelopes,
            tagHashes: nil,
            trigramTokens: trigramTokens
        )

        return try await apiService.createContact(body)
    }

    /// Update an existing encrypted contact.
    func update(contactId: String, hubId: String, hubKey: Data, readerPubkeys: [String], apiService: ContactsAPIService) async throws -> Contact {
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
            label: CryptoLabels.LABEL_CONTACT_PROFILE
        )

        // Encrypt PII
        let piiJSON = try encodePII(phone: phone, email: email, notes: notes)
        let piiResult: (ciphertextHex: String, envelopes: [RecipientEnvelope])?
        if let piiJSON {
            piiResult = try cryptoService.encryptContactData(
                jsonPayload: piiJSON,
                readerPubkeys: readerPubkeys,
                label: CryptoLabels.LABEL_CONTACT_ID
            )
        } else {
            piiResult = nil
        }

        // Rebuild blind indexes
        let hubKeyBytes = [UInt8](hubKey)
        let identifierHashes = buildIdentifierHashes(name: trimmedName, phone: phone, email: email, hubKey: hubKeyBytes)
        let nameHash = hmacBlindIndex(hubKey: hubKeyBytes, field: "name", value: trimmedName)
        let trigramTokens = buildTrigramTokens(value: trimmedName, hubKey: hubKeyBytes)

        let summaryEnvelopes = summaryResult.envelopes.map {
            SharedAdminEnvelope(ct: $0.ct, enc: $0.enc, pubkey: $0.pubkey)
        }

        let piiEnvelopes = piiResult?.envelopes.map {
            SharedAdminEnvelope(ct: $0.ct, enc: $0.enc, pubkey: $0.pubkey)
        }

        let body = UpdateContactBody(
            blindIndexes: nil,
            contactTypeHash: nil,
            encryptedPII: piiResult?.ciphertextHex,
            encryptedSummary: summaryResult.ciphertextHex,
            hubID: hubId,
            identifierHashes: identifierHashes,
            nameHash: nameHash,
            piiEnvelopes: piiEnvelopes,
            statusHash: nil,
            summaryEnvelopes: summaryEnvelopes,
            tagHashes: nil,
            trigramTokens: trigramTokens
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

    // MARK: - Blind Index Helpers

    private func buildIdentifierHashes(name: String, phone: String, email: String, hubKey: [UInt8]) -> [String] {
        var hashes: [String] = []
        let trimmedPhone = phone.trimmingCharacters(in: .whitespaces)
        let trimmedEmail = email.trimmingCharacters(in: .whitespaces)

        if !trimmedPhone.isEmpty {
            hashes.append(hmacBlindIndex(hubKey: hubKey, field: "phone", value: trimmedPhone))
        }
        if !trimmedEmail.isEmpty {
            hashes.append(hmacBlindIndex(hubKey: hubKey, field: "email", value: trimmedEmail))
        }
        if hashes.isEmpty {
            hashes.append(hmacBlindIndex(hubKey: hubKey, field: "name", value: name))
        }
        return hashes
    }

    private func buildTrigramTokens(value: String, hubKey: [UInt8]) -> [String] {
        let normalized = canonicalize(value)
        let chars = Array(normalized)
        guard chars.count >= 3 else {
            return [hmacBlindIndex(hubKey: hubKey, field: "name:trigram", value: normalized)]
        }
        var tokens = Set<String>()
        for i in 0...(chars.count - 3) {
            let trigram = String(chars[i..<(i + 3)])
            tokens.insert(hmacBlindIndex(hubKey: hubKey, field: "name:trigram", value: trigram))
        }
        return Array(tokens).sorted()
    }

    /// Compute HMAC-SHA256 blind index matching packages/crypto/src/blind_index.rs.
    /// HKDF-derives a per-field key from the hub key, then HMACs the canonicalized value.
    private func hmacBlindIndex(hubKey: [UInt8], field: String, value: String) -> String {
        // Derive per-field key: HKDF-SHA256(salt=LABEL_BLIND_INDEX_KEY, ikm=hubKey, info=LABEL_BLIND_INDEX_FIELD+field)
        let salt = Array(CryptoLabels.LABEL_BLIND_INDEX_KEY.utf8)
        let info = Array((CryptoLabels.LABEL_BLIND_INDEX_FIELD + field).utf8)
        let fieldKey = hkdfSHA256(ikm: hubKey, salt: salt, info: info, length: 32)

        // HMAC-SHA256(fieldKey, canonicalize(value))
        let canonical = canonicalize(value)
        let canonicalBytes = Array(canonical.utf8)
        var hmac = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
        CCHmac(CCHmacAlgorithm(kCCHmacAlgSHA256), fieldKey, fieldKey.count, canonicalBytes, canonicalBytes.count, &hmac)
        return hmac.map { String(format: "%02x", $0) }.joined()
    }

    /// Canonicalize for blind indexing: lowercase, strip diacritics, trim whitespace.
    private func canonicalize(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespaces)
            .lowercased()
            .folding(options: .diacriticInsensitive, locale: .current)
    }

    /// HKDF-SHA256 extract-and-expand (RFC 5869).
    private func hkdfSHA256(ikm: [UInt8], salt: [UInt8], info: [UInt8], length: Int) -> [UInt8] {
        // Extract: PRK = HMAC-SHA256(salt, IKM)
        var prk = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
        CCHmac(CCHmacAlgorithm(kCCHmacAlgSHA256), salt, salt.count, ikm, ikm.count, &prk)

        // Expand: OKM = T(1) || T(2) || ...
        var okm: [UInt8] = []
        var t: [UInt8] = []
        var counter: UInt8 = 1
        while okm.count < length {
            var input = t + info + [counter]
            var block = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
            CCHmac(CCHmacAlgorithm(kCCHmacAlgSHA256), prk, prk.count, &input, input.count, &block)
            t = block
            okm.append(contentsOf: block)
            counter += 1
        }
        return Array(okm.prefix(length))
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
