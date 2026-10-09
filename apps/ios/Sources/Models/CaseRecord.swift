import Foundation

// MARK: - CaseRecord
// Client-only: generated `RecordListResponseRecord` uses `Double` for counts,
// `BlindIndex` enum for blind indexes, and quicktype envelope names. This client
// model uses `Int` for counts and `String` for identifiers.

/// A case record from the CMS — an encrypted, structured entity stored in CaseDO.
/// Summary tier is decryptable by assigned volunteers; fields/PII by admins only.
struct CaseRecord: Codable, Identifiable, Sendable {
    let id: String
    let hubId: String?
    let entityTypeId: String
    let caseNumber: String?
    let statusHash: String
    let severityHash: String?
    let categoryHash: String?
    let assignedTo: [String]
    let blindIndexes: [String: String]?
    let encryptedSummary: String?
    let summaryEnvelopes: [CaseEnvelope]?
    let encryptedFields: String?
    let fieldEnvelopes: [CaseEnvelope]?
    let encryptedPII: String?
    let piiEnvelopes: [CaseEnvelope]?
    let contactCount: Int?
    let interactionCount: Int?
    let fileCount: Int?
    let reportCount: Int?
    let eventIds: [String]?
    let reportIds: [String]?
    let parentRecordId: String?
    let createdAt: String
    let updatedAt: String
    let closedAt: String?
    let createdBy: String?
}

// MARK: - CaseEnvelope
// Typealias to generated `RecipientEnvelope` — both have identical shape: {ct, enc, pubkey}.
// Many generated envelope types (PurpleFieldEnvelope, StickyPiiEnvelope, EventDetailEnvelope,
// etc.) share this shape; we use one canonical name for all case-related envelopes.

typealias CaseEnvelope = RecipientEnvelope

// MARK: - CaseEnumOption
// Typealias to generated `EnumOption` — identical fields:
// {value, label, color?, icon?, order, isClosed?, isDefault?, isDeprecated?}.
// Used for statuses, severities, categories, and contact roles in entity type definitions.

typealias CaseEnumOption = EnumOption

extension EnumOption: Identifiable {
    public var id: String { value }
}

extension EnumOption: Equatable {
    public static func == (lhs: EnumOption, rhs: EnumOption) -> Bool {
        lhs.value == rhs.value && lhs.label == rhs.label
    }
}

extension EnumOption {
    /// Convenience init matching the old `CaseEnumOption` / `StatusOption` argument order.
    init(value: String, label: String, color: String? = nil, icon: String? = nil,
         order: Int = 0, isDefault: Bool? = nil, isClosed: Bool? = nil, isDeprecated: Bool? = nil) {
        self.init(color: color, icon: icon, isClosed: isClosed, isDefault: isDefault,
                  isDeprecated: isDeprecated, label: label, order: order, value: value)
    }
}

// MARK: - EntityTypeDefinition
// Client-only: generated `EntityTypeDefinition` uses typed enums for `category`,
// `defaultAccessLevel`, non-optional booleans, `hubID` (CodingKey renamed), and
// `EntityTypeDefinitionField` sub-types. This client model has iOS-specific optionality
// and uses `CaseEnumOption` (= EnumOption) for all option arrays.

/// Template-driven schema defining a case type: fields, statuses, severities, numbering.
struct CaseEntityTypeDefinition: Codable, Identifiable, Sendable {
    let id: String
    let hubId: String?
    let name: String
    let label: String
    let labelPlural: String
    let description: String?
    let icon: String?
    let color: String?
    let category: String?
    let templateId: String?
    let templateVersion: String?
    let fields: [CaseFieldDefinition]
    let statuses: [CaseEnumOption]
    let defaultStatus: String
    let closedStatuses: [String]?
    let severities: [CaseEnumOption]?
    let defaultSeverity: String?
    let categories: [CaseEnumOption]?
    let contactRoles: [CaseEnumOption]?
    let numberPrefix: String?
    let numberingEnabled: Bool?
    let defaultAccessLevel: String?
    let piiFields: [String]?
    let allowSubRecords: Bool?
    let allowFileAttachments: Bool?
    let allowInteractionLinks: Bool?
    let showInNavigation: Bool?
    let showInDashboard: Bool?
    let accessRoles: [String]?
    let editRoles: [String]?
    let isArchived: Bool?
    let isSystem: Bool?
    let createdAt: String?
    let updatedAt: String?
}

// MARK: - CaseFieldDefinition
// Client-only: generated `EntityTypeDefinitionField` uses `JoinFieldType` enum
// and different optionality patterns.

