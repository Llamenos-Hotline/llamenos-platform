import Foundation
import SwiftUI

// MARK: - UI-Only Types & Client Models
// Types with computed properties, custom Codable, or client-specific logic
// that don't exist in the generated protocol types.

// MARK: - NotePayload

/// Decrypted note content matching the protocol spec (Appendix B).
/// The plaintext JSON inside every encrypted note envelope.
///
/// Encode and decode it with no key strategy: `fields` is keyed by custom field
/// `name`, which may contain underscores, and desktop and Android read those keys
/// verbatim.
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

// MARK: - DecryptedMessage

/// A fully decrypted message ready for display in the conversation detail view.
struct DecryptedMessage: Identifiable, Sendable {
    let id: String
    let text: String
    let direction: String
    let channelType: String
    let createdAt: Date
    let isRead: Bool

    /// Whether this is an inbound message (from the contact).
    var isInbound: Bool { direction == "inbound" }

    /// Whether this is an outbound message (from the volunteer).
    var isOutbound: Bool { direction == "outbound" }

    /// Parsed channel type.
    var channel: ClientChannelType {
        ClientChannelType(rawValue: channelType) ?? .sms
    }

    /// Formatted time string for display alongside the message bubble.
    var timeDisplay: String {
        createdAt.formatted(date: .omitted, time: .shortened)
    }

    /// Full date+time for accessibility and long-press display.
    var fullDateDisplay: String {
        createdAt.formatted(date: .abbreviated, time: .shortened)
    }
}
