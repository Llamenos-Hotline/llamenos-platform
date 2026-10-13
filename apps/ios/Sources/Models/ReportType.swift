import Foundation

// MARK: - ClientReportTypeDefinition
// Client-only: generated `CMSReportTypeListResponseReportType` uses `TypeEnum` for category,
// `ReportTypeField` with generated sub-types, and non-optional fields where this client
// model uses optionals. Kept manual for iOS form rendering compatibility.

/// Client-side report type definition for runtime use. Named `Client*` to avoid
/// conflict with the generated `ReportTypeDefinition` from protocol codegen
/// (packages/protocol/generated/swift/Types.swift), following the same pattern
/// as `ClientReportResponse` vs `ReportResponse`.
///
/// Fetched from `GET /api/settings/cms/report-types` (full CMS definitions)
/// or `GET /api/reports/types` (legacy endpoint). Optional fields allow decoding
/// responses from both endpoints.
struct ClientReportTypeDefinition: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let name: String
    let label: String
    let labelPlural: String
    let description: String
    let icon: String?
    let color: String?
    let category: String  // always "report"
    let fields: [ClientReportFieldDefinition]
    let statuses: [StatusOption]
    let defaultStatus: String
    let allowFileAttachments: Bool
    let allowCaseConversion: Bool
    let mobileOptimized: Bool
    let isArchived: Bool

    // CMS-specific fields (present from /api/settings/cms/report-types)
    let hubId: String?
    let isSystem: Bool?
    let numberingEnabled: Bool?
    let numberPrefix: String?
    let templateId: String?
    let templateVersion: String?
    let closedStatuses: [String]?
    let createdAt: String?
    let updatedAt: String?
}

// MARK: - ClientReportFieldDefinition
// Client-only: generated `ReportTypeField` uses `JoinFieldType` enum, `FieldValue`
// for defaults, `FieldOperator` for showWhen, and `AccessLevel` enum. This client
// model uses raw strings for flexibility in form rendering.

/// Client-side field definition for runtime use. Named `Client*` to avoid
/// conflict with the generated `ReportFieldDefinition` from protocol codegen.
///
/// Drives dynamic form rendering in `TypedReportCreateView`.
struct ClientReportFieldDefinition: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let name: String
    let label: String
    let type: String  // text, textarea, number, select, multiselect, checkbox, date, file
    let required: Bool
    let options: [FieldOption]?
    let section: String?
    let helpText: String?
    let order: Int
    let accessLevel: String
    let supportAudioInput: Bool

    // Extended fields from CMS schema
    let placeholder: String?
    let defaultValue: FieldDefaultValue?
    let validation: FieldValidation?
    let showWhen: FieldShowWhen?
    let indexable: Bool?
    let indexType: String?
    let hubEditable: Bool?
    let editableByVolunteers: Bool?
    let visibleToVolunteers: Bool?
    let accessRoles: [String]?
    let templateId: String?
    let lookupId: String?

    /// Field type as a strongly-typed enum for switch exhaustivity.
    var fieldType: ReportFieldType {
        ReportFieldType(rawValue: type) ?? .text
    }

    /// Whether this field should be visible given the current form values.
    func isVisible(given fieldValues: [String: AnyCodableValue]) -> Bool {
        guard let condition = showWhen else { return true }
        let currentValue = fieldValues[condition.field]
        switch condition.`operator` {
        case "equals":
            return matchesValue(currentValue, condition.value)
        case "not_equals":
            return !matchesValue(currentValue, condition.value)
        case "is_set":
            return currentValue != nil
        case "contains":
            if case .string(let str) = currentValue,
               case .string(let target) = condition.value {
                return str.contains(target)
            }
            return false
        default:
            return true
        }
    }

    private func matchesValue(_ current: AnyCodableValue?, _ expected: FieldDefaultValue?) -> Bool {
        guard let current, let expected else { return current == nil && expected == nil }
        switch (current, expected) {
        case (.string(let a), .string(let b)): return a == b
        case (.bool(let a), .bool(let b)): return a == b
        case (.int(let a), .double(let b)): return Double(a) == b
        case (.double(let a), .double(let b)): return a == b
        default: return false
        }
    }
}

