import Foundation

// MARK: - Custom field UI extensions
// Custom field definitions decode to generated `CustomFieldsListResponseField`
// (GET /api/settings/custom-fields) and are written back as generated
// `CustomFieldsBodyField` (PUT). Neither wire shape carries a server id — the
// client keys fields by `name`. Only the display helpers below are client-side.

extension CustomFieldsBodyField: Identifiable {
    public var id: String { name }

    /// Whether the field is required (wire `required` is optional).
    var isRequired: Bool { fieldRequired ?? true == true }

    /// Definition order, defaulting to the end of the list.
    var orderOrZero: Int { order ?? 0 }
}

extension CustomFieldsListResponseField: Identifiable {
    public var id: String { name }

    /// Whether the field is visible to volunteers (wire `visibleToUsers` is optional).
    var isVisibleToUsers: Bool { visibleToUsers ?? true }

    /// Definition order, defaulting to the end of the list.
    var orderOrZero: Double { order ?? 0 }
}
