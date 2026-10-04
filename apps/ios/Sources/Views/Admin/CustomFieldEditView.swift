import SwiftUI

// MARK: - CustomFieldEditView

struct CustomFieldEditView: View {
    @Environment(\.dismiss) private var dismiss

    let field: CustomFieldsBodyField?
    let existingCount: Int
    let onSave: (CustomFieldsBodyField) async -> Void

    @State private var label: String = ""
    @State private var fieldType: SharedCustomFieldDefinitionType = .text
    @State private var context: String = "call-notes"
    @State private var isRequired: Bool = false
    @State private var visibleToVolunteers: Bool = true
    @State private var options: [String] = []
    @State private var newOption: String = ""
    @State private var isSaving = false

    private var isEditing: Bool { field != nil }

    private var isFormValid: Bool {
        !label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var showsOptions: Bool {
        fieldType == .select
    }

    var body: some View {
        NavigationStack {
            Form {
                // Label
                Section {
                    TextField(
                        NSLocalizedString("field_label_placeholder", comment: "Field label"),
                        text: $label
                    )
                    .accessibilityIdentifier("field-label-input")
                }

                // Type
                Section {
                    Picker(
                        NSLocalizedString("field_type", comment: "Type"),
                        selection: $fieldType
                    ) {
                        Text(NSLocalizedString("field_type_text", comment: "Text")).tag(SharedCustomFieldDefinitionType.text)
                        Text(NSLocalizedString("field_type_number", comment: "Number")).tag(SharedCustomFieldDefinitionType.number)
                        Text(NSLocalizedString("field_type_select", comment: "Select")).tag(SharedCustomFieldDefinitionType.select)
                        Text(NSLocalizedString("field_type_checkbox", comment: "Checkbox")).tag(SharedCustomFieldDefinitionType.checkbox)
                        Text(NSLocalizedString("field_type_textarea", comment: "Text Area")).tag(SharedCustomFieldDefinitionType.textarea)
                    }
                    .accessibilityIdentifier("field-type-picker")
                }

                // Context
                Section {
                    Picker(
                        NSLocalizedString("field_context", comment: "Context"),
                        selection: $context
                    ) {
                        Text(NSLocalizedString("field_context_notes", comment: "Notes")).tag("call-notes")
                        Text(NSLocalizedString("field_context_reports", comment: "Reports")).tag("reports")
                        Text(NSLocalizedString("field_context_both", comment: "Both")).tag("all")
                    }
                    .accessibilityIdentifier("field-context-picker")
                }

                // Options (for select type)
                if showsOptions {
                    Section(NSLocalizedString("field_options", comment: "Options")) {
                        ForEach(options.indices, id: \.self) { index in
                            HStack {
                                Text(options[index])
                                Spacer()
                                Button {
                                    options.remove(at: index)
                                } label: {
                                    Image(systemName: "minus.circle.fill")
                                        .foregroundStyle(Color.brandDestructive)
                                }
                                .buttonStyle(.plain)
                            }
                        }

                        HStack {
                            TextField(
                                NSLocalizedString("field_new_option", comment: "New option"),
                                text: $newOption
                            )
                            Button {
                                let trimmed = newOption.trimmingCharacters(in: .whitespacesAndNewlines)
                                guard !trimmed.isEmpty else { return }
                                options.append(trimmed)
                                newOption = ""
                            } label: {
                                Image(systemName: "plus.circle.fill")
                                    .foregroundStyle(Color.statusActive)
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("add-option-button")
                        }
                    }
                }

                // Toggles
                Section {
                    Toggle(
                        NSLocalizedString("field_required_toggle", comment: "Required"),
                        isOn: $isRequired
                    )
                    .accessibilityIdentifier("field-required-toggle")

                    Toggle(
                        NSLocalizedString("field_visible_users", comment: "Visible to volunteers"),
                        isOn: $visibleToVolunteers
                    )

                }
            }
            .navigationTitle(isEditing
                ? NSLocalizedString("field_edit_title", comment: "Edit Field")
                : NSLocalizedString("field_create_title", comment: "New Field")
            )
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(NSLocalizedString("cancel", comment: "Cancel")) {
                        dismiss()
                    }
                    .accessibilityIdentifier("cancel-field-edit")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(NSLocalizedString("save", comment: "Save")) {
                        Task { await save() }
                    }
                    .disabled(!isFormValid || isSaving)
                    .accessibilityIdentifier("field-save-button")
                }
            }
            .onAppear {
                if let field {
                    label = field.label
                    fieldType = field.type
                    context = field.context ?? "call-notes"
                    isRequired = field.fieldRequired ?? false
                    visibleToVolunteers = field.visibleToUsers ?? true
                    options = field.options ?? []
                }
            }
        }
    }

    private func save() async {
        isSaving = true
        defer { isSaving = false }

        let trimmedLabel = label.trimmingCharacters(in: .whitespacesAndNewlines)
        let slug = trimmedLabel.lowercased()
            .replacingOccurrences(of: " ", with: "_")
            .filter { $0.isLetter || $0.isNumber || $0 == "_" }

        let definition = CustomFieldsBodyField(
            context: context,
            label: trimmedLabel,
            name: field?.name ?? slug,
            options: showsOptions ? options : nil,
            order: field?.order ?? existingCount,
            fieldRequired: isRequired,
            type: fieldType,
            visibleToUsers: visibleToVolunteers
        )

        await onSave(definition)
    }
}
