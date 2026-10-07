import Foundation

// MARK: - CaseEnvelope
// Typealias to generated `RecipientEnvelope` — both have identical shape: {ct, enc, pubkey}.
// Many generated envelope types (PurpleFieldEnvelope, StickyPiiEnvelope, EventDetailEnvelope,
// etc.) share this shape; we use one canonical name for all case-related envelopes.

typealias CaseEnvelope = RecipientEnvelope

// MARK: - SharedStatus (generated)
// The entity type definition schema's enum option shape ({value, label, color?,
// icon?, order, isClosed?, isDefault?, isDeprecated?}) is generated as
// `SharedStatus` and used for statuses, severities, categories and contact roles.
// Only the UI conveniences below are client-side.

extension SharedStatus: Identifiable {
    public var id: String { value }
}

extension SharedStatus: Equatable {
    public static func == (lhs: SharedStatus, rhs: SharedStatus) -> Bool {
        lhs.value == rhs.value && lhs.label == rhs.label
    }
}

extension SharedStatus {
    /// Readable-order init for previews and tests; quicktype emits the
    /// memberwise init in alphabetical field order.
    init(value: String, label: String, color: String? = nil, icon: String? = nil,
         order: Int = 0, isDefault: Bool? = nil, isClosed: Bool? = nil, isDeprecated: Bool? = nil) {
        self.init(color: color, icon: icon, isClosed: isClosed, isDefault: isDefault,
                  isDeprecated: isDeprecated, label: label, order: order, value: value)
    }
}

// The report-types schema generates the structurally identical `EnumOption`
// (aliased as `StatusOption` in ReportType.swift); keep its UI conveniences here.

extension EnumOption: Identifiable {
    public var id: String { value }
}

extension EnumOption: Equatable {
    public static func == (lhs: EnumOption, rhs: EnumOption) -> Bool {
        lhs.value == rhs.value && lhs.label == rhs.label
    }
}

extension EnumOption {
    /// Convenience init matching the old `StatusOption` argument order.
    init(value: String, label: String, color: String? = nil, icon: String? = nil,
         order: Int = 0, isDefault: Bool? = nil, isClosed: Bool? = nil, isDeprecated: Bool? = nil) {
        self.init(color: color, icon: icon, isClosed: isClosed, isDefault: isDefault,
                  isDeprecated: isDeprecated, label: label, order: order, value: value)
    }
}

// MARK: - Entity type UI extensions
// Entity type lists decode to generated `EntityTypeListResponse` whose elements
// are generated `EntityType` (packages/protocol/schemas/entity-schema.ts; the
// item schema generates the structurally identical `EntityTypeDefinition`).
// Only the display helpers below are client-side.

extension EntityType: Identifiable {}

extension SharedEntityTypeDefinitionField: Identifiable {}

extension SharedEntityTypeDefinitionField {
    /// Field type mapped onto the client's display enum (same raw values as
    /// generated `SharedType`, minus `location` which renders as text).
    var fieldType: CaseFieldType {
        CaseFieldType(rawValue: type.rawValue) ?? .text
    }

    /// Convenience init for previews — accepts the client-era argument shapes
    /// and maps them onto the generated memberwise init.
    init(id: String, name: String, label: String, type: String,
         required: Bool?, options: [SharedEntityTypeDefinitionFieldOption]?,
         lookupId: String?, validation: SharedEntityTypeDefinitionFieldValidation?,
         section: String?, helpText: String?, placeholder: String?,
         defaultValue: FieldValue?, order: Int, indexable: Bool, indexType: String?,
         accessLevel: String, accessRoles: [String]?, visibleToUsers: Bool,
         editableByUsers: Bool, templateId: String?, hubEditable: Bool?) {
        self.init(accessLevel: SharedAccessLevel(rawValue: accessLevel) ?? .all,
                  accessRoles: accessRoles, createdAt: nil, defaultValue: defaultValue,
                  editableByUsers: editableByUsers, helpText: helpText,
                  hubEditable: hubEditable ?? false, id: id, indexable: indexable,
                  indexType: SharedIndexType(rawValue: indexType ?? "none") ?? .none,
                  label: label, locationOptions: nil, lookupID: lookupId, name: name,
                  options: options, order: order, placeholder: placeholder,
                  sharedEntityTypeDefinitionFielRequired: required ?? false,
                  section: section, showWhen: nil, templateID: templateId,
                  type: SharedType(rawValue: type) ?? .text, validation: validation,
                  visibleToUsers: visibleToUsers)
    }
}

