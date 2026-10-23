import SwiftUI

// MARK: - CustomFieldsView

struct CustomFieldsView: View {
    @Bindable var viewModel: AdminViewModel

    var body: some View {
        ZStack {
            if viewModel.isLoadingFields && viewModel.customFields.isEmpty {
                loadingState
            } else if viewModel.customFields.isEmpty {
                emptyState
            } else {
                fieldsList
            }
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    viewModel.editingField = nil
                    viewModel.showFieldEditor = true
                } label: {
                    Image(systemName: "plus.circle.fill")
                        .font(.brand(.body))
                }
                .accessibilityIdentifier("add-field-button")
            }
        }
        .sheet(isPresented: $viewModel.showFieldEditor) {
            CustomFieldEditView(
                field: viewModel.editingField,
                existingCount: viewModel.customFields.count,
                onSave: { field in
                    await viewModel.saveField(field)
                }
            )
        }
        .task {
            await viewModel.loadCustomFields()
        }
    }

    // MARK: - Fields List

    private var fieldsList: some View {
        List {
            ForEach(viewModel.customFields) { field in
                FieldRowView(field: field)
                    .accessibilityIdentifier("field-row-\(field.name)")
                    .contentShape(Rectangle())
                    .onTapGesture {
                        viewModel.editingField = field
                        viewModel.showFieldEditor = true
                    }
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) {
                            Task { await viewModel.deleteField(name: field.name) }
                        } label: {
                            Label(
                                NSLocalizedString("delete", comment: "Delete"),
                                systemImage: "trash"
                            )
                        }
                    }
            }
        }
        .listStyle(.plain)
        .accessibilityIdentifier("custom-fields-list")
    }

    // MARK: - Empty State

    private var emptyState: some View {
        BrandEmptyState(
            icon: "list.bullet.rectangle",
            title: NSLocalizedString("fields_empty_title", comment: "No Custom Fields"),
            message: NSLocalizedString("fields_empty_message", comment: "Custom fields will appear on note and report forms."),
            action: {
                viewModel.editingField = nil
                viewModel.showFieldEditor = true
            },
            actionLabel: NSLocalizedString("fields_add_first", comment: "Add First Field"),
            actionAccessibilityID: "add-first-field"
        )
        .accessibilityIdentifier("custom-fields-empty-state")
    }

    // MARK: - Loading State

    private var loadingState: some View {
        VStack(spacing: 16) {
            ProgressView()
                .scaleEffect(1.2)
            Text(NSLocalizedString("fields_loading", comment: "Loading custom fields..."))
                .font(.brand(.subheadline))
                .foregroundStyle(Color.brandMutedForeground)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("custom-fields-loading")
    }
}

// MARK: - FieldRowView

struct FieldRowView: View {
    let field: CustomFieldsBodyField

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(field.label)
                .font(.brand(.body))
                .fontWeight(.medium)

            HStack(spacing: 8) {
                // Type badge
                typeBadge(field.type)

                // Context badge
                contextBadge(field.context)

                if field.isRequired {
                    Text(NSLocalizedString("field_required", comment: "Required"))
                        .font(.brand(.caption2))
                        .fontWeight(.medium)
                        .foregroundStyle(Color.brandDestructive)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Capsule().fill(Color.brandDestructive.opacity(0.12)))
                }

                Spacer()
            }
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private func typeBadge(_ type: SharedCustomFieldDefinitionType) -> some View {
        Text(type.rawValue.capitalized)
            .font(.brand(.caption2))
            .fontWeight(.medium)
            .foregroundStyle(Color.brandPrimary)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Capsule().fill(Color.brandPrimary.opacity(0.12)))
    }

    @ViewBuilder
    private func contextBadge(_ context: String?) -> some View {
        // Wire contexts (packages/protocol/schemas/settings.ts):
        // call-notes, conversation-notes, reports, all.
        let label: String = switch context {
        case "call-notes": NSLocalizedString("field_context_notes", comment: "Notes")
        case "reports": NSLocalizedString("field_context_reports", comment: "Reports")
        default: NSLocalizedString("field_context_both", comment: "Both")
        }
        Text(label)
            .font(.brand(.caption2))
            .fontWeight(.medium)
            .foregroundStyle(Color.brandDarkTeal)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Capsule().fill(Color.brandDarkTeal.opacity(0.12)))
    }
}
