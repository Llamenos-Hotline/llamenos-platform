import Foundation
import SwiftUI

// MARK: - UI-Only Types & Client Models
// Types with computed properties, custom Codable, or client-specific logic
// that don't exist in the generated protocol types.

// MARK: - NotePayload

/// Decrypted note content matching the protocol spec (Appendix B).
/// The plaintext JSON inside every encrypted note envelope.
struct NotePayload: Codable, Equatable, Sendable {
    /// The note body text.
    let text: String

    /// Optional custom field values keyed by field `name`.
    /// Values may be String, Int, Double, or Bool depending on the field type.
    let fields: [String: AnyCodableValue]?
}

// MARK: - DecryptedNote

/// A fully decrypted note ready for display. Combines server metadata with
/// the decrypted payload.
struct DecryptedNote: Identifiable, Sendable {
    let id: String
    let payload: NotePayload
    let authorPubkey: String
    let callId: String?
    let conversationId: String?
    let createdAt: Date
    let updatedAt: Date?

    /// Truncated preview of the note text (first 120 characters).
    var preview: String {
        let text = payload.text
        if text.count <= 120 { return text }
        return String(text.prefix(120)) + "..."
    }

    /// Truncated author pubkey for display.
    var authorDisplayName: String {
        let pk = authorPubkey
        guard pk.count > 16 else { return pk }
        return "\(pk.prefix(8))...\(pk.suffix(6))"
    }
}

// MARK: - NotesListResponse

/// API response wrapper for the paginated notes list.
struct NotesListResponse: Codable, Sendable {
    let notes: [NoteResponse]
    let total: Int
}

// MARK: - NoteDetailResponse

/// Response wrapper for `POST /api/notes` and `PATCH /api/notes/:id` — both answer
/// `201/200 { note }` (apps/worker/routes/notes.ts), not a bare note object. Local
/// like `NotesListResponse` because the schema registry has no named schema for the
/// single-note wrapper.
struct NoteDetailResponse: Decodable, Sendable {
    let note: NoteResponse
}

// MARK: - AnyCodableValue

/// Type-erased codable value for custom field values.
/// Supports String, Int, Double, and Bool — the four JSON primitive types
/// that custom fields can contain.
enum AnyCodableValue: Codable, Equatable, Sendable {
    case string(String)
    case int(Int)
    case double(Double)
    case bool(Bool)

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let boolVal = try? container.decode(Bool.self) {
            self = .bool(boolVal)
        } else if let intVal = try? container.decode(Int.self) {
            self = .int(intVal)
        } else if let doubleVal = try? container.decode(Double.self) {
            self = .double(doubleVal)
        } else if let strVal = try? container.decode(String.self) {
            self = .string(strVal)
        } else {
            throw DecodingError.typeMismatch(
                AnyCodableValue.self,
                DecodingError.Context(
                    codingPath: decoder.codingPath,
                    debugDescription: "Cannot decode AnyCodableValue"
                )
            )
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let val): try container.encode(val)
        case .int(let val): try container.encode(val)
        case .double(let val): try container.encode(val)
        case .bool(let val): try container.encode(val)
        }
    }

    /// String representation for display in the UI.
    var displayValue: String {
        switch self {
        case .string(let val): return val
        case .int(let val): return "\(val)"
        case .double(let val): return String(format: "%.2f", val)
        case .bool(let val): return val ? NSLocalizedString("yes", comment: "Yes") : NSLocalizedString("no", comment: "No")
        }
    }
}

// MARK: - NoteResponse Extensions

extension NoteResponse: Identifiable {}

extension NoteResponse {
    /// HPKE envelopes to try when decrypting this note, in trial order.
    ///
    /// #1024: the server records `authorPubkey` as the author's Ed25519 SIGNING key
    /// (`apps/worker/routes/notes.ts` sets it from the auth identity), while every
    /// envelope wraps for an X25519 ENCRYPTION key. Signing and encryption keys come
    /// from independent random seeds, so comparing `authorPubkey` against our
    /// encryption pubkey can never select the author envelope — the comparison is
    /// structurally unsatisfiable, and while it gated the author envelope, every note
    /// you wrote yourself decrypted to nothing. Authorship is proven by HPKE
    /// succeeding on the author envelope, so it is always tried first; our admin copy
    /// (selected by encryption pubkey, which IS comparable) is the fallback.
    func decryptionCandidates(encryptionPubkey: String) -> [HpkeEnvelope] {
        var candidates: [HpkeEnvelope] = []
        if let authorEnv = authorEnvelope {
            candidates.append(HpkeEnvelope(v: 3, labelId: 0, enc: authorEnv.enc, ct: authorEnv.ct))
        }
        if let adminEnvs = adminEnvelopes,
           let ourEnvelope = adminEnvs.first(where: { $0.pubkey == encryptionPubkey }) {
            candidates.append(HpkeEnvelope(v: 3, labelId: 0, enc: ourEnvelope.enc, ct: ourEnvelope.ct))
        }
        return candidates
    }
}

// MARK: - DecryptedMessage

/// A fully decrypted message ready for display in the conversation detail view.
struct DecryptedMessage: Identifiable, Sendable {
    let id: String
    let text: String
    let direction: String
    let createdAt: Date
    let isRead: Bool

    /// Whether this is an inbound message (from the contact).
    var isInbound: Bool { direction == "inbound" }

    /// Whether this is an outbound message (from the volunteer).
    var isOutbound: Bool { direction == "outbound" }

    /// Formatted time string for display alongside the message bubble.
    var timeDisplay: String {
        createdAt.formatted(date: .omitted, time: .shortened)
    }

    /// Full date+time for accessibility and long-press display.
    var fullDateDisplay: String {
        createdAt.formatted(date: .abbreviated, time: .shortened)
    }
}