extension EntityType {
    /// Convenience init for previews — accepts the client-era argument shapes
    /// and maps them onto the generated memberwise init, defaulting the
    /// assignment-intelligence fields the client doesn't model.
    init(id: String, name: String, label: String, labelPlural: String, description: String,
         icon: String?, color: String?, category: String,
         templateId: String?, templateVersion: String?,
         fields: [SharedEntityTypeDefinitionField],
         statuses: [SharedStatus], defaultStatus: String, closedStatuses: [String],
         severities: [SharedStatus]?, defaultSeverity: String?,
         categories: [SharedStatus]?, contactRoles: [SharedStatus]?,
         numberPrefix: String?, numberingEnabled: Bool,
         defaultAccessLevel: String, piiFields: [String]?,
         allowSubRecords: Bool, allowFileAttachments: Bool, allowInteractionLinks: Bool,
         showInNavigation: Bool, showInDashboard: Bool,
         accessRoles: [String]?, editRoles: [String]?,
         isArchived: Bool, isSystem: Bool, createdAt: String, updatedAt: String) {
        self.init(accessRoles: accessRoles, allowFileAttachments: allowFileAttachments,
                  allowInteractionLinks: allowInteractionLinks, allowSubRecords: allowSubRecords,
                  autoAssign: false, autoAssignThreshold: 30, categories: categories,
                  category: SharedEntityTypeDefinitionCategory(rawValue: category) ?? .categoryCase,
                  closedStatuses: closedStatuses, color: color, contactRoles: contactRoles,
                  createdAt: createdAt,
                  defaultAccessLevel: SharedDefaultAccessLevel(rawValue: defaultAccessLevel) ?? .assigned,
                  defaultDisplayType: nil, defaultSeverity: defaultSeverity, defaultStatus: defaultStatus,
                  description: description, displayTypes: nil, editRoles: editRoles, fields: fields,
                  hubID: "", icon: icon, id: id, isArchived: isArchived, isSystem: isSystem,
                  label: label, labelPlural: labelPlural, name: name,
                  notifyContactsOnStatusChange: false, numberingEnabled: numberingEnabled,
                  numberPrefix: numberPrefix, piiFields: piiFields ?? [],
                  requiredSpecializations: [], severities: severities,
                  showInDashboard: showInDashboard, showInNavigation: showInNavigation,
                  statuses: statuses, templateID: templateId, templateVersion: templateVersion,
                  updatedAt: updatedAt)
    }
}

/// Field type enum matching the protocol field types.
enum CaseFieldType: String, Sendable {
    case text, textarea, number, select, multiselect, checkbox, date, file
}

// MARK: - Generated type extensions
// CaseInteraction, Interaction, Evidence, and RecordContact are defined
// in the generated Types.swift (protocol codegen).

extension CaseInteraction: Identifiable {}
extension Interaction: Identifiable {}
extension Evidence: Identifiable {}

extension SharedRecordListResponseRecord: Identifiable {}

extension RecordContact: Identifiable {
    public var id: String { contactID }

    /// Convenience alias matching the JSON key name used in view code.
    var contactId: String { contactID }
}

// MARK: - API Response Wrappers

// Record/evidence/interaction list responses decode directly to the generated
// types: `RecordListResponse`, `EvidenceListResponse`, `InteractionsResponse`.
// Entity type lists decode to generated `EntityTypeListResponse`.

struct RecordContactsResponse: Codable, Sendable {
    let contacts: [RecordContact]
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
