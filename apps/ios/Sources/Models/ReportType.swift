import Foundation

// MARK: - Report type UI extensions
// CMS report type definitions decode to generated
// `CMSReportTypeListResponseReportType` (both `GET /api/settings/cms/report-types`
// and the legacy `GET /api/reports/types` return full definitions from the same
// settings store) and their fields to generated `SharedField`
// (packages/protocol/schemas/report-types.ts). Only the display helpers below
// are client-side.

extension CMSReportTypeListResponseReportType: Identifiable {}

extension CMSReportTypeListResponseReportType {
    /// Convenience init matching the old client report-type argument shapes
    /// (used by previews); maps onto the generated memberwise init.
    init(id: String, name: String, label: String, labelPlural: String,
         description: String, icon: String?, color: String?, category: String,
         fields: [SharedField], statuses: [SharedStatus], defaultStatus: String,
         allowFileAttachments: Bool, allowCaseConversion: Bool,
         mobileOptimized: Bool, isArchived: Bool,
         hubId: String?, isSystem: Bool?, numberingEnabled: Bool?,
         numberPrefix: String?, templateId: String?, templateVersion: String?,
         closedStatuses: [String]?, createdAt: String?, updatedAt: String?) {
        self.init(allowCaseConversion: allowCaseConversion,
                  allowFileAttachments: allowFileAttachments,
                  category: ReportTypeCategory(rawValue: category) ?? .report,
                  closedStatuses: closedStatuses ?? [], color: color,
                  createdAt: createdAt ?? "", defaultStatus: defaultStatus,
                  description: description, fields: fields, hubID: hubId ?? "",
                  icon: icon, id: id, isArchived: isArchived,
                  isSystem: isSystem ?? false, label: label, labelPlural: labelPlural,
                  mobileOptimized: mobileOptimized, name: name,
                  numberingEnabled: numberingEnabled ?? false,
                  numberPrefix: numberPrefix, statuses: statuses,
                  templateID: templateId, templateVersion: templateVersion,
                  updatedAt: updatedAt ?? "")
    }
}

extension SharedFieldShowWhen {
    /// Convenience init matching the old client `FieldShowWhen` argument shape.
    init(field: String, operator: String, value: FieldValue?) {
        self.init(field: field,
                  showWhenOperator: SharedOperator(rawValue: `operator`) ?? .equals,
                  value: value)
    }
}

extension CMSReportTypeListResponseReportType: Equatable {
    public static func == (lhs: CMSReportTypeListResponseReportType, rhs: CMSReportTypeListResponseReportType) -> Bool {
        lhs.id == rhs.id
    }
}

extension SharedField: Identifiable {}

extension SharedField {
    /// Convenience init matching the old client field-definition argument
    /// shapes (used by previews); maps onto the generated memberwise init.
    init(id: String, name: String, label: String, type: String,
         required: Bool, options: [SharedFieldOption]?,
         section: String?, helpText: String?, order: Int,
         accessLevel: String, supportAudioInput: Bool,
         placeholder: String?, defaultValue: FieldValue?,
         validation: SharedFieldValidation?, showWhen: SharedFieldShowWhen?,
         indexable: Bool?, indexType: String?, hubEditable: Bool?,
         editableByUsers: Bool? = nil, visibleToUsers: Bool? = nil,
         accessRoles: [String]?, templateId: String?, lookupId: String?) {
        self.init(accessLevel: SharedAccessLevel(rawValue: accessLevel) ?? .all,
                  accessRoles: accessRoles, createdAt: nil, defaultValue: defaultValue,
                  editableByUsers: editableByUsers ?? true, helpText: helpText,
                  hubEditable: hubEditable ?? false, id: id,
                  indexable: indexable ?? false,
                  indexType: SharedIndexType(rawValue: indexType ?? "none") ?? .none,
                  label: label, locationOptions: nil, lookupID: lookupId, name: name,
                  options: options, order: order, placeholder: placeholder,
                  sharedFielRequired: required, section: section, showWhen: showWhen,
                  supportAudioInput: supportAudioInput, templateID: templateId,
                  type: SharedType(rawValue: type) ?? .text, validation: validation,
                  visibleToUsers: visibleToUsers ?? true)
    }

    /// Wire `required` (quicktype-renamed `sharedFielRequired`).
    var required: Bool { sharedFielRequired }

    /// Field type as a strongly-typed enum for switch exhaustivity (same raw
    /// values as generated `SharedType`, minus `location` which renders as text).
    var fieldType: ReportFieldType {
        ReportFieldType(rawValue: type.rawValue) ?? .text
    }

    /// Whether this field should be visible given the current form values.
    func isVisible(given fieldValues: [String: AnyCodableValue]) -> Bool {
        guard let condition = showWhen else { return true }
        let currentValue = fieldValues[condition.field]
        switch condition.showWhenOperator {
        case .equals:
            return matchesValue(currentValue, condition.value)
        case .notEquals:
            return !matchesValue(currentValue, condition.value)
        case .isSet:
            return currentValue != nil
        case .contains:
            if case .string(let str) = currentValue,
               case .string(let target) = condition.value {
                return str.contains(target)
            }
            return false
        }
    }

    private func matchesValue(_ current: AnyCodableValue?, _ expected: FieldValue?) -> Bool {
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
// Client display enum (same raw values as generated `SharedType`, minus `location`).

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

// MARK: - StatusOption
// Typealias to generated `EnumOption` — identical fields:
// {value, label, color?, icon?, order, isClosed?, isDefault?, isDeprecated?}.

typealias StatusOption = EnumOption

// MARK: - Request Bodies
// Typed report creation uses the generated `CreateReportBody`. It is encoded
// with a plain JSONEncoder and sent via `APIService.request(method:path:rawBody:)`
// because APIService's shared encoder applies convertToSnakeCase, which would
// mangle the camelCase wire keys (`reportTypeId`, `encryptedContent`,
// `readerEnvelopes`) declared in the schema.
