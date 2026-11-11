import Foundation

/// Who a case record's ciphertexts are sealed to, per tier (#1682).
///
/// This is the iOS half of the contract `src/client/lib/record-recipients.ts`
/// states for desktop; the two must not drift:
///
/// | payload                      | tier      | because                                   |
/// |------------------------------|-----------|-------------------------------------------|
/// | record summary               | `summary` | every member who may see the case exists  |
/// | custom field values          | `fields`  | assignees + admins + `editRoles` holders  |
/// | contact PII                  | `pii`     | admins + `contacts:view-pii` holders      |
///
/// The tiers are computed by the server from permissions and `editRoles` slugs
/// (`apps/worker/lib/envelope-recipients.ts`); nothing here names a role.
/// Before this type existed every create path built `[own device key] + admin`,
/// so a record stored, acknowledged and rendered to its author while the
/// `editRoles` holder or assignee who had to work it could not open it.
struct RecordReaders: Equatable, Sendable {
    let summary: [String]
    let fields: [String]
    let pii: [String]
}

/// There is no admin who could read what is about to be written.
///
/// The same refusal notes make (#1468): an envelope set with no admin reader
/// stores and renders to its author and no admin can ever open it. The caller
/// keeps the user's input on screen and says why; it never substitutes a key.
enum RecordReadersError: LocalizedError, Equatable {
    case noAdminReader

    var errorDescription: String? {
        NSLocalizedString("cases_no_admin_recipient", comment: "No admin decryption key is configured")
    }
}

enum RecordReaderSet {

    /// The admin decryption key as an HPKE recipient, or nil when the
    /// deployment has none or it is not a 64-hex key.
    static func adminRecipient(_ hex: String?) -> String? {
        guard let trimmed = hex?.trimmingCharacters(in: .whitespaces).lowercased(),
              isHex64(trimmed) else { return nil }
        return trimmed
    }

    /// Author + the server's tier + the admin recipient, in that order.
    ///
    /// `serverTiers == nil` is a failed lookup and not an error: it is advice
    /// about who ELSE may read, and a crisis hotline cannot fail to record a
    /// call because an HTTP request for it failed. The author keeps their own
    /// envelope and the admin keeps theirs; what the fallback never does is
    /// name some other key to stand in — a made-up reader is an envelope
    /// nobody can open (#1021).
    ///
    /// Throws ``RecordReadersError/noAdminReader`` without an admin recipient.
    /// Server entries that are not 64-hex are dropped, not repaired.
    static func compose(
        serverTiers: EnvelopeRecipientsResponse?,
        author: String,
        adminDecryptionPubkey: String?
    ) throws -> RecordReaders {
        guard let admin = adminRecipient(adminDecryptionPubkey) else {
            throw RecordReadersError.noAdminReader
        }
        func tier(_ server: [String]?) -> [String] {
            var seen = Set<String>()
            var out: [String] = []
            for key in [author] + (server ?? []).filter({ isHex64($0.lowercased()) }) + [admin] {
                if seen.insert(key.lowercased()).inserted { out.append(key) }
            }
            return out
        }
        return RecordReaders(
            summary: tier(serverTiers?.summary),
            fields: tier(serverTiers?.fields),
            pii: tier(serverTiers?.pii)
        )
    }

    /// Readers of a record that does not exist yet.
    ///
    /// `lookup` asks `GET /api/records/envelope-recipients?entityTypeId=&assignedTo=`
    /// with the intended assignees' account keys. The admin check runs before
    /// the request: with no admin recipient the write is refused without
    /// spending a round trip.
    static func creationReaders(
        author: String,
        adminDecryptionPubkey: String?,
        lookup: () async throws -> EnvelopeRecipientsResponse
    ) async throws -> RecordReaders {
        _ = try compose(serverTiers: nil, author: author, adminDecryptionPubkey: adminDecryptionPubkey)
        let tiers = try? await lookup()
        return try compose(serverTiers: tiers, author: author, adminDecryptionPubkey: adminDecryptionPubkey)
    }

    /// The hub-scoped request for the by-entity-type variant.
    static func lookupCreationTiers(
        apiService: APIService,
        entityTypeId: String,
        assignedTo: [String]
    ) async throws -> EnvelopeRecipientsResponse {
        var path = try apiService.activeHubPath("/api/records/envelope-recipients") + "?entityTypeId=\(entityTypeId)"
        if !assignedTo.isEmpty { path += "&assignedTo=\(assignedTo.joined(separator: ","))" }
        return try await apiService.request(method: "GET", path: path)
    }

    private static func isHex64(_ s: String) -> Bool {
        s.utf8.count == 64 && s.utf8.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) }
    }
}
