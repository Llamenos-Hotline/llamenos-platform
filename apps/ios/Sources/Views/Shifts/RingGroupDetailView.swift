import SwiftUI

// MARK: - RingGroupDetailView

/// Membership and rename management for one ring group. Member add/remove go
/// straight to the server and the detail is re-read from the mutation response,
/// so the list always shows what routing will actually resolve.
struct RingGroupDetailView: View {
    @Bindable var viewModel: ShiftAdminViewModel
    let groupId: String

    @State private var editedName = ""

    private var detail: RingGroupDetailResponse? {
        viewModel.ringGroupDetail?.id == groupId ? viewModel.ringGroupDetail : nil
    }

    /// Hub members not yet in the group — the addable pool.
    private var addableUsers: [UserListResponseUser] {
        let memberPubkeys = Set(detail?.members.map(\.pubkey) ?? [])
        return viewModel.users.filter { !memberPubkeys.contains($0.pubkey) }
    }

    var body: some View {
        List {
            if let error = viewModel.errorMessage {
                Section {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.brand(.footnote))
                        .foregroundStyle(.secondary)
                }
                .accessibilityIdentifier("ring-group-detail-error")
            }

            if let detail {
                renameSection(detail)
                membersSection(detail)
                addMembersSection
            } else {
                Section {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .accessibilityIdentifier("ring-group-detail-loading")
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(detail?.encryptedName ?? NSLocalizedString("shifts_ring_groups_title", comment: "Ring Groups"))
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("ring-group-detail")
        .task(id: groupId) {
            await viewModel.loadRingGroupDetail(id: groupId)
            if viewModel.users.isEmpty {
                await viewModel.loadUsers()
            }
            editedName = viewModel.ringGroupDetail?.encryptedName ?? ""
        }
    }

    // MARK: - Rename

    private func renameSection(_ detail: RingGroupDetailResponse) -> some View {
        Section {
            HStack(spacing: 8) {
                TextField(
                    NSLocalizedString("shifts_ring_groups_name", comment: "Ring Group Name"),
                    text: $editedName
                )
                .autocorrectionDisabled()
                .accessibilityIdentifier("ring-group-rename-input")

                Button(NSLocalizedString("save", comment: "Save")) {
                    Task { await viewModel.renameRingGroup(id: detail.id, name: editedName) }
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(
                    editedName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        || editedName == detail.encryptedName
                        || viewModel.isSaving
                )
                .accessibilityIdentifier("ring-group-rename-save")
            }
        } header: {
            Text(NSLocalizedString("shifts_ring_groups_edit", comment: "Edit Ring Group"))
        }
    }

    // MARK: - Members

    private func membersSection(_ detail: RingGroupDetailResponse) -> some View {
        Section {
            if detail.members.isEmpty {
                Text(NSLocalizedString("shifts_ring_groups_empty", comment: "No ring groups"))
                    .font(.brand(.caption))
                    .foregroundStyle(Color.brandMutedForeground)
            } else {
                ForEach(detail.members) { member in
                    HStack(spacing: 10) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(displayName(for: member.pubkey))
                                .font(.brand(.body))
                                .foregroundStyle(Color.brandForeground)
                            Text(member.pubkey.truncatedPubkey())
                                .font(.brandMono(.caption))
                                .foregroundStyle(Color.brandMutedForeground)
                        }
                        Spacer()
                        Button {
                            Task { await viewModel.removeRingGroupMember(groupId: detail.id, pubkey: member.pubkey) }
                        } label: {
                            Image(systemName: "minus.circle.fill")
                                .foregroundStyle(Color.brandDestructive)
                        }
                        .buttonStyle(.borderless)
                        .accessibilityIdentifier("ring-group-remove-member-\(member.pubkey)")
                    }
                    .accessibilityIdentifier("ring-group-member-\(member.pubkey)")
                }
            }
        } header: {
            Text(NSLocalizedString("shifts_ring_groups_members", comment: "Members"))
        }
        .accessibilityIdentifier("ring-group-detail-members")
    }

    // MARK: - Add Members

    private var addMembersSection: some View {
        Section {
            if viewModel.users.isEmpty {
                Text(NSLocalizedString("shifts_no_users_found", comment: "No volunteers found"))
                    .font(.brand(.caption))
                    .foregroundStyle(Color.brandMutedForeground)
            } else if addableUsers.isEmpty {
                Text(NSLocalizedString("shifts_no_users_found", comment: "No volunteers found"))
                    .font(.brand(.caption))
                    .foregroundStyle(Color.brandMutedForeground)
            } else {
                ForEach(addableUsers, id: \.pubkey) { user in
                    Button {
                        Haptics.impact(.light)
                        Task {
                            if let detail { await viewModel.addRingGroupMembers(groupId: detail.id, pubkeys: [user.pubkey]) }
                        }
                    } label: {
                        HStack(spacing: 10) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(displayName(for: user.pubkey))
                                    .font(.brand(.body))
                                    .foregroundStyle(Color.brandForeground)
                                Text(user.pubkey.truncatedPubkey())
                                    .font(.brandMono(.caption))
                                    .foregroundStyle(Color.brandMutedForeground)
                            }
                            Spacer()
                            Image(systemName: "plus.circle")
                                .foregroundStyle(Color.brandPrimary)
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("ring-group-add-member-\(user.pubkey)")
                }
            }
        } header: {
            Text(NSLocalizedString("shifts_ring_groups_add_members", comment: "Add Members"))
        }
    }

    // MARK: - Helpers

    private func displayName(for pubkey: String) -> String {
        let name = viewModel.users.first(where: { $0.pubkey == pubkey })?.name ?? ""
        return name.isEmpty ? pubkey.truncatedPubkey() : name
    }
}