/// A field within an entity type schema.
struct CaseFieldDefinition: Codable, Identifiable, Sendable {
    let id: String
    let name: String
    let label: String
    let type: String
    let required: Bool?
    let options: [CaseFieldOption]?
    let lookupId: String?
    let validation: CaseFieldValidation?
    let section: String?
    let helpText: String?
    let placeholder: String?
    let defaultValue: String?
    let order: Int?
    let indexable: Bool?
    let indexType: String?
    let accessLevel: String?
    let accessRoles: [String]?
    let visibleToVolunteers: Bool?
    let editableByVolunteers: Bool?
    let templateId: String?
    let hubEditable: Bool?

    var fieldType: CaseFieldType {
        CaseFieldType(rawValue: type) ?? .text
    }
}

/// Field type enum matching the protocol field types.
enum CaseFieldType: String, Sendable {
    case text, textarea, number, select, multiselect, checkbox, date, file
}

/// Key-label option for select/multiselect fields.
struct CaseFieldOption: Codable, Sendable {
    let key: String
    let label: String
}

/// Validation constraints for a field.
struct CaseFieldValidation: Codable, Sendable {
    let minLength: Int?
    let maxLength: Int?
    let min: Int?
    let max: Int?
    let pattern: String?
}

// MARK: - Generated type extensions
// CaseInteraction, Interaction, Evidence, and RecordContact are defined
// in the generated Types.swift (protocol codegen).

extension CaseInteraction: Identifiable {}
extension Interaction: Identifiable {}
extension Evidence: Identifiable {}

extension RecordContact: Identifiable {
    public var id: String { contactID }

    /// Convenience alias matching the JSON key name used in view code.
    var contactId: String { contactID }
}

// MARK: - EvidenceItem
// Client-only: generated `Evidence` uses typed enums (`SharedClassification`,
// `HashAlgorithm`) while this client model uses raw strings for flexibility.

/// Evidence metadata for a file attached to a case.
struct EvidenceItem: Codable, Identifiable, Sendable {
    let id: String
    let caseId: String
    let fileId: String
    let filename: String
    let mimeType: String
    let sizeBytes: Int?
    let classification: String
    let integrityHash: String
    let hashAlgorithm: String?
    let source: String?
    let sourceDescription: String?
    let encryptedDescription: String?
    let descriptionEnvelopes: [CaseEnvelope]?
    let uploadedAt: String
    let uploadedBy: String?
    let custodyEntryCount: Int?
}

// MARK: - API Response Wrappers

struct RecordsListResponse: Codable, Sendable {
    let records: [CaseRecord]
    let total: Int
    let page: Int?
    let limit: Int?
    let hasMore: Bool?
}

struct EntityTypesResponse: Codable, Sendable {
    let entityTypes: [CaseEntityTypeDefinition]
}

// InteractionsResponse and EvidenceListResponse are defined in generated Types.swift.

/// The contacts route serializes raw `case_contacts` rows: the record key is
/// `caseId` rather than the `recordId` that `recordContactListResponseSchema`
/// (and the generated `RecordContact`) declares, and the `role` column is
/// nullable while the schema requires a string. Strict decoding of a non-empty
/// list therefore throws and callers fall back to an empty list, so a case
/// with linked contacts rendered the empty state (#1246). Accept both key
/// spellings and a null role until the route is aligned with the schema.
struct RecordContactsResponse: Decodable, Sendable {
    let contacts: [RecordContact]

    private enum CodingKeys: String, CodingKey {
        case contacts
    }

    private enum ContactRowKeys: String, CodingKey {
        case recordId, caseId, contactId, role, addedAt, addedBy
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        var rows = try container.nestedUnkeyedContainer(forKey: .contacts)
        var decoded: [RecordContact] = []
        while !rows.isAtEnd {
            let row = try rows.nestedContainer(keyedBy: ContactRowKeys.self)
            let recordId = try row.decodeIfPresent(String.self, forKey: .recordId)
                ?? row.decodeIfPresent(String.self, forKey: .caseId)
                ?? ""
            decoded.append(RecordContact(
                addedAt: try row.decode(String.self, forKey: .addedAt),
                addedBy: try row.decode(String.self, forKey: .addedBy),
                contactID: try row.decode(String.self, forKey: .contactId),
                recordID: recordId,
                role: try row.decodeIfPresent(String.self, forKey: .role) ?? ""
            ))
        }
        contacts = decoded
    }
}

struct CaseManagementEnabledResponse: Codable, Sendable {
    let enabled: Bool
}

// MARK: - Request Bodies

struct UpdateRecordRequest: Codable, Sendable {
    let statusHash: String?
    let severityHash: String?
}

struct AssignRecordRequest: Codable, Sendable {
    let pubkeys: [String]
}

struct CreateInteractionRequest: Codable, Sendable {
    let interactionType: String
    let encryptedContent: String?
    let contentEnvelopes: [CaseEnvelope]?
    let interactionTypeHash: String
}
