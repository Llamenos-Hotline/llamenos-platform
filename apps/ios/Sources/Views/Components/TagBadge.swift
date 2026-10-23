import SwiftUI

// MARK: - TagBadge

/// Colored dot + label capsule for a decrypted tag, with an optional remove
/// button. Mirrors the desktop `tag-badge.tsx`.
struct TagBadge: View {
    let label: String
    let color: String
    var onRemove: (() -> Void)?

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(Color(hex: color) ?? Color.brandMutedForeground)
                .frame(width: 8, height: 8)
            Text(label)
                .font(.brand(.caption))
                .foregroundStyle(Color.brandForeground)
                .lineLimit(1)
            if let onRemove {
                Button {
                    onRemove()
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 8, weight: .bold))
                        .foregroundStyle(Color.brandMutedForeground)
                }
                .accessibilityLabel(L10n.format("tags_remove", label))
                .accessibilityIdentifier("tag-badge-remove-\(label)")
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(
            Capsule().fill(Color.brandCard)
        )
        .overlay(
            Capsule().stroke(Color.brandMutedForeground.opacity(0.3), lineWidth: 1)
        )
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("tag-badge-\(label)")
    }
}

// MARK: - TagPicker

/// Multi-select tag picker: selected tags render as removable badges; tapping
/// the trigger opens a sheet with search, category groups, and inline create
/// (gated on the `tags:create` permission). Mirrors the desktop `tag-input.tsx`.
struct TagPicker: View {
    @Bindable var viewModel: TagsViewModel
    @Binding var selectedTagIds: Set<String>
    var canCreate: Bool = false

    @State private var showSheet = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            let selected = viewModel.tags.filter { selectedTagIds.contains($0.id) }
            if !selected.isEmpty {
                FlowLayout(spacing: 6) {
                    ForEach(selected) { tag in
                        TagBadge(label: tag.label, color: tag.color) {
                            selectedTagIds.remove(tag.id)
                        }
                    }
                }
            }

            Button {
                showSheet = true
            } label: {
                HStack {
                    Text(NSLocalizedString("tags_add_tag", comment: "Add tag..."))
                        .font(.brand(.subheadline))
                        .foregroundStyle(Color.brandMutedForeground)
                    Spacer()
                    Image(systemName: "chevron.up.chevron.down")
                        .font(.brand(.caption))
                        .foregroundStyle(Color.brandMutedForeground)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(
                    RoundedRectangle(cornerRadius: 8)
                        .stroke(Color.brandMutedForeground.opacity(0.4), lineWidth: 1)
                )
            }
            .accessibilityIdentifier("tag-picker-trigger")
        }
        .sheet(isPresented: $showSheet) {
            TagPickerSheet(
                viewModel: viewModel,
                selectedTagIds: $selectedTagIds,
                canCreate: canCreate
            )
        }
        .task {
            if viewModel.tags.isEmpty {
                await viewModel.loadTags()
            }
        }
    }
}

// MARK: - TagPickerSheet

private struct TagPickerSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var viewModel: TagsViewModel
    @Binding var selectedTagIds: Set<String>
    let canCreate: Bool

    @State private var search = ""
    @State private var isCreating = false

    private var filteredGroups: [(category: String, tags: [DecryptedTag])] {
        let query = search.lowercased()
        guard !query.isEmpty else { return viewModel.groupedByCategory }
        return viewModel.groupedByCategory.compactMap { group in
            let matches = group.tags.filter {
                $0.label.lowercased().contains(query) || $0.name.contains(query)
            }
            return matches.isEmpty ? nil : (category: group.category, tags: matches)
        }
    }

    private var showCreate: Bool {
        let query = search.trimmingCharacters(in: .whitespaces)
        guard canCreate, !query.isEmpty else { return false }
        return !viewModel.tags.contains {
            $0.label.lowercased() == query.lowercased() || $0.name == TagsViewModel.slugify(query)
        }
    }

    var body: some View {
        NavigationStack {
            List {
                if showCreate {
                    Button {
                        create()
                    } label: {
                        HStack {
                            Image(systemName: "plus.circle.fill")
                                .foregroundStyle(Color.brandPrimary)
                            Text(L10n.format("tags_create_tag_named", search.trimmingCharacters(in: .whitespaces)))
                                .foregroundStyle(Color.brandForeground)
                            if isCreating {
                                Spacer()
                                ProgressView()
                            }
                        }
                    }
                    .disabled(isCreating)
                    .accessibilityIdentifier("tag-picker-create")
                }

                if filteredGroups.isEmpty && !showCreate {
                    ContentUnavailableView {
                        Label(
                            NSLocalizedString("tags_no_tags_found", comment: "No tags found."),
                            systemImage: "tag"
                        )
                    }
                    .accessibilityIdentifier("tag-picker-empty")
                }

                ForEach(filteredGroups, id: \.category) { group in
                    Section(group.category) {
                        ForEach(group.tags) { tag in
                            Button {
                                toggle(tag.id)
                            } label: {
                                HStack {
                                    Circle()
                                        .fill(Color(hex: tag.color) ?? Color.brandMutedForeground)
                                        .frame(width: 10, height: 10)
                                    Text(tag.label)
                                        .foregroundStyle(Color.brandForeground)
                                    Spacer()
                                    if selectedTagIds.contains(tag.id) {
                                        Image(systemName: "checkmark")
                                            .foregroundStyle(Color.brandPrimary)
                                    }
                                }
                            }
                            .accessibilityIdentifier("tag-picker-option-\(tag.name)")
                        }
                    }
                }
            }
            .searchable(
                text: $search,
                prompt: NSLocalizedString("tags_search_tags", comment: "Search tags...")
            )
            .navigationTitle(NSLocalizedString("tags_select_tags", comment: "Select tags"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(NSLocalizedString("common_done", comment: "Done")) { dismiss() }
                        .accessibilityIdentifier("tag-picker-done")
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func toggle(_ tagId: String) {
        if selectedTagIds.contains(tagId) {
            selectedTagIds.remove(tagId)
        } else {
            selectedTagIds.insert(tagId)
        }
    }

    private func create() {
        let label = search.trimmingCharacters(in: .whitespaces)
        guard !label.isEmpty else { return }
        isCreating = true
        Task {
            do {
                let tag = try await viewModel.createTag(
                    label: label,
                    color: "#6b7280",
                    category: nil
                )
                await MainActor.run {
                    selectedTagIds.insert(tag.id)
                    search = ""
                    isCreating = false
                }
            } catch {
                await MainActor.run { isCreating = false }
            }
        }
    }
}

// MARK: - FlowLayout

/// Left-to-right wrapping layout for badges (SwiftUI has no built-in flow
/// container on iOS 17 outside of a custom Layout).
struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var point = CGPoint.zero
        var height: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if point.x + size.width > width, point.x > 0 {
                point.x = 0
                point.y += size.height + spacing
            }
            point.x += size.width + spacing
            height = max(height, point.y + size.height)
        }
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var point = bounds.origin
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if point.x + size.width > bounds.maxX, point.x > bounds.minX {
                point.x = bounds.minX
                point.y += size.height + spacing
            }
            subview.place(at: point, proposal: ProposedViewSize(size))
            point.x += size.width + spacing
        }
    }
}
