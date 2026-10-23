import SwiftUI

// MARK: - TagsAdminView

/// Admin tag management: list (decrypted labels), create, and delete hub tags.
/// Mirrors the desktop `admin-sections/tags-section.tsx`. Editing is limited to
/// create/delete — label/color editing lands with the desktop-parity editor.
struct TagsAdminView: View {
    @Environment(AppState.self) private var appState
    @State private var viewModelBox = ViewModelBox<TagsViewModel>()
    @State private var showCreateSheet = false
    @State private var deleteTarget: DecryptedTag?

    var body: some View {
        let vm = resolvedViewModel

        ZStack {
            if vm.isLoading && vm.tags.isEmpty {
                ProgressView()
                    .accessibilityIdentifier("tags-loading")
            } else if vm.tags.isEmpty {
                ContentUnavailableView {
                    Label(
                        NSLocalizedString("tags_no_tags", comment: "No tags yet. Create your first tag."),
                        systemImage: "tag"
                    )
                }
                .accessibilityIdentifier("tags-empty-state")
            } else {
                List {
                    ForEach(vm.tags) { tag in
                        HStack(spacing: 12) {
                            Circle()
                                .fill(Color(hex: tag.color) ?? Color.brandMutedForeground)
                                .frame(width: 12, height: 12)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(tag.label)
                                    .font(.brand(.body))
                                    .foregroundStyle(Color.brandForeground)
                                Text(tag.name)
                                    .font(.brandMono(.caption))
                                    .foregroundStyle(Color.brandMutedForeground)
                            }
                            Spacer()
                            if let category = tag.category {
                                Text(category)
                                    .font(.brand(.caption2))
                                    .foregroundStyle(Color.brandMutedForeground)
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(Capsule().fill(Color.brandMutedForeground.opacity(0.12)))
                            }
                            if canManage {
                                Button(role: .destructive) {
                                    deleteTarget = tag
                                } label: {
                                    Image(systemName: "trash")
                                        .foregroundStyle(Color.brandDestructive)
                                }
                                .accessibilityIdentifier("tag-delete-\(tag.name)")
                            }
                        }
                        .accessibilityIdentifier("tag-row-\(tag.name)")
                    }
                }
                .accessibilityIdentifier("tags-list")
            }
        }
        .navigationTitle(NSLocalizedString("tags_title", comment: "Tags"))
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            if canCreate {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        showCreateSheet = true
                    } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityIdentifier("tags-create-button")
                }
            }
        }
        .refreshable {
            vm.isLoading = false
            await vm.loadTags()
        }
        .task {
            await vm.loadTags()
        }
        .sheet(isPresented: $showCreateSheet) {
            TagCreateSheet(viewModel: vm)
        }
        .alert(
            NSLocalizedString("tags_confirm_delete", comment: "Delete this tag?"),
            isPresented: Binding(
                get: { deleteTarget != nil },
                set: { if !$0 { deleteTarget = nil } }
            )
        ) {
            Button(NSLocalizedString("common_cancel", comment: "Cancel"), role: .cancel) {
                deleteTarget = nil
            }
            Button(NSLocalizedString("common_delete", comment: "Delete"), role: .destructive) {
                if let target = deleteTarget {
                    Task { try? await vm.deleteTag(target.id) }
                }
                deleteTarget = nil
            }
        }
        .alert(
            NSLocalizedString("common_error", comment: "Error"),
            isPresented: Binding(
                get: { vm.errorMessage != nil },
                set: { if !$0 { vm.errorMessage = nil } }
            )
        ) {
            Button(NSLocalizedString("common_done", comment: "Done"), role: .cancel) {
                vm.errorMessage = nil
            }
        } message: {
            Text(vm.errorMessage ?? "")
        }
    }

    private var canCreate: Bool {
        appState.hasPermission("tags:create")
    }

    private var canManage: Bool {
        appState.hasPermission("tags:manage")
    }

    private var resolvedViewModel: TagsViewModel {
        if let existing = viewModelBox.value { return existing }
        let vm = TagsViewModel(
            tagsAPI: TagsAPIService(apiService: appState.apiService),
            crypto: appState.cryptoService,
            hubIdProvider: { [hubContext = appState.hubContext] in hubContext.activeHubId }
        )
        viewModelBox.value = vm
        return vm
    }
}

// MARK: - TagCreateSheet

private struct TagCreateSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var viewModel: TagsViewModel

    @State private var label = ""
    @State private var category = ""
    @State private var selectedColor = "#6b7280"
    @State private var isSaving = false
    @State private var errorMessage: String?

    private static let palette = [
        "#6b7280", "#ef4444", "#f97316", "#eab308",
        "#22c55e", "#14b8a6", "#3b82f6", "#8b5cf6",
    ]

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(
                        NSLocalizedString("tags_tag_label", comment: "Display Label"),
                        text: $label
                    )
                    .accessibilityIdentifier("tag-create-label")

                    TextField(
                        NSLocalizedString("tags_tag_category", comment: "Category"),
                        text: $category
                    )
                    .accessibilityIdentifier("tag-create-category")
                }

                Section(NSLocalizedString("tags_tag_color", comment: "Color")) {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 36))], spacing: 12) {
                        ForEach(Self.palette, id: \.self) { hex in
                            Button {
                                selectedColor = hex
                            } label: {
                                Circle()
                                    .fill(Color(hex: hex) ?? Color.brandMutedForeground)
                                    .frame(width: 28, height: 28)
                                    .overlay(
                                        Circle()
                                            .stroke(Color.brandForeground, lineWidth: selectedColor == hex ? 2 : 0)
                                    )
                            }
                            .accessibilityIdentifier("tag-create-color-\(hex.dropFirst())")
                        }
                    }
                }

                Section(NSLocalizedString("tags_preview", comment: "Preview:")) {
                    HStack {
                        TagBadge(label: label.isEmpty ? "…" : label, color: selectedColor)
                        Text(L10n.format("tags_slug_preview", TagsViewModel.slugify(label)))
                            .font(.brandMono(.caption))
                            .foregroundStyle(Color.brandMutedForeground)
                    }
                    .accessibilityIdentifier("tag-create-preview")
                }

                if let errorMessage {
                    Section {
                        Text(errorMessage)
                            .foregroundStyle(Color.brandDestructive)
                            .font(.brand(.caption))
                    }
                }
            }
            .navigationTitle(NSLocalizedString("tags_create_tag", comment: "Create Tag"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(NSLocalizedString("common_cancel", comment: "Cancel")) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(NSLocalizedString("common_save", comment: "Save")) { save() }
                        .disabled(label.trimmingCharacters(in: .whitespaces).isEmpty || isSaving)
                        .accessibilityIdentifier("tag-create-save")
                }
            }
            .overlay { if isSaving { ProgressView() } }
        }
    }

    private func save() {
        isSaving = true
        errorMessage = nil
        Task {
            do {
                _ = try await viewModel.createTag(
                    label: label,
                    color: selectedColor,
                    category: category.isEmpty ? nil : category
                )
                await MainActor.run { dismiss() }
            } catch {
                await MainActor.run {
                    errorMessage = error.localizedDescription
                    isSaving = false
                }
            }
        }
    }
}
