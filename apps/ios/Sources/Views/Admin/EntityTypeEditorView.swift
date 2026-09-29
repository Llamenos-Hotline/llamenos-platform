import SwiftUI

private struct EntityTypeCustomizeBody: Codable {
    let label: String
    let labelPlural: String
    let showInNavigation: Bool
}

struct EntityTypeEditorView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss
    @State var entityType: CaseEntityTypeDefinition
    var onSave: (CaseEntityTypeDefinition) -> Void
    @State private var isSaving = false
    @State private var fields: [EditableField] = []
    @State private var saveError: String?

    // Mutable copies for editing (CaseEntityTypeDefinition has let properties)
    @State private var editLabel: String = ""
    @State private var editLabelPlural: String = ""
    @State private var editShowInNav: Bool = true

    var body: some View {
        NavigationStack {
            Form {
                Section(NSLocalizedString("admin_entity_type_section_general", comment: "General")) {
                    TextField(NSLocalizedString("admin_entity_type_label", comment: "Label"), text: $editLabel)
                    TextField(NSLocalizedString("admin_entity_type_label_plural", comment: "Plural label"), text: $editLabelPlural)
                    Toggle(NSLocalizedString("admin_entity_type_show_in_navigation", comment: "Show in navigation"),
                           isOn: $editShowInNav)
                }
                Section(NSLocalizedString("cms_fields", comment: "Fields")) {
                    NavigationLink(NSLocalizedString("cms_edit_fields", comment: "Edit Fields")) {
                        FieldDefinitionEditorView(fields: $fields, showEntityOptions: true)
                            .navigationTitle(NSLocalizedString("cms_fields", comment: "Fields"))
                    }
                }
                if let err = saveError {
                    Section {
                        Text(err).foregroundStyle(.red).font(.caption)
                    }
                }
            }
            .navigationTitle(editLabel)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(NSLocalizedString("common_cancel", comment: "Cancel")) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(NSLocalizedString("common_save", comment: "Save")) { save() }
                        .disabled(isSaving || editLabel.isEmpty)
                }
            }
            .onAppear {
                editLabel = entityType.label
                editLabelPlural = entityType.labelPlural
                editShowInNav = entityType.showInNavigation ?? true
            }
        }
    }

    private func save() {
        isSaving = true
        saveError = nil
        Task {
            do {
                let body = EntityTypeCustomizeBody(
                    label: editLabel,
                    labelPlural: editLabelPlural,
                    showInNavigation: editShowInNav
                )
                let updated: CaseEntityTypeDefinition = try await appState.apiService.request(
                    method: "PATCH",
                    path: appState.apiService.hp("/api/settings/cms/entity-types/\(entityType.id)/customize"),
                    body: body
                )
                await MainActor.run { onSave(updated); dismiss() }
            } catch {
                await MainActor.run { saveError = error.localizedDescription }
            }
            await MainActor.run { isSaving = false }
        }
    }
}
