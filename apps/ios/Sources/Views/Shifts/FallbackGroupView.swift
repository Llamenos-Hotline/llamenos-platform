import SwiftUI

// MARK: - FallbackGroupView

/// Admin configuration of the fallback ring group — the volunteers rung when no
/// scheduled shift matches. Toggles write through to `PUT /shifts/fallback`
/// immediately (desktop's UserMultiSelect saves on every selection change), and
/// routing reads this set per incoming call, so a change is live at once.
struct FallbackGroupView: View {
    @Bindable var viewModel: ShiftAdminViewModel
    @Environment(HubContext.self) private var hubContext

    var body: some View {
        List {
            if let error = viewModel.errorMessage {
                Section {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.brand(.footnote))
                        .foregroundStyle(.secondary)
                }
                .accessibilityIdentifier("fallback-error")
            }

            Section {
                Text(NSLocalizedString("shifts_fallback_description", comment: "Fallback group description"))
                    .font(.brand(.footnote))
                    .foregroundStyle(Color.brandMutedForeground)
            }

            Section {
                if viewModel.users.isEmpty && !viewModel.isLoading {
                    Text(NSLocalizedString("shifts_no_users_found", comment: "No volunteers found"))
                        .font(.brand(.caption))
                        .foregroundStyle(Color.brandMutedForeground)
                        .accessibilityIdentifier("fallback-empty-state")
                } else {
                    ForEach(viewModel.users, id: \.pubkey) { user in
                        let isMember = viewModel.fallbackPubkeys.contains(user.pubkey)
                        Button {
                            Haptics.impact(.light)
                            var next = viewModel.fallbackPubkeys
                            if isMember {
                                next.removeAll { $0 == user.pubkey }
                            } else {
                                next.append(user.pubkey)
                            }
                            Task { await viewModel.setFallback(pubkeys: next) }
                        } label: {
                            HStack(spacing: 10) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(user.name.isEmpty ? user.pubkey.truncatedPubkey() : user.name)
                                        .font(.brand(.body))
                                        .foregroundStyle(Color.brandForeground)
                                    Text(user.pubkey.truncatedPubkey())
                                        .font(.brandMono(.caption))
                                        .foregroundStyle(Color.brandMutedForeground)
                                }
                                Spacer()
                                if viewModel.isSaving {
                                    ProgressView()
                                        .controlSize(.small)
                                } else if isMember {
                                    Image(systemName: "checkmark.circle.fill")
                                        .foregroundStyle(Color.brandPrimary)
                                } else {
                                    Image(systemName: "circle")
                                        .foregroundStyle(Color.brandMutedForeground)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                        .disabled(viewModel.isSaving)
                        .accessibilityIdentifier("fallback-user-row-\(user.pubkey)")
                    }
                }
            } header: {
                Text(NSLocalizedString("shifts_users", comment: "Volunteers"))
            }
            .accessibilityIdentifier("fallback-member-list")
        }
        .listStyle(.insetGrouped)
        .navigationTitle(NSLocalizedString("shifts_fallback_group", comment: "Fallback Group"))
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("fallback-group-view")
        .refreshable {
            await viewModel.loadFallback()
            await viewModel.loadUsers()
        }
        .task(id: hubContext.activeHubId) {
            await viewModel.loadFallback()
            await viewModel.loadUsers()
        }
    }
}
