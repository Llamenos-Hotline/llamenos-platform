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
        NSLocalizedString("shifts_no_admin_reader", comment: "No admin of this hub could read this text")
    }
}

enum RecordReaderSet {

    /// Author + the server's tier + the hub's admin readers, in that order.
    ///
    /// `adminReaders` is the hub's admin set exactly as ``HubAdminReaders`` resolved
    /// it (the crate's rule, #1035) — every admin, never one key.
    ///
    /// `serverTiers == nil` is a failed lookup and not an error: it is advice
    /// about who ELSE may read, and a crisis hotline cannot fail to record a
    /// call because an HTTP request for it failed. The author keeps their own
    /// envelope and every admin keeps theirs; what the fallback never does is
    /// name some other key to stand in — a made-up reader is an envelope
    /// nobody can open (#1021).
    ///
    /// Throws ``RecordReadersError/noAdminReader`` when `adminReaders` is empty.
    /// Server entries that are not 64-hex are dropped, not repaired.
    static func compose(
        serverTiers: EnvelopeRecipientsResponse?,
        author: String,
        adminReaders: [String]
    ) throws -> RecordReaders {
        guard !adminReaders.isEmpty else { throw RecordReadersError.noAdminReader }
        func tier(_ server: [String]?) -> [String] {
            var seen = Set<String>()
            var out: [String] = []
            for key in [author] + (server ?? []).map({ $0.lowercased() }).filter(isHex64) + adminReaders {
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
    /// `adminReaders` resolves the hub's admin set and `lookup` asks
    /// `GET /api/records/envelope-recipients?entityTypeId=&assignedTo=` with the
    /// intended assignees' account keys. The admin set is resolved first: with no
    /// admin reader the write is refused without spending the second round trip.
    static func creationReaders(
        author: String,
        adminReaders: () async throws -> [String],
        lookup: () async throws -> EnvelopeRecipientsResponse
    ) async throws -> RecordReaders {
        let admins = try await adminReaders()
        _ = try compose(serverTiers: nil, author: author, adminReaders: admins)
        let tiers = try? await lookup()
        return try compose(serverTiers: tiers, author: author, adminReaders: admins)
    }

    /// Readers of a record that ALREADY exists, for a write that replaces one of its tiers.
    ///
    /// Unlike ``creationReaders(author:adminReaders:lookup:)`` a failed lookup is an error, not
    /// a fallback. A re-seal REPLACES the envelope set, so sealing to the author and the admins
    /// alone would silently drop every assignee and `editRoles` holder the record already had
    /// (#1682): the write would succeed and those volunteers could no longer open the case.
    static func existingRecordReaders(
        author: String,
        adminReaders: () async throws -> [String],
        lookup: () async throws -> EnvelopeRecipientsResponse
    ) async throws -> RecordReaders {
        let admins = try await adminReaders()
        let tiers = try await lookup()
        return try compose(serverTiers: tiers, author: author, adminReaders: admins)
    }

    /// The hub-scoped request for an EXISTING record's tiers: who may already read it, so a
    /// re-seal (a status change replaces the summary) keeps every co-assignee a reader.
    static func lookupRecordTiers(
        apiService: APIService,
        recordId: String
    ) async throws -> EnvelopeRecipientsResponse {
        try await apiService.request(
            method: "GET",
            path: try apiService.activeHubPath("/api/records/\(recordId)/envelope-recipients")
        )
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
