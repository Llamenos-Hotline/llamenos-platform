import Foundation

// MARK: - Custom field UI extensions
// Custom field definitions decode to generated `CustomFieldsListResponseField`
// (GET /api/settings/custom-fields — the whole stored row, see
// `customFieldDefinitionSchema`) and are written back as generated
// `CustomFieldsBodyField` (PUT), which the server validator narrows to the
// subset of columns it accepts. Only the display helpers below are client-side.

extension CustomFieldsBodyField: Identifiable {
    public var id: String { name }

    /// Whether the field is required (wire `required` is optional on the PUT shape).
    var isRequired: Bool { fieldRequired ?? true }

    /// Definition order, defaulting to the end of the list.
    var orderOrZero: Int { order ?? 0 }
}

// `CustomFieldsListResponseField` carries the server `id` column, so it
// satisfies `Identifiable` with no client-side key.
extension CustomFieldsListResponseField: Identifiable {
    /// Whether the field is required.
    var isRequired: Bool { fieldRequired }

    /// Definition order.
    var orderOrZero: Int { Int(order) }

    /// Readable-order init for previews and tests; quicktype emits the
    /// memberwise init in alphabetical field order.
    init(name: String, label: String, type: SharedCustomFieldDefinitionType,
         required: Bool, options: [String]? = nil, order: Double = 0,
         context: SharedContext = .callNotes,
         visibleToUsers: Bool = true, editableByUsers: Bool = true,
         validation: SharedCustomFieldDefinitionValidation? = nil,
         id: String = "", createdAt: String = "",
         maxFiles: Double? = nil, maxFileSize: Double? = nil,
         allowedMimeTypes: [String]? = nil) {
        self.init(allowedMIMETypes: allowedMimeTypes, context: context,
                  createdAt: createdAt, editableByUsers: editableByUsers,
                  id: id, label: label, maxFiles: maxFiles, maxFileSize: maxFileSize,
                  name: name, options: options, order: order,
                  fieldRequired: required, type: type, validation: validation,
                  visibleToUsers: visibleToUsers)
    }

    /// The PUT-shape projection the server's `customFieldsBodySchema` accepts.
    var bodyField: CustomFieldsBodyField {
        CustomFieldsBodyField(
            context: context.rawValue, label: label, name: name,
            options: options, order: Int(order), fieldRequired: fieldRequired,
            type: type, visibleToUsers: visibleToUsers
        )
    }
}
