import Foundation

/// Who a free-text shift field is sealed to (#2777, #2778), and how a sealed
/// field reads on this device.
///
/// | field                  | readers (besides this device, which Rust always adds) |
/// |------------------------|--------------------------------------------------------|
/// | availability reason    | the hub's `admin` reader set                           |
/// | override note          | `admin` + `shift-overrides` (`shifts:manage-overrides`) |
///
/// The availability list route is gated on `shifts:manage`, which no catalogue
/// role grants by name — only a `shifts:*` or `*` wildcard does, i.e. the hub's
/// admins — so the `admin` set is exactly who can already list reasons. A
/// volunteer's reason is never sealed to every hub member.
///
/// The sets come from `GET /api/hubs/:hubId/readers?purpose=` (PROTOCOL §2.4.2):
/// the server alone decides which permissions make a reader, and nothing here
/// names a role or the instance-wide admin key.
enum ShiftFieldReaders {

    /// Reader keys for `purpose` in the active hub. Throws
    /// ``ShiftFieldReadersError/noAdminReader`` when the hub has no admin with a
    /// registered device and no escrow key: the text would be stored where no
    /// admin can ever read it, which the server refuses too.
    static func readers(for purpose: ShiftFieldPurpose, apiService: APIService) async throws -> [String] {
        let admin = try await recipients(.admin, apiService: apiService)
        switch purpose {
        case .availabilityReason:
            return try compose(admin: admin, others: [])
        case .overrideNote:
            return try compose(admin: admin, others: try await recipients(.shiftOverrides, apiService: apiService))
        }
    }

    /// Admin readers first, then the purpose's own readers; lowercase,
    /// deduplicated, non-64-hex entries dropped rather than repaired.
    static func compose(admin: [String], others: [String]) throws -> [String] {
        let admins: [String]
        do {
            admins = try HubAdminReaders.admins(from: admin)
        } catch RecordReadersError.noAdminReader {
            throw ShiftFieldReadersError.noAdminReader
        }
        var seen = Set<String>()
        return (admins + normalise(others)).filter { seen.insert($0).inserted }
    }

    private static func recipients(_ purpose: ReaderPurpose, apiService: APIService) async throws -> [String] {
        let response: HubReadersResponse = try await apiService.request(
            method: "GET",
            path: try apiService.activeHubPath("/api/readers?purpose=\(purpose.rawValue)")
        )
        return response.recipients
    }

    private static func normalise(_ keys: [String]) -> [String] {
        keys.map { $0.lowercased() }.filter { key in
            key.utf8.count == 64 && key.utf8.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) }
        }
    }
}

/// No admin of the hub could read what is about to be written. The caller keeps
/// the user's input on screen and says why; it never substitutes another key.
enum ShiftFieldReadersError: LocalizedError, Equatable {
    case noAdminReader

    var errorDescription: String? {
        NSLocalizedString("shifts_no_admin_reader", comment: "No admin of this hub could read this text")
    }
}

/// A sealed shift field as this device can show it.
enum OpenedShiftField: Equatable, Sendable {
    /// The text the author typed.
    case text(String)
    /// Present, but this device holds no envelope for it (or it does not open).
    case unreadable

    /// Open `sealed` as `purpose`; `nil` when there is no field at all.
    static func open(_ sealed: SealedShiftField?, as purpose: ShiftFieldPurpose, with crypto: CryptoService) -> OpenedShiftField? {
        guard let sealed else { return nil }
        guard let text = try? crypto.openShiftField(purpose: purpose, sealed: sealed) else { return .unreadable }
        return text.isEmpty ? nil : .text(text)
    }

    /// What a row renders for this field.
    var displayText: String {
        switch self {
        case .text(let text): return text
        case .unreadable: return NSLocalizedString("cases_encrypted_content", comment: "Encrypted content")
        }
    }
}