// MARK: - ReportFieldType
// Client-only: mirrors generated `JoinFieldType` but without `location` case.
// Kept as separate enum for switch exhaustivity in form rendering.

/// Supported field types for report form rendering.
enum ReportFieldType: String, Sendable {
    case text
    case textarea
    case number
    case select
    case multiselect
    case checkbox
    case date
    case file
}

// MARK: - FieldOption
// Client-only: structurally identical to many generated `*Option` types
// (IndigoOption, PurpleOption, etc.) but uses a stable, readable name
// since quicktype names change when schemas are added/removed.

/// Key-label pair for select and multiselect field options.
struct FieldOption: Codable, Equatable, Sendable {
    let key: String
    let label: String
}

// MARK: - FieldDefaultValue
// Client-only: structurally similar to generated `FieldValue` but uses a
// clean enum with associated values rather than quicktype's class-based approach.

/// Type-erased default value for a field definition. Matches the backend's
/// `defaultValue` which can be a string, number, or boolean.
enum FieldDefaultValue: Codable, Equatable, Sendable {
    case string(String)
    case double(Double)
    case bool(Bool)

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let val = try? container.decode(Bool.self) {
            self = .bool(val)
        } else if let val = try? container.decode(Double.self) {
            self = .double(val)
        } else if let val = try? container.decode(String.self) {
            self = .string(val)
        } else {
            throw DecodingError.typeMismatch(
                FieldDefaultValue.self,
                DecodingError.Context(codingPath: decoder.codingPath, debugDescription: "Cannot decode FieldDefaultValue")
            )
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let val): try container.encode(val)
        case .double(let val): try container.encode(val)
        case .bool(let val): try container.encode(val)
        }
    }
}

// MARK: - FieldValidation
// Client-only: generated `PurpleValidation` uses `Double?` for all fields.
// This uses `Double?` too, matching.

/// Validation constraints for a field definition.
struct FieldValidation: Codable, Equatable, Sendable {
    let min: Double?
    let max: Double?
    let minLength: Double?
    let maxLength: Double?
    let pattern: String?
}

// MARK: - FieldShowWhen
// Client-only: generated `PurpleShowWhen` uses `FieldOperator` enum and `FieldValue`
// for the value. This uses raw strings for the operator and `FieldDefaultValue`.

/// Conditional visibility rule for a field. The field is shown only when
/// the referenced field's value satisfies the operator/value condition.
struct FieldShowWhen: Codable, Equatable, Sendable {
    let field: String
    let `operator`: String  // equals, not_equals, is_set, contains
    let value: FieldDefaultValue?

    enum CodingKeys: String, CodingKey {
        case field
        case `operator` = "operator"
        case value
    }
}

// MARK: - StatusOption
// Typealias to generated `EnumOption` (= CaseEnumOption) — identical fields:
// {value, label, color?, icon?, order, isClosed?, isDefault?, isDeprecated?}.

typealias StatusOption = EnumOption

// MARK: - ClientReportTypesResponse

/// API response from `GET /api/reports/types` or `GET /api/settings/cms/report-types`.
struct ClientReportTypesResponse: Codable, Sendable {
    let reportTypes: [ClientReportTypeDefinition]
}

// MARK: - CreateTypedReportRequest

/// Request body for `POST /api/reports` with a report type.
/// Extends the base report creation with `reportTypeId`.
struct CreateTypedReportRequest: Encodable, Sendable {
    let title: String
    let category: String?
    let reportTypeId: String
    let encryptedContent: String
    let readerEnvelopes: [RecipientEnvelope]
}
