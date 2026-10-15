import SwiftUI

// MARK: - RingGroupsView

/// Admin management of the hub's ring groups: create, delete, and drill into a
/// group to manage membership. Parity with desktop's `ring-groups-panel.tsx`.
struct RingGroupsView: View {
    @Bindable var viewModel: ShiftAdminViewModel
    @Environment(HubContext.self) private var hubContext

    @State private var showCreateSheet = false
    @State private var newGroupName = ""
    @State private var groupPendingDeletion: RingGroup?

    var body: some View {
        Group {
            if viewModel.isLoading && viewModel.ringGroups.isEmpty {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .accessibilityIdentifier("ring-groups-loading")
            } else {
                groupList
            }
        }
        .navigationTitle(NSLocalizedString("shifts_ring_groups_title", comment: "Ring Groups"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    newGroupName = ""
                    showCreateSheet = true
                } label: {
                    Image(systemName: "plus.circle.fill")
                        .foregroundStyle(Color.brandPrimary)
                }
                .accessibilityIdentifier("ring-group-create-button")
                .accessibilityLabel(NSLocalizedString("shifts_ring_groups_create", comment: "Create Ring Group"))
            }
        }
        .sheet(isPresented: $showCreateSheet) {
            createSheet
        }
        .refreshable {
            await viewModel.loadRingGroups()
        }
        .task(id: hubContext.activeHubId) {
            await viewModel.loadRingGroups()
            await viewModel.loadUsers()
        }
        .alert(
            NSLocalizedString("shifts_ring_groups_delete", comment: "Delete Ring Group"),
            isPresented: Binding(
                get: { groupPendingDeletion != nil },
                set: { if !$0 { groupPendingDeletion = nil } }
            )
        ) {
            Button(NSLocalizedString("cancel", comment: "Cancel"), role: .cancel) {}
            Button(NSLocalizedString("common_delete", comment: "Delete"), role: .destructive) {
                if let group = groupPendingDeletion {
                    Task { await viewModel.deleteRingGroup(id: group.id) }
                }
            }
        } message: {
            Text(NSLocalizedString("shifts_ring_groups_delete_confirm", comment: "Delete confirmation"))
        }
    }

    // MARK: - Group List

    private var groupList: some View {
        List {
            if let error = viewModel.errorMessage {
                Section {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.brand(.footnote))
                        .foregroundStyle(.secondary)
                }
                .accessibilityIdentifier("ring-groups-error")
            }

            if viewModel.ringGroups.isEmpty {
                Section {
                    BrandEmptyState(
                        icon: "person.3.sequence",
                        title: NSLocalizedString("shifts_ring_groups_empty", comment: "No ring groups"),
                        message: NSLocalizedString("shifts_ring_groups_empty_subtitle", comment: "Empty state subtitle")
                    )
                    .accessibilityIdentifier("ring-groups-empty-state")
                    .listRowBackground(Color.clear)
                }
            } else {
                Section {
                    ForEach(viewModel.ringGroups) { group in
                        NavigationLink {
                            RingGroupDetailView(viewModel: viewModel, groupId: group.id)
                        } label: {
                            HStack(spacing: 12) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(group.encryptedName)
                                        .font(.brand(.body))
                                        .fontWeight(.medium)
                                        .foregroundStyle(Color.brandForeground)
                                    Text(L10n.format(
                                        "shifts_ring_groups_member_count",
                                        comment: "%d member(s)",
                                        group.memberCount
                                    ))
                                    .font(.brand(.caption))
                                    .foregroundStyle(Color.brandMutedForeground)
                                }
                                Spacer()
                            }
                        }
                        .accessibilityIdentifier("ring-group-row-\(group.id)")
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) {
                                groupPendingDeletion = group
                            } label: {
                                Label(
                                    NSLocalizedString("common_delete", comment: "Delete"),
                                    systemImage: "trash"
                                )
                            }
                            .accessibilityIdentifier("ring-group-delete-\(group.id)")
                        }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .accessibilityIdentifier("ring-group-list")
    }

    // MARK: - Create Sheet

    private var createSheet: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(
                        NSLocalizedString("shifts_ring_groups_name", comment: "Ring Group Name"),
                        text: $newGroupName
                    )
                    .autocorrectionDisabled()
                    .accessibilityIdentifier("ring-group-name-input")
                }
            }
            .navigationTitle(NSLocalizedString("shifts_ring_groups_create", comment: "Create Ring Group"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(NSLocalizedString("cancel", comment: "Cancel")) {
                        showCreateSheet = false
                    }
                    .accessibilityIdentifier("ring-group-create-cancel")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(NSLocalizedString("save", comment: "Save")) {
                        Task {
                            if await viewModel.createRingGroup(name: newGroupName) {
                                showCreateSheet = false
                            }
                        }
                    }
                    .disabled(newGroupName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || viewModel.isSaving)
                    .accessibilityIdentifier("ring-group-save-button")
                }
            }
        }
    }
}
